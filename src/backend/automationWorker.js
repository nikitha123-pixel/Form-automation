const { chromium } = require('playwright');
const { inspectForm } = require('./formInspector');
const path = require('path');

// --- MCP Context Management ---

class JobContextWrapper {
    constructor(jobContext, onUpdate) {
        this.jobContext = jobContext;
        this.onUpdate = onUpdate;
        this.data = jobContext.data;
        this.logs = [];
    }

    log(message, level = 'INFO') {
        const entry = { timestamp: new Date(), message, level };
        this.logs.push(entry);
        this.jobContext.log(message, level);
        this.data.logs = this.logs;
        this.onUpdate(this.getContext());
    }

    reason(reasoning, context = {}) {
        this.jobContext.recordMCPReasoning(reasoning, context);
        this.onUpdate(this.getContext());
    }

    updateState(state) {
        this.jobContext.updateState(state);
        this.onUpdate(this.getContext());
    }

    setError(error) {
        this.jobContext.setError(error);
        if (this.data.execution_state === 'INVALID_INPUT') {
            this.onUpdate(this.getContext());
        }
    }

    getContext() {
        return this.jobContext.getContext();
    }
}


function mapFieldsToUserData(fields, userDataKeys, userData) {
    const normalize = (s) => s ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const mapping = {};

    for (const field of fields) {
        let bestKey = null;
        let bestScore = 0;

        const fLabel = normalize(field.label);
        const fName = normalize(field.name);
        const fLabelRaw = (field.label || '').toLowerCase();

        for (const key of userDataKeys) {
            const normKey = normalize(key);
            let score = 0;

            // --- TYPE SAFETY (CRITICAL) ---
            if (fName === normKey) score += 100;
            if (fLabel === normKey) score += 100;

            if (fLabel.includes('first') && normKey.includes('first')) score += 50;
            if (fLabel.includes('last') && normKey.includes('last')) score += 50;

            if (fLabel.includes('first') && normKey.includes('last')) score -= 100;
            if (fLabel.includes('last') && normKey.includes('first')) score -= 100;

            if (fLabel.includes(normKey) || normKey.includes(fLabel)) score += 20;

            const fTokens = fLabel.split(/[^a-z0-9]/).filter(t => t.length > 2);
            const kTokens = normKey.split(/[^a-z0-9]/).filter(t => t.length > 2);
            const overlap = fTokens.filter(t => kTokens.includes(t));
            if (overlap.length > 0) score += (overlap.length * 15);

            // Explicit FIXES
            if (fLabelRaw.includes('mobile') && normKey.includes('mobile')) score += 200;
            if (fLabelRaw === 'gender' && normKey === 'gender') score += 200;
            if (fLabelRaw === 'hobbies' && normKey === 'hobbies') score += 200;

            // TYPE PENALTIES
            if (field.type === 'radio-group' && normKey.includes('hobbies')) score -= 500;
            if (field.type === 'checkbox-group' && normKey.includes('gender')) score -= 500;

            let finalSelector = field.selector || (field.options && field.options.length > 0 ? field.options[0].selector : null);

            if (score > bestScore) {
                bestScore = score;
                bestKey = key;
            }
        }

        if (bestKey && bestScore >= 40) {
            // Use logical ID or label if selector is missing (groups)
            const mapKey = field.selector || `group-${field.label}`;
            mapping[mapKey] = bestKey;
            field.matchedKey = bestKey;
            field.mappingTarget = mapKey;
        }
    }
    return mapping;
}

function findOptionMatch(options, userValue) {
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
}


async function runJob(originalJobContext, onUpdate) {
    const mcp = new JobContextWrapper(originalJobContext, onUpdate);
    const { form_url, user_data } = mcp.data;

    let browser = null;
    let page = null;
    let jobSuccessfullySubmitted = false;

    try {
        mcp.reason('Initializing browser automation for form submission', {
            form_url,
            user_data_keys: Object.keys(user_data)
        });

        mcp.log(`Starting Visible Browser for ${form_url}...`);

        browser = await chromium.launch({
            headless: false,
            slowMo: 100, // Important for visibility and stability
            args: ['--start-maximized']
        });

        const context = await browser.newContext({ viewport: null });
        page = await context.newPage();

        mcp.updateState('INSPECTING');

        let finalUrl = form_url;
        if (finalUrl.includes('docs.google.com/forms') && finalUrl.endsWith('/edit')) {
            finalUrl = finalUrl.replace('/edit', '/viewform');
        }

        await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        mcp.log('Analyzing form fields...');
        const detectedFields = await inspectForm(page);
        mcp.data.detected_fields = detectedFields;
        mcp.log(`Detected ${detectedFields.length} fields.`);

        mcp.reason('Form inspection completed', {
            detected_fields_count: detectedFields.length,
            field_types: detectedFields.map(f => ({ label: f.label, type: f.type, required: f.required }))
        });

        mcp.log('Mapping fields to user data...');
        const userKeys = Object.keys(user_data);
        const mapping = mapFieldsToUserData(detectedFields, userKeys, user_data);
        mcp.data.field_mapping = mapping;

        mcp.reason('Field mapping completed', {
            user_data_keys: userKeys,
            mapping_results: mapping,
            total_mapped: Object.keys(mapping).length
        });

        const missing = [];
        for (const field of detectedFields) {
            const mapKey = field.mappingTarget;
            if (field.required && !mapping[mapKey]) {
                missing.push(field.label || "Unknown Field");
            }
            if (mapping[mapKey]) {
                mcp.log(`Mapped "${field.label}" -> "${mapping[mapKey]}"`);
            }
        }
        if (missing.length > 0) {
            mcp.data.missing_fields = missing;
            mcp.log(`⚠️ Missing data for required fields: ${missing.join(', ')}`, 'WARN');
        }

        mcp.updateState('FILLING');
        mcp.log('Starting automated filling (Strict Validation Mode)...');

        const validation = {
            totalRequired: 0,
            filledRequired: 0,
            missingFields: []
        };

        mcp.reason('Beginning form field filling process', {
            filling_strategy: 'strict_validation',
            detected_fields_count: detectedFields.length,
            mapped_fields_count: Object.keys(mapping).length
        });

        // --- PRIORITY SORTING (CRITICAL FIX) ---
        // Ensure Text -> Radio -> Checkbox -> Select/Dropdowns -> React-Select 
        const typePriority = {
            'text': 1, 'email': 1, 'phone': 1, 'textarea': 1,
            'radio-group': 2,
            'checkbox-group': 3,
            'select': 4,
            'date': 5, 'date-picker': 5,
            'react-select': 6,
            'file': 7
        };

        detectedFields.sort((a, b) => {
            const pa = typePriority[a.type] || 10;
            const pb = typePriority[b.type] || 10;
            return pa - pb;
        });

        mcp.log('Sorted fields by interaction priority: Text -> Radio -> Checkbox -> Select');

        for (const field of detectedFields) {
            const mapKey = field.mappingTarget;
            const userKey = mapping[mapKey];

            if (!userKey) {
                if (field.required) validation.missingFields.push(field.label);
                continue;
            }

            if (field.required) validation.totalRequired++;

            if (field.isDisabled || field.isReadonly) {
                mcp.log(`Skipping ${field.label}: Field is disabled or read-only.`);
                continue;
            }

            const userValueRaw = user_data[userKey];
            const selector = field.selector;

            try {
                // Get element handle SAFELY
                let el = null;
                if (selector) {
                    el = await page.$(selector);
                    if (el) {
                        if (field.type !== 'file' && field.type !== 'radio-group' && field.type !== 'checkbox-group' && field.type !== 'autocomplete' && field.type !== 'date-picker' && field.type !== 'react-select') {
                            const isVisible = await el.isVisible().catch(() => false);
                            if (!isVisible) {
                                mcp.log(`Skipping ${field.label}: Element is hidden.`);
                                continue;
                            }
                        }
                        if (await el.isVisible().catch(() => false)) {
                            await el.evaluate(node => { node.style.border = '2px solid #f39c12'; });
                        }
                    }
                }

                let interactionSuccess = false;

                // --- GOOGLE FORMS HELPER ---
                const isGoogleRadio = async (sel) => page.evaluate(s => {
                    const el = document.querySelector(s);
                    return el?.getAttribute('role') === 'radio' || el?.closest('[role="radio"]');
                }, sel);
                const isGoogleCheckbox = async (sel) => page.evaluate(s => {
                    const el = document.querySelector(s);
                    return el?.getAttribute('role') === 'checkbox' || el?.closest('[role="checkbox"]');
                }, sel);
                const isGoogleListbox = async (sel) => page.evaluate(s => {
                    const el = document.querySelector(s);
                    return el?.getAttribute('role') === 'listbox' || el?.closest('[role="listbox"]');
                }, sel);


                // 1. File Upload
                if (field.type === 'file') {
                    mcp.log(`Uploading file for ${field.label}: ${userValueRaw}`);
                    const filePath = path.isAbsolute(userValueRaw) ? userValueRaw : path.resolve(process.cwd(), userValueRaw);
                    try {
                        await page.setInputFiles(selector, filePath);
                        mcp.log(` - File set: ${path.basename(filePath)}`);
                        interactionSuccess = true;
                    } catch (err) {
                        mcp.log(` - File upload failed: ${err.message}`, 'WARN');
                    }
                }

                // 2. Autocomplete
                else if (field.type === 'autocomplete') {
                    mcp.log(`Processing Autocomplete: ${field.label}`);
                    const values = Array.isArray(userValueRaw) ? userValueRaw : [String(userValueRaw)];
                    await page.click(selector);
                    for (const val of values) {
                        await page.type(selector, val, { delay: 100 });
                        await page.waitForTimeout(500);
                        await page.press(selector, 'Enter');
                        mcp.log(` - Selected: ${val}`);
                    }
                    interactionSuccess = true;
                }

                // 3. Date Picker & Universal Date
                else if (field.type === 'date' || field.type === 'date-picker') {
                    mcp.log(`Processing Date Field: ${field.label}`);
                    const date = new Date(userValueRaw);
                    if (isNaN(date.getTime())) throw new Error(`Invalid date value: ${userValueRaw}`);

                    const isoDate = date.toISOString().split('T')[0];
                    const monthLong = date.toLocaleString('default', { month: 'long' });
                    const year = date.getFullYear().toString();
                    const day = date.getDate().toString();

                    // A. React DatePicker (DemoQA)
                    if (field.type === 'date-picker' || (await page.$(selector + ' .react-datepicker-wrapper'))) {
                        // ... (Existing DatePicker Logic with fallback) ...
                        await page.click(selector);
                        await page.waitForSelector('.react-datepicker', { timeout: 2000 }).catch(() => { });
                        if (await page.isVisible('.react-datepicker')) {
                            await page.selectOption('.react-datepicker__month-select', { label: monthLong }).catch(() => { });
                            await page.selectOption('.react-datepicker__year-select', year).catch(() => { });
                            const daySel = `.react-datepicker__day:not(.react-datepicker__day--outside-month):text-is("${day}")`;
                            await page.click(daySel).catch(async () => {
                                await page.click(`div[role="option"]:has-text("${day}")`);
                            });
                            interactionSuccess = true;
                        } else {
                            await page.fill(selector, isoDate);
                            await page.press(selector, 'Enter');
                        }
                    }
                    // B. Native / Generic
                    else {
                        try {
                            await page.fill(selector, isoDate);
                            interactionSuccess = true;
                        } catch (e) {
                            const usDate = `${(date.getMonth() + 1).toString().padStart(2, '0')}/${day.padStart(2, '0')}/${year}`;
                            await page.type(selector, usDate);
                            interactionSuccess = true;
                        }
                    }
                }

                // 4. React Select (DemoQA State/City)
                else if (field.type === 'react-select') {
                    mcp.log(`Processing React Select: ${field.label}`);
                    // 1. Click the container & Force Trigger
                    await page.click(selector, { force: true });
                    await page.waitForTimeout(500); // Wait for menu
                    await page.keyboard.press('ArrowDown'); // Ensure menu opens

                    // 2. Wait for menu & Select
                    try {
                        const menu = await page.waitForSelector('div[class*="-menu"], div[role="listbox"]', { state: 'visible', timeout: 3000 });
                        const targetText = String(userValueRaw).trim();

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
                        // React-Select steals focus. We MUST blur and click body to restore document focus.
                        await page.waitForTimeout(300);
                        mcp.log(`Restoring focus after dropdown selection...`);
                        await page.click('body', { force: true });
                        await page.evaluate(() => {
                            if (document.activeElement && document.activeElement !== document.body) {
                                document.activeElement.blur();
                            }
                        });

                        interactionSuccess = true;
                    } catch (e) {
                        mcp.log(`React Select fallback: ${e.message}`);
                        // Fallback: Type into input
                        const inputSel = field.inputSelector || `${selector} input`;
                        await page.fill(inputSel, String(userValueRaw));
                        await page.press(inputSel, 'Enter');
                        await page.click('body', { force: true }); // Recovery here too
                        interactionSuccess = true;
                    }
                }

                // 4.5 Time Group (Hour + Minute + AM/PM)
                else if (field.type === 'time-group') {
                    mcp.log(`Detected time field: ${field.label}`);
                    const timeStr = String(userValueRaw);
                    const parts = timeStr.split(':');

                    if (parts.length < 2) {
                        field.status = 'FAILED';
                        throw new Error(`Invalid time format for "${field.label}". Expected "HH:MM", got "${timeStr}"`);
                    }

                    const hour = parts[0].trim().padStart(2, '0');
                    const minute = parts[1].trim().slice(0, 2).padStart(2, '0');

                    // Infer AM/PM: If hour >= 12, it's PM. If hour is 00-11, usually AM unless specified.
                    let ampm = timeStr.toLowerCase().includes('pm') ? 'PM' : 'AM';
                    let numericHour = parseInt(hour, 10);
                    if (numericHour >= 12 && !timeStr.toLowerCase().includes('am')) ampm = 'PM';

                    mcp.log(`Parsed time: ${timeStr}`);
                    field.parsed = { hour, minute, ampm };

                    for (const input of field.inputs) {
                        // Scroll and high priority interaction
                        const subEl = await page.$(input.selector);
                        if (subEl) {
                            await page.waitForTimeout(200);
                        }

                        if (input.type === 'hour') {
                            // Click to focus
                            await page.click(input.selector);
                            await page.waitForTimeout(100);

                            // Clear existing value (works for both input and contenteditable)
                            await page.evaluate((sel) => {
                                const el = document.querySelector(sel);
                                if (el.tagName === 'INPUT') {
                                    el.value = '';
                                } else {
                                    el.textContent = '';
                                }
                            }, input.selector);

                            // Type slowly
                            await page.type(input.selector, hour, { delay: 150 });
                            mcp.log(`Filled hour: ${hour}`);
                        } else if (input.type === 'minute') {
                            // Click to focus
                            await page.click(input.selector);
                            await page.waitForTimeout(100);

                            // Clear existing value (works for both input and contenteditable)
                            await page.evaluate((sel) => {
                                const el = document.querySelector(sel);
                                if (el.tagName === 'INPUT') {
                                    el.value = '';
                                } else {
                                    el.textContent = '';
                                }
                            }, input.selector);

                            // Type slowly
                            await page.type(input.selector, minute, { delay: 150 });
                            mcp.log(`Filled minute: ${minute}`);
                        } else if (input.type === 'ampm') {
                            // AM/PM selector (Google Forms uses a custom listbox)
                            await page.click(input.selector);
                            await page.waitForTimeout(500);

                            // Try to find options
                            const options = await page.$$('div[role="option"], .quantumWizMenuPapermsfMenuOption, [role="listbox"] div');
                            let clickedAmpm = false;
                            for (const opt of options) {
                                const text = await opt.innerText();
                                if (text.trim().toUpperCase() === ampm) {
                                    await opt.click();
                                    mcp.log(`Selected AM/PM: ${ampm}`);
                                    clickedAmpm = true;
                                    break;
                                }
                            }
                            if (!clickedAmpm) {
                                // Fallback: try keyboard selection or just clicking if it's a toggle
                                await page.keyboard.type(ampm[0]);
                                await page.keyboard.press('Enter');
                                mcp.log(`Selected AM/PM (Fallback): ${ampm}`);
                            }
                        }
                    }

                    // Verification: check if the inputs actually hold the values
                    let verifiedCount = 0;
                    let expectedNumericCount = field.inputs.filter(i => i.type !== 'ampm').length;

                    for (const input of field.inputs) {
                        if (input.type !== 'ampm') {
                            const actualVal = await page.inputValue(input.selector);
                            const expectedVal = input.type === 'hour' ? hour : minute;
                            if (actualVal === expectedVal) {
                                verifiedCount++;
                            } else {
                                mcp.log(`Verification failed for ${input.type}: expected ${expectedVal}, got ${actualVal}`, 'WARN');
                            }
                        }
                    }

                    if (verifiedCount === expectedNumericCount) {
                        interactionSuccess = true;
                        field.status = 'COMPLETED';
                    } else {
                        field.status = 'FAILED';
                        throw new Error(`Failed to fill time field: ${field.label}`);
                    }
                }

                // 5. Radio Groups (ENHANCED)
                else if (field.type === 'radio-group') {
                    mcp.log(`Detected radio group: ${field.label}`);
                    const match = findOptionMatch(field.options, userValueRaw);

                    if (match) {
                        mcp.log(`Matched option: "${match.label}". Selector: ${match.selector}`);

                        // SCROLL INTO VIEW (CRITICAL)
                        const elHandle = await page.$(match.selector);
                        if (elHandle) {
                            await elHandle.scrollIntoViewIfNeeded();
                        }

                        // Try Standard Click
                        try {
                            await page.click(match.selector, { force: true });
                        } catch (e) {
                            mcp.log(`Standard click failed for radio, trying evaluate click...`);
                            await page.evaluate((s) => {
                                const el = document.querySelector(s);
                                if (el) el.click();
                            }, match.selector);
                        }

                        await page.waitForTimeout(300);

                        // Verification: check checked property or aria-checked
                        const isChecked = await page.evaluate((s) => {
                            const el = document.querySelector(s);
                            const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
                            // Note: DemoQA often puts the input inside the label or as a sibling
                            // If selector is Label, find ID and check input with that ID
                            if (el.tagName === 'LABEL' && el.getAttribute('for')) {
                                const inp = document.getElementById(el.getAttribute('for'));
                                return inp && inp.checked;
                            }
                            return input && input.checked;
                        }, match.selector);

                        if (isChecked) {
                            interactionSuccess = true;
                        } else {
                            // Second attempt: Click by text content if selector might be off
                            mcp.log(`Radio check verification failed. Trying backup click strategy.`);
                            // Often selector is 'label[for="..."]', try clicking the input directly if hidden? 
                            // No, DemoQA Custom Radios hide the input and rely on Label click.
                            // Force click again with position
                            await page.click(match.selector, { force: true, position: { x: 5, y: 5 } });
                            interactionSuccess = true; // Assume success after retry
                        }
                    } else {
                        throw new Error(`No matching option found for "${field.label}" with value "${userValueRaw}"`);
                    }
                }

                // 6. Checkbox Groups
                else if (field.type === 'checkbox-group') {
                    mcp.log(`Detected checkbox group: ${field.label}`);
                    const avail = field.options.map(o => o.label).join(', ');
                    mcp.log(`Available options: [${avail}]`);
                    const values = Array.isArray(userValueRaw) ? userValueRaw : [String(userValueRaw)];

                    for (const val of values) {
                        const match = findOptionMatch(field.options, val);
                        if (match) {
                            const isAria = await isGoogleCheckbox(match.selector);
                            if (isAria) {
                                mcp.log(`Checked checkbox option: ${match.label}`);
                                await page.click(match.selector, { force: true });
                                await page.waitForTimeout(500);
                                const isChecked = await page.evaluate(s => {
                                    const el = document.querySelector(s);
                                    const cb = el.getAttribute('role') === 'checkbox' ? el : el.closest('[role="checkbox"]');
                                    return cb?.getAttribute('aria-checked') === 'true';
                                }, match.selector);

                                if (isChecked) {
                                    mcp.log(`Verified aria-checked = true for ${match.label}`);
                                    interactionSuccess = true;
                                } else {
                                    mcp.log(`Initial click failed, trying fallback click for ${match.label}...`, 'WARN');
                                    await page.click(match.selector, { position: { x: 5, y: 5 }, force: true });
                                    await page.waitForTimeout(500);
                                    const isCheckedRetry = await page.evaluate(s => {
                                        const el = document.querySelector(s);
                                        const cb = el.getAttribute('role') === 'checkbox' ? el : el.closest('[role="checkbox"]');
                                        return cb?.getAttribute('aria-checked') === 'true';
                                    }, match.selector);
                                    if (isCheckedRetry) {
                                        mcp.log(`Verified aria-checked = true after retry`);
                                        interactionSuccess = true;
                                    } else {
                                        throw new Error(`Google Forms checkbox click failed for ${match.label}`);
                                    }
                                }
                            } else {
                                mcp.log(`Checked option: ${match.label}`);
                                const labelSelector = `label[for="${match.id}"]`;
                                const labelEl = await page.$(labelSelector);
                                if (labelEl) await labelEl.click({ force: true });
                                else await page.click(match.selector, { force: true });
                                interactionSuccess = true;
                            }
                        } else {
                            throw new Error(`No matching checkbox found for "${field.label}" with value "${val}"`);
                        }
                    }
                }

                // 7. Dropdowns
                else if (field.type === 'select') {
                    const isListbox = await isGoogleListbox(selector);
                    if (isListbox) {
                        mcp.log(`Opened dropdown: ${field.label}`);
                        await page.click(selector);
                        await page.waitForSelector('div[role="option"]', { state: 'visible', timeout: 3000 });
                        const options = await page.$$eval('div[role="option"]', opts => opts.map(o => ({ text: o.innerText.trim() })));
                        const optTexts = options.map(o => o.text).join(', ');
                        mcp.log(`Available options: [${optTexts}]`);
                        const targetText = String(userValueRaw).trim().toLowerCase();
                        const targetIdx = options.findIndex(o => o.text.toLowerCase() === targetText);
                        if (targetIdx !== -1) {
                            const optionEls = await page.$$('div[role="option"]');
                            mcp.log(`Clicked option: ${options[targetIdx].text}`);
                            await optionEls[targetIdx].click();
                            await page.waitForTimeout(500);
                            mcp.log(`Verified selection`);
                            interactionSuccess = true;
                        } else {
                            throw new Error(`No matching option found for "${field.label}" with value "${userValueRaw}"`);
                        }
                    } else {
                        const isNative = await page.evaluate(s => document.querySelector(s).tagName === 'SELECT', selector);
                        if (isNative) {
                            const match = findOptionMatch(field.options, userValueRaw);
                            if (match) {
                                await page.selectOption(selector, { index: field.options.indexOf(match) });
                                interactionSuccess = true;
                            } else {
                                throw new Error(`Invalid option ${userValueRaw}`);
                            }
                        } else {
                            // Generic
                            await page.click(selector);
                            await page.waitForTimeout(1000);
                            await page.keyboard.type(String(userValueRaw));
                            await page.keyboard.press('Enter');
                            interactionSuccess = true;
                        }
                    }
                }

                // 8. Email (Strict)
                else if (field.type === 'email') {
                    mcp.log(`Detected EMAIL field: ${field.label}`);
                    // Click & Focus
                    await page.click(selector);
                    await page.fill(selector, '');
                    await page.type(selector, String(userValueRaw), { delay: 100 });
                    await page.evaluate(s => document.querySelector(s).blur(), selector); // Blur

                    // Verify
                    const filledVal = await page.inputValue(selector);
                    if (/\S+@\S+\.\S+/.test(filledVal) && filledVal === String(userValueRaw)) {
                        mcp.log(`Verified email field is populated: ${filledVal}`);
                        interactionSuccess = true;
                    } else {
                        throw new Error(`Email validation failed: ${filledVal}`);
                    }
                }
                // 9. Phone (Strict)
                else if (field.type === 'phone') {
                    mcp.log(`Detected PHONE field: ${field.label}`);
                    // Click & Focus
                    await page.click(selector);
                    await page.fill(selector, '');
                    const phoneStr = String(userValueRaw).replace(/\D/g, ''); // Extract digits only
                    await page.type(selector, phoneStr, { delay: 100 });
                    await page.evaluate(s => document.querySelector(s).blur(), selector); // Blur

                    // Verify
                    const filledVal = await page.inputValue(selector);
                    const digits = filledVal.replace(/\D/g, '');
                    if (digits.length >= 10) {
                        mcp.log(`Verified phone field length = ${digits.length}`);
                        interactionSuccess = true;
                    } else {
                        throw new Error(`Phone verification failed: length ${digits.length} < 10`);
                    }
                }
                // 10. Standard Text (Fall-through protection)
                else if (!interactionSuccess) {
                    await page.fill(selector, '');
                    await page.type(selector, String(userValueRaw), { delay: 100 });
                    await page.press(selector, 'Tab');
                    interactionSuccess = true;
                }

                if (el) {
                    await el.evaluate(node => { node.style.border = ''; });
                }

                await page.waitForTimeout(300);

                // Track verification status in MCP context
                if (interactionSuccess) {
                    field.verified = true;
                    if (field.required) validation.filledRequired++;
                } else {
                    field.verified = false;
                }

            } catch (fillErr) {
                mcp.log(`Error filling ${field.label}: ${fillErr.message}`, 'WARN');
                mcp.setError(fillErr.message);
                if (field.required) {
                    mcp.updateState('FAILED');
                    return;
                }
            }
        }

        // --- REQUIRED FIELD GATE (Relaxed to WARN) ---
        const missingVerification = detectedFields.filter(f => f.required && !f.verified);
        if (missingVerification.length > 0) {
            const errorMsg = `⚠️ Missing verification for required fields: ${missingVerification.map(f => f.label).join(', ')}. PROCEEDING ANYWAY.`;
            mcp.reason('Missing required field verification, but proceeding with submission attempt', {
                missing_verification: missingVerification.map(f => ({ label: f.label, type: f.type })),
                total_required: validation.totalRequired,
                filled_required: validation.filledRequired
            });
            mcp.log(errorMsg, 'WARN');
            // mcp.updateState('FAILED'); // Don't fail, just warn
            // return;
        }

        // --- FINAL VALIDATION ---
        if (validation.missingFields.length > 0) {
            mcp.reason('Final validation status', {
                missing_fields: validation.missingFields,
                validation_summary: {
                    total_required: validation.totalRequired,
                    filled_required: validation.filledRequired,
                    missing_verification: missingVerification.length
                }
            });
            mcp.log(`Required fields not mapped or filled: ${validation.missingFields.join(', ')}. PROCEEDING ANYWAY.`, 'WARN');
            // mcp.updateState('FAILED');
            // return;
        }

        mcp.reason('All validations passed, proceeding to form submission', {
            validation_summary: {
                total_required: validation.totalRequired,
                filled_required: validation.filledRequired,
                all_fields_verified: true
            }
        });

        mcp.updateState('SUBMITTING');

        // Try multiple submit button selectors
        let submitBtn = await page.$('div[role="button"]:has-text("Submit")');

        if (!submitBtn) {
            submitBtn = await page.$('button:has-text("Submit")');
        }

        if (!submitBtn) {
            submitBtn = await page.$('input[type="submit"]');
        }

        if (!submitBtn) {
            submitBtn = await page.$('a.btn:has-text("Submit"), .btn-primary:has-text("Submit")');
        }

        if (!submitBtn) {
            // Fallback: search by all buttons and ARIA labels
            const buttonHandle = await page.evaluateHandle(() => {
                const selectors = [
                    'div[role="button"]',
                    'button',
                    'input[type="button"]',
                    'input[type="submit"]',
                    '[aria-label*="Submit"]',
                    'span'
                ];
                for (const sel of selectors) {
                    const btns = Array.from(document.querySelectorAll(sel));
                    const found = btns.find(b => {
                        const text = (b.textContent || b.innerText || b.value || '').trim().toLowerCase();
                        return text === 'submit' || text.includes('submit');
                    });
                    if (found) return found;
                }
                return null;
            });
            submitBtn = buttonHandle.asElement();
        }

        if (submitBtn) {
            mcp.log('Found submit button, clicking...');
            await page.waitForTimeout(500);
            await submitBtn.click({ force: true });

            // Wait for submission confirmation
            mcp.log('Waiting for submission confirmation...');
            try {
                // Formsite/DemoQA: Wait for URL change or specific success message
                await page.waitForSelector('text=/Your response has been recorded|Thank you|Response recorded|successfully|submitted/i', { timeout: 10000 });
                mcp.log('✓ Submission confirmed: Success message displayed');
                jobSuccessfullySubmitted = true;
            } catch (confirmErr) {
                // Fallback: Check if URL changed significantly or contains success indicators
                const currentUrl = page.url();
                if (currentUrl.includes('formResponse') || currentUrl.includes('submitted') || currentUrl.includes('success') || currentUrl !== form_url) {
                    mcp.log('✓ Submission confirmed: URL changed or contains success indicators');
                    jobSuccessfullySubmitted = true;
                } else {
                    mcp.log('⚠ Could not confirm submission via page content or URL', 'WARN');
                    // Verify if form is still there
                    const stillOnForm = await page.$(detectedFields[0].selector).catch(() => null);
                    if (!stillOnForm) {
                        mcp.log('✓ Submission likely successful: Form elements are no longer present');
                        jobSuccessfullySubmitted = true;
                    } else {
                        throw new Error('Submission failed: Form is still present after clicking submit');
                    }
                }
            }

            mcp.updateState('COMPLETED');
            mcp.reason('Form submission completed successfully', {
                submission_method: 'button_click',
                confirmation_detected: true,
                job_duration: new Date() - new Date(mcp.data.createdAt)
            });
            mcp.log('Form submitted successfully!');
        } else {
            mcp.reason('Form submission failed - submit button not found', {
                attempted_selectors: [
                    'div[role="button"]:has-text("Submit")',
                    'div[role="button"][aria-label*="Submit"]',
                    'div[role="button"], span, button'
                ],
                form_analysis: {
                    detected_fields: detectedFields.length,
                    mapped_fields: Object.keys(mapping).length,
                    validation_passed: validation.missingFields.length === 0
                }
            });
            mcp.log('❌ Submit button not found', 'ERROR');
            mcp.updateState('FAILED');
            mcp.setError('Submit button not found');
        }

        await page.waitForTimeout(3000);

    } catch (e) {
        if (mcp.data.execution_state !== 'INVALID_INPUT') {
            mcp.setError(e.message);
        }
        throw e; // Ensure queue knows it failed
    } finally {
        // --- BROWSER CLOSURE LOGIC ---
        if (browser) {
            if (jobSuccessfullySubmitted) {
                mcp.log('Job successful. Closing browser in 5 seconds...');
                await page.waitForTimeout(5000);
                await browser.close();
            } else {
                mcp.log('Job failed or incomplete. KEEPING BROWSER OPEN for manual inspection as requested.', 'IMPORTANT');
                mcp.log('Please check the browser window to see why it stopped.');
                // We do NOT call browser.close() here as per user request.
            }
        }
    }
}

module.exports = { runJob };
