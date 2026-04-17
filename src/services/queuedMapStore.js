const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getDataFilePath } = require('../utils/dataPath');

const STORE_PATH = getDataFilePath('queued-maps.json');
const STORE_TMP_PATH = `${STORE_PATH}.tmp`;
const STORE_LOCK_PATH = `${STORE_PATH}.lock`;
const STORE_LOCK_TIMEOUT_MS = 5000;
const STORE_LOCK_RETRY_MS = 25;
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;
const STALE_RESOLVED_MS = 72 * 60 * 60 * 1000;

class QueuedMapStore {
    constructor() {
        this.entries = this.load();
    }

    load() {
        try {
            const dataDir = path.dirname(STORE_PATH);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            if (fs.existsSync(STORE_PATH)) {
                return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
            }
        } catch (error) {
            logger.error('[QueuedMapStore] Error loading queued maps:', error.message);
        }

        return {};
    }

    reload() {
        this.entries = this.load();
        return this.entries;
    }

    saveUnlocked() {
        try {
            const dataDir = path.dirname(STORE_PATH);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            fs.writeFileSync(STORE_TMP_PATH, JSON.stringify(this.entries, null, 2));
            fs.renameSync(STORE_TMP_PATH, STORE_PATH);
            return true;
        } catch (error) {
            logger.error('[QueuedMapStore] Error saving queued maps:', error.message);
            try {
                if (fs.existsSync(STORE_TMP_PATH)) {
                    fs.unlinkSync(STORE_TMP_PATH);
                }
            } catch {
                // Ignore cleanup failures.
            }
            return false;
        }
    }

    withStoreLock(callback) {
        const releaseLock = this.acquireStoreLock();

        try {
            this.entries = this.load();
            return callback();
        } finally {
            releaseLock();
        }
    }

    acquireStoreLock() {
        const startTime = Date.now();

        while (true) {
            try {
                fs.mkdirSync(STORE_LOCK_PATH);
                return () => {
                    try {
                        fs.rmSync(STORE_LOCK_PATH, { recursive: true, force: true });
                    } catch {
                        // Ignore unlock failures.
                    }
                };
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw error;
                }

                if (Date.now() - startTime >= STORE_LOCK_TIMEOUT_MS) {
                    throw new Error(`Timed out waiting for queued map store lock: ${STORE_LOCK_PATH}`);
                }

                sleepSync(STORE_LOCK_RETRY_MS);
            }
        }
    }

    buildServerKey(serverNum) {
        return `server_${serverNum}`;
    }

    getQueuedMap(serverNum) {
        this.reload();
        const entry = this.entries[this.buildServerKey(serverNum)];
        return entry?.state === 'pending' ? entry : null;
    }

    getLastEntry(serverNum) {
        this.reload();
        return this.entries[this.buildServerKey(serverNum)] || null;
    }

    upsertQueuedMap(serverNum, payload) {
        return this.withStoreLock(() => {
            const key = this.buildServerKey(serverNum);
            const existingEntry = this.entries[key];
            const now = Date.now();
            const generationId = existingEntry?.state === 'pending'
                ? existingEntry.generationId
                : `${serverNum}:${now}`;

            const entry = {
                generationId,
                serverNum,
                desiredMapId: payload.desiredMapId,
                source: payload.source || existingEntry?.source || 'unknown',
                gameStart: payload.gameStart ?? existingEntry?.gameStart ?? null,
                voteMessageId: payload.voteMessageId ?? existingEntry?.voteMessageId ?? null,
                queuedAt: existingEntry?.queuedAt ?? now,
                updatedAt: now,
                state: 'pending',
                lastEnforcedAt: payload.lastEnforcedAt ?? existingEntry?.lastEnforcedAt ?? null,
                lastVerifiedAt: payload.lastVerifiedAt ?? existingEntry?.lastVerifiedAt ?? null,
                lastObservedCurrentMapId: payload.lastObservedCurrentMapId ?? existingEntry?.lastObservedCurrentMapId ?? null,
                lastObservedNextMapId: payload.lastObservedNextMapId ?? existingEntry?.lastObservedNextMapId ?? null,
                lastError: payload.lastError ?? existingEntry?.lastError ?? null,
                reapplyCount: payload.reapplyCount ?? existingEntry?.reapplyCount ?? 0,
                consumedAt: null,
                failedAt: null,
                failureReason: null,
                actualMapId: null
            };

            this.entries[key] = entry;
            this.saveUnlocked();
            return entry;
        });
    }

    updateQueuedMap(serverNum, updater) {
        return this.withStoreLock(() => {
            const key = this.buildServerKey(serverNum);
            const existingEntry = this.entries[key];
            if (!existingEntry) {
                return null;
            }

            const updatedEntry = typeof updater === 'function'
                ? updater({ ...existingEntry })
                : { ...existingEntry, ...updater };

            if (!updatedEntry) {
                return existingEntry;
            }

            updatedEntry.updatedAt = Date.now();
            this.entries[key] = updatedEntry;
            this.saveUnlocked();
            return updatedEntry;
        });
    }

    markQueuedMapVerified(serverNum, details = {}) {
        return this.updateQueuedMap(serverNum, (entry) => ({
            ...entry,
            lastVerifiedAt: Date.now(),
            lastObservedCurrentMapId: details.currentMapId ?? entry.lastObservedCurrentMapId ?? null,
            lastObservedNextMapId: details.nextMapId ?? entry.lastObservedNextMapId ?? null,
            lastError: null
        }));
    }

    noteEnforcement(serverNum, details = {}) {
        return this.updateQueuedMap(serverNum, (entry) => ({
            ...entry,
            lastEnforcedAt: Date.now(),
            lastObservedCurrentMapId: details.currentMapId ?? entry.lastObservedCurrentMapId ?? null,
            lastObservedNextMapId: details.nextMapId ?? entry.lastObservedNextMapId ?? null,
            lastError: details.lastError ?? null,
            reapplyCount: (entry.reapplyCount ?? 0) + (details.incrementReapplyCount === false ? 0 : 1)
        }));
    }

    markQueuedMapConsumed(serverNum, details = {}) {
        return this.updateQueuedMap(serverNum, (entry) => ({
            ...entry,
            state: 'consumed',
            consumedAt: Date.now(),
            actualMapId: details.actualMapId ?? entry.actualMapId ?? entry.desiredMapId,
            lastObservedCurrentMapId: details.currentMapId ?? entry.lastObservedCurrentMapId ?? null,
            lastObservedNextMapId: details.nextMapId ?? entry.lastObservedNextMapId ?? null,
            lastError: null
        }));
    }

    markQueuedMapFailed(serverNum, details = {}) {
        return this.updateQueuedMap(serverNum, (entry) => ({
            ...entry,
            state: 'failed',
            failedAt: Date.now(),
            failureReason: details.failureReason || 'unknown',
            actualMapId: details.actualMapId ?? entry.actualMapId ?? null,
            lastObservedCurrentMapId: details.currentMapId ?? entry.lastObservedCurrentMapId ?? null,
            lastObservedNextMapId: details.nextMapId ?? entry.lastObservedNextMapId ?? null,
            lastError: details.lastError ?? entry.lastError ?? null
        }));
    }

    clearQueuedMap(serverNum) {
        return this.withStoreLock(() => {
            const key = this.buildServerKey(serverNum);
            if (!this.entries[key]) {
                return false;
            }

            delete this.entries[key];
            this.saveUnlocked();
            return true;
        });
    }

    cleanup() {
        return this.withStoreLock(() => {
            const now = Date.now();
            let cleaned = 0;

            for (const [key, entry] of Object.entries(this.entries)) {
                const ageMs = now - (entry.updatedAt ?? entry.queuedAt ?? now);
                const maxAgeMs = entry.state === 'pending' ? STALE_PENDING_MS : STALE_RESOLVED_MS;
                if (ageMs > maxAgeMs) {
                    delete this.entries[key];
                    cleaned += 1;
                }
            }

            if (cleaned > 0) {
                this.saveUnlocked();
                logger.info(`[QueuedMapStore] Cleaned up ${cleaned} stale queued map entr${cleaned === 1 ? 'y' : 'ies'}`);
            }
        });
    }
}

function sleepSync(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

module.exports = new QueuedMapStore();
