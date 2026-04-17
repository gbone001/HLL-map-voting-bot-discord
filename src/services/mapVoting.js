/**
 * Map Voting Service
 * Standalone automatic map voting system with CRCON integration
 * Integrated with Schedule Manager for time-based map pools
 */

const logger = require('../utils/logger');
const { crconService } = require('./crcon');
const scheduleManager = require('./scheduleManager');
const automodPresetManager = require('./automodPresetManager');
const voteStore = require('./voteStore');
const configManager = require('./configManager');
const queuedMapStore = require('./queuedMapStore');

const QUEUED_MAP_REAPPLY_COOLDOWN_MS = 30000;
const QUEUED_MAP_VERIFY_RETRIES = 3;
const QUEUED_MAP_VERIFY_RETRY_DELAY_MS = 1000;

class MapVotingService {
    constructor(serverNum = 1) {
        MapVotingService.instanceCounter = (MapVotingService.instanceCounter || 0) + 1;
        if (!MapVotingService.activeServicesByServer) {
            MapVotingService.activeServicesByServer = new Map();
        }
        this.serverNum = serverNum;
        this.instanceId = MapVotingService.instanceCounter;
        this.client = null;
        this.channel = null;
        this.channelId = null;
        this.crcon = null;
        this.pollInterval = null;

        // Vote state
        this.voteMessage = null;
        this.voteMessageId = null;
        this.gameActive = null;
        this.gameStart = null;
        this.voteActive = false;
        this.maps = null;
        this.voteResults = [];

        // Seeding state
        this.seeded = false;
        this.seedingMessage = null;
        this.sendSeedingMessage = true;
        this.minimumPlayers = 50;
        this.deactivatePlayers = 40;

        // Reminder state
        this.lastReminderTime = null;
        this.reminderCount = 0;
        this.reminderInterval = 50 * 60 * 1000; // 50 minutes
        this.maxReminders = 2;

        // Config
        this.voteHeader = 'Vote for the next map!';
        this.voteMapActive = false;
        this.doingMapVote = false;
        this.isRunning = false;
        this.destroyed = false;

        // Map selection config
        this.mapsPerVote = 8;
        this.nightMapCount = 1;
        this.excludeRecentMaps = 3;

        // Mode weighting
        this.modeWeights = {
            warfare: 5,
            offensive: 2,
            skirmish: 0
        };

        // Seeding rotation
        this.seedingRotation = [
            'stmariedumont_warfare',
            'stalingrad_warfare',
            'foy_warfare',
            'omahabeach_warfare'
        ];

        // Blacklist
        this.blacklist = [];

        // Messages
        this.seedingMessageText = `\n\nImportant:\n\n    Vote function available when\n        there are more than\n\n          ** ${this.minimumPlayers} Player **\n\n          on the server!\n\n`;
        this.pauseMessageText = `\n\n       Vote function is paused!\n\n   We will inform you in the channel\n  when the function is enabled again.\n\n             Stay tuned!\n\n`;

        // Cache
        this.cachedMaps = null;
        this.cachedWhitelist = null;
        this.cacheTime = 0;
        this.cacheDuration = 60000;

        // Schedule tracking
        this.lastScheduleId = null;
        this.pendingScheduleTransition = false;

        // CRCON status resilience
        this.statusFailureCount = 0;
        this.statusBackoffUntil = 0;
        this.lastStatusFailureLogAt = 0;
        this.lastServerStatus = null;
        this.lastObservedMatchMapId = null;
        this.lastObservedMatchStartEpochSeconds = null;
        this.pendingMatchStartDetection = false;
        this.voteFinalizationInProgress = false;
        this.skipNextUnseededMatchEndRotation = false;
        this.queuedNextMapId = null;
    }

    claimActiveServiceSlot() {
        const activeServices = MapVotingService.activeServicesByServer;
        const existingService = activeServices.get(this.serverNum);

        if (existingService && existingService !== this) {
            logger.warn(
                `[MapVoting S${this.serverNum}] Replacing stale service instance ${existingService.instanceId} with instance ${this.instanceId}`
            );
            existingService.deactivateAsSuperseded(this.instanceId);
        }

        activeServices.set(this.serverNum, this);
    }

    releaseActiveServiceSlot() {
        const activeServices = MapVotingService.activeServicesByServer;
        if (activeServices.get(this.serverNum) === this) {
            activeServices.delete(this.serverNum);
        }
    }

    isActiveServiceInstance() {
        const activeService = MapVotingService.activeServicesByServer?.get(this.serverNum);
        return !activeService || activeService === this;
    }

    deactivateAsSuperseded(replacingInstanceId) {
        if (this.destroyed) {
            return;
        }

        this.stopPolling();
        this.voteActive = false;
        this.isRunning = false;
        this.doingMapVote = false;
        this.destroyed = true;

        logger.warn(
            `[MapVoting S${this.serverNum}] Service instance ${this.instanceId} superseded by instance ${replacingInstanceId}; polling disabled`
        );
    }

    // ==================== INITIALIZATION ====================

    async initialize(client, channelId, crconService) {
        this.client = client;
        this.channelId = channelId;
        this.crcon = crconService;

        try {
            this.channel = await this.client.channels.fetch(this.channelId);
            if (!this.channel) {
                logger.error(`[MapVoting S${this.serverNum}] Channel not found`);
                return false;
            }

            this.claimActiveServiceSlot();
            await this.getAllMaps();
            await this.getWhitelist();

            // Clean up old votes on startup
            voteStore.cleanup();
            queuedMapStore.cleanup();

            // Restore service state from last run
            const savedState = voteStore.getState(`voteMapActive_${this.serverNum}`);
            if (savedState !== null) {
                this.voteMapActive = savedState;
                logger.info(`[MapVoting S${this.serverNum}] Restored state: ${this.voteMapActive ? 'active' : 'paused'}`);
            }

            const pendingQueuedMap = queuedMapStore.getQueuedMap(this.serverNum);
            if (pendingQueuedMap?.desiredMapId) {
                this.queuedNextMapId = pendingQueuedMap.desiredMapId;
                logger.info(
                    `[MapVoting S${this.serverNum}] Restored pending queued map: ${pendingQueuedMap.desiredMapId} (${pendingQueuedMap.source})`
                );
            }

            this.startPolling();

            logger.info(`[MapVoting S${this.serverNum}] Service initialized`);
            return true;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Failed to initialize:`, error);
            return false;
        }
    }

    // ==================== CACHE MANAGEMENT ====================

    async getAllMaps() {
        const now = Date.now();
        if (this.cachedMaps && (now - this.cacheTime) < this.cacheDuration) {
            return this.cachedMaps;
        }

        try {
            const response = await this.crcon.getMaps();
            if (response && response.result) {
                this.cachedMaps = response.result;
                this.cacheTime = now;
                return this.cachedMaps;
            }
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error fetching maps:`, error.message);
        }
        return this.cachedMaps || [];
    }

    async getWhitelist() {
        const now = Date.now();
        if (this.cachedWhitelist && (now - this.cacheTime) < this.cacheDuration) {
            return this.cachedWhitelist;
        }

        try {
            const response = await this.crcon.getVotemapWhitelist();
            if (response && response.result) {
                this.cachedWhitelist = new Set(response.result);
                this.cacheTime = now;
                return this.cachedWhitelist;
            }
        } catch (error) {
            if (error.code === 'UNSUPPORTED_TRANSPORT') {
                logger.warn(`[MapVoting S${this.serverNum}] CRCON whitelist unavailable on current transport; using all local maps`);
                return null;
            }
            logger.warn(`[MapVoting S${this.serverNum}] Could not fetch whitelist`);
        }
        return null;
    }

    clearCache() {
        this.cachedMaps = null;
        this.cachedWhitelist = null;
        this.cacheTime = 0;
    }

    getStatusBackoffMs() {
        const baseMs = 15000;
        const exponent = Math.max(this.statusFailureCount - 1, 0);
        return Math.min(baseMs * (2 ** exponent), 5 * 60 * 1000);
    }

    handleStatusFailure(error) {
        this.statusFailureCount += 1;
        const backoffMs = this.getStatusBackoffMs();
        this.statusBackoffUntil = Date.now() + backoffMs;

        const now = Date.now();
        if (this.statusFailureCount === 1 || now - this.lastStatusFailureLogAt >= 60000) {
            logger.warn(
                `[MapVoting S${this.serverNum}] CRCON get_status unavailable; failure=${this.statusFailureCount} backoff=${Math.round(backoffMs / 1000)}s reason=${error.message}`
            );
            this.lastStatusFailureLogAt = now;
        }
    }

    handleStatusRecovery() {
        if (this.statusFailureCount > 0) {
            logger.info(
                `[MapVoting S${this.serverNum}] CRCON get_status recovered after ${this.statusFailureCount} failure(s)`
            );
        }
        this.statusFailureCount = 0;
        this.statusBackoffUntil = 0;
        this.lastStatusFailureLogAt = 0;
    }

    async getServerStatus() {
        if (this.statusBackoffUntil > Date.now()) {
            return null;
        }

        try {
            const status = await this.crcon.getStatus();
            this.handleStatusRecovery();
            return status;
        } catch (error) {
            this.handleStatusFailure(error);
            return null;
        }
    }

    // ==================== VOTE PERSISTENCE ====================

    /**
     * Get current match start time from CRCON
     * This uniquely identifies each match
     */
    async getGameStartTime() {
        try {
            if (typeof this.crcon?.getMatchSnapshot === 'function') {
                const snapshot = await this.crcon.getMatchSnapshot();
                if (snapshot?.matchStartEpochSeconds) {
                    return snapshot.matchStartEpochSeconds;
                }
            }

            const response = await this.crcon.get('get_public_info');
            if (response?.result?.current_map?.start) {
                const startTime = response.result.current_map.start;
                return typeof startTime === 'number'
                    ? startTime
                    : Math.floor(new Date(startTime).getTime() / 1000);
            }
        } catch (error) {
            logger.warn(`[MapVoting S${this.serverNum}] Could not get game start time:`, error.message);
        }
        return null;
    }

    /**
     * Check if a vote already exists for the current match
     * Returns true if we resumed an existing vote, false if we need to create a new one
     */
    async checkActiveVote() {
        try {
            // Get current match start time
            this.gameStart = await this.getGameStartTime();
            if (!this.gameStart) {
                logger.warn(`[MapVoting S${this.serverNum}] No game start time available`);
                return false;
            }

            // Check if we have a stored vote for this match
            const existingVote = voteStore.getVote(this.gameStart, this.serverNum);
            if (!existingVote) {
                return false;
            }

            // Try to fetch the existing vote message
            try {
                this.voteMessageId = existingVote.messageId;
                this.voteMessage = await this.channel.messages.fetch(this.voteMessageId);

                if (this.voteMessage && this.voteMessage.poll) {
                    const isFinalized = this.voteMessage.poll.resultsFinalized === true;

                    if (!isFinalized) {
                        // Resume the existing vote
                        const livePollMaps = await this.getMapsFromPoll(this.voteMessage.poll);
                        this.maps = livePollMaps.length > 0 ? livePollMaps : (existingVote.maps || []);
                        logger.info(`[MapVoting S${this.serverNum}] Resumed existing vote (gameStart: ${this.gameStart})`);
                        return true;
                    }
                }

                // Poll is finalized or invalid, clean up
                voteStore.deleteVote(this.gameStart, this.serverNum);
                this.voteMessageId = null;
                this.voteMessage = null;
                return false;

            } catch (e) {
                // Message not found, clean up the stale record
                logger.warn(`[MapVoting S${this.serverNum}] Stored vote message not found, cleaning up`);
                voteStore.deleteVote(this.gameStart, this.serverNum);
                return false;
            }
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error checking active vote:`, error.message);
            return false;
        }
    }

    async fetchVoteMessage() {
        if (!this.voteMessageId) {
            return null;
        }

        const message = await this.channel.messages.fetch(this.voteMessageId);
        this.voteMessage = message;
        return message;
    }

    /**
     * Extract maps from an existing poll (for resuming votes)
     */
    async getMapsFromPoll(poll) {
        try {
            const maps = [];
            const allMaps = await this.getAllMaps();
            if (!allMaps) return [];

            for (const answer of poll.answers.values()) {
                const matchingMap = allMaps.find(m => m.pretty_name === answer.text);
                if (matchingMap) {
                    maps.push(this.formatMapForVote(matchingMap));
                }
            }
            return maps;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error getting maps from poll:`, error.message);
            return [];
        }
    }

    async getCurrentPollMaps(allMaps = null) {
        try {
            const message = await this.fetchVoteMessage();
            if (!message?.poll?.answers) {
                return [];
            }

            const resolvedMaps = await this.getMapsFromPoll(message.poll);
            if (resolvedMaps.length > 0) {
                this.maps = resolvedMaps;
            }
            return resolvedMaps;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error getting current poll maps:`, error.message);
            return [];
        }
    }

    // ==================== SCHEDULE INTEGRATION ====================

    /**
     * Get the active schedule and its settings
     */
    getActiveScheduleSettings() {
        try {
            const schedule = scheduleManager.getActiveSchedule(this.serverNum);
            return {
                scheduleId: schedule.id,
                scheduleName: schedule.name,
                isDefault: schedule.isDefault || false,
                isOverride: schedule.isOverride || false,
                settings: schedule.settings,
                generalSettings: schedule.generalSettings || {
                    teamSwitchCooldown: null,
                    idleAutokickTime: null,
                    maxPingAutokick: null,
                    mapVoteCooldownVotes: null
                },
                whitelist: schedule.whitelist, // null = use CRCON whitelist, array = custom
                automodConfigs: schedule.automodConfigs || {
                    level: null,
                    no_leader: null,
                    solo_tank: null
                },
                automodProfiles: schedule.automodProfiles || {
                    level: null,
                    no_leader: null,
                    solo_tank: null
                }
            };
        } catch (error) {
            logger.warn(`[MapVoting S${this.serverNum}] Error getting schedule:`, error.message);
            return {
                scheduleId: 'default',
                scheduleName: 'Default',
                isDefault: true,
                isOverride: false,
                settings: null,
                generalSettings: {
                    teamSwitchCooldown: null,
                    idleAutokickTime: null,
                    maxPingAutokick: null,
                    mapVoteCooldownVotes: null
                },
                whitelist: null,
                automodConfigs: {
                    level: null,
                    no_leader: null,
                    solo_tank: null
                },
                automodProfiles: {
                    level: null,
                    no_leader: null,
                    solo_tank: null
                }
            };
        }
    }

    /**
     * Apply schedule settings if changed
     */
    async applyScheduleSettings() {
        const schedule = this.getActiveScheduleSettings();

        // Check if schedule changed
        if (schedule.scheduleId !== this.lastScheduleId) {
            if (this.lastScheduleId !== null) {
                logger.info(`[MapVoting S${this.serverNum}] Schedule changed: ${this.lastScheduleId} -> ${schedule.scheduleId} (${schedule.scheduleName})`);

                // Mark pending transition - will apply after match ends
                if (this.gameActive && this.voteActive) {
                    this.pendingScheduleTransition = true;
                    logger.info(`[MapVoting S${this.serverNum}] Schedule transition pending until match ends`);
                } else {
                    await this.applyScheduleSettingsNow(schedule);
                }
            } else {
                // First run - apply settings immediately
                await this.applyScheduleSettingsNow(schedule);
            }
            this.lastScheduleId = schedule.scheduleId;
        }

        return schedule;
    }

    /**
     * Apply schedule settings immediately
     */
    async applyScheduleSettingsNow(schedule) {
        if (!schedule) {
            schedule = this.getActiveScheduleSettings();
        }

        if (schedule.settings) {
            // Apply schedule's settings
            if (schedule.settings.minimumPlayers !== undefined) {
                this.minimumPlayers = schedule.settings.minimumPlayers;
            }
            if (schedule.settings.deactivatePlayers !== undefined) {
                this.deactivatePlayers = schedule.settings.deactivatePlayers;
            }
            if (schedule.settings.mapsPerVote !== undefined) {
                this.mapsPerVote = schedule.settings.mapsPerVote;
            }
            if (schedule.settings.nightMapCount !== undefined) {
                this.nightMapCount = schedule.settings.nightMapCount;
            }

            logger.info(`[MapVoting S${this.serverNum}] Applied schedule "${schedule.scheduleName}" settings: ` +
                `minPlayers=${this.minimumPlayers}, mapsPerVote=${this.mapsPerVote}, nightMaps=${this.nightMapCount}`);
        }

        await this.applyScheduleAutomods(schedule);
        await this.applyScheduleGeneralSettings(schedule);

        // Clear cache to pick up new whitelist
        this.clearCache();
        this.pendingScheduleTransition = false;
    }

    async applyScheduleAutomods(schedule) {
        const configs = schedule?.automodConfigs || {};
        const profiles = schedule?.automodProfiles || {};

        const applySpec = [
            {
                type: 'level',
                directConfig: configs.level,
                presetId: profiles.level,
                setter: (cfg) => this.crcon.setAutoModLevelConfig(`schedule:${schedule.scheduleName}`, cfg, false)
            },
            {
                type: 'no_leader',
                directConfig: configs.no_leader,
                presetId: profiles.no_leader,
                setter: (cfg) => this.crcon.setAutoModNoLeaderConfig(`schedule:${schedule.scheduleName}`, cfg, false)
            },
            {
                type: 'solo_tank',
                directConfig: configs.solo_tank,
                presetId: profiles.solo_tank,
                setter: (cfg) => this.crcon.setAutoModSoloTankConfig(`schedule:${schedule.scheduleName}`, cfg, false)
            }
        ];

        for (const spec of applySpec) {
            let configToApply = null;
            let sourceLabel = null;

            if (spec.directConfig && typeof spec.directConfig === 'object' && Object.keys(spec.directConfig).length > 0) {
                configToApply = spec.directConfig;
                sourceLabel = 'schedule config';
            } else if (spec.presetId) {
                const preset = automodPresetManager.getPresetById(this.serverNum, spec.type, spec.presetId);
                if (!preset?.config) {
                    logger.warn(`[MapVoting S${this.serverNum}] Missing ${spec.type} preset ${spec.presetId} for schedule ${schedule.scheduleName}`);
                    continue;
                }
                configToApply = preset.config;
                sourceLabel = `preset "${preset.displayName}"`;
            }

            if (!configToApply) {
                continue;
            }

            try {
                await spec.setter(configToApply);
                logger.info(`[MapVoting S${this.serverNum}] Applied ${spec.type} ${sourceLabel} for schedule "${schedule.scheduleName}"`);
            } catch (error) {
                if (error.code === 'UNSUPPORTED_TRANSPORT') {
                    logger.warn(
                        `[MapVoting S${this.serverNum}] Skipping ${spec.type} ${sourceLabel} for schedule "${schedule.scheduleName}": ${error.message}`
                    );
                    continue;
                }

                logger.error(`[MapVoting S${this.serverNum}] Failed applying ${spec.type} ${sourceLabel}: ${error.message}`);
            }
        }
    }

    async applyScheduleGeneralSettings(schedule) {
        const generalSettings = schedule?.generalSettings || {};
        const applySpec = [
            {
                key: 'teamSwitchCooldown',
                value: generalSettings.teamSwitchCooldown,
                setter: (v) => this.crcon.setTeamSwitchCooldown(v)
            },
            {
                key: 'idleAutokickTime',
                value: generalSettings.idleAutokickTime,
                setter: (v) => this.crcon.setIdleAutokickTime(v)
            },
            {
                key: 'maxPingAutokick',
                value: generalSettings.maxPingAutokick,
                setter: (v) => this.crcon.setMaxPingAutokick(v)
            }
        ];

        for (const spec of applySpec) {
            if (spec.value === null || spec.value === undefined) {
                continue;
            }

            try {
                await spec.setter(spec.value);
                logger.info(
                    `[MapVoting S${this.serverNum}] Applied schedule ${spec.key}=${spec.value} for "${schedule.scheduleName}"`
                );
            } catch (error) {
                logger.error(
                    `[MapVoting S${this.serverNum}] Failed applying ${spec.key} for "${schedule.scheduleName}": ${error.message}`
                );
            }
        }

        const serverConfig = configManager.getEffectiveServerConfig(this.serverNum);
        const serverDefaultCooldown = Math.min(Math.max(parseInt(serverConfig.excludePlayedMapForXvotes ?? 3, 10) || 3, 0), 10);
        const scheduleCooldown = generalSettings.mapVoteCooldownVotes;
        if (scheduleCooldown === null || scheduleCooldown === undefined) {
            this.excludeRecentMaps = serverDefaultCooldown;
            logger.info(`[MapVoting S${this.serverNum}] Using server map vote cooldown: ${this.excludeRecentMaps}`);
        } else {
            const clamped = Math.min(Math.max(parseInt(scheduleCooldown, 10) || 0, 0), 10);
            this.excludeRecentMaps = clamped;
            logger.info(`[MapVoting S${this.serverNum}] Applied schedule map vote cooldown: ${this.excludeRecentMaps}`);
        }
    }

    /**
     * Get effective whitelist (schedule's custom whitelist or CRCON whitelist)
     */
    async getEffectiveWhitelist() {
        const schedule = this.getActiveScheduleSettings();

        // If schedule has custom whitelist, use it
        if (schedule.whitelist !== null && Array.isArray(schedule.whitelist)) {
            logger.info(`[MapVoting S${this.serverNum}] Using schedule "${schedule.scheduleName}" custom whitelist (${schedule.whitelist.length} maps)`);
            return new Set(schedule.whitelist);
        }

        // Otherwise use CRCON whitelist
        return await this.getWhitelist();
    }

    // ==================== POLLING ====================

    startPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }

        this.pollInterval = setInterval(() => {
            this.doMapVote();
        }, 5000);

        logger.info(`[MapVoting S${this.serverNum}] Automatic polling started`);
    }

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        logger.info(`[MapVoting S${this.serverNum}] Polling stopped`);
    }

    // ==================== MESSAGES ====================

    async sendSeedingMsg() {
        try {
            const msgText = this.seedingMessageText.replace(/\*\* \d+ Player \*\*/, `** ${this.minimumPlayers} Player **`);
            const message = `\`\`\`${msgText}\`\`\``;
            this.seedingMessage = await this.channel.send(message);
            logger.info(`[MapVoting S${this.serverNum}] Seeding message sent`);
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error sending seeding message:`, error.message);
        }
    }

    async sendPauseMsg() {
        try {
            const message = `\`\`\`${this.pauseMessageText}\`\`\``;
            this.seedingMessage = await this.channel.send(message);
            logger.info(`[MapVoting S${this.serverNum}] Pause message sent`);
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error sending pause message:`, error.message);
        }
    }

    async clearAllMessages(exceptMessageId = null) {
        try {
            const messages = await this.channel.messages.fetch({ limit: 100 });

            for (const [msgId, msg] of messages) {
                if (exceptMessageId && String(msgId) === String(exceptMessageId)) continue;
                if (msg.author.id === this.client.user.id) {
                    try {
                        await msg.delete();
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (e) {
                        // Ignore
                    }
                }
            }
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error clearing messages:`, error.message);
        }
    }

    sleep(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    getPendingQueuedMap() {
        const pendingEntry = queuedMapStore.getQueuedMap(this.serverNum);
        this.queuedNextMapId = pendingEntry?.desiredMapId || null;
        return pendingEntry;
    }

    async readLiveQueuedMapState() {
        const publicInfoState = typeof this.crcon?.getPublicInfoState === 'function'
            ? await this.crcon.getPublicInfoState()
            : null;

        if (publicInfoState) {
            return publicInfoState;
        }

        if (typeof this.crcon?.getMatchSnapshot === 'function') {
            const snapshot = await this.crcon.getMatchSnapshot();
            return {
                currentMapId: snapshot?.currentMapId || null,
                nextMapId: snapshot?.nextMapId || null,
                currentPlayers: snapshot?.currentPlayers ?? null,
                gameActive: snapshot?.gameActive ?? null,
                matchStartEpochSeconds: snapshot?.matchStartEpochSeconds ?? null
            };
        }

        return {
            currentMapId: null,
            nextMapId: null,
            currentPlayers: null,
            gameActive: null,
            matchStartEpochSeconds: null
        };
    }

    async ensureDesiredNextMap(mapId, source, options = {}) {
        const pendingEntry = queuedMapStore.upsertQueuedMap(this.serverNum, {
            desiredMapId: mapId,
            source,
            gameStart: options.gameStart ?? this.gameStart ?? null,
            voteMessageId: options.voteMessageId ?? this.voteMessageId ?? null
        });
        this.queuedNextMapId = mapId;

        let latestLiveState = null;
        let lastError = null;

        for (let attempt = 1; attempt <= QUEUED_MAP_VERIFY_RETRIES; attempt += 1) {
            try {
                await this.crcon.queueNextMap(mapId);
                latestLiveState = await this.readLiveQueuedMapState();

                queuedMapStore.noteEnforcement(this.serverNum, {
                    currentMapId: latestLiveState?.currentMapId ?? null,
                    nextMapId: latestLiveState?.nextMapId ?? null,
                    incrementReapplyCount: attempt > 1
                });

                if (latestLiveState?.currentMapId === mapId) {
                    queuedMapStore.markQueuedMapConsumed(this.serverNum, {
                        actualMapId: mapId,
                        currentMapId: mapId,
                        nextMapId: latestLiveState?.nextMapId ?? null
                    });
                    this.queuedNextMapId = null;
                    return {
                        queued: true,
                        consumed: true,
                        liveState: latestLiveState
                    };
                }

                if (latestLiveState?.nextMapId === mapId) {
                    queuedMapStore.markQueuedMapVerified(this.serverNum, {
                        currentMapId: latestLiveState?.currentMapId ?? null,
                        nextMapId: mapId
                    });
                    return {
                        queued: true,
                        consumed: false,
                        liveState: latestLiveState
                    };
                }

                lastError = new Error(
                    `expected next map ${mapId} but live next map is ${latestLiveState?.nextMapId || 'unknown'}`
                );
            } catch (error) {
                lastError = error;
                queuedMapStore.noteEnforcement(this.serverNum, {
                    currentMapId: latestLiveState?.currentMapId ?? null,
                    nextMapId: latestLiveState?.nextMapId ?? null,
                    lastError: error.message,
                    incrementReapplyCount: attempt > 1
                });
            }

            if (attempt < QUEUED_MAP_VERIFY_RETRIES) {
                await this.sleep(QUEUED_MAP_VERIFY_RETRY_DELAY_MS * attempt);
            }
        }

        queuedMapStore.updateQueuedMap(this.serverNum, (entry) => ({
            ...entry,
            lastError: lastError?.message || 'unknown queue verification failure'
        }));

        throw lastError || new Error(`Failed to verify queued next map ${mapId}`);
    }

    async reapplyPendingQueuedMap(pendingEntry, reason, liveState = null) {
        if (!pendingEntry?.desiredMapId) {
            return false;
        }

        const now = Date.now();
        if (pendingEntry.lastEnforcedAt && now - pendingEntry.lastEnforcedAt < QUEUED_MAP_REAPPLY_COOLDOWN_MS) {
            return false;
        }

        logger.warn(
            `[MapVoting S${this.serverNum}] Reapplying queued map ${pendingEntry.desiredMapId} because ${reason}`
        );

        try {
            await this.ensureDesiredNextMap(pendingEntry.desiredMapId, pendingEntry.source, {
                gameStart: pendingEntry.gameStart ?? null,
                voteMessageId: pendingEntry.voteMessageId ?? null
            });
            return true;
        } catch (error) {
            logger.error(
                `[MapVoting S${this.serverNum}] Failed to reapply queued map ${pendingEntry.desiredMapId}: ${error.message}`
            );
            queuedMapStore.updateQueuedMap(this.serverNum, (entry) => ({
                ...entry,
                lastObservedCurrentMapId: liveState?.currentMapId ?? entry.lastObservedCurrentMapId ?? null,
                lastObservedNextMapId: liveState?.nextMapId ?? entry.lastObservedNextMapId ?? null,
                lastError: error.message
            }));
            return false;
        }
    }

    async reconcilePendingQueuedMap(snapshot) {
        const pendingEntry = this.getPendingQueuedMap();
        if (!pendingEntry?.desiredMapId) {
            return {
                pendingEntry: null,
                awaitingQueuedTransition: false,
                consumed: false,
                failed: false
            };
        }

        const desiredMapId = pendingEntry.desiredMapId;
        const currentMapId = snapshot?.currentMapId || null;
        const nextMapId = snapshot?.nextMapId || null;
        const currentMatchStartEpochSeconds = snapshot?.matchStartEpochSeconds ?? null;
        const sourceMatchStartEpochSeconds = pendingEntry.gameStart ?? null;

        if (currentMapId === desiredMapId) {
            logger.info(`[MapVoting S${this.serverNum}] Observed queued next map live: ${currentMapId}`);
            queuedMapStore.markQueuedMapConsumed(this.serverNum, {
                actualMapId: currentMapId,
                currentMapId,
                nextMapId
            });
            this.queuedNextMapId = null;
            return {
                pendingEntry: null,
                awaitingQueuedTransition: false,
                consumed: true,
                failed: false
            };
        }

        const sameMatchStillRunning = Number.isFinite(sourceMatchStartEpochSeconds) &&
            Number.isFinite(currentMatchStartEpochSeconds) &&
            currentMatchStartEpochSeconds === sourceMatchStartEpochSeconds;

        if (sameMatchStillRunning) {
            if (nextMapId !== desiredMapId) {
                await this.reapplyPendingQueuedMap(pendingEntry, 'live next map drifted before match transition', snapshot);
            } else {
                queuedMapStore.markQueuedMapVerified(this.serverNum, {
                    currentMapId,
                    nextMapId
                });
            }

            return {
                pendingEntry,
                awaitingQueuedTransition: true,
                consumed: false,
                failed: false
            };
        }

        const advancedToDifferentMatch = Number.isFinite(sourceMatchStartEpochSeconds) &&
            Number.isFinite(currentMatchStartEpochSeconds) &&
            currentMatchStartEpochSeconds > sourceMatchStartEpochSeconds;

        if (advancedToDifferentMatch && currentMapId && currentMapId !== desiredMapId) {
            logger.error(
                `[MapVoting S${this.serverNum}] Queued winner ${desiredMapId} was not played next; live map started on ${currentMapId}`
            );
            queuedMapStore.markQueuedMapFailed(this.serverNum, {
                failureReason: 'wrong_map_started',
                actualMapId: currentMapId,
                currentMapId,
                nextMapId,
                lastError: `expected ${desiredMapId} but observed ${currentMapId}`
            });
            this.queuedNextMapId = null;
            return {
                pendingEntry: null,
                awaitingQueuedTransition: false,
                consumed: false,
                failed: true
            };
        }

        if (nextMapId !== desiredMapId) {
            await this.reapplyPendingQueuedMap(pendingEntry, 'queued winner no longer matches live next map', snapshot);
        } else {
            queuedMapStore.markQueuedMapVerified(this.serverNum, {
                currentMapId,
                nextMapId
            });
        }

        return {
            pendingEntry,
            awaitingQueuedTransition: false,
            consumed: false,
            failed: false
        };
    }

    // ==================== GAME STATE ====================

    async getGameState() {
        try {
            if (typeof this.crcon?.getMatchSnapshot === 'function') {
                const snapshot = await this.crcon.getMatchSnapshot();
                const currentMapId = snapshot?.currentMapId || null;
                const currentMatchStartEpochSeconds = snapshot?.matchStartEpochSeconds ?? null;

                if (!currentMapId) {
                    if (this.gameActive === null) {
                        this.gameActive = false;
                    }
                    return this.gameActive;
                }

                const pendingQueueState = await this.reconcilePendingQueuedMap(snapshot);

                if (pendingQueueState.awaitingQueuedTransition) {
                    this.lastObservedMatchMapId = currentMapId;
                    this.lastObservedMatchStartEpochSeconds = currentMatchStartEpochSeconds;
                    this.gameActive = false;
                    return this.gameActive;
                }

                if (!this.lastObservedMatchMapId) {
                    this.lastObservedMatchMapId = currentMapId;
                    this.lastObservedMatchStartEpochSeconds = currentMatchStartEpochSeconds;
                    this.gameActive = true;
                    return this.gameActive;
                }

                const matchStartChanged = Number.isFinite(currentMatchStartEpochSeconds) &&
                    Number.isFinite(this.lastObservedMatchStartEpochSeconds) &&
                    this.lastObservedMatchStartEpochSeconds !== currentMatchStartEpochSeconds;

                if (this.lastObservedMatchMapId !== currentMapId || matchStartChanged) {
                    this.lastObservedMatchMapId = currentMapId;
                    this.lastObservedMatchStartEpochSeconds = currentMatchStartEpochSeconds;
                    this.pendingMatchStartDetection = true;
                    this.gameActive = false;
                    return this.gameActive;
                }

                if (this.pendingMatchStartDetection) {
                    this.pendingMatchStartDetection = false;
                }

                this.lastObservedMatchStartEpochSeconds = currentMatchStartEpochSeconds;
                this.gameActive = true;
                return this.gameActive;
            }

            const payload = {
                end: 10000,
                filter_action: ['MATCH ENDED', 'MATCH START'],
                filter_player: [],
                inclusive_filter: true
            };

            const response = await this.crcon.post('get_recent_logs', payload);

            if (!response || !response.result || !response.result.logs || response.result.logs.length === 0) {
                if (this.gameActive === null) {
                    this.gameActive = false;
                }
                return this.gameActive;
            }

            const latestLog = response.result.logs[0];
            const logText = latestLog.raw || latestLog.message || '';

            if (logText.includes('MATCH START')) {
                this.gameActive = true;
            } else if (logText.includes('MATCH ENDED')) {
                this.gameActive = false;
            }

            return this.gameActive;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error getting game state:`, error.message);
            return this.gameActive;
        }
    }

    // ==================== MAP SELECTION ====================

    /**
     * Fisher-Yates shuffle algorithm for proper randomization
     */
    shuffleArray(array) {
        const result = [...array];
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
    }

    normalizeMapKey(value) {
        if (value === undefined || value === null) return null;
        return String(value).trim().toLowerCase();
    }

    getMapAliases(map) {
        return [
            map?.id,
            map?.pretty_name,
            map?.name,
            map?.map?.id,
            map?.map?.name,
            map?.map?.pretty_name
        ]
            .map(value => this.normalizeMapKey(value))
            .filter(Boolean);
    }

    buildCanonicalMapLookup(allMaps) {
        const lookup = new Map();

        for (const map of allMaps) {
            for (const alias of this.getMapAliases(map)) {
                lookup.set(alias, map.id);
            }
        }

        return lookup;
    }

    getRecentMapIds(historyEntries, canonicalMapLookup) {
        const recentMapIds = new Set();

        for (const entry of historyEntries) {
            const aliases = [
                entry?.map_id,
                entry?.id,
                entry?.name,
                entry?.pretty_name,
                entry?.map?.id,
                entry?.map?.name,
                entry?.map?.pretty_name
            ]
                .map(value => this.normalizeMapKey(value))
                .filter(Boolean);

            for (const alias of aliases) {
                recentMapIds.add(canonicalMapLookup.get(alias) || alias);
            }
        }

        return recentMapIds;
    }

    resolveMapIdFromPayload(mapPayload, canonicalMapLookup) {
        if (!mapPayload) {
            return null;
        }

        const aliases = [
            mapPayload?.map_id,
            mapPayload?.id,
            mapPayload?.name,
            mapPayload?.pretty_name,
            mapPayload?.map?.id,
            mapPayload?.map?.name,
            mapPayload?.map?.pretty_name
        ]
            .map(value => this.normalizeMapKey(value))
            .filter(Boolean);

        for (const alias of aliases) {
            const canonicalId = canonicalMapLookup.get(alias) || alias;
            if (canonicalId) {
                return canonicalId;
            }
        }

        return null;
    }

    async getCurrentMapId(allMaps, canonicalMapLookup = this.buildCanonicalMapLookup(allMaps)) {
        const resolveCurrentMapId = (statusPayload) => {
            if (!statusPayload?.result) {
                return null;
            }

            return this.resolveMapIdFromPayload(
                statusPayload.result.map || statusPayload.result.current_map || statusPayload.result,
                canonicalMapLookup
            );
        };

        const cachedCurrentMapId = resolveCurrentMapId(this.lastServerStatus);
        if (cachedCurrentMapId) {
            return cachedCurrentMapId;
        }

        if (typeof this.crcon?.getStatus === 'function') {
            try {
                if (typeof this.crcon?.getMatchSnapshot === 'function') {
                    const snapshot = await this.crcon.getMatchSnapshot();
                    if (snapshot?.currentMapId) {
                        return snapshot.currentMapId;
                    }
                }

                const liveStatus = await this.crcon.getStatus();
                this.lastServerStatus = liveStatus;
                return resolveCurrentMapId(liveStatus);
            } catch (error) {
                logger.warn(`[MapVoting S${this.serverNum}] Could not fetch current map for exclusion: ${error.message}`);
            }
        }

        return null;
    }

    async getRecentExcludedMapIds(allMaps) {
        const canonicalMapLookup = this.buildCanonicalMapLookup(allMaps);
        let recentMapIds = new Set();
        try {
            const historyResponse = await this.crcon.getMapHistory();
            if (historyResponse?.result && Array.isArray(historyResponse.result)) {
                const recentMaps = historyResponse.result.slice(0, this.excludeRecentMaps);
                recentMapIds = this.getRecentMapIds(recentMaps, canonicalMapLookup);
            }
        } catch (e) {
            logger.warn(`[MapVoting S${this.serverNum}] Could not fetch map history: ${e.message}`);
        }

        const currentMapId = await this.getCurrentMapId(allMaps, canonicalMapLookup);
        if (currentMapId) {
            recentMapIds.add(currentMapId);
        }

        return recentMapIds;
    }

    async getMapsToVote() {
        try {
            const allMaps = await this.getAllMaps();
            if (!allMaps || allMaps.length === 0) {
                return null;
            }

            const recentMapIds = await this.getRecentExcludedMapIds(allMaps);
            const currentMapId = await this.getCurrentMapId(allMaps);

            if (recentMapIds.size > 0) {
                logger.info(`[MapVoting S${this.serverNum}] Excluding ${recentMapIds.size} recent map IDs: ${[...recentMapIds].join(', ')}`);
            }

            // Use effective whitelist (schedule's or CRCON's)
            const whitelist = await this.getEffectiveWhitelist();
            const useWhitelist = whitelist && whitelist.size > 0;

            // Filter available maps
            const availableMaps = allMaps.filter(map => {
                if (useWhitelist && !whitelist.has(map.id)) return false;
                if (this.blacklist.includes(map.id)) return false;
                if (map.game_mode === 'skirmish' && this.modeWeights.skirmish === 0) return false;
                // Exclude recently played maps
                if (recentMapIds.has(map.id)) return false;
                return true;
            });

            // Group by mode
            const mapsByMode = {
                warfare: { day: [], night: [] },
                offensive: { day: [], night: [] }
            };

            for (const map of availableMaps) {
                const mode = map.game_mode;
                const isNight = map.environment === 'night';
                const timeKey = isNight ? 'night' : 'day';
                if (mapsByMode[mode]) {
                    mapsByMode[mode][timeKey].push(map);
                }
            }

            // Select maps (capped at mapsPerVote)
            const result = [];
            const usedMapIds = new Set();
            const dayMapsNeeded = this.mapsPerVote - this.nightMapCount;

            // Warfare day maps
            const shuffledWarfare = this.shuffleArray(mapsByMode.warfare.day);
            for (let i = 0; i < this.modeWeights.warfare && i < shuffledWarfare.length && result.length < dayMapsNeeded; i++) {
                const map = shuffledWarfare[i];
                if (!usedMapIds.has(map.id)) {
                    result.push(this.formatMapForVote(map));
                    usedMapIds.add(map.id);
                }
            }

            // Offensive day maps
            const shuffledOffensive = this.shuffleArray(mapsByMode.offensive.day);
            for (let i = 0; i < this.modeWeights.offensive && i < shuffledOffensive.length && result.length < dayMapsNeeded; i++) {
                const map = shuffledOffensive[i];
                if (!usedMapIds.has(map.id)) {
                    result.push(this.formatMapForVote(map));
                    usedMapIds.add(map.id);
                }
            }

            // Night maps
            const allNightMaps = [...mapsByMode.warfare.night, ...mapsByMode.offensive.night]
                .filter(m => !usedMapIds.has(m.id));
            const nightMaps = this.shuffleArray(allNightMaps);

            for (let i = 0; i < this.nightMapCount && i < nightMaps.length && result.length < this.mapsPerVote; i++) {
                result.push(this.formatMapForVote(nightMaps[i]));
                usedMapIds.add(nightMaps[i].id);
            }

            // Fill remaining slots with day maps if needed
            if (result.length < this.mapsPerVote) {
                const remainingDay = [...shuffledWarfare, ...shuffledOffensive]
                    .filter(m => !usedMapIds.has(m.id));
                for (const map of remainingDay) {
                    if (result.length >= this.mapsPerVote) break;
                    result.push(this.formatMapForVote(map));
                    usedMapIds.add(map.id);
                }
            }

            // Shuffle final result
            for (let i = result.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [result[i], result[j]] = [result[j], result[i]];
            }

            const mapNames = result.map(m => m.id).join(', ');
            logger.info(`[MapVoting S${this.serverNum}] Selected ${result.length} maps for vote: ${mapNames}`);

            if (currentMapId && result.some(map => map.id === currentMapId)) {
                logger.warn(`[MapVoting S${this.serverNum}] Selected map list still includes current map: ${currentMapId}`);
            }

            return result;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error getting maps to vote:`, error.message);
            return [];
        }
    }

    async applyNonSeededRotation() {
        try {
            const nonSeededMapList = configManager.getNonSeededMapList(this.serverNum);
            const allMaps = await this.getAllMaps();
            if (!allMaps?.length) {
                return false;
            }

            let desiredMapIds = new Set(nonSeededMapList);
            if (!desiredMapIds.size) {
                const whitelist = await this.getEffectiveWhitelist();
                const fallbackMaps = allMaps.filter(map => {
                    if (this.blacklist.includes(map.id)) {
                        return false;
                    }
                    if (whitelist && whitelist.size > 0 && !whitelist.has(map.id)) {
                        return false;
                    }
                    return true;
                });

                desiredMapIds = new Set(fallbackMaps.map(map => map.id));
                logger.warn(
                    `[MapVoting S${this.serverNum}] Non-seeded map list is empty; falling back to ${desiredMapIds.size} available map(s)`
                );
            }

            const configuredMaps = allMaps.filter(map => desiredMapIds.has(map.id) && !this.blacklist.includes(map.id));
            if (!configuredMaps.length) {
                logger.warn(`[MapVoting S${this.serverNum}] Non-seeded map list is configured but no valid maps are currently available`);
                return false;
            }

            const recentMapIds = await this.getRecentExcludedMapIds(allMaps);
            const currentMapId = await this.getCurrentMapId(allMaps);
            const alternateMaps = currentMapId
                ? configuredMaps.filter(map => map.id !== currentMapId)
                : configuredMaps;
            const cooldownEligibleMaps = alternateMaps.filter(map => !recentMapIds.has(map.id));
            const selectionPool = cooldownEligibleMaps.length > 0
                ? cooldownEligibleMaps
                : alternateMaps.length > 0
                    ? alternateMaps
                    : configuredMaps;
            const selectedMap = selectionPool[Math.floor(Math.random() * selectionPool.length)];

            if (!selectedMap) {
                return false;
            }

            if (currentMapId && selectedMap.id === currentMapId) {
                logger.warn(
                    `[MapVoting S${this.serverNum}] Re-selecting current map ${currentMapId} because no alternative non-seeded maps were available`
                );
            }

            await this.ensureDesiredNextMap(selectedMap.id, 'non-seeded-rotation', {
                gameStart: this.gameStart ?? null
            });
            logger.info(`[MapVoting S${this.serverNum}] Applied non-seeded rotation map: ${selectedMap.id}`);
            return true;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Failed to apply non-seeded rotation: ${error.message}`);
            return false;
        }
    }

    formatMapForVote(map) {
        return {
            id: map.id,
            name: map.map?.name || map.id,
            mode: map.game_mode,
            time: map.environment,
            pretty_name: map.pretty_name
        };
    }

    // ==================== VOTE RESULTS ====================

    async getResults() {
        try {
            this.voteResults = [];
            const message = await this.fetchVoteMessage();

            if (!message.poll || !message.poll.answers) {
                return null;
            }

            const answers = [];

            for (const answer of message.poll.answers.values()) {
                try {
                    const voters = await answer.voters.fetch();
                    const voteCount = voters.size;
                    answers.push([answer.text, voteCount]);
                    this.voteResults.push([answer.text, voteCount]);
                } catch (e) {
                    answers.push([answer.text, answer.voteCount || 0]);
                    this.voteResults.push([answer.text, answer.voteCount || 0]);
                }
            }

            answers.sort((a, b) => b[1] - a[1]);
            return answers;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error getting results:`, error.message);
            return null;
        }
    }

    async getVoteResult(mapResults, candidateMaps = this.maps) {
        try {
            let candidates = [];
            let voteCount = -1;

            for (const item of mapResults) {
                if (item[1] >= voteCount) {
                    if (item[1] > voteCount) {
                        candidates = [];
                        voteCount = item[1];
                    }
                    candidates.push(item);
                }
            }

            let voteResult = null;
            if (candidates.length === 1) {
                voteResult = candidates[0][0];
            } else if (candidates.length > 1) {
                const i = Math.floor(Math.random() * candidates.length);
                voteResult = candidates[i][0];
            }

            if (!voteResult) return null;

            for (const map of candidateMaps || []) {
                if (map.pretty_name === voteResult) {
                    logger.info(`[MapVoting S${this.serverNum}] Vote Result: ${map.id}`);
                    return map.id;
                }
            }

            return null;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error getting vote result:`, error.message);
            return null;
        }
    }

    async setVoteResult() {
        try {
            const allMaps = await this.getAllMaps();
            const recentMapIds = allMaps?.length > 0 ? await this.getRecentExcludedMapIds(allMaps) : new Set();
            const currentMapId = allMaps?.length > 0 ? await this.getCurrentMapId(allMaps) : null;
            const currentPollMaps = await this.getCurrentPollMaps(allMaps);
            const candidateMaps = currentPollMaps.length > 0 ? currentPollMaps : (Array.isArray(this.maps) ? this.maps : []);
            const mapResults = await this.getResults();
            let mapId = null;

            if (mapResults) {
                mapId = await this.getVoteResult(mapResults, candidateMaps);
            }

            // If no vote result (0 votes or error), pick random from available maps
            if (!mapId && candidateMaps.length > 0) {
                const randomIndex = Math.floor(Math.random() * candidateMaps.length);
                mapId = candidateMaps[randomIndex].id;
                logger.info(`[MapVoting S${this.serverNum}] No votes cast, picking random: ${mapId}`);
            }

            if (mapId) {
                const recentExcludedSummary = recentMapIds.size > 0 ? [...recentMapIds].join(', ') : 'none';
                logger.info(
                    `[MapVoting S${this.serverNum}] Vote finalization context: currentMap=${currentMapId || 'unknown'} recentExcluded=${recentExcludedSummary} selected=${mapId}`
                );

                if (currentMapId && mapId === currentMapId) {
                    logger.error(`[MapVoting S${this.serverNum}] Refusing to queue voted map because it matches the live current map: ${mapId}`);
                    throw new Error(`Vote selected the live current map ${mapId}`);
                }

                logger.info(`[MapVoting S${this.serverNum}] Setting next map: ${mapId}`);
                await this.ensureDesiredNextMap(mapId, 'seeded-vote', {
                    gameStart: this.gameStart ?? null,
                    voteMessageId: this.voteMessageId ?? null
                });
            } else {
                logger.warn(`[MapVoting S${this.serverNum}] Could not determine next map`);
            }

            return mapId;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error setting vote result:`, error.message);
            throw error;
        }
    }

    // ==================== VOTE CONTROL ====================

    async startVote() {
        if (this.destroyed) return;
        if (this.voteActive) return; // Already voting

        // Set flag immediately to prevent race condition
        this.voteActive = true;

        try {
            // Check if we already have a vote for this match
            const existingVote = await this.checkActiveVote();
            if (existingVote) {
                // Already have a vote for this match, just resume
                logger.info(`[MapVoting S${this.serverNum}] Using existing vote for this match`);
                return;
            }

            // Get maps for new vote
            this.maps = await this.getMapsToVote();
            if (!this.maps || this.maps.length === 0) {
                logger.warn(`[MapVoting S${this.serverNum}] No maps available for voting`);
                this.voteActive = false;
                return;
            }

            // Get game start time for this match
            this.gameStart = await this.getGameStartTime();

            const pollData = {
                question: { text: 'Vote for the next map:' },
                answers: this.maps.map(map => ({ text: map.pretty_name })),
                duration: 2,
                allowMultiselect: false
            };

            this.voteMessage = await this.channel.send({ poll: pollData });
            this.voteMessageId = this.voteMessage.id;

            // Store vote in database
            if (this.gameStart) {
                voteStore.setVote(this.voteMessageId, this.gameStart, this.serverNum, this.maps);
            }

            logger.info(`[MapVoting S${this.serverNum}] Vote started with ${this.maps.length} maps (gameStart: ${this.gameStart})`);
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error starting vote:`, error.message);
            this.voteActive = false;
        }
    }

    async stopVote() {
        if (this.voteFinalizationInProgress) {
            logger.warn(`[MapVoting S${this.serverNum}] Vote finalization already in progress; skipping duplicate stopVote`);
            return null;
        }

        this.voteFinalizationInProgress = true;
        const voteMessageId = this.voteMessageId;
        const gameStart = this.gameStart;
        const finalizationOwnerId = `${process.pid}:${this.serverNum}:${this.instanceId}:${voteMessageId || 'no-message'}`;
        let finalizationClaimed = false;

        try {
            if (gameStart && voteMessageId) {
                const claimResult = voteStore.claimVoteFinalization(
                    gameStart,
                    this.serverNum,
                    voteMessageId,
                    finalizationOwnerId
                );

                if (!claimResult.claimed) {
                    logger.warn(
                        `[MapVoting S${this.serverNum}] Skipping duplicate vote finalization for message ${voteMessageId}: ${claimResult.reason || 'unknown'}`
                    );
                    this.voteActive = false;
                    return null;
                }

                finalizationClaimed = true;
            }

            if (this.voteMessage && this.voteMessage.poll) {
                try {
                    await this.voteMessage.poll.end();
                } catch (error) {
                    const message = error?.message || '';
                    if (!message.includes('already expired')) {
                        throw error;
                    }

                    logger.warn(
                        `[MapVoting S${this.serverNum}] Poll already expired before finalization; continuing with vote result processing`
                    );
                }
            }
            const finalizedMapId = await this.setVoteResult();

            if (finalizationClaimed) {
                voteStore.completeVoteFinalization(
                    gameStart,
                    this.serverNum,
                    finalizationOwnerId,
                    finalizedMapId
                );
            }

            // Clean up vote from store
            if (gameStart) {
                voteStore.deleteVote(gameStart, this.serverNum);
            }

            this.voteActive = false;
            logger.info(`[MapVoting S${this.serverNum}] Vote stopped`);
            return finalizedMapId;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error stopping vote:`, error.message);
            if (finalizationClaimed && gameStart) {
                voteStore.releaseVoteFinalization(gameStart, this.serverNum, finalizationOwnerId);
            }
            this.voteActive = false;
            return null;
        } finally {
            this.voteFinalizationInProgress = false;
        }
    }

    // ==================== MAIN LOOP ====================

    async doMapVote() {
        if (this.destroyed) return;
        if (!this.isActiveServiceInstance()) {
            this.deactivateAsSuperseded('active-registry');
            return;
        }
        if (this.isRunning) return;

        this.isRunning = true;
        this.doingMapVote = true;

        try {
            // Check for schedule changes
            await this.applyScheduleSettings();

            const previousGameActive = this.gameActive;
            await this.getGameState();

            // Detect match end
            const matchEnded = previousGameActive === true && this.gameActive === false;

            if (matchEnded) {
                // Clear match-based overrides
                scheduleManager.onMatchEnd(this.serverNum);

                // Apply pending schedule transition
                if (this.pendingScheduleTransition) {
                    logger.info(`[MapVoting S${this.serverNum}] Match ended - applying pending schedule transition`);
                    await this.applyScheduleSettingsNow();
                }
            }

            const status = await this.getServerStatus();
            this.lastServerStatus = status;
            if (!status || !status.result) {
                this.isRunning = false;
                this.doingMapVote = false;
                return;
            }

            const currentPlayers = status.result.current_players || 0;
            const wasSeeded = this.seeded;
            const votingEnabled = this.voteMapActive;
            let finalizedVoteThisTick = false;

            if (currentPlayers >= this.minimumPlayers && !this.seeded) {
                logger.info(`[MapVoting S${this.serverNum}] Server reached ${this.minimumPlayers} players!`);
                this.seeded = true;
            } else if (currentPlayers <= this.deactivatePlayers) {
                if (this.seeded) {
                    logger.info(`[MapVoting S${this.serverNum}] Server dropped below ${this.deactivatePlayers} players`);
                }
                this.seeded = false;
            }

            const justDroppedOutOfSeeded = wasSeeded && !this.seeded;

            if (justDroppedOutOfSeeded && this.voteActive) {
                logger.info(`[MapVoting S${this.serverNum}] Seeded state lost while vote active, finalizing current vote`);
                const finalizedMapId = await this.stopVote();
                if (finalizedMapId) {
                    this.skipNextUnseededMatchEndRotation = true;
                }
                this.lastReminderTime = null;
                finalizedVoteThisTick = true;
            }

            if (votingEnabled && this.seeded) {
                if (this.gameActive && !this.voteActive) {
                    logger.info(`[MapVoting S${this.serverNum}] Starting vote...`);
                    await this.clearAllMessages();
                    await this.startVote();
                    this.lastReminderTime = Date.now();
                    this.reminderCount = 0;
                } else if (!this.gameActive && this.voteActive) {
                    logger.info(`[MapVoting S${this.serverNum}] Game over, stopping vote...`);
                    await this.stopVote();
                    this.lastReminderTime = null;
                }

                if (!this.sendSeedingMessage) {
                    this.sendSeedingMessage = true;
                }
            } else {
                if (votingEnabled && this.sendSeedingMessage) {
                    await this.clearAllMessages();
                    await this.sendSeedingMsg();
                    this.voteActive = false;
                    this.sendSeedingMessage = false;
                }

                if (matchEnded && !finalizedVoteThisTick) {
                    const pendingQueuedMap = this.getPendingQueuedMap();
                    if (pendingQueuedMap?.desiredMapId && pendingQueuedMap.source === 'seeded-vote') {
                        logger.info(
                            `[MapVoting S${this.serverNum}] Skipping non-seeded rotation because seeded vote winner ${pendingQueuedMap.desiredMapId} is still pending`
                        );
                    } else if (this.skipNextUnseededMatchEndRotation) {
                        logger.info(`[MapVoting S${this.serverNum}] Skipping non-seeded rotation because a seeded vote already selected the next map`);
                        this.skipNextUnseededMatchEndRotation = false;
                    } else {
                        await this.applyNonSeededRotation();
                    }
                }
            }
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error in doMapVote:`, error.message);
        } finally {
            this.doingMapVote = false;
            this.isRunning = false;
        }
    }

    // ==================== EVENT HANDLERS ====================

    async onPollVoteAdd(pollAnswer, userId) {
        try {
            const messageId = pollAnswer.poll?.message?.id || pollAnswer.messageId;

            if (this.voteMessageId && this.gameActive && this.voteActive) {
                if (String(messageId) !== String(this.voteMessageId)) return;

                const user = await this.client.users.fetch(userId);
                const answerId = pollAnswer.id;

                this.voteMessage = await this.channel.messages.fetch(this.voteMessageId);
                const answerText = this.voteMessage.poll?.answers?.get(answerId)?.text || `Option ${answerId}`;

                logger.info(`[MapVoting S${this.serverNum}] ${user.username} voted for ${answerText}`);
            }
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error handling vote:`, error.message);
        }
    }

    async onPollVoteRemove(pollAnswer, userId) {
        try {
            const messageId = pollAnswer.poll?.message?.id || pollAnswer.messageId;

            if (this.voteMessageId && this.gameActive && this.voteActive) {
                if (String(messageId) !== String(this.voteMessageId)) return;

                const user = await this.client.users.fetch(userId);
                logger.info(`[MapVoting S${this.serverNum}] ${user.username} removed vote`);
            }
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error handling vote remove:`, error.message);
        }
    }

    // ==================== COMMANDS ====================

    async pause(userName) {
        if (!this.voteMapActive) return false;

        this.voteMapActive = false;
        voteStore.setState(`voteMapActive_${this.serverNum}`, false);
        logger.info(`[MapVoting S${this.serverNum}] Paused by ${userName}`);

        while (this.doingMapVote) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (this.seeded) {
            await this.stopVote();
        }

        await this.clearAllMessages();
        await this.sendPauseMsg();

        this.resetVoteVariables();
        return true;
    }

    async resume(userName) {
        if (this.voteMapActive) return false;

        this.voteMapActive = true;
        voteStore.setState(`voteMapActive_${this.serverNum}`, true);
        this.clearCache();
        logger.info(`[MapVoting S${this.serverNum}] Started by ${userName}`);
        return true;
    }

    resetVoteVariables() {
        this.voteMessage = null;
        this.voteMessageId = null;
        this.seedingMessage = null;
        this.gameStart = null;
        this.gameActive = null;
        this.voteActive = false;
        this.maps = null;
        this.voteResults = [];
        this.reminderCount = 0;
        this.lastReminderTime = null;
        this.sendSeedingMessage = true;
        this.seeded = false;
        this.skipNextUnseededMatchEndRotation = false;
        this.queuedNextMapId = null;
    }

    getStatus() {
        return this.voteMapActive ? 'running' : 'stopped';
    }

    getConfig() {
        const schedule = this.getActiveScheduleSettings();

        return {
            voteMapActive: this.voteMapActive,
            voteActive: this.voteActive,
            seeded: this.seeded,
            minimumPlayers: this.minimumPlayers,
            deactivatePlayers: this.deactivatePlayers,
            mapsPerVote: this.mapsPerVote,
            nightMapCount: this.nightMapCount,
            modeWeights: this.modeWeights,
            blacklist: this.blacklist,
            excludeRecentMaps: this.excludeRecentMaps,
            nonSeededMapListCount: configManager.getNonSeededMapList(this.serverNum).length,
            // Schedule info
            activeSchedule: {
                id: schedule.scheduleId,
                name: schedule.scheduleName,
                isDefault: schedule.isDefault,
                isOverride: schedule.isOverride,
                hasCustomWhitelist: schedule.whitelist !== null
            },
            pendingScheduleTransition: this.pendingScheduleTransition
        };
    }

    setConfig(key, value) {
        switch (key) {
            case 'minimumPlayers':
                this.minimumPlayers = parseInt(value) || 50;
                break;
            case 'deactivatePlayers':
                this.deactivatePlayers = parseInt(value) || 40;
                break;
            case 'mapsPerVote':
                this.mapsPerVote = parseInt(value) || 8;
                break;
            case 'nightMapCount':
                this.nightMapCount = parseInt(value) || 1;
                break;
            case 'excludeRecentMaps': {
                const parsed = parseInt(value);
                this.excludeRecentMaps = Number.isNaN(parsed) ? this.excludeRecentMaps : Math.min(Math.max(parsed, 0), 10);
                break;
            }
            case 'voteHeader':
                this.voteHeader = value;
                break;
            case 'blacklist':
                if (Array.isArray(value)) {
                    this.blacklist = value;
                }
                break;
            default:
                return false;
        }
        logger.info(`[MapVoting S${this.serverNum}] Config updated: ${key} = ${value}`);
        return true;
    }

    stop() {
        this.stopPolling();
        this.voteMapActive = false;
        this.isRunning = false;
        this.voteActive = false;
        this.destroyed = true;
        this.releaseActiveServiceSlot();
        logger.info(`[MapVoting S${this.serverNum}] Service stopped`);
    }
}

module.exports = { MapVotingService };

