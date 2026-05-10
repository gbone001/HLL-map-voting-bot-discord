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
const { hllMapCatalog } = require('./hllMapCatalog');

class MapVotingService {
    constructor(serverNum = 1) {
        MapVotingService.instanceCounter = (MapVotingService.instanceCounter || 0) + 1;
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

        // Vote activation state.
        // `minimumPlayers` is the gate for opening map voting, while
        // `deactivatePlayers` provides hysteresis so the bot does not flap.
        this.seeded = false;
        this.seedingMessage = null;
        this.sendSeedingMessage = true;
        this.minimumPlayers = 25;
        this.deactivatePlayers = 10;

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
        this.lastVoteStartedForCurrentMapId = null;
        this.voteFinalizationInProgress = false;
        this.voteFinalizationFailureCount = 0;
        this.maxVoteFinalizationRetries = 3;
        this.skipNextUnseededMatchEndRotation = false;
        this.pendingQueuedMapMaxHoldMs = 3 * 60 * 60 * 1000;
        this.lastObservedSessionRemainingMatchTime = null;
        this.managedRotationPoolMapIds = [];
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

            await this.getAllMaps();
            await this.getWhitelist();

            // Clean up old votes on startup
            voteStore.cleanup();

            // Restore service state from last run
            const savedState = voteStore.getState(`voteMapActive_${this.serverNum}`);
            if (savedState !== null) {
                this.voteMapActive = savedState;
                logger.info(`[MapVoting S${this.serverNum}] Restored state: ${this.voteMapActive ? 'active' : 'paused'}`);
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

        const catalogStatus = hllMapCatalog.getCatalogStatus();
        if (catalogStatus.hasRuntimeCatalog) {
            this.cachedMaps = hllMapCatalog.getMaps();
            this.cacheTime = now;
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

        const bundledCatalogMaps = hllMapCatalog.getMaps();
        if (bundledCatalogMaps.length > 0) {
            logger.warn(
                `[MapVoting S${this.serverNum}] Using bundled local map catalog because live getMaps was unavailable`
            );
            this.cachedMaps = bundledCatalogMaps;
            this.cacheTime = now;
            return this.cachedMaps;
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

    getPendingQueuedMapStateKey() {
        return `pendingQueuedMap_${this.serverNum}`;
    }

    getPendingQueuedMap() {
        return voteStore.getState(this.getPendingQueuedMapStateKey());
    }

    setPendingQueuedMap(mapId, source = 'unknown') {
        if (!mapId) {
            return;
        }

        voteStore.setState(this.getPendingQueuedMapStateKey(), {
            mapId,
            source,
            queuedAt: Date.now()
        });
    }

    clearPendingQueuedMap() {
        voteStore.setState(this.getPendingQueuedMapStateKey(), null);
    }

    async shouldDeferNewVoteForQueuedWinner() {
        const pendingQueuedMap = this.getPendingQueuedMap();
        if (!pendingQueuedMap?.mapId) {
            return false;
        }

        const allMaps = await this.getAllMaps();
        const currentMapId = await this.getCurrentMapId(allMaps);
        if (currentMapId === pendingQueuedMap.mapId) {
            logger.info(
                `[MapVoting S${this.serverNum}] Queued winner ${pendingQueuedMap.mapId} is now live; clearing pending guard`
            );
            this.clearPendingQueuedMap();
            return false;
        }

        if (typeof this.crcon?.readQueuedNextMapState !== 'function') {
            logger.warn(
                `[MapVoting S${this.serverNum}] Clearing pending queued winner ${pendingQueuedMap.mapId} because the transport cannot verify queued-map state`
            );
            this.clearPendingQueuedMap();
            return false;
        }

        let queuedState = null;
        try {
            queuedState = await this.crcon.readQueuedNextMapState();
        } catch (error) {
            logger.warn(
                `[MapVoting S${this.serverNum}] Could not verify pending queued winner ${pendingQueuedMap.mapId}: ${error.message}`
            );
        }

        if (queuedState?.nextMapId === pendingQueuedMap.mapId) {
            logger.info(
                `[MapVoting S${this.serverNum}] Deferring new vote because queued winner ${pendingQueuedMap.mapId} is still pending`
            );
            return true;
        }

        if (queuedState?.nextMapId && queuedState.nextMapId !== pendingQueuedMap.mapId) {
            logger.warn(
                `[MapVoting S${this.serverNum}] Queued winner ${pendingQueuedMap.mapId} was overwritten externally by ${queuedState.nextMapId}; clearing pending guard`
            );
            this.clearPendingQueuedMap();
            return false;
        }

        if ((Date.now() - pendingQueuedMap.queuedAt) > this.pendingQueuedMapMaxHoldMs) {
            logger.warn(
                `[MapVoting S${this.serverNum}] Pending queued winner ${pendingQueuedMap.mapId} exceeded hold window without verification; clearing pending guard`
            );
            this.clearPendingQueuedMap();
            return false;
        }

        logger.info(
            `[MapVoting S${this.serverNum}] Deferring new vote while queued winner ${pendingQueuedMap.mapId} awaits match transition`
        );
        return true;
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

            const mapByVoteLabel = new Map(
                allMaps.map((map) => [this.getVoteLabel(map), map])
            );

            for (const answer of poll.answers.values()) {
                const matchingMap = mapByVoteLabel.get(answer.text) ||
                    allMaps.find((map) => map.pretty_name === answer.text);
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
        await this.syncManagedRotationPool(schedule);
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

    async getManagedRotationPoolMapIds(schedule = null, allMaps = null) {
        const resolvedSchedule = schedule || this.getActiveScheduleSettings();
        const resolvedMaps = allMaps || await this.getAllMaps();
        const availableMapIds = new Set(resolvedMaps.map((map) => map.id));
        let poolMapIds = [];

        if (Array.isArray(resolvedSchedule?.whitelist) && resolvedSchedule.whitelist.length > 0) {
            poolMapIds = resolvedSchedule.whitelist.filter((mapId) => availableMapIds.has(mapId));
        } else {
            const effectiveWhitelist = await this.getEffectiveWhitelist();
            poolMapIds = resolvedMaps
                .filter((map) => !effectiveWhitelist || effectiveWhitelist.has(map.id))
                .map((map) => map.id);
        }

        return [...new Set(poolMapIds.filter((mapId) => !this.blacklist.includes(mapId)))];
    }

    buildManagedRotationOrder(poolMapIds, selectedMapId = null, currentMapId = null) {
        const uniquePoolMapIds = [...new Set((poolMapIds || []).filter(Boolean))];
        if (!selectedMapId) {
            return uniquePoolMapIds;
        }

        if (
            currentMapId &&
            currentMapId !== selectedMapId &&
            uniquePoolMapIds.includes(currentMapId)
        ) {
            const remainingMapIds = uniquePoolMapIds.filter((mapId) => (
                mapId !== currentMapId && mapId !== selectedMapId
            ));
            return [currentMapId, selectedMapId, ...remainingMapIds];
        }

        const remainingMapIds = uniquePoolMapIds.filter((mapId) => mapId !== selectedMapId);
        return [selectedMapId, ...remainingMapIds];
    }

    async syncManagedRotationPool(schedule = null, allMaps = null) {
        if (typeof this.crcon?.replaceMapRotation !== 'function') {
            throw new Error('CRCON replaceMapRotation support is required for bot-managed map pools');
        }

        const poolMapIds = await this.getManagedRotationPoolMapIds(schedule, allMaps);
        if (poolMapIds.length === 0) {
            logger.warn(`[MapVoting S${this.serverNum}] Active schedule map pool resolved to zero maps; skipping managed rotation sync`);
            this.managedRotationPoolMapIds = [];
            return false;
        }

        await this.crcon.replaceMapRotation(poolMapIds);
        this.managedRotationPoolMapIds = poolMapIds;
        logger.info(
            `[MapVoting S${this.serverNum}] Synced managed rotation pool with ${poolMapIds.length} map(s): ${poolMapIds.join(', ')}`
        );
        return true;
    }

    async loadScheduleMapPoolAsRotation(schedule = null, allMaps = null) {
        return this.syncManagedRotationPool(schedule, allMaps);
    }

    async applyManagedRotationSelection(selectedMapId, source = 'unknown', schedule = null, allMaps = null, options = {}) {
        const {
            queueStrategy = 'default'
        } = options;

        if (!selectedMapId) {
            throw new Error('applyManagedRotationSelection requires a selected map id');
        }

        const basePoolMapIds = this.managedRotationPoolMapIds.length > 0
            ? this.managedRotationPoolMapIds
            : await this.getManagedRotationPoolMapIds(schedule, allMaps);
        const rotationOrder = this.buildManagedRotationOrder(basePoolMapIds, selectedMapId, options.currentMapId || null);

        if (queueStrategy === 'direct-sequence-start' && typeof this.crcon?.queueNextMapAtSequenceStart === 'function') {
            await this.crcon.queueNextMapAtSequenceStart(selectedMapId);
        } else if (typeof this.crcon?.queueNextMap === 'function') {
            await this.crcon.queueNextMap(selectedMapId, rotationOrder);
        } else if (typeof this.crcon?.replaceMapRotation === 'function') {
            await this.crcon.replaceMapRotation(rotationOrder);
        } else {
            throw new Error('A queueNextMap or replaceMapRotation transport capability is required for vote-driven rotation management');
        }

        this.managedRotationPoolMapIds = rotationOrder;
        this.setPendingQueuedMap(selectedMapId, source);
        return rotationOrder;
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

    // ==================== GAME STATE ====================

    async getGameState() {
        try {
            const payload = {
                end: 10000,
                filter_action: ['MATCH ENDED', 'MATCH START'],
                filter_player: [],
                inclusive_filter: true
            };

            try {
                const response = await this.crcon.post('get_recent_logs', payload);

                if (response?.result?.logs?.length > 0) {
                    const latestLog = response.result.logs[0];
                    const logText = latestLog.raw || latestLog.message || '';

                    if (logText.includes('MATCH START')) {
                        this.gameActive = true;
                        return this.gameActive;
                    }

                    if (logText.includes('MATCH ENDED')) {
                        this.gameActive = false;
                        return this.gameActive;
                    }
                }
            } catch (logError) {
                logger.warn(
                    `[MapVoting S${this.serverNum}] Falling back to snapshot-based game state detection because recent log lookup failed: ${logError.message}`
                );
            }

            if (typeof this.crcon?.getMatchSnapshot === 'function') {
                try {
                    const snapshot = await this.crcon.getMatchSnapshot();
                    if (typeof snapshot?.gameActive === 'boolean') {
                        this.gameActive = snapshot.gameActive;
                        return this.gameActive;
                    }

                    if (snapshot?.currentMapId) {
                        this.gameActive = true;
                        return this.gameActive;
                    }
                } catch (snapshotError) {
                    logger.warn(
                        `[MapVoting S${this.serverNum}] Snapshot-based game state detection failed: ${snapshotError.message}`
                    );
                }
            }

            if (this.gameActive === null) {
                this.gameActive = false;
            }

            return this.gameActive;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error getting game state:`, error.message);
            return this.gameActive;
        }
    }

    async getDirectSessionTimerState() {
        if (typeof this.crcon?.supportsDirectSessionPolling !== 'function' || !this.crcon.supportsDirectSessionPolling()) {
            this.lastObservedSessionRemainingMatchTime = null;
            return {
                enabled: false,
                timerExpired: false,
                remainingMatchTime: null
            };
        }

        try {
            const sessionInfo = await this.crcon.getDirectSessionInfo();
            const remainingMatchTime = Number.isInteger(sessionInfo?.remainingMatchTime)
                ? sessionInfo.remainingMatchTime
                : null;

            this.lastObservedSessionRemainingMatchTime = remainingMatchTime;

            return {
                enabled: true,
                timerExpired: remainingMatchTime === 0,
                remainingMatchTime,
                sessionInfo
            };
        } catch (error) {
            logger.warn(
                `[MapVoting S${this.serverNum}] Direct RCON session timer polling failed: ${error.message}`
            );
            return {
                enabled: true,
                timerExpired: false,
                remainingMatchTime: null,
                error
            };
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

    getGeneralMapName(map) {
        const explicitName = map?.map_name ||
            map?.map?.name ||
            map?.name ||
            null;

        if (explicitName) {
            return explicitName;
        }

        const prettyName = map?.pretty_name || map?.id || null;
        if (!prettyName) {
            return null;
        }

        return String(prettyName)
            .replace(/\s+\|\s+.+$/i, '')
            .replace(/\s+(warfare|offensive|skirmish)(\s+\(.+\))?$/i, '')
            .replace(/\s+offensive\s+\(.+\)$/i, '')
            .replace(/\s+\(.+\)$/i, '')
            .trim() || prettyName;
    }

    getGeneralMapKey(map) {
        return this.normalizeMapKey(this.getGeneralMapName(map));
    }

    buildMapLookupById(allMaps) {
        return new Map(
            (allMaps || [])
                .filter((map) => map?.id)
                .map((map) => [map.id, map])
        );
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

    getRecentMapExclusions(historyEntries, canonicalMapLookup, mapLookupById) {
        const recentMapIds = new Set();
        const recentGeneralMapKeys = new Set();

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
                const resolvedMapId = canonicalMapLookup.get(alias) || alias;
                recentMapIds.add(resolvedMapId);

                const resolvedMap = mapLookupById.get(resolvedMapId);
                const generalMapKey = this.getGeneralMapKey(resolvedMap || entry);
                if (generalMapKey) {
                    recentGeneralMapKeys.add(generalMapKey);
                }
            }
        }

        return {
            recentMapIds,
            recentGeneralMapKeys
        };
    }

    resolveMapIdFromPayload(mapPayload, canonicalMapLookup) {
        if (!mapPayload) {
            return null;
        }

        const aliases = [
            typeof mapPayload === 'string' || typeof mapPayload === 'number' ? mapPayload : null,
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

        if (typeof this.crcon?.getMatchSnapshot === 'function') {
            try {
                const snapshot = await this.crcon.getMatchSnapshot();
                const snapshotCurrentMapId = this.resolveMapIdFromPayload(
                    snapshot?.currentMapId,
                    canonicalMapLookup
                );
                if (snapshotCurrentMapId) {
                    return snapshotCurrentMapId;
                }
            } catch (error) {
                logger.warn(`[MapVoting S${this.serverNum}] Could not fetch live match snapshot for current map detection: ${error.message}`);
            }
        }

        const cachedCurrentMapId = resolveCurrentMapId(this.lastServerStatus);
        if (cachedCurrentMapId) {
            return cachedCurrentMapId;
        }

        if (typeof this.crcon?.getStatus === 'function') {
            try {
                const liveStatus = await this.crcon.getStatus();
                this.lastServerStatus = liveStatus;
                return resolveCurrentMapId(liveStatus);
            } catch (error) {
                logger.warn(`[MapVoting S${this.serverNum}] Could not fetch current map for exclusion: ${error.message}`);
            }
        }

        return null;
    }

    async getRecentExclusionContext(allMaps, options = {}) {
        const {
            requireCurrentMap = false,
            requireHistory = false
        } = options;
        const canonicalMapLookup = this.buildCanonicalMapLookup(allMaps);
        const mapLookupById = this.buildMapLookupById(allMaps);
        let recentMapIds = new Set();
        let recentGeneralMapKeys = new Set();
        let historyAvailable = this.excludeRecentMaps <= 0;

        try {
            if (this.excludeRecentMaps > 0) {
                const historyResponse = await this.crcon.getMapHistory();
                if (Array.isArray(historyResponse?.result)) {
                    const recentMaps = historyResponse.result.slice(0, this.excludeRecentMaps);
                    const exclusions = this.getRecentMapExclusions(recentMaps, canonicalMapLookup, mapLookupById);
                    recentMapIds = exclusions.recentMapIds;
                    recentGeneralMapKeys = exclusions.recentGeneralMapKeys;
                    historyAvailable = true;
                }
            }
        } catch (e) {
            logger.warn(`[MapVoting S${this.serverNum}] Could not fetch map history: ${e.message}`);
        }

        const currentMapId = await this.getCurrentMapId(allMaps, canonicalMapLookup);
        const currentMap = currentMapId ? mapLookupById.get(currentMapId) : null;
        const currentGeneralMapKey = this.getGeneralMapKey(currentMap);
        if (currentMapId) {
            recentMapIds.add(currentMapId);
        }
        if (currentGeneralMapKey) {
            recentGeneralMapKeys.add(currentGeneralMapKey);
        }

        const hasExactRepeatProtection = historyAvailable || Boolean(currentMapId);
        const reliable = (!requireHistory || historyAvailable || Boolean(currentMapId)) &&
            (!requireCurrentMap || hasExactRepeatProtection);

        return {
            recentMapIds,
            recentGeneralMapKeys,
            currentMapId,
            currentGeneralMapKey,
            historyAvailable,
            hasExactRepeatProtection,
            reliable
        };
    }

    async getRecentExcludedMapIds(allMaps) {
        const exclusionContext = await this.getRecentExclusionContext(allMaps);

        return exclusionContext.recentMapIds;
    }

    async getMapsToVote() {
        try {
            const allMaps = await this.getAllMaps();
            if (!allMaps || allMaps.length === 0) {
                return null;
            }

            const exclusionContext = await this.getRecentExclusionContext(allMaps, {
                requireHistory: this.excludeRecentMaps > 0,
                requireCurrentMap: true
            });
            const {
                recentMapIds,
                recentGeneralMapKeys,
                currentMapId,
                currentGeneralMapKey,
                historyAvailable,
                hasExactRepeatProtection,
                reliable
            } = exclusionContext;

            if (!reliable) {
                logger.warn(
                    `[MapVoting S${this.serverNum}] Skipping vote generation because map exclusions were not reliable: historyAvailable=${historyAvailable} currentMapId=${currentMapId || 'unknown'} exactProtection=${hasExactRepeatProtection}`
                );
                return [];
            }

            if (recentMapIds.size > 0) {
                logger.info(`[MapVoting S${this.serverNum}] Excluding ${recentMapIds.size} recent map IDs: ${[...recentMapIds].join(', ')}`);
            }
            if (recentGeneralMapKeys.size > 0) {
                logger.info(`[MapVoting S${this.serverNum}] Excluding ${recentGeneralMapKeys.size} recent base maps: ${[...recentGeneralMapKeys].join(', ')}`);
            }

            // Use effective whitelist (schedule's or CRCON's)
            const whitelist = await this.getEffectiveWhitelist();
            const useWhitelist = whitelist && whitelist.size > 0;

            // Filter available maps
            const availableMaps = allMaps.filter(map => {
                const generalMapKey = this.getGeneralMapKey(map);
                if (useWhitelist && !whitelist.has(map.id)) return false;
                if (this.blacklist.includes(map.id)) return false;
                if (map.game_mode === 'skirmish' && this.modeWeights.skirmish === 0) return false;
                // Exclude recently played maps
                if (recentMapIds.has(map.id)) return false;
                if (generalMapKey && recentGeneralMapKeys.has(generalMapKey)) return false;
                return true;
            });

            // Group by mode
            const mapsByMode = {
                warfare: { day: [], night: [] },
                offensive: { day: [], night: [] },
                skirmish: { day: [], night: [] }
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
            const usedGeneralMapKeys = new Set(currentGeneralMapKey ? [currentGeneralMapKey] : []);
            const dayMapsNeeded = this.mapsPerVote - this.nightMapCount;

            const shuffledDayMapsByMode = {
                warfare: this.shuffleArray(mapsByMode.warfare.day),
                offensive: this.shuffleArray(mapsByMode.offensive.day),
                skirmish: this.shuffleArray(mapsByMode.skirmish.day)
            };

            for (const mode of ['warfare', 'offensive', 'skirmish']) {
                const weightedDayMaps = shuffledDayMapsByMode[mode];
                const modeWeight = this.modeWeights[mode] || 0;

                for (let i = 0; i < modeWeight && i < weightedDayMaps.length && result.length < dayMapsNeeded; i++) {
                    const map = weightedDayMaps[i];
                    const generalMapKey = this.getGeneralMapKey(map);
                    if (!usedMapIds.has(map.id) && (!generalMapKey || !usedGeneralMapKeys.has(generalMapKey))) {
                        result.push(this.formatMapForVote(map));
                        usedMapIds.add(map.id);
                        if (generalMapKey) {
                            usedGeneralMapKeys.add(generalMapKey);
                        }
                    }
                }
            }

            // Night maps
            const allNightMaps = [...mapsByMode.warfare.night, ...mapsByMode.offensive.night, ...mapsByMode.skirmish.night]
                .filter((map) => {
                    const generalMapKey = this.getGeneralMapKey(map);
                    return !usedMapIds.has(map.id) && (!generalMapKey || !usedGeneralMapKeys.has(generalMapKey));
                });
            const nightMaps = this.shuffleArray(allNightMaps);

            for (let i = 0; i < this.nightMapCount && i < nightMaps.length && result.length < this.mapsPerVote; i++) {
                result.push(this.formatMapForVote(nightMaps[i]));
                usedMapIds.add(nightMaps[i].id);
                const generalMapKey = this.getGeneralMapKey(nightMaps[i]);
                if (generalMapKey) {
                    usedGeneralMapKeys.add(generalMapKey);
                }
            }

            // Fill remaining slots with day maps if needed
            if (result.length < this.mapsPerVote) {
                const remainingDay = [
                    ...shuffledDayMapsByMode.warfare,
                    ...shuffledDayMapsByMode.offensive,
                    ...shuffledDayMapsByMode.skirmish
                ]
                    .filter((map) => {
                        const generalMapKey = this.getGeneralMapKey(map);
                        return !usedMapIds.has(map.id) && (!generalMapKey || !usedGeneralMapKeys.has(generalMapKey));
                    });
                for (const map of remainingDay) {
                    if (result.length >= this.mapsPerVote) break;
                    result.push(this.formatMapForVote(map));
                    usedMapIds.add(map.id);
                    const generalMapKey = this.getGeneralMapKey(map);
                    if (generalMapKey) {
                        usedGeneralMapKeys.add(generalMapKey);
                    }
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

            const desiredMapIds = new Set(nonSeededMapList);
            if (!desiredMapIds.size) {
                logger.warn(
                    `[MapVoting S${this.serverNum}] Non-seeded rotation skipped because no non-seeded map list is configured`
                );
                return false;
            }

            const configuredMaps = allMaps.filter(map => desiredMapIds.has(map.id) && !this.blacklist.includes(map.id));
            if (!configuredMaps.length) {
                logger.warn(`[MapVoting S${this.serverNum}] Non-seeded map list is configured but no valid maps are currently available`);
                return false;
            }

            const exclusionContext = await this.getRecentExclusionContext(allMaps, {
                requireHistory: this.excludeRecentMaps > 0,
                requireCurrentMap: true
            });
            const {
                recentMapIds,
                recentGeneralMapKeys,
                currentMapId,
                currentGeneralMapKey,
                historyAvailable,
                hasExactRepeatProtection,
                reliable
            } = exclusionContext;

            if (!reliable) {
                logger.warn(
                    `[MapVoting S${this.serverNum}] Skipping non-seeded rotation because map exclusions were not reliable: historyAvailable=${historyAvailable} currentMapId=${currentMapId || 'unknown'} exactProtection=${hasExactRepeatProtection}`
                );
                return false;
            }

            const alternateMaps = currentMapId
                ? configuredMaps.filter(map => map.id !== currentMapId)
                : configuredMaps;
            const cooldownEligibleMaps = alternateMaps.filter((map) => {
                const generalMapKey = this.getGeneralMapKey(map);
                if (recentMapIds.has(map.id)) {
                    return false;
                }
                if (generalMapKey && recentGeneralMapKeys.has(generalMapKey) && generalMapKey !== currentGeneralMapKey) {
                    return false;
                }
                return true;
            });
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

            await this.applyManagedRotationSelection(
                selectedMap.id,
                'non-seeded-rotation',
                this.getActiveScheduleSettings(),
                allMaps,
                { currentMapId }
            );
            logger.info(`[MapVoting S${this.serverNum}] Applied non-seeded rotation map: ${selectedMap.id}`);
            return true;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Failed to apply non-seeded rotation: ${error.message}`);
            return false;
        }
    }

    formatMapForVote(map) {
        const voteLabel = this.getVoteLabel(map);
        return {
            id: map.id,
            name: map.map_name || map.map?.name || map.id,
            mode: map.mode || map.game_mode,
            variant: map.variant || map.environment,
            time: map.environment,
            pretty_name: map.pretty_name,
            vote_label: voteLabel,
            weight: map.weight ?? null,
            seeding: map.seeding ?? null,
            stress: map.stress ?? null
        };
    }

    getVoteLabel(map) {
        return map?.vote_label || map?.pretty_name || map?.id;
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

    async getVoteResult(mapResults, candidateMaps = this.maps, options = null) {
        try {
            const currentMapId = typeof options === 'string' || options === null
                ? options
                : options?.currentMapId || null;
            const currentGeneralMapKey = typeof options === 'object' && options !== null
                ? options.currentGeneralMapKey || null
                : null;
            const recentMapIds = typeof options === 'object' && options !== null
                ? options.recentMapIds || new Set()
                : new Set();
            const recentGeneralMapKeys = typeof options === 'object' && options !== null
                ? options.recentGeneralMapKeys || new Set()
                : new Set();
            const candidateMapByVoteLabel = new Map(
                (candidateMaps || []).flatMap((map) => {
                    const entries = [[this.getVoteLabel(map), map]];
                    if (map.pretty_name && map.pretty_name !== this.getVoteLabel(map)) {
                        entries.push([map.pretty_name, map]);
                    }
                    return entries;
                })
            );

            let candidates = [];
            let bestEligibleVoteCount = null;

            for (const [answerText, voteCount] of mapResults) {
                const matchingMap = candidateMapByVoteLabel.get(answerText);
                if (!matchingMap) {
                    continue;
                }

                const matchingGeneralMapKey = this.getGeneralMapKey(matchingMap);

                if (currentMapId && matchingMap.id === currentMapId) {
                    logger.warn(
                        `[MapVoting S${this.serverNum}] Ignoring poll winner candidate because it matches the live current map: ${matchingMap.id}`
                    );
                    continue;
                }

                if (recentMapIds.has(matchingMap.id)) {
                    logger.warn(
                        `[MapVoting S${this.serverNum}] Ignoring poll winner candidate because it is still in exact-layer cooldown: ${matchingMap.id}`
                    );
                    continue;
                }

                if (matchingGeneralMapKey && recentGeneralMapKeys.has(matchingGeneralMapKey)) {
                    const reason = matchingGeneralMapKey === currentGeneralMapKey
                        ? 'it repeats the live base map'
                        : 'it is still in base-map cooldown';
                    logger.warn(
                        `[MapVoting S${this.serverNum}] Ignoring poll winner candidate because ${reason}: ${matchingMap.id}`
                    );
                    continue;
                }

                if (bestEligibleVoteCount === null) {
                    bestEligibleVoteCount = voteCount;
                }

                if (voteCount !== bestEligibleVoteCount) {
                    break;
                }

                candidates.push(matchingMap);
            }

            if (candidates.length === 0) {
                return null;
            }

            let selectedMap = null;
            if (candidates.length === 1) {
                selectedMap = candidates[0];
            } else if (candidates.length > 1) {
                const i = Math.floor(Math.random() * candidates.length);
                selectedMap = candidates[i];
            }

            if (!selectedMap) {
                return null;
            }

            logger.info(`[MapVoting S${this.serverNum}] Vote Result: ${selectedMap.id}`);
            return selectedMap.id;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error getting vote result:`, error.message);
            return null;
        }
    }

    async getConfirmedCurrentMapIdForVoteStart() {
        try {
            const allMaps = await this.getAllMaps();
            const currentMapId = await this.getCurrentMapId(allMaps);

            if (!currentMapId) {
                logger.warn(`[MapVoting S${this.serverNum}] Could not confirm live current map for vote-start gating`);
                return null;
            }

            return currentMapId;
        } catch (error) {
            logger.warn(
                `[MapVoting S${this.serverNum}] Failed to confirm live current map before starting vote: ${error.message}`
            );
            return null;
        }
    }

    async setVoteResult(options = {}) {
        const { queueStrategy = 'default' } = options;

        try {
            const allMaps = await this.getAllMaps();
            const exclusionContext = allMaps?.length > 0
                ? await this.getRecentExclusionContext(allMaps, {
                    requireHistory: this.excludeRecentMaps > 0,
                    requireCurrentMap: true
                })
                : {
                    recentMapIds: new Set(),
                    recentGeneralMapKeys: new Set(),
                    currentMapId: null,
                    currentGeneralMapKey: null,
                    historyAvailable: false,
                    hasExactRepeatProtection: false,
                    reliable: false
                };
            const {
                recentMapIds,
                recentGeneralMapKeys,
                currentMapId,
                currentGeneralMapKey,
                historyAvailable,
                hasExactRepeatProtection,
                reliable
            } = exclusionContext;
            const currentPollMaps = await this.getCurrentPollMaps(allMaps);
            const candidateMaps = currentPollMaps.length > 0 ? currentPollMaps : (Array.isArray(this.maps) ? this.maps : []);
            const mapResults = await this.getResults();
            let mapId = null;

            if (allMaps?.length > 0 && !reliable) {
                throw new Error(
                    `Could not reliably resolve current/recent map exclusions for vote finalization (historyAvailable=${historyAvailable} currentMapId=${currentMapId || 'unknown'} exactProtection=${hasExactRepeatProtection})`
                );
            }

            if (mapResults) {
                mapId = await this.getVoteResult(mapResults, candidateMaps, {
                    currentMapId,
                    currentGeneralMapKey,
                    recentMapIds,
                    recentGeneralMapKeys
                });
            }

            // If no vote result (0 votes or error), pick random from available maps
            if (!mapId && candidateMaps.length > 0) {
                const fallbackCandidateMaps = candidateMaps.filter((candidateMap) => {
                    const candidateGeneralMapKey = this.getGeneralMapKey(candidateMap);
                    if (currentMapId && candidateMap.id === currentMapId) {
                        return false;
                    }
                    if (recentMapIds.has(candidateMap.id)) {
                        return false;
                    }
                    if (candidateGeneralMapKey && recentGeneralMapKeys.has(candidateGeneralMapKey)) {
                        return false;
                    }
                    return true;
                });
                const randomSelectionPool = fallbackCandidateMaps.length > 0
                    ? fallbackCandidateMaps
                    : [];
                if (randomSelectionPool.length === 0) {
                    throw new Error('No eligible vote candidates remained after applying current-map and cooldown exclusions');
                }
                const randomIndex = Math.floor(Math.random() * randomSelectionPool.length);
                mapId = randomSelectionPool[randomIndex].id;
                logger.info(`[MapVoting S${this.serverNum}] No votes cast, picking random: ${mapId}`);
            }

            if (mapId) {
                const recentExcludedSummary = recentMapIds.size > 0 ? [...recentMapIds].join(', ') : 'none';
                logger.info(
                    `[MapVoting S${this.serverNum}] Vote finalization context: currentMap=${currentMapId || 'unknown'} recentExcluded=${recentExcludedSummary} selected=${mapId}`
                );

                logger.info(`[MapVoting S${this.serverNum}] Applying selected map to managed rotation: ${mapId}`);
                try {
                    await this.applyManagedRotationSelection(
                        mapId,
                        queueStrategy === 'direct-sequence-start' ? 'vote-result-session-zero' : 'vote-result',
                        this.getActiveScheduleSettings(),
                        allMaps,
                        { queueStrategy, currentMapId }
                    );
                } catch (selectionError) {
                    const canRetryWithDirectSequenceStart =
                        queueStrategy !== 'direct-sequence-start' &&
                        /Queued next map mismatch/i.test(selectionError?.message || '') &&
                        typeof this.crcon?.supportsDirectSessionPolling === 'function' &&
                        this.crcon.supportsDirectSessionPolling();

                    if (!canRetryWithDirectSequenceStart) {
                        throw selectionError;
                    }

                    logger.warn(
                        `[MapVoting S${this.serverNum}] Managed-rotation queue verification mismatched for ${mapId}; retrying once with direct sequence-start queueing`
                    );

                    await this.applyManagedRotationSelection(
                        mapId,
                        'vote-result-sequence-start-fallback',
                        this.getActiveScheduleSettings(),
                        allMaps,
                        { queueStrategy: 'direct-sequence-start', currentMapId }
                    );
                }
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

    async startVote(confirmedCurrentMapId = null) {
        if (this.destroyed) return;
        if (this.voteActive) return; // Already voting

        // Set flag immediately to prevent race condition
        this.voteActive = true;

        try {
            // Check if we already have a vote for this match
            const existingVote = await this.checkActiveVote();
            if (existingVote) {
                // Already have a vote for this match, just resume
                if (confirmedCurrentMapId) {
                    this.lastVoteStartedForCurrentMapId = confirmedCurrentMapId;
                }
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
                answers: this.maps.map((map) => ({ text: this.getVoteLabel(map) })),
                duration: 2,
                allowMultiselect: false
            };

            this.voteMessage = await this.channel.send({ poll: pollData });
            this.voteMessageId = this.voteMessage.id;

            // Store vote in database
            if (this.gameStart) {
                voteStore.setVote(this.voteMessageId, this.gameStart, this.serverNum, this.maps);
            }

            if (confirmedCurrentMapId) {
                this.lastVoteStartedForCurrentMapId = confirmedCurrentMapId;
            }

            this.voteFinalizationFailureCount = 0;

            logger.info(`[MapVoting S${this.serverNum}] Vote started with ${this.maps.length} maps (gameStart: ${this.gameStart})`);
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error starting vote:`, error.message);
            this.voteActive = false;
        }
    }

    shouldRetryVoteFinalization(error) {
        const message = error?.message || '';

        if (/Queued next map mismatch/i.test(message)) {
            return false;
        }

        return true;
    }

    async stopVote(options = {}) {
        const {
            keepVoteActiveOnFailure = false,
            queueStrategy = 'default'
        } = options;

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
            const finalizedMapId = await this.setVoteResult({ queueStrategy });

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

            this.voteFinalizationFailureCount = 0;
            this.voteActive = false;
            logger.info(`[MapVoting S${this.serverNum}] Vote stopped`);
            return finalizedMapId;
        } catch (error) {
            logger.error(`[MapVoting S${this.serverNum}] Error stopping vote:`, error.message);
            if (finalizationClaimed && gameStart) {
                voteStore.releaseVoteFinalization(gameStart, this.serverNum, finalizationOwnerId);
            }
            const canRetryFinalization = keepVoteActiveOnFailure && this.shouldRetryVoteFinalization(error);

            if (canRetryFinalization) {
                this.voteFinalizationFailureCount += 1;
            }

            if (canRetryFinalization && this.voteFinalizationFailureCount <= this.maxVoteFinalizationRetries) {
                logger.warn(
                    `[MapVoting S${this.serverNum}] Preserving active vote state so finalization can retry on the next polling tick (attempt ${this.voteFinalizationFailureCount}/${this.maxVoteFinalizationRetries})`
                );
            } else {
                this.voteActive = false;
                if (gameStart) {
                    voteStore.deleteVote(gameStart, this.serverNum);
                }

                if (keepVoteActiveOnFailure && !canRetryFinalization) {
                    logger.warn(
                        `[MapVoting S${this.serverNum}] Finalization failure is non-retryable; clearing active vote state to prevent infinite retry loops`
                    );
                } else if (canRetryFinalization) {
                    logger.error(
                        `[MapVoting S${this.serverNum}] Finalization retry limit exceeded (${this.maxVoteFinalizationRetries}); clearing active vote state`
                    );
                }

                this.voteFinalizationFailureCount = 0;
            }
            return null;
        } finally {
            this.voteFinalizationInProgress = false;
        }
    }

    // ==================== MAIN LOOP ====================

    async doMapVote() {
        if (this.destroyed) return;
        if (this.isRunning) return;

        this.isRunning = true;
        this.doingMapVote = true;

        try {
            // Check for schedule changes
            await this.applyScheduleSettings();

            const previousGameActive = this.gameActive;
            await this.getGameState();
            const directSessionTimerState = await this.getDirectSessionTimerState();

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

            const votingEnabled = this.voteMapActive;
            let finalizedVoteThisTick = false;
            const shouldFinalizeFromSessionTimer = directSessionTimerState.timerExpired && this.voteActive;

            if (shouldFinalizeFromSessionTimer || (!this.gameActive && this.voteActive)) {
                const queueStrategy = shouldFinalizeFromSessionTimer ? 'direct-sequence-start' : 'default';
                const finalizationReason = shouldFinalizeFromSessionTimer
                    ? 'Direct RCON session timer reached zero'
                    : 'Match closure detected';

                logger.info(`[MapVoting S${this.serverNum}] ${finalizationReason}, finalizing active vote...`);
                const finalizedMapId = await this.stopVote({
                    keepVoteActiveOnFailure: true,
                    queueStrategy
                });
                if (finalizedMapId) {
                    finalizedVoteThisTick = true;
                }
                this.lastReminderTime = null;
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

            if (currentPlayers >= this.minimumPlayers && !this.seeded) {
                logger.info(`[MapVoting S${this.serverNum}] Server reached ${this.minimumPlayers} players!`);
                this.seeded = true;
            } else if (currentPlayers < this.minimumPlayers) {
                if (this.seeded) {
                    logger.info(
                        `[MapVoting S${this.serverNum}] Server dropped below ${this.minimumPlayers} players; switching to non-seeded rules`
                    );
                }
                this.seeded = false;
            }

            const justDroppedOutOfSeeded = wasSeeded && !this.seeded;

            if (justDroppedOutOfSeeded && this.voteActive) {
                logger.info(`[MapVoting S${this.serverNum}] Seeded state lost while vote active, finalizing current vote`);
                const finalizedMapId = await this.stopVote({ keepVoteActiveOnFailure: true });
                if (finalizedMapId) {
                    this.skipNextUnseededMatchEndRotation = true;
                    finalizedVoteThisTick = true;
                }
                this.lastReminderTime = null;
            }

            if (votingEnabled && this.seeded) {
                if (this.gameActive && !this.voteActive) {
                    const shouldDeferVote = await this.shouldDeferNewVoteForQueuedWinner();
                    if (shouldDeferVote) {
                        return;
                    }

                    const confirmedCurrentMapId = await this.getConfirmedCurrentMapIdForVoteStart();
                    if (!confirmedCurrentMapId) {
                        return;
                    }

                    if (this.lastVoteStartedForCurrentMapId === confirmedCurrentMapId) {
                        logger.info(
                            `[MapVoting S${this.serverNum}] Waiting for confirmed live map change before starting a new vote; current map is still ${confirmedCurrentMapId}`
                        );
                        return;
                    }

                    logger.info(`[MapVoting S${this.serverNum}] Starting vote...`);
                    await this.clearAllMessages();
                    await this.startVote(confirmedCurrentMapId);
                    this.lastReminderTime = Date.now();
                    this.reminderCount = 0;
                }

                if (!this.sendSeedingMessage) {
                    this.sendSeedingMessage = true;
                }
            } else {
                if (votingEnabled && this.sendSeedingMessage && !this.voteActive) {
                    await this.clearAllMessages();
                    await this.sendSeedingMsg();
                    this.sendSeedingMessage = false;
                }

                if (matchEnded && !finalizedVoteThisTick) {
                    if (this.skipNextUnseededMatchEndRotation) {
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
        this.lastVoteStartedForCurrentMapId = null;
        this.lastObservedSessionRemainingMatchTime = null;
        this.managedRotationPoolMapIds = [];
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
                this.minimumPlayers = parseInt(value) || 25;
                break;
            case 'deactivatePlayers':
                this.deactivatePlayers = parseInt(value) || 10;
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
        logger.info(`[MapVoting S${this.serverNum}] Service stopped`);
    }
}

module.exports = { MapVotingService };

