const form = document.getElementById('job-form');
const submitMsg = document.getElementById('submit-msg');
const statusInd = document.getElementById('connection-status');
const statusDot = document.getElementById('connection-dot');
const chatFeed = document.getElementById('chat-feed');
const logGroupsContainer = document.getElementById('log-groups');
const timelineSteps = document.querySelectorAll('.timeline-step');
const activeJobDetails = document.getElementById('active-job-details');

let socket;
let jobs = []; // local cache
let selectedJobId = null;
let lastState = null;

function connect() {
    socket = new WebSocket(`ws://${location.host}`);

    socket.onopen = () => {
        console.log('WebSocket connection opened'); // Debug log
        statusInd.textContent = 'Connected';
        statusDot.className = 'status-dot green';
    };

    socket.onclose = () => {
        console.log('WebSocket connection closed'); // Debug log
        statusInd.textContent = 'Disconnected - Retrying...';
        statusDot.className = 'status-dot red';
        setTimeout(connect, 2000);
    };

    socket.onmessage = (event) => {
        console.log('WebSocket message received:', event.data); // Debug log
        const data = JSON.parse(event.data);
        handleMessage(data);
    };
}

function handleMessage(msg) {
    console.log('Handling message:', msg); // Debug log
    if (msg.type === 'init') {
        jobs = msg.jobs;
    } else if (msg.type === 'job_added') {
        jobs.push(msg.job);
        // If the user just started this job (selectedJobId set via submit), update UI now
        if (selectedJobId && selectedJobId === msg.job.id) {
            updateUI(msg.job);
        }
    } else if (msg.type === 'job_updated') {
        const idx = jobs.findIndex(j => j.id === msg.job.id);
        if (idx !== -1) {
            jobs[idx] = msg.job;
        } else {
            jobs.push(msg.job);
        }

        // Update UI if this is the currently selected job
        if (selectedJobId && selectedJobId === msg.job.id) {
            updateUI(msg.job);
        }
    }
    renderJobList(jobs);
}

function selectJob(id) {
    selectedJobId = id;
    const job = jobs.find(j => j.id === id);
    if (job) {
        lastState = null; // reset for state transitions
        updateUI(job);
    }
}

function updateUI(job) {
    updateTimeline(job.execution_state);
    updateLogs(job.logs || []);
    handleStateTransitions(job);
    renderDetailedStats(job);
    updateCurrentActionIndicator(job.current_action);
    (job.fields_status || []).forEach(fieldStatus => {
        updateFieldStatus(fieldStatus.field, fieldStatus.status);
    });
    renderJobList(jobs);
}

function renderJobList(jobs) {
    const jobListContainer = document.getElementById('job-list');

    // Sort jobs chronologically (newest first)
    const sortedJobs = jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    jobListContainer.innerHTML = sortedJobs.map((job, index) => {
        const statusIcons = {
            'QUEUED': '🕒',
            'RUNNING': '▶',
            'COMPLETED': '✅',
            'FAILED': '❌'
        };

        const statusClasses = {
            'QUEUED': 'status-queued',
            'RUNNING': 'status-running',
            'COMPLETED': 'status-completed',
            'FAILED': 'status-failed'
        };

        const startTime = new Date(job.createdAt).toLocaleString();
        const endTime = job.completedAt ? new Date(job.completedAt).toLocaleString() : 'In Progress';

        const currentStep = job.current_step || job.execution_state || 'Initializing';

        return `<div class="job-card ${job.status === 'RUNNING' ? 'active-job' : ''}" onclick="selectJob('${job.id}')">
            <div class="job-header">
                <div class="job-id">${statusIcons[job.status]} ${job.id.slice(0, 8)}</div>
                <div class="job-status ${statusClasses[job.status]}">${job.status.replace('_', ' ')}</div>
            </div>
            <div class="job-details">
                <div class="job-url">${job.formUrl.length > 60 ? job.formUrl.substring(0, 60) + '...' : job.formUrl}</div>
                <div class="job-meta">
                    <span>Started: ${startTime}</span>
                    <span>Current Step: ${currentStep}</span>
                </div>
                ${job.completedAt ? `<div class="job-completed">Completed: ${endTime}</div>` : ''}
                ${job.error ? `<div class="job-error">Error: ${job.error}</div>` : ''}
                <div class="job-logs-preview">
                    ${job.logs && job.logs.length > 0 ? `Latest: ${job.logs[job.logs.length - 1].message.substring(0, 50)}...` : 'No logs yet'}
                </div>
            </div>
        </div>`;
    }).join('');
}

function updateTimeline(state) {
    // Map external status to internal execution state for timeline
    const executionState = state;
    const states = ['QUEUED', 'INSPECTING', 'FILLING', 'SUBMITTING', 'COMPLETED', 'FAILED'];
    const currentStateIdx = states.indexOf(executionState);

    timelineSteps.forEach((stepEl, index) => {
        const stepState = stepEl.getAttribute('data-step');
        const stepIdx = states.indexOf(stepState);

        stepEl.classList.remove('active', 'completed', 'failed');

        if (executionState === 'FAILED' && stepIdx === currentStateIdx) {
            stepEl.classList.add('failed');
            stepEl.classList.add('active');
        } else if (stepIdx < currentStateIdx || executionState === 'COMPLETED') {
            stepEl.classList.add('completed');
        } else if (stepIdx === currentStateIdx || (executionState === 'RUNNING' && stepIdx === 1)) {
            stepEl.classList.add('active');
        }
    });

    // Special case for COMPLETED state on the last step
    if (executionState === 'COMPLETED') {
        const lastStep = timelineSteps[timelineSteps.length - 1];
        lastStep.classList.add('completed');
    }
}

function handleStateTransitions(job) {
    const currentExecutionState = job.execution_state || job.status;
    if (currentExecutionState === lastState) return;

    const stateMessages = {
        'INSPECTING': "I'm analyzing the form structure to detect all available input fields.",
        'FILLING': "Analysis complete! I'm now mapping your data to the form fields and filling them.",
        'SUBMITTING': "All fields filled. I'm performing the final submission now.",
        'COMPLETED': "Success! The form has been submitted successfully.",
        'FAILED': `I encountered an issue: ${job.error || 'Unknown error'}.`
    };

    if (stateMessages[currentExecutionState]) {
        addAssistantMessage(stateMessages[currentExecutionState]);
    }

    lastState = currentExecutionState;
}

function addAssistantMessage(text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message assistant';
    msgDiv.innerHTML = `<div class="bubble">${text}</div>`;
    chatFeed.appendChild(msgDiv);
    chatFeed.scrollTop = chatFeed.scrollHeight;
}

function addUserMessage(text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message user';
    msgDiv.innerHTML = `<div class="bubble">${text}</div>`;
    chatFeed.appendChild(msgDiv);
    chatFeed.scrollTop = chatFeed.scrollHeight;
}

function updateLogs(logs) {
    logGroupsContainer.innerHTML = '';
    if (logs.length === 0) {
        logGroupsContainer.innerHTML = '<div class="empty-state">Waiting for execution to start...</div>';
        return;
    }

    const logGroups = {};
    logs.forEach(log => {
        const step = log.step;
        if (!logGroups[step]) {
            logGroups[step] = [];
        }
        logGroups[step].push(log);
    });

    Object.keys(logGroups).forEach(step => {
        const stepDiv = document.createElement('div');
        stepDiv.className = 'log-group';
        stepDiv.innerHTML = `<h4>${step}</h4>`;

        logGroups[step].forEach(log => {
            const logDiv = document.createElement('div');
            logDiv.className = `log-entry log-level-${log.level}`;
            const time = new Date(log.timestamp).toLocaleTimeString();
            logDiv.innerHTML = `<span class="log-time">${time}</span> <span class="log-message">${log.message}</span>`;
            stepDiv.appendChild(logDiv);
        });

        logGroupsContainer.appendChild(stepDiv);
    });

    const terminal = document.getElementById('log-window');
    const isAtBottom = terminal.scrollHeight - terminal.scrollTop <= terminal.clientHeight + 100;
    if (isAtBottom) {
        terminal.scrollTop = terminal.scrollHeight;
    }
}

function renderDetailedStats(job) {
    let html = '';

    // Missing Fields
    if (job.missing_fields && job.missing_fields.length > 0) {
        html += `<div class="details-alert">
            <strong>⚠️ Missing Required Information</strong>
            <p>I couldn't find data for these fields:</p>
            <div style="margin-top: 8px;">
                ${job.missing_fields.map(f => `<span class="field-pill">${f}</span>`).join('')}
            </div>
        </div>`;
    }

    // Detected Fields Summary (Small badge)
    if (job.detected_fields && job.detected_fields.length > 0) {
        const mappedCount = Object.keys(job.field_mapping || {}).length;
        const totalCount = job.detected_fields.length;
        const percent = Math.round((mappedCount / totalCount) * 100);

        html += `<div style="margin-top: 15px; font-size: 0.8rem; color: var(--text-secondary);">
            Mapped ${mappedCount}/${totalCount} fields (${percent}%)
            <div style="background: rgba(255,255,255,0.1); height: 4px; border-radius: 2px; margin-top: 4px;">
                <div style="background: var(--success); height: 100%; width: ${percent}%; border-radius: 2px;"></div>
            </div>
        </div>`;
    }

    activeJobDetails.innerHTML = html;
}

function updateCurrentActionIndicator(action) {
    const currentActionElement = document.getElementById('current-action');
    if (currentActionElement) {
        currentActionElement.textContent = `Current action: ${action}`;
    }
}

function updateFieldStatus(field, status) {
    const fieldElement = document.querySelector(`[data-field="${field}"]`);
    if (fieldElement) {
        fieldElement.textContent = `${field} ${status}`;
        fieldElement.className = `field-status ${status.toLowerCase()}`;
    }
}

function renderFieldStatuses(fields) {
    const fieldStatusContainer = document.getElementById('field-statuses');
    fieldStatusContainer.innerHTML = fields.map(field => `<div data-field="${field}" class="field-status pending">${field} ⏳</div>`).join('');
}

// Form Submission
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = document.getElementById('formUrl').value;
    const jsonStr = document.getElementById('userData').value;

    try {
        const userData = JSON.parse(jsonStr);
        submitMsg.textContent = 'Queueing job...';
        submitMsg.style.color = 'var(--text-secondary)';

        addUserMessage(`Automate this form for me: ${url}`);

        const res = await fetch('/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ formUrl: url, userData })
        });

        const data = await res.json();
        if (res.ok) {
            submitMsg.textContent = `Job ID: ${data.jobId.slice(0, 8)}`;
            submitMsg.style.color = 'var(--success)';
            selectJob(data.jobId); // Auto-select the new job to show live logs
            // form.reset(); // Don't reset to let user see what they sent, or reset if preferred
        } else {
            submitMsg.textContent = `Error: ${data.error}`;
            submitMsg.style.color = 'var(--danger)';
            addAssistantMessage(`I couldn't queue that job: ${data.error}`);
        }
    } catch (err) {
        if (err instanceof SyntaxError) {
            submitMsg.textContent = 'Invalid JSON in User Data';
        } else {
            submitMsg.textContent = `Error: ${err.message}`;
        }
        submitMsg.style.color = 'var(--danger)';
    }
});

// Clear Logs
document.getElementById('clear-logs').addEventListener('click', () => {
    logGroupsContainer.innerHTML = '<div class="empty-state">Logs cleared.</div>';
});

// Make selectJob available globally for onclick handlers
window.selectJob = selectJob;

// --- CHAT INTERFACE LOGIC ---
const chatInput = document.getElementById('chat-input');
const sendBtn = document.querySelector('.send-btn');

// Enable Controls
chatInput.disabled = false;
sendBtn.disabled = false;

async function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    chatInput.value = '';
    addUserMessage(text);

    // If an active job is selected and running/waiting, maybe we append?
    // For now, simpler: Create NEW Job for every main instruction.
    // Or if instruction starts with "Full URL...", we parse it?
    // Let backend handle parsing.

    // Optimistic UI
    const loadingId = addAssistantMessage("Thinking...");

    try {
        const res = await fetch('/api/chat/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instruction: text })
        });

        const data = await res.json();

        // Remove "Thinking..."
        // (In a real app we'd track the element ID, for now just append new response or let socket handle update)

        if (res.ok) {
            // The socket will update us with "Job Added".
            // We just need to wait or auto-select.
            selectJob(data.jobId);
        } else {
            addAssistantMessage(`Error: ${data.error}`);
        }
    } catch (err) {
        addAssistantMessage(`Network Error: ${err.message}`);
    }
}

sendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
});

// Start
connect();
