/**
 * Schedule Manager Service
 * Handles time-based map pool scheduling
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getDataFilePath } = require('../utils/dataPath');
const { hllMapCatalog } = require('./hllMapCatalog');

const SCHEDULE_PATH = getDataFilePath('schedules.json');
const SCHEDULE_BACKUP_PATH = `${SCHEDULE_PATH}.bak`;
const SCHEDULE_TMP_PATH = `${SCHEDULE_PATH}.tmp`;

// Common timezones for dropdown
const COMMON_TIMEZONES = [
    { label: 'US Eastern', value: 'America/New_York' },
    { label: 'US Central', value: 'America/Chicago' },
    { label: 'US Mountain', value: 'America/Denver' },
    { label: 'US Pacific', value: 'America/Los_Angeles' },
    { label: 'UK (London)', value: 'Europe/London' },
    { label: 'Central Europe', value: 'Europe/Berlin' },
    { label: 'Australia Eastern', value: 'Australia/Sydney' },
    { label: 'Australia Western', value: 'Australia/Perth' },
    { label: 'Japan', value: 'Asia/Tokyo' },
    { label: 'UTC', value: 'UTC' }
];

const DAY_PRESETS = {
    all: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    weekend: ['sat', 'sun']
};
const DAY_ORDER = [...DAY_PRESETS.all];

function createDefaultScheduleGeneralSettings() {
    return {
        teamSwitchCooldown: null,
        idleAutokickTime: null,
        maxPingAutokick: null,
        mapVoteCooldownVotes: null
    };
}

function parseSchedulePriority(value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return 0;
    }

    return Math.min(Math.max(parsed, 0), 100);
}

function normalizeScheduleDays(days) {
    if (!Array.isArray(days) || days.length === 0) {
        return [...DAY_PRESETS.all];
    }

    if (days.includes('all')) {
        return [...DAY_PRESETS.all];
    }

    const normalizedDays = DAY_ORDER.filter(day => days.includes(day));
    return normalizedDays.length > 0 ? normalizedDays : [...DAY_PRESETS.all];
}

function normalizeScheduleWhitelist(whitelist) {
    if (!Array.isArray(whitelist)) {
        return null;
    }

    return hllMapCatalog.normalizeMapIds(whitelist, {
        dropUnknown: false
    });
}

class ScheduleManager {
    constructor() {
        this.data = this.loadData();
        this.overrideTimers = new Map(); // Track override expiration timers
    }

    loadData() {
        try {
            const dataDir = path.dirname(SCHEDULE_PATH);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            if (fs.existsSync(SCHEDULE_PATH)) {
                const content = fs.readFileSync(SCHEDULE_PATH, 'utf8');
                const parsed = JSON.parse(content);
                if (!parsed || typeof parsed !== 'object' || !parsed.servers || typeof parsed.servers !== 'object') {
                    throw new Error('Invalid schedules.json format');
                }
                return this.normalizeData(parsed).data;
            }
        } catch (error) {
            logger.error('[ScheduleManager] Error loading data:', error);
            try {
                if (fs.existsSync(SCHEDULE_BACKUP_PATH)) {
                    const backupContent = fs.readFileSync(SCHEDULE_BACKUP_PATH, 'utf8');
                    const backupParsed = JSON.parse(backupContent);
                    if (backupParsed && typeof backupParsed === 'object' && backupParsed.servers && typeof backupParsed.servers === 'object') {
                        logger.warn('[ScheduleManager] Loaded schedules from backup file after primary load failed.');
                        return this.normalizeData(backupParsed).data;
                    }
                }
            } catch (backupError) {
                logger.error('[ScheduleManager] Error loading backup data:', backupError);
            }
        }

        return { servers: {} };
    }

    normalizeServerConfig(serverConfig = {}) {
        const normalizedServer = {
            timezone: typeof serverConfig.timezone === 'string' && serverConfig.timezone.trim().length > 0
                ? serverConfig.timezone
                : 'America/New_York',
            schedules: [],
            defaultSchedule: serverConfig.defaultSchedule ?? null,
            activeOverride: serverConfig.activeOverride ?? null
        };

        if (Array.isArray(serverConfig.schedules)) {
            normalizedServer.schedules = serverConfig.schedules
                .filter(schedule => schedule && typeof schedule === 'object')
                .map(schedule => this.normalizeSchedule(schedule));
        }

        return normalizedServer;
    }

    normalizeSchedule(schedule = {}) {
        return {
            id: typeof schedule.id === 'string' && schedule.id.trim().length > 0
                ? schedule.id
                : `legacy-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            name: typeof schedule.name === 'string' && schedule.name.trim().length > 0
                ? schedule.name
                : 'Unnamed Schedule',
            startTime: typeof schedule.startTime === 'string' && schedule.startTime.trim().length > 0
                ? schedule.startTime
                : '00:00',
            endTime: typeof schedule.endTime === 'string' && schedule.endTime.trim().length > 0
                ? schedule.endTime
                : '23:59',
            days: normalizeScheduleDays(schedule.days),
            priority: parseSchedulePriority(schedule.priority),
            enabled: schedule.enabled !== false,
            createdAt: schedule.createdAt || new Date(0).toISOString(),
            updatedAt: schedule.updatedAt,
            settings: {
                minimumPlayers: schedule.settings?.minimumPlayers ?? 25,
                deactivatePlayers: schedule.settings?.deactivatePlayers ?? 10,
                mapsPerVote: schedule.settings?.mapsPerVote ?? 6,
                nightMapCount: schedule.settings?.nightMapCount ?? 1
            },
            whitelist: Array.isArray(schedule.whitelist)
                ? normalizeScheduleWhitelist(schedule.whitelist)
                : null,
            generalSettings: {
                ...createDefaultScheduleGeneralSettings(),
                ...(schedule.generalSettings && typeof schedule.generalSettings === 'object' ? schedule.generalSettings : {})
            },
            automodConfigs: {
                level: schedule.automodConfigs?.level ?? null,
                no_leader: schedule.automodConfigs?.no_leader ?? null,
                solo_tank: schedule.automodConfigs?.solo_tank ?? null
            },
            automodProfiles: {
                level: schedule.automodProfiles?.level ?? null,
                no_leader: schedule.automodProfiles?.no_leader ?? null,
                solo_tank: schedule.automodProfiles?.solo_tank ?? null
            }
        };
    }

    normalizeData(data = {}) {
        const normalizedData = { servers: {} };
        let changed = false;

        for (const [serverNum, serverConfig] of Object.entries(data.servers || {})) {
            const normalizedServer = this.normalizeServerConfig(serverConfig);
            normalizedData.servers[serverNum] = normalizedServer;
            if (JSON.stringify(serverConfig) !== JSON.stringify(normalizedServer)) {
                changed = true;
            }
        }

        return { data: normalizedData, changed };
    }

    saveData() {
        try {
            const dataDir = path.dirname(SCHEDULE_PATH);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            const normalizedResult = this.normalizeData(this.data);
            this.data = normalizedResult.data;
            const payload = JSON.stringify(this.data, null, 2);

            if (fs.existsSync(SCHEDULE_PATH)) {
                try {
                    fs.copyFileSync(SCHEDULE_PATH, SCHEDULE_BACKUP_PATH);
                } catch (backupError) {
                    logger.warn('[ScheduleManager] Could not update schedules backup file:', backupError);
                }
            }

            fs.writeFileSync(SCHEDULE_TMP_PATH, payload, 'utf8');
            fs.renameSync(SCHEDULE_TMP_PATH, SCHEDULE_PATH);
            return true;
        } catch (error) {
            logger.error('[ScheduleManager] Error saving data:', error);
            try {
                if (fs.existsSync(SCHEDULE_TMP_PATH)) {
                    fs.unlinkSync(SCHEDULE_TMP_PATH);
                }
            } catch {
                // Ignore cleanup failures
            }
            return false;
        }
    }

    // Initialize server data if not exists
    initServer(serverNum) {
        if (!this.data.servers[serverNum]) {
            this.data.servers[serverNum] = {
                timezone: 'America/New_York',
                schedules: [],
                defaultSchedule: null,
                activeOverride: null
            };
            this.saveData();
        } else {
            this.data.servers[serverNum] = this.normalizeServerConfig(this.data.servers[serverNum]);
        }
        return this.data.servers[serverNum];
    }

    // Get server schedule config
    getServerConfig(serverNum) {
        return this.data.servers[serverNum] || this.initServer(serverNum);
    }

    // Set timezone
    setTimezone(serverNum, timezone) {
        const config = this.initServer(serverNum);
        const previousTimezone = config.timezone;
        config.timezone = timezone;
        if (!this.saveData()) {
            config.timezone = previousTimezone;
            return false;
        }
        logger.info(`[ScheduleManager] Server ${serverNum} timezone set to ${timezone}`);
        return true;
    }

    // Get current time in server's timezone
    getCurrentTime(serverNum) {
        const config = this.getServerConfig(serverNum);
        const timezone = config.timezone || 'UTC';

        try {
            const now = new Date();
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            const dayFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                weekday: 'short'
            });

            const timeStr = formatter.format(now);
            const dayStr = dayFormatter.format(now).toLowerCase();

            return {
                time: timeStr, // "HH:MM"
                day: dayStr.slice(0, 3), // "mon", "tue", etc.
                timezone
            };
        } catch (error) {
            logger.error('[ScheduleManager] Error getting current time:', error);
            return { time: '00:00', day: 'mon', timezone: 'UTC' };
        }
    }

    // Parse time string to minutes since midnight
    parseTime(timeStr) {
        const [hours, minutes] = timeStr.split(':').map(Number);
        return hours * 60 + minutes;
    }

    // Check if time is within a range (handles overnight ranges)
    isTimeInRange(currentTime, startTime, endTime) {
        const current = this.parseTime(currentTime);
        const start = this.parseTime(startTime);
        const end = this.parseTime(endTime);

        if (start <= end) {
            // Normal range (e.g., 09:00 - 17:00)
            return current >= start && current < end;
        } else {
            // Overnight range (e.g., 22:00 - 06:00)
            return current >= start || current < end;
        }
    }

    // Check if day matches schedule
    isDayMatch(currentDay, scheduleDays) {
        if (!scheduleDays || scheduleDays.length === 0) return true;
        if (scheduleDays.includes('all')) return true;
        return scheduleDays.includes(currentDay);
    }

    getPreviousDay(day) {
        const dayIndex = DAY_ORDER.indexOf(day);
        if (dayIndex === -1) {
            return null;
        }

        return DAY_ORDER[(dayIndex + DAY_ORDER.length - 1) % DAY_ORDER.length];
    }

    scheduleMatchesDateTime(currentDay, currentTime, schedule) {
        if (!schedule?.enabled) {
            return false;
        }

        const scheduleDays = schedule.days;
        const startTime = schedule.startTime;
        const endTime = schedule.endTime;

        if (!startTime || !endTime) {
            return false;
        }

        const currentMinutes = this.parseTime(currentTime);
        const startMinutes = this.parseTime(startTime);
        const endMinutes = this.parseTime(endTime);

        if (startMinutes <= endMinutes) {
            return this.isDayMatch(currentDay, scheduleDays) && this.isTimeInRange(currentTime, startTime, endTime);
        }

        const previousDay = this.getPreviousDay(currentDay);
        const matchesLateWindow = this.isDayMatch(currentDay, scheduleDays) && currentMinutes >= startMinutes;
        const matchesAfterMidnightWindow = previousDay !== null
            && this.isDayMatch(previousDay, scheduleDays)
            && currentMinutes < endMinutes;

        return matchesLateWindow || matchesAfterMidnightWindow;
    }

    compareSchedulesByPriority(leftSchedule, rightSchedule) {
        const leftPriority = parseSchedulePriority(leftSchedule?.priority);
        const rightPriority = parseSchedulePriority(rightSchedule?.priority);
        if (rightPriority !== leftPriority) {
            return rightPriority - leftPriority;
        }

        const leftUpdatedAt = Date.parse(leftSchedule?.updatedAt || leftSchedule?.createdAt || 0);
        const rightUpdatedAt = Date.parse(rightSchedule?.updatedAt || rightSchedule?.createdAt || 0);
        return rightUpdatedAt - leftUpdatedAt;
    }

    // Get currently active schedule (considering overrides)
    getActiveSchedule(serverNum) {
        const config = this.getServerConfig(serverNum);

        // Check for active override
        if (config.activeOverride) {
            const override = config.activeOverride;

            // Check if override has expired
            if (override.expiresAt && new Date(override.expiresAt) < new Date()) {
                this.clearOverride(serverNum);
            } else {
                // Find the override schedule
                const schedule = config.schedules.find(s => s.id === override.scheduleId);
                if (schedule) {
                    return {
                        ...schedule,
                        isOverride: true,
                        overrideType: override.type,
                        overrideExpiresAt: override.expiresAt
                    };
                }
            }
        }

        // Get current time
        const { time, day } = this.getCurrentTime(serverNum);

        const matchingSchedules = [...config.schedules]
            .filter(schedule => this.scheduleMatchesDateTime(day, time, schedule))
            .sort((leftSchedule, rightSchedule) => this.compareSchedulesByPriority(leftSchedule, rightSchedule));

        if (matchingSchedules.length > 0) {
            return { ...matchingSchedules[0], isOverride: false };
        }

        // No matching schedule - use default (all maps)
        return {
            id: 'default',
            name: 'Default',
            isDefault: true,
            isOverride: false,
            settings: null, // Will use current service settings
            whitelist: null, // Will use CRCON whitelist
            generalSettings: createDefaultScheduleGeneralSettings(),
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

    // Create a new schedule
    createSchedule(serverNum, scheduleData) {
        const config = this.initServer(serverNum);

        const schedule = {
            id: `s${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
            name: scheduleData.name || 'New Schedule',
            startTime: scheduleData.startTime || '00:00',
            endTime: scheduleData.endTime || '23:59',
            days: scheduleData.days || DAY_PRESETS.all,
            priority: parseSchedulePriority(scheduleData.priority),
            enabled: true,
            createdAt: new Date().toISOString(),
            settings: {
                minimumPlayers: scheduleData.minimumPlayers ?? 25,
                deactivatePlayers: scheduleData.deactivatePlayers ?? 10,
                mapsPerVote: scheduleData.mapsPerVote ?? 6,
                nightMapCount: scheduleData.nightMapCount ?? 1
            },
            whitelist: Array.isArray(scheduleData.whitelist)
                ? normalizeScheduleWhitelist(scheduleData.whitelist)
                : null, // null = use CRCON whitelist
            generalSettings: {
                ...createDefaultScheduleGeneralSettings(),
                ...(scheduleData.generalSettings || {})
            },
            automodConfigs: scheduleData.automodConfigs || {
                level: null,
                no_leader: null,
                solo_tank: null
            },
            automodProfiles: scheduleData.automodProfiles || {
                level: null,
                no_leader: null,
                solo_tank: null
            }
        };

        config.schedules.push(schedule);
        if (!this.saveData()) {
            config.schedules = config.schedules.filter(item => item.id !== schedule.id);
            return null;
        }

        logger.info(`[ScheduleManager] Created schedule "${schedule.name}" for server ${serverNum}`);
        return schedule;
    }

    // Update a schedule
    updateSchedule(serverNum, scheduleId, updates) {
        const config = this.getServerConfig(serverNum);
        const index = config.schedules.findIndex(s => s.id === scheduleId);

        if (index === -1) {
            return { success: false, error: 'Schedule not found' };
        }

        const schedule = config.schedules[index];
        const originalSchedule = JSON.parse(JSON.stringify(schedule));

        // Update allowed fields
        if (updates.name !== undefined) schedule.name = updates.name;
        if (updates.startTime !== undefined) schedule.startTime = updates.startTime;
        if (updates.endTime !== undefined) schedule.endTime = updates.endTime;
        if (updates.days !== undefined) schedule.days = updates.days;
        if (updates.priority !== undefined) schedule.priority = parseSchedulePriority(updates.priority);
        if (updates.enabled !== undefined) schedule.enabled = updates.enabled;
        if (updates.settings !== undefined) {
            schedule.settings = { ...schedule.settings, ...updates.settings };
        }
        if (updates.whitelist !== undefined) {
            schedule.whitelist = Array.isArray(updates.whitelist)
                ? normalizeScheduleWhitelist(updates.whitelist)
                : updates.whitelist;
        }
        if (updates.generalSettings !== undefined) {
            schedule.generalSettings = {
                ...createDefaultScheduleGeneralSettings(),
                ...(updates.generalSettings || {})
            };
        }
        if (updates.automodConfigs !== undefined) schedule.automodConfigs = updates.automodConfigs;
        if (updates.automodProfiles !== undefined) schedule.automodProfiles = updates.automodProfiles;

        schedule.updatedAt = new Date().toISOString();
        if (!this.saveData()) {
            config.schedules[index] = originalSchedule;
            return { success: false, error: 'Failed to save schedule changes' };
        }

        logger.info(`[ScheduleManager] Updated schedule "${schedule.name}" for server ${serverNum}`);
        return { success: true, schedule };
    }

    // Delete a schedule
    deleteSchedule(serverNum, scheduleId) {
        const config = this.getServerConfig(serverNum);
        const index = config.schedules.findIndex(s => s.id === scheduleId);

        if (index === -1) {
            return { success: false, error: 'Schedule not found' };
        }

        const deleted = config.schedules.splice(index, 1)[0];

        // Clear override if it was using this schedule
        if (config.activeOverride?.scheduleId === scheduleId) {
            config.activeOverride = null;
        }

        if (!this.saveData()) {
            config.schedules.splice(index, 0, deleted);
            return { success: false, error: 'Failed to save schedule deletion' };
        }
        logger.info(`[ScheduleManager] Deleted schedule "${deleted.name}" from server ${serverNum}`);
        return { success: true };
    }

    // Get all schedules for a server
    getSchedules(serverNum) {
        const config = this.getServerConfig(serverNum);
        return config.schedules || [];
    }

    // Set override
    setOverride(serverNum, scheduleId, type, durationHours = null) {
        const config = this.getServerConfig(serverNum);
        const previousOverride = config.activeOverride ? { ...config.activeOverride } : null;

        // Validate schedule exists (or allow 'default')
        if (scheduleId !== 'default') {
            const schedule = config.schedules.find(s => s.id === scheduleId);
            if (!schedule) {
                return { success: false, error: 'Schedule not found' };
            }
        }

        let expiresAt = null;
        if (type === 'hours' && durationHours) {
            expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
        }

        config.activeOverride = {
            scheduleId,
            type, // 'match' or 'hours'
            durationHours,
            expiresAt,
            setAt: new Date().toISOString()
        };

        if (!this.saveData()) {
            config.activeOverride = previousOverride;
            return { success: false, error: 'Failed to save override' };
        }

        // Set timer to clear override if hours-based
        if (expiresAt) {
            const timerId = setTimeout(() => {
                this.clearOverride(serverNum);
                logger.info(`[ScheduleManager] Override expired for server ${serverNum}`);
            }, durationHours * 60 * 60 * 1000);

            // Clear any existing timer
            if (this.overrideTimers.has(serverNum)) {
                clearTimeout(this.overrideTimers.get(serverNum));
            }
            this.overrideTimers.set(serverNum, timerId);
        }

        logger.info(`[ScheduleManager] Override set for server ${serverNum}: ${scheduleId} (${type})`);
        return { success: true };
    }

    // Clear override
    clearOverride(serverNum) {
        const config = this.getServerConfig(serverNum);
        const previousOverride = config.activeOverride ? { ...config.activeOverride } : null;
        config.activeOverride = null;
        if (!this.saveData()) {
            config.activeOverride = previousOverride;
            return { success: false, error: 'Failed to clear override' };
        }

        // Clear timer if exists
        if (this.overrideTimers.has(serverNum)) {
            clearTimeout(this.overrideTimers.get(serverNum));
            this.overrideTimers.delete(serverNum);
        }

        logger.info(`[ScheduleManager] Override cleared for server ${serverNum}`);
        return { success: true };
    }

    // Called when match ends - clears 'match' type overrides
    onMatchEnd(serverNum) {
        const config = this.getServerConfig(serverNum);
        if (config.activeOverride?.type === 'match') {
            this.clearOverride(serverNum);
            logger.info(`[ScheduleManager] Match override cleared for server ${serverNum}`);
            return true;
        }
        return false;
    }

    // Get schedule settings to apply
    getScheduleSettings(serverNum) {
        const schedule = this.getActiveSchedule(serverNum);

        return {
            scheduleName: schedule.name,
            scheduleId: schedule.id,
            isDefault: schedule.isDefault || false,
            isOverride: schedule.isOverride || false,
            overrideType: schedule.overrideType,
            overrideExpiresAt: schedule.overrideExpiresAt,
            settings: schedule.settings,
            whitelist: schedule.whitelist,
            generalSettings: {
                ...createDefaultScheduleGeneralSettings(),
                ...(schedule.generalSettings || {})
            },
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
    }

    // Format schedule for display
    formatScheduleDisplay(schedule, serverNum) {
        const config = this.getServerConfig(serverNum);
        const { time } = this.getCurrentTime(serverNum);
        const normalizedDays = Array.isArray(schedule.days) ? [...schedule.days].sort() : null;
        const weekdayPreset = [...DAY_PRESETS.weekdays].sort();
        const weekendPreset = [...DAY_PRESETS.weekend].sort();

        let daysDisplay = 'All Days';
        if (schedule.days) {
            if (JSON.stringify(normalizedDays) === JSON.stringify(weekdayPreset)) {
                daysDisplay = 'Weekdays';
            } else if (JSON.stringify(normalizedDays) === JSON.stringify(weekendPreset)) {
                daysDisplay = 'Weekend';
            } else if (schedule.days.length < 7) {
                daysDisplay = schedule.days.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
            }
        }

        return {
            name: schedule.name,
            timeRange: `${schedule.startTime} - ${schedule.endTime}`,
            days: daysDisplay,
            enabled: schedule.enabled !== false,
            settings: schedule.settings,
            priority: parseSchedulePriority(schedule.priority),
            whitelistCount: schedule.whitelist?.length || 'All'
        };
    }

    // Get common timezones for UI
    getTimezones() {
        return COMMON_TIMEZONES;
    }

    // Get day presets
    getDayPresets() {
        return DAY_PRESETS;
    }
}

module.exports = new ScheduleManager();
