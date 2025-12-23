const Anthropic = require('@anthropic-ai/sdk');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { TOOLS } = require('./tools');

// Initialize Anthropic Client
// NOTE: Requires ANTHROPIC_API_KEY in environment variables
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || 'DUMMY_KEY_FOR_TESTING'
});

// Convert Tools to Anthropic Format
const anthropicTools = Object.values(TOOLS).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema)
}));

const SYSTEM_PROMPT = `
You are an autonomous Form Automation Agent powered by Claude and MCP.
Your goal is to fill out web forms reliably and accurately based on user instructions.

CRITICAL RULES:
1. **Top-to-Bottom Order**: You MUST fill fields in the exact visual order they appear on the 'detect_form_fields' list. Do NOT jump around. This prevents scrolling issues and overlay blocking.
2. **One by One**: Fill one field at a time (or logically grouped fields like First+Last Name), then move to the next.
3. **Verify**: After filling, assume success unless you see an error.
4. **Context**: You have persistent browser state.
5. **Tool Usage**:
   - Start with \`navigate_to_form(url)\`.
   - Then \`detect_form_fields()\` to see what is on the page.
   - Then loop through the fields from top to bottom and use:
     - \`fill_text_input\` for Text, Email, Phone, Date, Textarea.
     - \`select_radio\` for Radio Groups (Gender).
     - \`select_checkbox\` for Checkboxes (Hobbies).
     - \`select_dropdown\` for Select/React-Select (State, City).
   - Finally \`submit_form()\`.

If a field is not found or fails, try to recover or ask the user.
Always output your reasoning before calling a tool.
`;

async function processUserMessage(job, userMessage) {
    // Update History
    job.context.chatHistory.push({ role: 'user', content: userMessage });

    if (!process.env.ANTHROPIC_API_KEY) {
        const msg = "⚠️ ANTHROPIC_API_KEY is missing. Please set it in your environment to use the AI features.";
        job.context.chatHistory.push({ role: 'assistant', content: msg });
        return msg;
    }

    let currentTurnCount = 0;
    const MAX_TURNS = 10; // Prevent infinite loops

    while (currentTurnCount < MAX_TURNS) {
        currentTurnCount++;

        try {
            console.log(`[Agent] Consuming Claude API (Turn ${currentTurnCount})...`);

            const response = await anthropic.messages.create({
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 1024,
                system: SYSTEM_PROMPT,
                messages: job.context.chatHistory,
                tools: anthropicTools
            });

            // Add Assistant Response to History
            // We need to store the raw message for tool use continuity
            job.context.chatHistory.push(response); // Store the full response object logic? 
            // Anthropic SDK messages format expects specific structure. 
            // We should push the content properly.

            const assistantContent = response.content;
            // The SDK response object structure is slightly different from the input message structure.
            // We need to normalize it for the next request.
            // However, `response` itself is not exactly the message parameter format.
            // We'll reconstruct the message to push.
            const assistantMessage = {
                role: 'assistant',
                content: assistantContent
            };
            // Note: If we just push `assistantMessage`, we might lose the tool_use ID mapping 
            // if we don't include it exactly as received. 
            // In the new SDK, `response.content` IS the array of text/tool_use blocks.
            // So `assistantMessage` is correct.

            // Wait, we need to ensure we don't have duplicate 'assistant' messages if we are just appending.
            // We already appended user message above.
            // Now we replace the history with valid chain? No, we append.

            // Fix: The job.context.chatHistory needs to adapt. 
            // If the last message was user, we add assistant.
            // If we are looping for tools, the last message in `messages` param MUST be user or tool_result.
            // Actually, for multiple tool calls, we have: User -> Assistant(ToolUse) -> User(ToolResult) -> Assistant...
            // So we need to push `assistantMessage` to history.

            // BUT: We already pushed `userMessage` at the start of the function.
            // So on first loop iteration: [User] -> API -> Returns Assistant Message.

            // We log text response
            const textBlock = assistantContent.find(b => b.type === 'text');
            if (textBlock) {
                job.log(`Agent says: ${textBlock.text}`);
            }

            // Check for Tool Use
            const toolUses = assistantContent.filter(b => b.type === 'tool_use');

            if (toolUses.length === 0) {
                // No tools, just a reply. We are done with this turn.
                job.context.chatHistory.push(assistantMessage);
                return textBlock ? textBlock.text : "Task Completed."; // Return final text
            }

            // Execute Tools
            job.context.chatHistory.push(assistantMessage); // Add the Tool Intent

            for (const toolUse of toolUses) {
                const toolName = toolUse.name;
                const toolArgs = toolUse.input;
                const toolId = toolUse.id;

                job.log(`Executing tool: ${toolName}`);

                let resultContent;
                try {
                    const toolDef = TOOLS[toolName];
                    if (!toolDef) throw new Error(`Tool ${toolName} not found`);

                    const result = await toolDef.execute(job, toolArgs);
                    // result is { content: ... }
                    // We need to format for Anthropic
                    resultContent = result.content;
                    // result.content is usually [{ type: 'text', text: '...' }]
                    // But for tool_result block, check SDK docs.
                } catch (err) {
                    console.error(`Tool execution failed:`, err);
                    resultContent = [{ type: 'text', text: `Error: ${err.message}` }];
                }

                // Add Tool Result to History
                job.context.chatHistory.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: toolId,
                        content: resultContent
                    }]
                });
            }

            // Loop continues to let Claude see the results and decide next step

        } catch (error) {
            console.error("Agent Loop Error:", error);
            job.log(`Agent Error: ${error.message}`, 'ERROR');
            return `I encountered an error: ${error.message}`;
        }
    }

    return "I reached the maximum number of steps without finishing. Please continue or refine your instruction.";
}

module.exports = { processUserMessage };
