const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');

// Job Store (In-Memory for now)
const jobs = new Map();

class Job {
    constructor(id, instructions) {
        this.id = id;
        this.instructions = instructions;
        this.status = 'PENDING'; // PENDING, RUNNING, COMPLETED, FAILED
        this.context = {
            logs: [],
            formUrl: null,
            detectedFields: [],
            filledFields: {}, // label -> value
            chatHistory: [] // Role/Content for LLM
        };
        this.browser = null;
        this.page = null;
    }

    log(message, level = 'INFO') {
        const entry = { timestamp: new Date(), message, level };
        this.context.logs.push(entry);
        console.log(`[Job ${this.id}] ${message}`);
    }

    async startBrowser() {
        if (this.browser) return;
        this.browser = await chromium.launch({
            headless: false,
            slowMo: 100,
            args: ['--start-maximized']
        });
        const context = await this.browser.newContext({ viewport: null });
        this.page = await context.newPage();
        this.status = 'RUNNING';
    }

    async navigateTo(url) {
        if (!this.browser) await this.startBrowser();
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    getPage() {
        return this.page;
    }

    findField(label) {
        if (!this.context.detectedFields) return null;
        const norm = s => s.toLowerCase().trim();
        // Exact match
        let found = this.context.detectedFields.find(f => norm(f.label) === norm(label));
        // Partial match
        if (!found) {
            found = this.context.detectedFields.find(f => norm(f.label).includes(norm(label)) || norm(label).includes(norm(f.label)));
        }
        return found;
    }

    findOption(field, optionLabel) {
        if (!field.options) return null;
        const norm = s => s.toLowerCase().trim();
        return field.options.find(o => norm(o.label) === norm(optionLabel) || norm(o.value) === norm(optionLabel));
    }

    markFieldStatus(label, status, value) {
        this.context.filledFields[label] = { status, value };
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }
}

module.exports = {
    createJob: (instructions) => {
        const id = uuidv4();
        const job = new Job(id, instructions);
        jobs.set(id, job);
        return job;
    },
    getJob: (id) => jobs.get(id),
    getAllJobs: () => Array.from(jobs.values())
};
