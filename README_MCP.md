# Form Automation Agent (MCP + Claude)

This project has been extended with an Intelligent Form Automation Agent powered by Claude and the Model Context Protocol (MCP).

## Features
- **Natural Language Control**: Type instructions like "Fill the contact form for John Doe" in the UI.
- **Intelligent Field Detection**: Automatically detects form fields and maps data.
- **Robust Tool Use**: Uses specialized tools for filling text, radios, checkboxes, and dropdowns.
- **Context Awareness**: Maintains state across the job execution.

## Setup
1. **API Key Required**: You must set your Anthropic API Key for the agent to work.
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-api03-...
   ```
   Or add it to a `.env` file (if you set one up).

## Usage
1. Start the server:
   ```bash
   npm start
   ```
2. Open `http://localhost:3000`.
3. In the "Automation Assistant" panel (left), type your instruction.
   - Example: "Go to https://demoqa.com/automation-practice-form and fill it with random data."
   - Example: "Fill the form with Name: Alice, Email: alice@example.com."
4. Click Request/Send.
5. Watch the "Live Logs" to see Claude analyzing the page and executing tools.

## Architecture
- **`src/backend/mcp/`**: Contains the MCP System.
  - `tools.js`: Tool definitions (Navigate, Detect, Fill, etc.).
  - `agent.js`: The reasoning loop connecting to Claude.
  - `system.js`: The execution engine binding Playwright to the Agent.
- **`src/backend/queue.js`**: Dispatches 'nlp' jobs to the new system.
- **`src/frontend/app.js`**: Connects the chat UI to the backend API.
