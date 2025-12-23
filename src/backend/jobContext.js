const { v4: uuidv4 } = require('uuid');

/**
 * JobContext
 * 
 * Represents the structured context for a form automation job.
 * Acts as the single source of truth for the job's state, validation, and logs.
 * 
 * Structure follows the requirement:
 * {
 *   "intent": "form_automation",
 *   "form_url": "...",
 *   "required_fields": [...],
 *   "provided_fields": [...],
 *   "missing_fields": [...],
 *   "field_mapping": {...},
 *   "execution_state": "..."
 * }
 */
class JobContext {
    constructor(formUrl, userData, type = 'json') {
        const id = uuidv4();
        this.data = {
            id: id,
            jobId: id,
            type: type, // 'json' or 'nlp'
            form_url: formUrl,
            formUrl: formUrl, // Alias for legacy frontend support
            user_data: userData,
            jsonData: userData, // Alias for legacy frontend support
            status: 'QUEUED', // QUEUED, RUNNING, COMPLETED, FAILED
            logs: [],
            createdAt: new Date().toISOString(),
            completedAt: null,
            // MCP Context fields for internal use
            intent: 'form_automation',
            required_fields: [], // To be populated by Inspector
            provided_fields: userData ? Object.keys(userData) : [],
            missing_fields: [],
            field_mapping: {}, // Maps specific input identifiers to user data keys
            execution_state: 'QUEUED', // Internal state tracking
            error: null, // Detailed error message
            detected_fields: [], // Store detected fields for MCP context
            current_step: null, // Current automation step
            retry_count: 0, // For field-level retries
            chatHistory: [] // Role/Content for LLM (NLP jobs)
        };
    }

    /**
     * Updates state to FAILED and records error message.
     * @param {string} message
     */
    setError(message) {
        this.data.error = message;
        this.log(message, 'ERROR');
        this.updateState('FAILED');
        this.data.completedAt = new Date().toISOString();
    }

    /**
     * Updates the execution state and logs the transition.
     * @param {string} newState
     */
    updateState(newState) {
        const oldState = this.data.execution_state;
        this.data.execution_state = newState;

        // Map internal states to external status
        const statusMap = {
            'QUEUED': 'QUEUED',
            'RUNNING': 'RUNNING',
            'INSPECTING': 'RUNNING',
            'FILLING': 'RUNNING',
            'SUBMITTING': 'RUNNING',
            'COMPLETED': 'COMPLETED',
            'FAILED': 'FAILED'
        };

        this.data.status = statusMap[newState] || 'FAILED';
        if (newState === 'COMPLETED' || newState === 'FAILED') {
            this.data.completedAt = new Date().toISOString();
        }

        this.log(`State transition: ${oldState} -> ${newState}`);
    }

    /**
     * Adds a log entry with timestamp.
     * @param {string} message 
     * @param {string} level - INFO, WARN, ERROR
     */
    log(message, level = 'INFO') {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message
        };
        this.data.logs.push(entry);
        return entry; // Return for broadcasting
    }

    /**
     * Sets the discovered required fields and validates against provided data.
     * @param {Array<string>} requiredFields - List of field names/ids found in the form
     * @returns {boolean} - True if valid, False if fields are missing
     */
    validateRequirements(requiredFields) {
        this.data.required_fields = requiredFields;

        // Simple case-insensitive matching for now, can be improved
        const providedKeys = this.data.provided_fields.map(k => k.toLowerCase());

        this.data.missing_fields = requiredFields.filter(req => {
            // Check if req is present in provided keys
            // We'll try exact match first, then case-insensitive
            return !this.data.provided_fields.includes(req) &&
                !providedKeys.includes(req.toLowerCase());
        });

        if (this.data.missing_fields.length > 0) {
            this.setError(`Missing required fields: ${this.data.missing_fields.join(', ')}`, 'INVALID_INPUT');
            return false;
        }

        this.log('Input validation successful. All required fields present.');
        return true;
    }

    /**
     * Records a mapping decision (which user key was used for which form input)
     * @param {string} formInputIdentifier 
     * @param {string} userKey 
     */
    setFieldMapping(formInputIdentifier, userKey) {
        this.data.field_mapping[formInputIdentifier] = userKey;
    }

    /**
     * Sets the current step in the automation process for MCP reasoning
     * @param {string} step - Current automation step
     */
    setCurrentStep(step) {
        this.data.current_step = step;
        this.log(`MCP Step: ${step}`);
    }

    /**
     * Records MCP reasoning for debugging and resumption
     * @param {string} reasoning - Step-by-step reasoning explanation
     * @param {object} context - Additional context data
     */
    recordMCPReasoning(reasoning, context = {}) {
        const mcpEntry = {
            timestamp: new Date().toISOString(),
            type: 'mcp_reasoning',
            reasoning,
            context,
            current_step: this.data.current_step,
            execution_state: this.data.execution_state
        };
        this.data.logs.push(mcpEntry);
    }

    /**
     * Checks if job can be resumed from failure
     * @returns {boolean} - True if job can be resumed
     */
    canResume() {
        return this.data.status === 'FAILED' &&
            this.data.execution_state !== 'INVALID_INPUT' &&
            this.data.retry_count < 3;
    }

    /**
     * Prepares job context for resumption
     */
    prepareForResume() {
        if (!this.canResume()) {
            throw new Error('Job cannot be resumed');
        }

        this.data.retry_count++;
        this.data.status = 'PENDING';
        this.data.execution_state = 'PENDING';
        this.data.error = null;
        this.data.completedAt = null;
        this.data.current_step = 'Resuming from previous failure';

        this.log(`MCP: Preparing job for resume (attempt ${this.data.retry_count})`);
        this.recordMCPReasoning('Resuming failed job from last successful step', {
            previous_error: this.data.error,
            retry_attempt: this.data.retry_count,
            last_step: this.data.current_step
        });
    }

    /**
     * Gets MCP context for step-by-step reasoning
     * @returns {object} - Structured MCP context
     */
    getMCPContext() {
        return {
            intent: this.data.intent,
            current_state: this.data.execution_state,
            current_step: this.data.current_step,
            form_url: this.data.form_url,
            user_data: this.data.user_data,
            required_fields: this.data.required_fields,
            provided_fields: this.data.provided_fields,
            missing_fields: this.data.missing_fields,
            field_mapping: this.data.field_mapping,
            detected_fields: this.data.detected_fields,
            error: this.data.error,
            retry_count: this.data.retry_count,
            reasoning_history: this.data.logs.filter(log => log.type === 'mcp_reasoning'),
            last_reasoning: this.data.logs.filter(log => log.type === 'mcp_reasoning').pop()
        };
    }

    getContext() {
        // Return the core data object which now includes 'id' and both camel/snake case properties
        return {
            ...this.data,
            mcp_context: this.getMCPContext()
        };
    }
}

module.exports = { JobContext };
