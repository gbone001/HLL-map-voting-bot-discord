const logger = require('../utils/logger');

class RconPoller {
    constructor(options = {}) {
        this.name = options.name || 'RCON';
        this.intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 5000;
        this.fetcher = options.fetcher;
        this.timer = null;
        this.running = false;
        this.inFlight = false;
        this.snapshot = null;
        this.lastError = null;
        this.lastSuccessAt = null;
    }

    getSnapshot() {
        return this.snapshot;
    }

    async pollNow() {
        if (this.inFlight) {
            return this.snapshot;
        }

        if (typeof this.fetcher !== 'function') {
            return this.snapshot;
        }

        this.inFlight = true;
        try {
            const next = await this.fetcher();
            if (next && typeof next === 'object') {
                this.snapshot = next;
                this.lastSuccessAt = Date.now();
                this.lastError = null;
            }
        } catch (error) {
            this.lastError = error;
            logger.warn(`[${this.name}] Poll failed: ${error.message}`);
        } finally {
            this.inFlight = false;
        }

        return this.snapshot;
    }

    start() {
        if (this.running) return;
        this.running = true;

        this.pollNow().catch(() => {
            // handled by pollNow
        });

        this.timer = setInterval(() => {
            this.pollNow().catch(() => {
                // handled by pollNow
            });
        }, this.intervalMs);
    }

    stop() {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = {
    RconPoller
};
