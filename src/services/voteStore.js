/**
 * Vote Store
 * Simple JSON-based storage to track active votes per match
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getDataFilePath } = require('../utils/dataPath');

const STORE_PATH = getDataFilePath('votes.json');

class VoteStore {
    constructor() {
        this.votes = this.load();
    }

    reload() {
        this.votes = this.load();
        return this.votes;
    }

    load() {
        try {
            const dataDir = path.dirname(STORE_PATH);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            if (fs.existsSync(STORE_PATH)) {
                const data = fs.readFileSync(STORE_PATH, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            logger.error('[VoteStore] Error loading votes:', error.message);
        }
        return {};
    }

    save() {
        try {
            const dataDir = path.dirname(STORE_PATH);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(STORE_PATH, JSON.stringify(this.votes, null, 2));
            return true;
        } catch (error) {
            logger.error('[VoteStore] Error saving votes:', error.message);
            return false;
        }
    }

    /**
     * Get vote by game start timestamp
     * @param {number} gameStart - Unix timestamp of match start
     * @param {number} serverNum - Server number
     * @returns {object|null} Vote data or null
     */
    getVote(gameStart, serverNum) {
        this.reload();
        const key = `${serverNum}_${gameStart}`;
        return this.votes[key] || null;
    }

    /**
     * Store a vote
     * @param {string} messageId - Discord message ID
     * @param {number} gameStart - Unix timestamp of match start
     * @param {number} serverNum - Server number
     * @param {Array} maps - Maps in the vote
     */
    setVote(messageId, gameStart, serverNum, maps = []) {
        this.reload();
        const key = `${serverNum}_${gameStart}`;
        this.votes[key] = {
            messageId,
            gameStart,
            serverNum,
            maps,
            finalizationClaim: null,
            finalizedAt: null,
            finalizedMapId: null,
            createdAt: Date.now()
        };
        this.save();
        logger.info(`[VoteStore] Stored vote for server ${serverNum}, gameStart ${gameStart}`);
    }

    /**
     * Claim vote finalization so only one bot instance applies the result.
     * @param {number} gameStart
     * @param {number} serverNum
     * @param {string} messageId
     * @param {string} ownerId
     * @param {number} ttlMs
     * @returns {{ claimed: boolean, reason?: string, vote?: object }}
     */
    claimVoteFinalization(gameStart, serverNum, messageId, ownerId, ttlMs = 120000) {
        this.reload();
        const key = `${serverNum}_${gameStart}`;
        const vote = this.votes[key];

        if (!vote) {
            return { claimed: false, reason: 'missing' };
        }

        if (messageId && vote.messageId && String(vote.messageId) !== String(messageId)) {
            return { claimed: false, reason: 'message_mismatch', vote };
        }

        if (vote.finalizedAt) {
            return { claimed: false, reason: 'already_finalized', vote };
        }

        const existingClaim = vote.finalizationClaim;
        const now = Date.now();
        if (existingClaim && existingClaim.ownerId !== ownerId && existingClaim.expiresAt > now) {
            return { claimed: false, reason: 'claimed_by_other', vote };
        }

        vote.finalizationClaim = {
            ownerId,
            claimedAt: now,
            expiresAt: now + ttlMs
        };

        this.save();
        logger.info(`[VoteStore] Finalization claimed for server ${serverNum}, gameStart ${gameStart}, owner ${ownerId}`);
        return { claimed: true, vote };
    }

    /**
     * Mark finalization as complete for observability before cleanup.
     * @param {number} gameStart
     * @param {number} serverNum
     * @param {string} ownerId
     * @param {string|null} finalizedMapId
     * @returns {boolean}
     */
    completeVoteFinalization(gameStart, serverNum, ownerId, finalizedMapId = null) {
        this.reload();
        const key = `${serverNum}_${gameStart}`;
        const vote = this.votes[key];

        if (!vote) {
            return false;
        }

        if (vote.finalizationClaim?.ownerId !== ownerId) {
            return false;
        }

        vote.finalizedAt = Date.now();
        vote.finalizedMapId = finalizedMapId || null;
        vote.finalizationClaim = null;
        this.save();
        return true;
    }

    /**
     * Release a finalization claim after a failed attempt so a later retry can proceed.
     * @param {number} gameStart
     * @param {number} serverNum
     * @param {string} ownerId
     * @returns {boolean}
     */
    releaseVoteFinalization(gameStart, serverNum, ownerId) {
        this.reload();
        const key = `${serverNum}_${gameStart}`;
        const vote = this.votes[key];

        if (!vote || vote.finalizationClaim?.ownerId !== ownerId) {
            return false;
        }

        vote.finalizationClaim = null;
        this.save();
        logger.warn(`[VoteStore] Released finalization claim for server ${serverNum}, gameStart ${gameStart}, owner ${ownerId}`);
        return true;
    }

    /**
     * Delete a vote
     * @param {number} gameStart - Unix timestamp of match start
     * @param {number} serverNum - Server number
     */
    deleteVote(gameStart, serverNum) {
        this.reload();
        const key = `${serverNum}_${gameStart}`;
        if (this.votes[key]) {
            delete this.votes[key];
            this.save();
            logger.info(`[VoteStore] Deleted vote for server ${serverNum}, gameStart ${gameStart}`);
        }
    }

    /**
     * Clean up old votes (older than 24 hours)
     */
    cleanup() {
        this.reload();
        const cutoff = Date.now() - (24 * 60 * 60 * 1000);
        let cleaned = 0;

        for (const key of Object.keys(this.votes)) {
            if (this.votes[key].createdAt < cutoff) {
                delete this.votes[key];
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.save();
            logger.info(`[VoteStore] Cleaned up ${cleaned} old votes`);
        }
    }

    /**
     * Get service state (e.g. voteMapActive)
     * @param {string} key
     * @returns {*} Value or null
     */
    getState(key) {
        this.reload();
        return this.votes[`_state_${key}`] ?? null;
    }

    /**
     * Set service state
     * @param {string} key
     * @param {*} value
     */
    setState(key, value) {
        this.reload();
        this.votes[`_state_${key}`] = value;
        this.save();
    }
}

module.exports = new VoteStore();
