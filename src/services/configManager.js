/**
 * Configuration Manager
 * Handles persistent configuration via Discord setup wizard
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getDataFilePath } = require('../utils/dataPath');

const CONFIG_PATH = getDataFilePath('config.json');

class ConfigManager {
    constructor() {
        this.config = this.loadConfig();
    }

    loadConfig() {
        try {
            // Ensure data directory exists
            const dataDir = path.dirname(CONFIG_PATH);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            if (fs.existsSync(CONFIG_PATH)) {
                const data = fs.readFileSync(CONFIG_PATH, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            logger.error('Error loading config:', error);
        }

        // Default config structure
        return {
            setupComplete: false,
            adminRoleId: null,
            servers: {}
        };
    }

    // Admin role management
    getAdminRoleId() {
        return this.config.adminRoleId;
    }

    setAdminRoleId(roleId) {
        this.config.adminRoleId = roleId;
        return this.saveConfig();
    }

    clearAdminRole() {
        this.config.adminRoleId = null;
        return this.saveConfig();
    }

    saveConfig() {
        try {
            const dataDir = path.dirname(CONFIG_PATH);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
            logger.info('Configuration saved');
            return true;
        } catch (error) {
            logger.error('Error saving config:', error);
            return false;
        }
    }

    isSetupComplete() {
        return this.config.setupComplete && Object.keys(this.config.servers).length > 0;
    }

    getServerConfig(serverNum) {
        return this.config.servers[serverNum] || null;
    }

    getNonSeededMapList(serverNum) {
        const serverConfig = this.getServerConfig(serverNum);
        return Array.isArray(serverConfig?.nonSeededMapList) ? [...serverConfig.nonSeededMapList] : [];
    }

    setServerConfig(serverNum, config) {
        const previousServerConfig = this.config.servers[serverNum]
            ? JSON.parse(JSON.stringify(this.config.servers[serverNum]))
            : undefined;
        const previousSetupComplete = this.config.setupComplete;

        this.config.servers[serverNum] = {
            ...this.config.servers[serverNum],
            ...config,
            updatedAt: new Date().toISOString()
        };
        this.config.setupComplete = true;

        if (this.saveConfig()) {
            return true;
        }

        if (previousServerConfig === undefined) {
            delete this.config.servers[serverNum];
        } else {
            this.config.servers[serverNum] = previousServerConfig;
        }
        this.config.setupComplete = previousSetupComplete;
        return false;
    }

    removeServerConfig(serverNum) {
        delete this.config.servers[serverNum];
        if (Object.keys(this.config.servers).length === 0) {
            this.config.setupComplete = false;
        }
        return this.saveConfig();
    }

    setNonSeededMapList(serverNum, mapList) {
        const current = this.config.servers[serverNum] || {};
        this.config.servers[serverNum] = {
            ...current,
            nonSeededMapList: Array.isArray(mapList) ? [...new Set(mapList)] : [],
            updatedAt: new Date().toISOString()
        };
        this.config.setupComplete = true;
        return this.saveConfig();
    }

    getAllServers() {
        return this.config.servers;
    }

    // Get effective config - merges .env with saved config (env takes priority)
    getEffectiveServerConfig(serverNum) {
        const saved = this.getServerConfig(serverNum);
        const suffix = serverNum === 1 ? '' : `_${serverNum}`;

        const normalizeEnvValue = (value) => {
            if (value === undefined || value === null) return undefined;
            const trimmed = String(value).trim();
            if (!trimmed) return undefined;
            // Allow accidentally quoted env values (e.g. "https://...")
            return trimmed.replace(/^['"]|['"]$/g, '');
        };

        // Environment variable names
        const envUrl = normalizeEnvValue(process.env[`CRCON_API_URL${suffix}`]);
        const envToken = normalizeEnvValue(process.env[`CRCON_API_TOKEN${suffix}`]);
        const envRconHost = normalizeEnvValue(process.env[`HLL_RCON_HOST${suffix}`]);
        const envRconPort = normalizeEnvValue(process.env[`HLL_RCON_PORT${suffix}`]);
        const envRconPassword = normalizeEnvValue(process.env[`HLL_RCON_PASSWORD${suffix}`]);
        const envTransportMode = normalizeEnvValue(
            process.env[`TRANSPORT_MODE${suffix}`] ?? process.env.TRANSPORT_MODE
        );
        const envChannel = normalizeEnvValue(process.env[`MAP_VOTE_CHANNEL_ID${suffix}`]);
        const envExclude = normalizeEnvValue(
            process.env[`EXCLUDE_PLAYED_MAP_FOR_XVOTES${suffix}`] ?? process.env.EXCLUDE_PLAYED_MAP_FOR_XVOTES
        );

        const parseExcludeValue = (value) => {
            if (value === undefined || value === null) return undefined;
            const parsed = parseInt(value, 10);
            if (Number.isNaN(parsed)) return undefined;
            return Math.min(Math.max(parsed, 0), 10);
        };

        const excludeFromConfig = saved?.excludePlayedMapForXvotes;
        const excludeFromEnv = parseExcludeValue(envExclude);
        const excludePlayedMapForXvotes = excludeFromEnv ?? excludeFromConfig ?? 3;
        const transportMode = envTransportMode || saved?.transportMode || 'crcon-api';
        const resolvedCrconUrl = envUrl || saved?.crconUrl;
        const resolvedCrconToken = envToken || saved?.crconToken;
        const resolvedRconHost = envRconHost || saved?.rconHost;
        const resolvedRconPort = envRconPort || saved?.rconPort;
        const resolvedRconPassword = envRconPassword || saved?.rconPassword;

        const apiConfigured = !!resolvedCrconUrl && !!resolvedCrconToken;
        const rconConfigured = !!resolvedRconHost && !!resolvedRconPort && !!resolvedRconPassword;
        const configured = transportMode === 'direct-rcon'
            ? rconConfigured
            : transportMode === 'crcon-api-with-rcon-fallback'
                ? (apiConfigured || rconConfigured)
                : apiConfigured;

        // Merge: env overrides saved config
        return {
            crconUrl: resolvedCrconUrl,
            crconToken: resolvedCrconToken,
            rconHost: resolvedRconHost,
            rconPort: resolvedRconPort,
            rconPassword: resolvedRconPassword,
            transportMode,
            channelId: envChannel || saved?.channelId,
            serverName: saved?.serverName || `Server ${serverNum}`,
            configured,
            apiConfigured,
            rconConfigured,
            excludePlayedMapForXvotes,
            nonSeededMapList: Array.isArray(saved?.nonSeededMapList) ? [...saved.nonSeededMapList] : []
        };
    }
}

module.exports = new ConfigManager();
