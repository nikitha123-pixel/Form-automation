const { z } = require('zod');
const { inspectForm } = require('../formInspector');
const interactions = require('../shared/fieldInteractions');
const path = require('path');

// --- TOOL DEFINITIONS ---

const TOOLS = {
    navigate_to_form: {
        name: 'navigate_to_form',
        description: 'Navigates the browser to a specific URL to start filling a form.',
        inputSchema: z.object({
            url: z.string().url().describe('The URL of the form to navigate to.')
        }),
        execute: async (job, { url }) => {
            job.log(`Navigating to ${url}...`);
            await job.navigateTo(url);
            job.context.formUrl = url;
            return { content: [{ type: 'text', text: `Successfully navigated to ${url}` }] };
        }
    },

    detect_form_fields: {
        name: 'detect_form_fields',
        description: 'Scans the current page to detect all form fields, their labels, types, and options.',
        inputSchema: z.object({}),
        execute: async (job) => {
            job.log('Detecting form fields...');
            const page = job.getPage();
            if (!page) throw new Error('Browser not initialized. Call navigate_to_form first.');

            const fields = await inspectForm(page);
            job.context.detectedFields = fields;

            // Create a summary for the LLM
            const summary = fields.map((f, i) =>
                `${i + 1}. [${f.type}] "${f.label}" ${f.required ? '(Required)' : ''} ${f.options && f.options.length ? `Options: [${f.options.map(o => o.label).join(', ')}]` : ''}`
            ).join('\n');

            return {
                content: [{ type: 'text', text: `Detected ${fields.length} fields:\n${summary}` }],
                data: fields
            };
        }
    },

    fill_text_input: {
        name: 'fill_text_input',
        description: 'Fills a text, email, phone, date, or textarea input identified by its label.',
        inputSchema: z.object({
            label: z.string().describe('The exact or approximate label of the field to fill.'),
            value: z.string().describe('The value to type into the field.')
        }),
        execute: async (job, { label, value }) => {
            job.log(`Filling text field "${label}" with "${value}"`);
            const field = job.findField(label);
            if (!field) throw new Error(`Field "${label}" not found. Run detect_form_fields first.`);

            const page = job.getPage();
            const el = await page.$(field.selector);
            if (el) await el.scrollIntoViewIfNeeded();

            // Delegate to robust interaction library
            if (field.type === 'date' || field.type === 'date-picker') {
                await interactions.fillDate(page, field.selector, value, field, job);
            } else if (field.type === 'email') {
                await interactions.fillEmail(page, field.selector, value, field.label, job);
            } else if (field.type === 'phone') {
                await interactions.fillPhone(page, field.selector, value, field.label, job);
            } else if (field.type === 'autocomplete') {
                await interactions.fillAutocomplete(page, field.selector, value, field.label, job);
            } else {
                await interactions.fillStandard(page, field.selector, value, job);
            }

            job.markFieldStatus(field.label, 'FILLED', value);
            return { content: [{ type: 'text', text: `Filled "${label}"` }] };
        }
    },

    select_radio: {
        name: 'select_radio',
        description: 'Selects a radio button option for a given group label.',
        inputSchema: z.object({
            label: z.string().describe('The label of the radio group (e.g. "Gender").'),
            option: z.string().describe('The text/label of the option to select (e.g. "Male").')
        }),
        execute: async (job, { label, option }) => {
            job.log(`Selecting radio "${option}" for "${label}"`);
            const field = job.findField(label);
            if (!field) throw new Error(`Field "${label}" not found.`);
            if (field.type !== 'radio-group') throw new Error(`Field "${label}" is not a radio group.`);

            const page = job.getPage();
            await interactions.selectRadio(page, field, option, job);

            job.markFieldStatus(field.label, 'FILLED', option);
            return { content: [{ type: 'text', text: `Selected "${option}" for "${label}"` }] };
        }
    },

    select_checkbox: {
        name: 'select_checkbox',
        description: 'Checks a checkbox. Can be a single checkbox or an option in a checkbox group.',
        inputSchema: z.object({
            label: z.string().describe('The label of the checkbox or group.'),
            option: z.string().optional().describe('If it is a group, specific option to check.')
        }),
        execute: async (job, { label, option }) => {
            job.log(`Selecting checkbox "${label}"` + (option ? ` option "${option}"` : ''));
            const field = job.findField(label);
            if (!field) throw new Error(`Field "${label}" not found.`);

            const page = job.getPage();

            if (field.type === 'checkbox-group' && option) {
                await interactions.selectCheckbox(page, field, option, job);
            } else {
                // Single checkbox
                await interactions.selectCheckbox(page, { ...field, options: [{ label, value: 'on', selector: field.selector }] }, option || 'on', job);
            }

            job.markFieldStatus(field.label, 'FILLED', option || 'Checked');
            return { content: [{ type: 'text', text: `Checked "${label}"` }] };
        }
    },

    select_dropdown: {
        name: 'select_dropdown',
        description: 'Selects an option from a dropdown (select) field.',
        inputSchema: z.object({
            label: z.string().describe('The label of the dropdown field.'),
            option: z.string().describe('The option text to select.')
        }),
        execute: async (job, { label, option }) => {
            job.log(`Selecting dropdown "${option}" for "${label}"`);
            const field = job.findField(label);
            if (!field) throw new Error(`Field "${label}" not found.`);

            const page = job.getPage();

            if (field.type === 'react-select') {
                await interactions.selectReactSelect(page, field.selector, option, label, field, job);
            } else {
                await interactions.selectDropdown(page, field.selector, field, option, job);
            }

            job.markFieldStatus(field.label, 'FILLED', option);
            return { content: [{ type: 'text', text: `Selected "${option}" for "${label}"` }] };
        }
    },

    submit_form: {
        name: 'submit_form',
        description: 'Submits the form by finding and clicking the submit button.',
        inputSchema: z.object({}),
        execute: async (job) => {
            job.log('Submitting form...');
            const page = job.getPage();

            // Try common submit selectors
            const selectors = [
                'button:has-text("Submit")',
                'input[type="submit"]',
                'div[role="button"]:has-text("Submit")',
                'button[type="submit"]',
                '.btn-primary:has-text("Submit")'
            ];

            let clicked = false;
            for (const sel of selectors) {
                if (await page.$(sel)) {
                    await page.click(sel);
                    clicked = true;
                    break;
                }
            }

            if (!clicked) throw new Error('Could not find a submit button.');

            // Wait for navigation or success message
            await page.waitForTimeout(3000); // rudimentary wait

            job.status = 'COMPLETED';
            return { content: [{ type: 'text', text: 'Form submitted (waited 3s). Check screenshot for confirmation.' }] };
        }
    }
};

module.exports = { TOOLS };
