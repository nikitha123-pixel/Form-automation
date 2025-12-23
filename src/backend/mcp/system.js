const { chromium } = require('playwright');
const { processUserMessage } = require('./agent');

/**
 * Executes a Natural Language Form Automation Job.
 * This is the entry point called by the Queue.
 * 
 * @param {JobContext} jobContext - The job context object from the queue.
 * @param {Function} onUpdate - Callback to broadcast updates.
 */
async function runJob(jobContext, onUpdate) {
    const { user_data } = jobContext.data;
    const instruction = user_data.instruction || user_data.prompt || "Please detect fields and fill this form.";

    // 1. Initialize Browser
    jobContext.log('Initializing browser for NLP Agent...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 100,
        args: ['--start-maximized']
    });
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    jobContext.updateState('RUNNING');

    // 2. Create the Adapter (The "Job" object expected by Agent/Tools)
    // We mix in the jobContext methods + browser methods + helper logic
    const mcpJob = {
        id: jobContext.data.jobId,
        context: jobContext.data, // Direct reference to data for persistence

        // Proxy logging to the real context
        log: (msg, level) => {
            jobContext.log(msg, level);
            onUpdate(jobContext.getContext());
        },

        // Update State
        updateState: (state) => {
            jobContext.updateState(state);
            onUpdate(jobContext.getContext());
        },

        // Browser Access
        getPage: () => page,

        navigateTo: async (url) => {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        },

        // Helper: Find Field in Detected Fields
        findField: (label) => {
            const fields = jobContext.data.detectedFields || [];
            if (!fields.length) return null;

            const norm = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]/g, '');
            const target = norm(label);

            // 1. Exact Label Match
            let match = fields.find(f => norm(f.label) === target);

            // 2. Contains Match
            if (!match) {
                match = fields.find(f => norm(f.label).includes(target) || target.includes(norm(f.label)));
            }

            // 3. Heuristic: "Email" -> type=email logic already handled by Inspector?
            // If label is generic "email" and we have a field of type email?
            if (!match && target === 'email') {
                match = fields.find(f => f.type === 'email' || f.label.toLowerCase().includes('email'));
            }

            return match;
        },

        // Helper: Find Option in Field
        findOption: (field, optionLabel) => {
            if (!field.options) return null;
            const norm = s => String(s).toLowerCase().trim();
            const target = norm(optionLabel);

            return field.options.find(o =>
                norm(o.label) === target ||
                norm(o.value) === target ||
                norm(o.label).includes(target)
            );
        },

        // Helper: Mark Field Status
        markFieldStatus: (label, status, value) => {
            if (!jobContext.data.filledFields) jobContext.data.filledFields = {};
            jobContext.data.filledFields[label] = { status, value };
            onUpdate(jobContext.getContext());
        }
    };

    try {
        // 3. Start the Agent Loop
        // If the instruction implies a URL, the agent will handle navigation via tools.
        // If the UI passed a `formUrl`, we can pre-seed it or let the agent handle it.
        // Usually, the prompt should be sufficient.

        // If formUrl serves as a base, we can instruct the agent.
        if (jobContext.data.formUrl) {
            await mcpJob.navigateTo(jobContext.data.formUrl);
            jobContext.data.formUrl = jobContext.data.formUrl;
        }

        jobContext.log(`Starting Agent with instruction: "${instruction}"`);

        const finalResponse = await processUserMessage(mcpJob, instruction);

        jobContext.log(`Agent Finished: ${finalResponse}`);
        jobContext.updateState('COMPLETED');

    } catch (error) {
        jobContext.setError(error.message);
        jobContext.updateState('FAILED');
    } finally {
        // 4. Cleanup
        await browser.close();
        onUpdate(jobContext.getContext());
    }
}

module.exports = { runJob };
