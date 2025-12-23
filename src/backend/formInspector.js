/**
 * Form Inspector
 * 
 * Analyzes the DOM to identify input fields, capable of:
 * 1. Visual/Grid Label Detection.
 * 2. Google Forms specific structure detection.
 * 3. Grouping Radio/Checkbox inputs.
 * 4. Robust Label Resolution (ARIA, For, Proximity).
 * 5. DemoQA / React Custom Components (Autocomplete, DatePicker, React Select).
 */

async function inspectForm(page) {
    try {
        // Wait for any standard input or Google Forms specific container
        await page.waitForSelector('input:not([type="hidden"]), textarea, select, [role="checkbox"], [role="radio"], [role="listbox"], [role="combobox"], [jsname="o699le"], .quantumWizBoxPaper', { timeout: 15000 });
        await page.waitForTimeout(1000); // Small extra buffer for animations
    } catch (e) {
        console.warn('Timeout waiting for form elements, proceeding anyway...');
    }

    const fields = await page.evaluate(() => {
        // Helper: Clean text
        const clean = (s) => s ? s.innerText.trim().replace(/\s+/g, ' ') : '';

        // Helper: Get text from element or its children
        const getText = (el) => clean(el);

        const detectedMap = new Map();

        // --- STRATEGY 0: GOOGLE FORMS SPECIFIC (QUESTION-FIRST) ---
        // Google Forms uses a consistent structure: div[role="listitem"] per question
        const googleQuestions = document.querySelectorAll('div[role="listitem"]');

        googleQuestions.forEach((q, index) => {
            const heading = q.querySelector('div[role="heading"]');
            let labelText = clean(heading);
            // Remove * (Required) from label
            labelText = labelText.replace(/^[\*\s]+|[\*\s]+$/g, '').replace(/\s*\(Required\)$/i, '').trim();
            const isRequired = !!q.querySelector('span[aria-label*="Required"]');

            // ROBUST BASE SELECTOR
            // CSS is 1-based, so index + 1
            const baseSelector = `div[role="listitem"]:nth-of-type(${index + 1})`;

            // Determine Field Type by inspecting contents
            let fieldType = 'text'; // default
            let options = [];
            let selector = null;

            // 1. Radio
            if (q.querySelector('div[role="radio"]')) {
                fieldType = 'radio-group';
                const radios = Array.from(q.querySelectorAll('div[role="radio"]'));
                radios.forEach(r => {
                    const val = r.getAttribute('data-value') || r.getAttribute('aria-label') || clean(r);
                    // For Google Forms, we need the clickable container or the radio itself
                    // We'll trust the worker to find the right element to click based on the specific attributes
                    options.push({
                        id: r.id,
                        value: val,
                        label: val,
                        selector: generateSelector(r) // Keep generic for specific option clicks for now
                    });
                });
                selector = baseSelector; // Group selector is the listitem
            }
            // 2. Checkbox
            else if (q.querySelector('div[role="checkbox"]')) {
                fieldType = 'checkbox-group';
                const checks = Array.from(q.querySelectorAll('div[role="checkbox"]'));
                checks.forEach(c => {
                    const val = c.getAttribute('data-value') || c.getAttribute('aria-label') || clean(c);
                    options.push({
                        id: c.id,
                        value: val,
                        label: val,
                        selector: generateSelector(c)
                    });
                });
                selector = baseSelector;
            }
            // 3. Dropdown (Listbox)
            else if (q.querySelector('div[role="listbox"]')) {
                fieldType = 'select'; // Treated as select, but handled as custom listbox
                selector = `${baseSelector} div[role="listbox"]`;
                // Options are often loaded dynamically, so strictly we might not see them yet.
                // We'll rely on the worker to open and find options.
            }
            // 4. Text / Textarea
            else {
                // Short answer
                const textInput = q.querySelector('input:not([type="hidden"])');
                const textarea = q.querySelector('textarea');
                const contentEditable = q.querySelector('[contenteditable="true"]');

                if (textInput) {
                    // Check if it's Date or Time
                    if (textInput.type === 'date') fieldType = 'date';
                    else if (textInput.type === 'time') fieldType = 'time-group'; // simple mapping
                    else fieldType = 'text';

                    // ROBUST SELECTOR GENERATION FOR GOOGLE FORMS
                    // Use index-based selector to guarantee uniqueness
                    selector = `${baseSelector} input:not([type="hidden"])`;
                } else if (textarea) {
                    fieldType = 'textarea';
                    selector = `${baseSelector} textarea`;
                } else if (contentEditable) {
                    fieldType = 'text';
                    selector = `${baseSelector} [contenteditable="true"]`;
                }
            }

            // Heuristics for Email/Phone/Date/Time based on Label
            const lowerLabel = labelText.toLowerCase();
            if (lowerLabel.includes('email')) fieldType = 'email';
            else if (lowerLabel.includes('phone') || lowerLabel.includes('mobile')) fieldType = 'phone';
            else if (lowerLabel.includes('date') && fieldType === 'text') fieldType = 'date'; // generic date text
            // Time is tricky, often it's split. Google Forms usually has specific attributes we caught above? 
            // If not, our previous logic for Time Groups will catch it in the general scan if we miss it here.
            // But usually Google Forms Time is a structured container.

            // Special: Date with multiple inputs (Google Forms often uses one hidden input + styled divs, or native date)
            // If we see 'date' in label but no simple input, check for the specific date structure
            if (q.querySelector('div[jscontroller][data-initial-value]')) { // Generic data controller
                // refine types...
            }

            if (labelText && selector) {
                detectedMap.set(labelText, {
                    type: fieldType,
                    label: labelText,
                    required: isRequired,
                    selector: selector,
                    options: options,
                    verified: false
                });
            }
        });

        // --- STRATEGY 0.5: GENERIC RADIO/CHECKBOX GROUPING (DEMOQA ETC) ---
        // Group native inputs by name to form single fields
        const processedGroupInputs = new Set();
        const groupCandidates = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
        const groups = {};

        groupCandidates.forEach(el => {
            if (el.closest('div[role="listitem"]')) return; // Skip Google Forms processed above
            let name = el.name;

            // Fix for DemoQA Hobbies: Checkboxes lack 'name' but have 'id' pattern 'hobbies-checkbox-X'
            if (!name && el.id && el.id.startsWith('hobbies-checkbox')) {
                name = 'hobbies-group';
            }

            if (name) {
                if (!groups[name]) groups[name] = [];
                groups[name].push(el);
            }
        });

        Object.keys(groups).forEach(name => {
            const inputs = groups[name];
            if (inputs.length === 0) return;

            // 1. Determine Group Label (Strategy: Proximity of first item)
            const firstEl = inputs[0];
            let groupLabel = '';

            // Try fieldset/legend
            const fieldset = firstEl.closest('fieldset');
            if (fieldset) {
                const legend = fieldset.querySelector('legend');
                if (legend) groupLabel = clean(legend);
            }

            // Try DemoQA / Bootstrap col-3 label pattern
            if (!groupLabel) {
                const col = firstEl.closest('.col-md-9, .col-sm-12');
                if (col && col.previousElementSibling) {
                    groupLabel = clean(col.previousElementSibling);
                }
            }

            // Try preceding label if not in col structure
            if (!groupLabel) {
                // heuristic: look for a label immediately preceding the container of these inputs
                const container = firstEl.parentElement?.parentElement; // rough guess
                if (container && container.previousElementSibling && container.previousElementSibling.tagName === 'LABEL') {
                    groupLabel = clean(container.previousElementSibling);
                }
            }

            // Fallback: Use name as label
            if (!groupLabel) groupLabel = name;

            if (!groupLabel) return;

            // 2. Build Options
            const options = inputs.map(input => {
                let optLabel = input.value; // fallback
                // Try label[for=id]
                if (input.id) {
                    const l = document.querySelector(`label[for="${input.id}"]`);
                    if (l) optLabel = clean(l);
                }
                // Try parent label
                if (!optLabel || optLabel === 'on') {
                    if (input.parentElement.tagName === 'LABEL') optLabel = clean(input.parentElement);
                }

                // Selector: Prefer Label for interaction if custom control
                let optSelector = generateSelector(input);
                if (input.id && document.querySelector(`label[for="${input.id}"]`)) {
                    optSelector = `label[for="${input.id}"]`;
                }

                return {
                    id: input.id,
                    value: input.value,
                    label: optLabel,
                    selector: optSelector,
                    text: optLabel // standardizing
                };
            });

            // 3. Mark processed
            inputs.forEach(i => processedGroupInputs.add(i));

            // 4. Register Field
            const type = inputs[0].type === 'radio' ? 'radio-group' : 'checkbox-group';
            detectedMap.set(groupLabel, {
                type: type,
                label: groupLabel,
                required: false, // hard to detect on group level easily without HTML5 validation inspection
                selector: generateSelector(inputs[0].parentElement), // Approx group container
                options: options,
                verified: false
            });
        });

        // --- STRATEGY 1: SCAN ALL POTENTIAL INPUTS (GENERIC / REACT) ---
        // Only run for elements NOT already covered by Strategy 0 (simplification: we just add unique ones)

        const inputs = Array.from(document.querySelectorAll(`
            input:not([type="hidden"]),
            textarea,
            select,
            div[role="listbox"],
            .react-select__input input,
            #subjectsInput,
            [data-initial-value],
            [id*="react-select"]
        `));

        inputs.forEach(el => {
            // FILTER: Skip purely structural/helper hidden inputs unless specific React cases
            if (el.tagName === 'INPUT' && el.type === 'hidden') {
                if (!el.id.includes('react-select')) return;
            }

            // If inside a Google Form listitem we already processed, skip
            if (el.closest('div[role="listitem"]')) return;

            // If processed by Grouping Strategy 0.5, skip
            if (processedGroupInputs.has(el)) return;

            const style = window.getComputedStyle(el);
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;

            let isReactCustom = false;
            let customType = null;
            let customContainer = null;

            // A. Autocomplete (Subjects)
            if (el.id === 'subjectsInput' || el.classList.contains('react-select__input')) {
                isReactCustom = true;
                customType = 'autocomplete';
            }
            // B. Date Picker (Date of Birth)
            else if (el.id === 'dateOfBirthInput' || el.closest('.react-datepicker-wrapper')) {
                isReactCustom = true;
                customType = 'date-picker';
            }
            // C. React Select (State/City)
            else if (el.id && el.id.includes('react-select')) {
                // Determine if this is the active input or a hidden value holder
                isReactCustom = true;
                customType = 'react-select';
                // Find the main container for the Select
                customContainer = el.closest('div[class*="-container"]') || el.parentElement;
            }

            if (!isVisible && !isReactCustom && el.type !== 'radio' && el.type !== 'checkbox' && el.type !== 'file') {
                return;
            }

            // ... (Rest of classic label resolution logic) ...
            let labelText = '';

            // Wrapper check for DemoQA State/City
            if (el.closest('#stateCity-wrapper') || el.closest('#city-wrapper') || el.id.includes('react-select')) {
                if (el.id.includes('react-select-3')) labelText = 'State';
                else if (el.id.includes('react-select-4')) labelText = 'City';
            }

            // Classic Label Resolution (Id, For, Aria, Proximity)
            if (!labelText && el.id) {
                const l = document.querySelector(`label[for="${el.id}"]`);
                if (l) labelText = clean(l);
            }
            if (!labelText) { // Proximity col-3 / col-9 (Bootstrap/DemoQA)
                const col = el.closest('.col-md-9, .col-sm-12');
                if (col && col.previousElementSibling) {
                    labelText = clean(col.previousElementSibling);
                }
            }
            if (!labelText) labelText = el.getAttribute('placeholder') || '';

            if (!labelText) return; // Skip unnamed generic inputs to avoid noise

            // Avoid Duplicates
            if (detectedMap.has(labelText)) return;

            let fieldType = customType || el.type || 'text';
            if (el.tagName === 'SELECT') fieldType = 'select';
            if (el.tagName === 'TEXTAREA') fieldType = 'textarea';

            // Refine type
            if (fieldType === 'text') {
                if (labelText.toLowerCase().includes('email')) fieldType = 'email';
                else if (labelText.toLowerCase().includes('phone') || labelText.toLowerCase().includes('mobile')) fieldType = 'phone';
            }

            detectedMap.set(labelText, {
                type: fieldType,
                label: labelText,
                required: el.required || labelText.includes('*'),
                selector: customContainer ? generateSelector(customContainer) : generateSelector(el), // Prefer container for React Select
                // For React Select, we pass the container selector so the worker clicks IT, not the hidden input
                inputSelector: generateSelector(el), // Keep ref to input just in case
                options: fieldType === 'select' ? getSelectOptions(el) : [],
                verified: false
            });
        });

        function generateSelector(el) {
            if (el.id) return `#${el.id}`;
            if (el.name) return `[name="${el.name}"]`;
            // ... (standard path generation) ...
            let path = [];
            let current = el;
            while (current && current !== document.body) {
                let tag = current.tagName.toLowerCase();
                let params = '';
                if (current.className && typeof current.className === 'string' && current.className.trim()) {
                    // specific fix for DemoQA weird classes? keep simple
                    // Use first class only if it looks stable
                    const cls = current.className.trim().split(/\s+/)[0];
                    if (!cls.includes('css-')) params = '.' + cls; // Avoid styled-components hashes if possible
                }
                path.unshift(tag + params);
                current = current.parentElement;
            }
            return path.slice(-3).join(' > ');
        }

        function getSelectOptions(el) {
            if (el.tagName === 'SELECT') return Array.from(el.options).map(o => ({ value: o.value, text: o.text }));
            return [];
        }

        return Array.from(detectedMap.values());
    });

    return fields;
}

module.exports = { inspectForm };
