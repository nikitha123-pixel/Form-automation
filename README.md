# 🔥 Form Automation Queue System

A production-grade, Node.js-based Form Automation Queue System capable of dynamically solving any web form (Google Forms, Formsite, DemoQA, etc.) without skipping any fields, providing a real-time dashboard with job-wise execution status.

## 🎯 Core Features

### ✅ **Queue Management**
- **Sequential Processing**: Jobs processed one at a time, no overlaps
- **Job States**: `PENDING` → `IN_PROGRESS` → `SUCCESS` / `FAILED`
- **Persistent Context**: In-memory queue with MCP context isolation
- **Job Format**:
```json
{
  "jobId": "uuid",
  "formUrl": "string",
  "jsonData": {},
  "status": "PENDING | IN_PROGRESS | SUCCESS | FAILED",
  "logs": [],
  "createdAt": "timestamp",
  "completedAt": "timestamp | null"
}
```

### ✅ **Browser Automation**
- **Playwright Engine**: Headless browser automation with visual feedback
- **Field Detection**: Supports all input types:
  - Text inputs, Email, Phone, Textarea
  - Radio buttons, Checkboxes, Dropdowns (native + custom)
  - Date/Time pickers, File uploads
  - Multi-page forms with Next/Submit flow
- **Strict Rules**:
  - ✅ Click dropdowns before selecting
  - ✅ Click radio buttons explicitly
  - ✅ Select by visible text, not index
  - ✅ Wait for elements to render
  - ✅ Validate successful field filling
  - ✅ Never skip required fields
  - ✅ Fail job if required field unfilled

### ✅ **Dynamic Form Solving**
- **Smart Label Matching**: Exact match → Case-insensitive → Fuzzy matching
- **Example Mapping**:
```json
{
  "Email Address": "test@gmail.com"
}
```
Matches: `Email`, `Email ID`, `Email address *`

### ✅ **Google Forms Edge Cases**
- **Email/Phone Detection**: Enhanced detection for Google Forms custom fields
- **Custom Components**: Radio groups, dropdowns, date/time split inputs
- **Hidden Fields**: Scroll into view before interaction
- **Retry Logic**: Max 3 retries per field with screenshots on failure
- **DOM Snapshots**: Detailed logging for debugging

### ✅ **Real-Time Dashboard**
- **Live Updates**: WebSocket-powered status updates
- **Job Cards**: Chronological display with detailed info:
  - Job ID, Form URL, Status (color-coded)
  - Current step, Start/End times
  - Expandable logs, Error details
- **Status Colors**:
  - 🟡 PENDING: Orange
  - 🔵 IN_PROGRESS: Blue
  - 🟢 SUCCESS: Green
  - 🔴 FAILED: Red

### ✅ **MCP (Model Context Protocol) Integration**
- **Per-Job Context**: Isolated reasoning state for each job
- **Step-by-Step Reasoning**: Detailed automation logic traces
- **Resume Capability**: Failed jobs can be resumed from last successful step
- **Context Structure**:
```json
{
  "intent": "form_automation",
  "current_state": "FILLING",
  "current_step": "Processing email field",
  "form_url": "...",
  "required_fields": [...],
  "field_mapping": {...},
  "error": null,
  "reasoning_history": [...]
}
```

## 🏗️ Architecture

```
┌─────────────────┐    HTTP POST    ┌─────────────────┐
│   Frontend UI   │───────────────▶│  Express Server │
│   (React/Vue)   │◀───────────────│   (WebSocket)   │
└─────────────────┘   Real-time     └─────────────────┘
         │                                      │
         │                             ┌────────▼────────┐
         │                             │   Job Queue     │
         │                             │ (Sequential)    │
         │                             └─────────────────┘
         │                                      │
         │                             ┌────────▼────────┐
         │                             │ Automation      │
         │                             │ Worker          │
         │                             │ (Playwright)    │
         └─────────────────────────────┘─────────────────┘
                                       │
                                       ▼
                              ┌───────────────┐
                              │ Form Inspector│
                              │ (DOM Analysis)│
                              └───────────────┘
```

## 🚀 Setup & Installation

### Prerequisites
- Node.js 16+
- npm or yarn

### Installation
```bash
# Clone or download the project
cd form-automation-system

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install
```

### Running the Application
```bash
# Start the server
npm start

# Or with custom port
PORT=8080 npm start

# Server will be available at http://localhost:3000
```

## 📖 Usage

### 1. **Submit a Job**
```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "formUrl": "https://forms.google.com/...",
    "userData": {
      "Email": "user@example.com",
      "Name": "John Doe",
      "Message": "Hello World"
    }
  }'
```

### 2. **Resume a Failed Job**
```bash
curl -X POST http://localhost:3000/jobs/{jobId}/resume
```

### 3. **Monitor Jobs**
- Open `http://localhost:3000` in browser
- Watch real-time job updates via WebSocket
- Click job cards for detailed logs

## 🧪 Tested Forms

### ✅ **Formsite**
```javascript
{
  formUrl: "https://fs1.formsite.com/res/showFormEmbed?EParam=B6fiTn-RcO5Oi8C4iSTjsq4WXqv4L_Qk&748593425&EmbedId=748593425",
  userData: {
    "Name": "John Doe",
    "Email": "john@example.com",
    // ... other fields
  }
}
```

### ✅ **DemoQA Practice Form**
```javascript
{
  formUrl: "https://demoqa.com/automation-practice-form",
  userData: {
    "First Name": "John",
    "Last Name": "Doe",
    "Email": "john@example.com",
    "Gender": "Male",
    "Mobile Number": "1234567890",
    "Date of Birth": "1990-01-01",
    "Subjects": ["Maths", "Physics"],
    "Hobbies": ["Sports", "Music"],
    "Picture": "path/to/file.jpg",
    "Current Address": "123 Main St",
    "State": "NCR",
    "City": "Delhi"
  }
}
```

### ✅ **Google Forms**
```javascript
{
  formUrl: "https://docs.google.com/forms/.../viewform",
  userData: {
    "Email address": "user@gmail.com",
    "Name": "John Doe",
    "Phone number": "1234567890",
    // ... form-specific fields
  }
}
```

## 🔧 API Reference

### **POST /jobs**
Submit a new automation job.

**Request Body:**
```json
{
  "formUrl": "string",
  "userData": "object"
}
```

**Response:**
```json
{
  "message": "Job queued successfully",
  "jobId": "uuid"
}
```

### **POST /jobs/{jobId}/resume**
Resume a failed job.

**Response:**
```json
{
  "message": "Job resumed successfully",
  "jobId": "uuid",
  "retry_attempt": 1
}
```

### **WebSocket Events**
- `job_added`: New job queued
- `job_updated`: Job status/progress update
- `init`: Initial job list on connection

## 🛠️ Configuration

### Environment Variables
```bash
PORT=3000                    # Server port (default: 3000)
NODE_ENV=production          # Environment mode
PLAYWRIGHT_HEADLESS=false    # Browser visibility (default: false for debugging)
```

### Browser Configuration
- **Headless Mode**: Set `headless: true` in `automationWorker.js` for production
- **Slow Motion**: Adjust `slowMo` for debugging (currently 100ms)
- **Viewport**: Set to `null` for maximized window

## 🐛 Error Handling

### Job States & Errors
- **INVALID_INPUT**: Missing required fields in user data
- **FAILED**: Automation errors (field not found, validation failed, etc.)
- **NETWORK_ERROR**: Form URL unreachable
- **TIMEOUT**: Form loading or interaction timeout

### Retry Logic
- **Field Level**: Max 3 retries per field with progressive delays
- **Job Level**: Failed jobs can be resumed up to 3 times
- **Screenshot**: Automatic screenshots on field failures

## 📝 Development

### Project Structure
```
src/
├── backend/
│   ├── server.js           # Express server + WebSocket
│   ├── queue.js            # Job queue management
│   ├── jobContext.js       # MCP context per job
│   ├── automationWorker.js # Playwright automation
│   └── formInspector.js    # DOM field detection
├── frontend/
│   ├── index.html          # Main UI
│   ├── app.js              # Frontend logic
│   ├── styles.css          # UI styling
│   └── JobProgressColumn.js # React component
└── shared/                 # Shared utilities
```

### Key Components

#### **JobContext (MCP)**
```javascript
const jobContext = new JobContext(formUrl, userData);
// Tracks: intent, state, validation, mapping, reasoning
```

#### **Form Inspector**
```javascript
const fields = await inspectForm(page);
// Detects: labels, types, required fields, selectors
```

#### **Automation Worker**
```javascript
await automationWorker.runJob(jobContext, onUpdate);
// Handles: field filling, validation, submission
```

## 🔒 Security Considerations

- **Input Validation**: Strict JSON schema validation
- **Rate Limiting**: Consider implementing job submission limits
- **Browser Isolation**: Each job runs in separate browser context
- **Data Sanitization**: User data validated before automation
- **Error Masking**: Sensitive information not exposed in logs

## 📊 Performance

- **Concurrent Jobs**: Sequential processing (configurable)
- **Memory Usage**: In-memory queue (consider Redis for production)
- **Browser Pool**: Single browser instance per job
- **Timeouts**: 60s page load, 30s per field interaction

## 🚨 Known Limitations

- **Single Browser**: One job at a time (sequential queue)
- **Memory Persistence**: Jobs lost on server restart
- **Form Types**: Best suited for standard web forms
- **Captcha**: Not handled (would require manual intervention)
- **Authentication**: Forms requiring login not supported

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/new-form-support`
3. Add tests for new functionality
4. Submit pull request with detailed description

## 📄 License

MIT License - see LICENSE file for details.

---

**Built with**: Node.js, Express, Playwright, WebSocket, MCP Protocol
**Status**: Production-ready for web form automation
**Maintainer**: Form Automation Team