const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const { chromium } = require('playwright');
const { TOOLS } = require('./tools');
const { JobContext } = require('../jobContext');

// --- SINGLETON STATE FOR DESKTOP SESSION ---
// In a proper server, we might map sessions, but for Stdio (1-on-1), proper singleton is fine.
const session = {
    browser: null,
    page: null,
    jobContext: new JobContext('http://localhost', {}, 'stdio'), // Placeholder context

    // Helper to ensure browser is open
    async ensureBrowser() {
        if (this.browser) {
            // Check if page/context is still alive
            if (!this.page || this.page.isClosed()) {
                console.error('[MCP] Page closed, cleaning up...');
                try { await this.browser.close(); } catch (e) { }
                this.browser = null;
                this.page = null;
            }
        }

        if (!this.browser) {
            console.error('[MCP] Launching Browser...');
            this.browser = await chromium.launch({
                headless: false,
                slowMo: 100,
                args: ['--start-maximized']
            });
            const context = await this.browser.newContext({ viewport: null });
            this.page = await context.newPage();

            // Handle manual closure
            this.page.on('close', () => {
                console.error('[MCP] User closed page.');
                this.page = null;
            });
        }
        return this.page;
    },

    // Adapter to match the "Job" interface expected by tools.js
    getJobAdapter() {
        const self = this;
        // Ensure data structures exist
        if (!self.jobContext.data.detectedFields) self.jobContext.data.detectedFields = [];
        if (!self.jobContext.data.filledFields) self.jobContext.data.filledFields = {};

        return {
            id: 'stdio-session',
            context: self.jobContext.data,

            log: (msg, level = 'INFO') => {
                // MCP Stdio relies on stdout for protocol. Logs must go to stderr.
                console.error(`[${level}] ${msg}`);
            },

            updateState: (state) => {
                console.error(`[STATE] ${state}`);
                self.jobContext.updateState(state);
            },

            getPage: () => self.page,

            navigateTo: async (url) => {
                await self.ensureBrowser();
                await self.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            },

            findField: (label) => {
                const fields = self.jobContext.data.detectedFields || [];
                const norm = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]/g, '');
                const target = norm(label);

                let match = fields.find(f => norm(f.label) === target);
                if (!match) {
                    match = fields.find(f => norm(f.label).includes(target) || target.includes(norm(f.label)));
                }
                if (!match && target === 'email') {
                    match = fields.find(f => f.type === 'email' || f.label.toLowerCase().includes('email'));
                }
                return match;
            },

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

            markFieldStatus: (label, status, value) => {
                self.jobContext.data.filledFields[label] = { status, value };
                console.error(`[FIELD] ${label} = ${status}`);
            }
        };
    }
};

// --- MCP SERVER SETUP ---

const server = new Server(
    {
        name: "form-automation-mcp",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);



// We need zod-to-json-schema conversion for the ListTools response
const { zodToJsonSchema } = require('zod-to-json-schema');

// Override the handler to use JSON Schema
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: Object.values(TOOLS).map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: zodToJsonSchema(tool.inputSchema)
        }))
    };
});

// 2. Call Tool Handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments;

    const tool = TOOLS[toolName];
    if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
    }

    try {
        console.error(`[EXEC] Calling tool ${toolName}`);

        // Ensure browser is ready for non-nav tools if page is missing?
        // But tools.js handles generic errors.
        if (toolName !== 'navigate_to_form' && !session.page) {
            // Implicitly launch if detect is called first?
            // Better to allow tool implementation to throw, but we can help.
            if (toolName === 'detect_form_fields') {
                await session.ensureBrowser(); // But it won't be on a URL...
            }
        }

        const jobAdapter = session.getJobAdapter();
        const result = await tool.execute(jobAdapter, args);

        // result is { content: [...] }
        return result;

    } catch (error) {
        console.error(`[ERROR] ${error.message}`);
        return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
        };
    }
});

// 3. Start Server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Form Automation MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
