const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors'); // Good practice even if not strictly needed for same-origin
const { JobContext } = require('./jobContext');
const jobQueue = require('./queue');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// WebSocket Connection Logic
wss.on('connection', (ws) => {
    console.log('Client connected');

    // Send initial state: Current jobs
    const allJobs = jobQueue.getAllJobs();
    ws.send(JSON.stringify({ type: 'init', jobs: allJobs }));

    ws.on('close', () => console.log('Client disconnected'));
});

// Broadcast helper
const broadcast = (data) => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
};

// Queue Event Listeners -> Broadcast
jobQueue.on('jobAdded', (job) => {
    broadcast({ type: 'job_added', job });
});
jobQueue.on('jobStarted', (job) => {
    broadcast({ type: 'job_updated', job });
});
jobQueue.on('jobUpdated', (job) => {
    broadcast({ type: 'job_updated', job });
});
jobQueue.on('jobCompleted', (job) => {
    broadcast({ type: 'job_updated', job });
});

// HTTP API

/**
 * POST /api/chat/start
 * Starts a new NLP Automation Job from natural language instruction.
 */
app.post('/api/chat/start', (req, res) => {
    const { instruction, formUrl } = req.body;

    if (!instruction) {
        return res.status(400).json({ error: 'Instruction is required' });
    }

    // Create Job Context with type 'nlp'
    const userData = { instruction, prompt: instruction };
    const jobContext = new JobContext(formUrl || '', userData, 'nlp');

    // Add to Queue
    jobQueue.addJob(jobContext);

    res.status(201).json({
        message: 'NLP Job queued',
        jobId: jobContext.data.jobId
    });
});

/**
 * POST /jobs
 * Input: { "formUrl": "...", "userData": {...} }
 */
app.post('/jobs', (req, res) => {
    const { formUrl, userData } = req.body;

    // Strict Input Contract Check
    if (!formUrl || !userData || typeof userData !== 'object') {
        return res.status(400).json({ error: 'Invalid input. Expected { formUrl, userData }' });
    }

    // Create Job Context (The foundation of the job)
    const jobContext = new JobContext(formUrl, userData);

    // Add to Queue
    jobQueue.addJob(jobContext);

    res.status(201).json({
        message: 'Job queued successfully',
        jobId: jobContext.data.jobId
    });
});

/**
 * POST /jobs/:jobId/resume
 * Resume a failed job
 */
app.post('/jobs/:jobId/resume', (req, res) => {
    const { jobId } = req.params;

    try {
        const jobContext = jobQueue.getJobById(jobId);
        if (!jobContext) {
            return res.status(404).json({ error: 'Job not found' });
        }

        if (!jobContext.canResume()) {
            return res.status(400).json({
                error: 'Job cannot be resumed',
                reason: jobContext.data.execution_state === 'INVALID_INPUT' ?
                    'Invalid input data' : 'Maximum retry attempts reached'
            });
        }

        // Prepare for resume
        jobContext.prepareForResume();

        // Re-queue the job
        jobQueue.addJob(jobContext);

        res.json({
            message: 'Job resumed successfully',
            jobId: jobContext.data.jobId,
            retry_attempt: jobContext.data.retry_count
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket endpoint ready`);
});
