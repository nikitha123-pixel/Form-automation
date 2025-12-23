const EventEmitter = require('events');

/**
 * JobQueue
 * 
 * Simple in-memory queue that processes jobs sequentially.
 * Emits events when job status changes.
 */
class JobQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.isProcessing = false;
        this.processedJobs = []; // Keep history of recent jobs
    }

    /**
     * Adds a new job to the queue.
     * @param {MCPContext} mcpContext 
     */
    addJob(mcpContext) {
        this.queue.push(mcpContext);
        mcpContext.log('Job added to queue');
        this.emit('jobAdded', mcpContext.getContext());
        this.processNext();
    }

    /**
     * Attempts to process the next job in the queue.
     */
    async processNext() {
        if (this.isProcessing) {
            return;
        }

        if (this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;
        const currentJobContext = this.queue.shift();

        // Move to processed list (reference kept)
        this.processedJobs.push(currentJobContext);

        // Notify start
        currentJobContext.updateState('RUNNING');
        this.emit('jobUpdated', currentJobContext.getContext());

        try {
            // We strictly decouple queue from worker implementation. 
            // The worker function is passed in or required lazily to avoid circular deps if any.
            // But for simplicity here, we will emit an event that the worker listens to,
            // OR we can require the worker here. 

            // Emitting 'processJob' lets the worker pick it up.
            // We need to wait for it to complete though to maintain sequential processing.

            // Dispatch based on Job Type
            if (currentJobContext.data.type === 'nlp') {
                const nlpSystem = require('./mcp/system');
                await nlpSystem.runJob(currentJobContext, (updatedContext) => {
                    this.emit('jobUpdated', updatedContext);
                });
            } else {
                // Classic Automation
                const automationWorker = require('./automationWorker');
                await automationWorker.runJob(currentJobContext, (updatedContext) => {
                    this.emit('jobUpdated', updatedContext);
                });
            }

        } catch (error) {
            currentJobContext.log(`System Error: ${error.message}`, 'ERROR');
            currentJobContext.updateState('FAILED');
            this.emit('jobUpdated', currentJobContext.getContext());
        } finally {
            this.isProcessing = false;
            this.emit('jobCompleted', currentJobContext.getContext()); // Completed or Failed
            // Process next
            this.processNext();
        }
    }

    getJobById(jobId) {
        // Search in both queue and processed jobs
        let job = this.queue.find(ctx => ctx.data.jobId === jobId);
        if (!job) {
            job = this.processedJobs.find(ctx => ctx.data.jobId === jobId);
        }
        return job;
    }

    getAllJobs() {
        return [
            ...this.queue.map(ctx => ctx.getContext()),
            ...this.processedJobs.map(ctx => ctx.getContext())
        ];
    }
}

module.exports = new JobQueue();
