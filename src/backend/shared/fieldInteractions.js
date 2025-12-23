const path = require('path');

// --- HELPER FUNCTIONS ---

const isGoogleRadio = async (page, sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    return el?.getAttribute('role') === 'radio' || el?.closest('[role="radio"]');
}, sel);

const isGoogleCheckbox = async (page, sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    return el?.getAttribute('role') === 'checkbox' || el?.closest('[role="checkbox"]');
}, sel);

const isGoogleListbox = async (page, sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    return el?.getAttribute('role') === 'listbox' || el?.closest('[role="listbox"]');
}, sel);

const findOptionMatch = (options, userValue) => {
    if (!options || options.length === 0) return null;
    const normVal = String(userValue).trim().toLowerCase();

    for (const opt of options) {
        if ((opt.value && String(opt.value).trim().toLowerCase() === normVal) ||
            (opt.label && String(opt.label).trim().toLowerCase() === normVal) ||
            (opt.text && String(opt.text).trim().toLowerCase() === normVal)) {
            return opt;
        }
    }
    return null;
};


// --- INTERACTION LOGIC ---

async function uploadFile(page, selector, userValue, label, logger) {
    logger.log(`Uploading file for ${label}: ${userValue}`);
    const filePath = path.isAbsolute(userValue) ? userValue : path.resolve(process.cwd(), userValue);
    try {
        await page.setInputFiles(selector, filePath);
        logger.log(` - File set: ${path.basename(filePath)}`);
        return true;
    } catch (err) {
        logger.log(` - File upload failed: ${err.message}`, 'WARN');
        return false;
    }
}

async function fillAutocomplete(page, selector, userValue, label, logger) {
    logger.log(`Processing Autocomplete: ${label}`);
    const values = Array.isArray(userValue) ? userValue : [String(userValue)];
    await page.click(selector);
    for (const val of values) {
        await page.type(selector, val, { delay: 100 });
        await page.waitForTimeout(500);
        await page.press(selector, 'Enter');
        logger.log(` - Selected: ${val}`);
    }
    return true;
}

async function fillDate(page, selector, userValue, field, logger) {
    logger.log(`Processing Date Field: ${field.label}`);
    const date = new Date(userValue);
    if (isNaN(date.getTime())) throw new Error(`Invalid date value: ${userValue}`);

    const isoDate = date.toISOString().split('T')[0];
    const monthLong = date.toLocaleString('default', { month: 'long' });
    const year = date.getFullYear().toString();
    const day = date.getDate().toString();

    // A. React DatePicker (DemoQA)
    if (field.type === 'date-picker' || (await page.$(selector + ' .react-datepicker-wrapper'))) {
        await page.click(selector);
        await page.waitForSelector('.react-datepicker', { timeout: 2000 }).catch(() => { });
        if (await page.isVisible('.react-datepicker')) {
            await page.selectOption('.react-datepicker__month-select', { label: monthLong }).catch(() => { });
            await page.selectOption('.react-datepicker__year-select', year).catch(() => { });
            const daySel = `.react-datepicker__day:not(.react-datepicker__day--outside-month):text-is("${day}")`;
            await page.click(daySel).catch(async () => {
                await page.click(`div[role="option"]:has-text("${day}")`);
            });
            return true;
        } else {
            await page.fill(selector, isoDate);
            await page.press(selector, 'Enter');
            return true;
        }
    }
    // B. Native / Generic
    else {
        try {
            await page.fill(selector, isoDate);
            return true;
        } catch (e) {
            const usDate = `${(date.getMonth() + 1).toString().padStart(2, '0')}/${day.padStart(2, '0')}/${year}`;
            await page.type(selector, usDate);
            return true;
        }
    }
}

async function selectReactSelect(page, selector, userValue, label, field, logger) {
    logger.log(`Processing React Select: ${label}`);
    // 1. Click the container & Force Trigger
    await page.click(selector, { force: true });
    await page.waitForTimeout(500); // Wait for menu
    await page.keyboard.press('ArrowDown'); // Ensure menu opens

    // 2. Wait for menu & Select
    try {
        await page.waitForSelector('div[class*="-menu"], div[role="listbox"]', { state: 'visible', timeout: 3000 });
        const targetText = String(userValue).trim();

        // Try exact match first
        const option = await page.evaluateHandle((text) => {
            const opts = Array.from(document.querySelectorAll('div[class*="-option"]'));
            return opts.find(o => o.innerText.trim().toLowerCase() === text.toLowerCase());
        }, targetText);

        if (option.asElement()) {
            await option.asElement().click();
        } else {
            // Contains match
            await page.click(`div[class*="-option"]:has-text("${targetText}")`);
        }

        // --- POST-DROPDOWN RECOVERY (CRITICAL) ---
        await page.waitForTimeout(300);
        logger.log(`Restoring focus after dropdown selection...`);
        await page.click('body', { force: true });
        await page.evaluate(() => {
            if (document.activeElement && document.activeElement !== document.body) {
                document.activeElement.blur();
            }
        });

        return true;
    } catch (e) {
        logger.log(`React Select fallback: ${e.message}`);
        // Fallback: Type into input
        const inputSel = field.inputSelector || `${selector} input`;
        await page.fill(inputSel, String(userValue));
        await page.press(inputSel, 'Enter');
        await page.click('body', { force: true }); // Recovery here too
        return true;
    }
}

async function fillTimeGroup(page, field, userValue, logger) {
    logger.log(`Detected time field: ${field.label}`);
    const timeStr = String(userValue);
    const parts = timeStr.split(':');

    if (parts.length < 2) {
        throw new Error(`Invalid time format for "${field.label}". Expected "HH:MM", got "${timeStr}"`);
    }

    const hour = parts[0].trim().padStart(2, '0');
    const minute = parts[1].trim().slice(0, 2).padStart(2, '0');

    // Infer AM/PM
    let ampm = timeStr.toLowerCase().includes('pm') ? 'PM' : 'AM';
    let numericHour = parseInt(hour, 10);
    if (numericHour >= 12 && !timeStr.toLowerCase().includes('am')) ampm = 'PM';

    logger.log(`Parsed time: ${timeStr}`);

    // Store parsed in field object if needed by caller, but we are just filling here

    let verifiedCount = 0;
    let expectedNumericCount = field.inputs.filter(i => i.type !== 'ampm').length;

    for (const input of field.inputs) {
        const subEl = await page.$(input.selector);
        if (subEl) await page.waitForTimeout(200);

        if (input.type === 'hour') {
            await page.click(input.selector);
            await page.waitForTimeout(100);
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el.tagName === 'INPUT') el.value = '';
                else el.textContent = '';
            }, input.selector);
            await page.type(input.selector, hour, { delay: 150 });
            logger.log(`Filled hour: ${hour}`);
        } else if (input.type === 'minute') {
            await page.click(input.selector);
            await page.waitForTimeout(100);
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el.tagName === 'INPUT') el.value = '';
                else el.textContent = '';
            }, input.selector);
            await page.type(input.selector, minute, { delay: 150 });
            logger.log(`Filled minute: ${minute}`);
        } else if (input.type === 'ampm') {
            await page.click(input.selector);
            await page.waitForTimeout(500);
            const options = await page.$$('div[role="option"], .quantumWizMenuPapermsfMenuOption, [role="listbox"] div');
            let clickedAmpm = false;
            for (const opt of options) {
                const text = await opt.innerText();
                if (text.trim().toUpperCase() === ampm) {
                    await opt.click();
                    logger.log(`Selected AM/PM: ${ampm}`);
                    clickedAmpm = true;
                    break;
                }
            }
            if (!clickedAmpm) {
                await page.keyboard.type(ampm[0]);
                await page.keyboard.press('Enter');
                logger.log(`Selected AM/PM (Fallback): ${ampm}`);
            }
        }
    }

    // Verification
    for (const input of field.inputs) {
        if (input.type !== 'ampm') {
            const actualVal = await page.inputValue(input.selector);
            const expectedVal = input.type === 'hour' ? hour : minute;
            if (actualVal === expectedVal) {
                verifiedCount++;
            } else {
                logger.log(`Verification failed for ${input.type}: expected ${expectedVal}, got ${actualVal}`, 'WARN');
            }
        }
    }

    if (verifiedCount === expectedNumericCount) {
        return true;
    } else {
        throw new Error(`Failed to fill time field: ${field.label}`);
    }
}

async function selectRadio(page, field, userValue, logger) {
    logger.log(`Detected radio group: ${field.label}`);
    const match = findOptionMatch(field.options, userValue);

    if (match) {
        logger.log(`Matched option: "${match.label}". Base Selector: ${match.selector}`);

        // PRIORITY: Try to find the associated label at runtime.
        // This fixes cases where the input is hidden (display:none) and needs a label click.
        let clickSelector = match.selector;
        if (match.id) {
            const labelSelector = `label[for="${match.id}"]`;
            if (await page.$(labelSelector)) {
                clickSelector = labelSelector;
                logger.log(` - Using label selector: ${clickSelector}`);
            }
        }

        const elHandle = await page.$(clickSelector);
        if (elHandle) await elHandle.scrollIntoViewIfNeeded();

        // Perform Click
        try {
            await page.click(clickSelector, { force: true });
        } catch (e) {
            logger.log(`Standard click failed, trying evaluate click...`);
            await page.evaluate((s) => {
                const el = document.querySelector(s);
                if (el) el.click();
            }, clickSelector);
        }

        await page.waitForTimeout(300);

        // Verification
        const isChecked = await page.evaluate((args) => {
            const s = args.selector;
            const id = args.id;
            const el = document.querySelector(s);

            // If we clicked label, check linked input
            if (el && el.tagName === 'LABEL' && el.getAttribute('for')) {
                const inp = document.getElementById(el.getAttribute('for'));
                return inp && inp.checked;
            }
            // If we clicked input
            if (el && el.tagName === 'INPUT') return el.checked;

            // Check by ID if we have it
            if (id) {
                const inp = document.getElementById(id);
                return inp && inp.checked;
            }
            return false;
        }, { selector: clickSelector, id: match.id });

        if (isChecked) {
            return true;
        } else {
            logger.log(`Radio check verification failed. Trying backup click strategy (JS Click).`, 'WARN');

            // Backup 1: JavaScript Click on Label
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) el.click();
            }, clickSelector);

            await page.waitForTimeout(300);

            // Re-Verify
            const isCheckedRetry = await page.evaluate((args) => {
                const s = args.selector;
                const id = args.id;
                const el = document.querySelector(s);
                if (el && el.tagName === 'LABEL' && el.getAttribute('for')) {
                    const inp = document.getElementById(el.getAttribute('for'));
                    return inp && inp.checked;
                }
                if (el && el.tagName === 'INPUT') return el.checked;
                if (id) {
                    const inp = document.getElementById(id);
                    return inp && inp.checked;
                }
                return false;
            }, { selector: clickSelector, id: match.id });

            if (isCheckedRetry) {
                logger.log(` - Backup strategy success.`);
                return true;
            } else {
                throw new Error(`Failed to select radio "${field.label}" (option: "${userValue}") after multiple attempts.`);
            }
        }
    } else {
        throw new Error(`No matching option found for "${field.label}" with value "${userValue}"`);
    }
}

async function selectCheckbox(page, field, userValue, logger) {
    logger.log(`Detected checkbox group: ${field.label}`);
    const values = Array.isArray(userValue) ? userValue : [String(userValue)];

    for (const val of values) {
        const match = findOptionMatch(field.options, val);
        if (match) {
            // PRIORITY: Determine best selector (Label vs Input)
            let clickSelector = match.selector;
            let isLabel = false;

            if (match.id) {
                const labelSelector = `label[for="${match.id}"]`;
                if (await page.$(labelSelector)) {
                    clickSelector = labelSelector;
                    isLabel = true;
                }
            }

            logger.log(`Checking option: "${match.label}" using ${clickSelector}`);

            // Check if already checked to toggle? 
            // Usually we want to ensure 'checked'. Automation assumes unchecked or we just click.
            // But if it's already checked, clicking might uncheck it.
            // Let's check state first.
            const currentState = await page.evaluate((id) => {
                const el = document.getElementById(id);
                return el && el.checked;
            }, match.id);

            if (currentState) {
                logger.log(` - Already checked.`);
                continue;
            }

            await page.click(clickSelector, { force: true });
            await page.waitForTimeout(300);

            // Verify
            const isChecked = await page.evaluate((id) => {
                const el = document.getElementById(id);
                return el && el.checked;
            }, match.id);

            if (isChecked) {
                logger.log(` - Verified checked.`);
            } else {
                logger.log(` - Verification failed, trying backup click.`, 'WARN');
                await page.click(clickSelector, { force: true });
            }

        } else {
            throw new Error(`No matching checkbox found for "${field.label}" with value "${val}"`);
        }
    }
    return true;
}

async function selectDropdown(page, selector, field, userValue, logger) {
    const isListbox = await isGoogleListbox(page, selector);
    if (isListbox) {
        logger.log(`Opened dropdown: ${field.label}`);
        await page.click(selector);
        await page.waitForSelector('div[role="option"]', { state: 'visible', timeout: 3000 });
        const options = await page.$$eval('div[role="option"]', opts => opts.map(o => ({ text: o.innerText.trim() })));
        const targetText = String(userValue).trim().toLowerCase();
        const targetIdx = options.findIndex(o => o.text.toLowerCase() === targetText);
        if (targetIdx !== -1) {
            const optionEls = await page.$$('div[role="option"]');
            logger.log(`Clicked option: ${options[targetIdx].text}`);
            await optionEls[targetIdx].click();
            await page.waitForTimeout(500);
            return true;
        } else {
            throw new Error(`No matching option found for "${field.label}" with value "${userValue}"`);
        }
    } else {
        const isNative = await page.evaluate(s => document.querySelector(s).tagName === 'SELECT', selector);
        if (isNative) {
            const match = findOptionMatch(field.options, userValue);
            if (match) {
                await page.selectOption(selector, { index: field.options.indexOf(match) });
                return true;
            } else {
                throw new Error(`Invalid option ${userValue}`);
            }
        } else {
            // Generic
            await page.click(selector);
            await page.waitForTimeout(1000);
            await page.keyboard.type(String(userValue));
            await page.keyboard.press('Enter');
            return true;
        }
    }
}

async function fillEmail(page, selector, userValue, label, logger) {
    logger.log(`Detected EMAIL field: ${label}`);
    await page.click(selector);
    await page.fill(selector, '');
    await page.type(selector, String(userValue), { delay: 100 });
    await page.evaluate(s => document.querySelector(s).blur(), selector);

    const filledVal = await page.inputValue(selector);
    if (/\S+@\S+\.\S+/.test(filledVal) && filledVal === String(userValue)) {
        logger.log(`Verified email field is populated: ${filledVal}`);
        return true;
    } else {
        throw new Error(`Email validation failed: ${filledVal}`);
    }
}

async function fillPhone(page, selector, userValue, label, logger) {
    logger.log(`Detected PHONE field: ${label}`);
    await page.click(selector);
    await page.fill(selector, '');
    const phoneStr = String(userValue).replace(/\D/g, '');
    await page.type(selector, phoneStr, { delay: 100 });
    await page.evaluate(s => document.querySelector(s).blur(), selector);

    const filledVal = await page.inputValue(selector);
    const digits = filledVal.replace(/\D/g, '');
    if (digits.length >= 10) {
        logger.log(`Verified phone field length = ${digits.length}`);
        return true;
    } else {
        throw new Error(`Phone verification failed: length ${digits.length} < 10`);
    }
}

async function fillStandard(page, selector, userValue, logger) {
    await page.fill(selector, '');
    await page.type(selector, String(userValue), { delay: 100 });
    await page.press(selector, 'Tab');
    return true;
}

module.exports = {
    findOptionMatch,
    uploadFile,
    fillAutocomplete,
    fillDate,
    selectReactSelect,
    fillTimeGroup,
    selectRadio,
    selectCheckbox,
    selectDropdown,
    fillEmail,
    fillPhone,
    fillStandard
};
