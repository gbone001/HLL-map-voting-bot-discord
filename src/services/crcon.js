/**
 * CRCON Service
 * Handles communication with Hell Let Loose CRCON API
 */

const axios = require('axios');
const logger = require('../utils/logger');

class CRCONService {
    constructor(baseUrl, apiToken, serverName = 'Server') {
        this.baseUrl = baseUrl?.replace(/\/$/, ''); // Remove trailing slash
        this.apiToken = apiToken;
        this.serverName = serverName;
        this.supportsAutomod = true;
        this.supportsHistory = true;
        this.supportsRecentLogs = true;
        this.supportsDirectGameState = false;
        this.client = null;

        if (this.baseUrl && this.apiToken) {
            this.client = axios.create({
                baseURL: this.baseUrl,
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
        }
    }

    isConfigured() {
        return !!(this.baseUrl && this.apiToken);
    }

    formatRequestError(error) {
        if (!error) return 'Unknown error';

        const parts = [];
        const responseData = error.response?.data;

        if (error.response) {
            parts.push(`status=${error.response.status}`);
            if (error.response.statusText) {
                parts.push(`statusText=${error.response.statusText}`);
            }
            if (responseData?.detail) {
                parts.push(`detail=${responseData.detail}`);
            } else if (responseData?.message) {
                parts.push(`apiMessage=${responseData.message}`);
            } else if (typeof responseData === 'string' && responseData.trim()) {
                parts.push(`apiBody=${responseData.trim().slice(0, 300)}`);
            }
        } else if (error.request) {
            parts.push('no_response=true');
        }

        if (error.code) {
            parts.push(`code=${error.code}`);
        }

        if (error.config?.method) {
            parts.push(`method=${String(error.config.method).toUpperCase()}`);
        }

        if (error.config?.url) {
            parts.push(`url=${error.config.url}`);
        }

        if (error.message) {
            parts.push(`message=${error.message}`);
        }

        return parts.join(' | ') || 'Unknown request error';
    }

    async get(endpoint) {
        if (!this.client) {
            throw new Error('CRCON not configured');
        }

        try {
            logger.debug(`CRCON GET: ${endpoint}`);
            const response = await this.client.get(`/api/${endpoint}`);
            return response.data;
        } catch (error) {
            logger.error(`[CRCON ${this.serverName}] GET ${endpoint} failed: ${this.formatRequestError(error)}`);
            throw error;
        }
    }

    async post(endpoint, data = {}) {
        if (!this.client) {
            throw new Error('CRCON not configured');
        }

        try {
            logger.debug(`CRCON POST: ${endpoint}`);
            const response = await this.client.post(`/api/${endpoint}`, data);
            return response.data;
        } catch (error) {
            logger.error(`[CRCON ${this.serverName}] POST ${endpoint} failed: ${this.formatRequestError(error)}`);
            throw error;
        }
    }

    assertCommandSucceeded(response, endpoint) {
        if (response && typeof response === 'object' && response.failed === true) {
            const err = response.error || `CRCON command ${endpoint} returned failed=true`;
            throw new Error(err);
        }
    }

    // Map Voting Methods
    async getMaps() {
        return this.get('get_maps');
    }

    async getMapRotation() {
        return this.get('get_map_rotation');
    }

    async getCurrentMap() {
        return this.get('get_map');
    }

    async getGameState() {
        return this.get('get_gamestate');
    }

    async getStatus() {
        return this.get('get_status');
    }

    async getDetailedPlayers() {
        return this.get('get_detailed_players');
    }

    async setNextMap(mapId) {
        return this.post('set_map', { map_name: mapId });
    }

    async addMapToRotation(mapId) {
        return this.post('add_map_to_rotation', { map_name: mapId });
    }

    async removeMapFromRotation(mapId) {
        return this.post('remove_map_from_rotation', { map_name: mapId });
    }

    // Votemap specific methods
    async getVotemapConfig() {
        return this.get('get_votemap_config');
    }

    async getVotemapWhitelist() {
        return this.get('get_votemap_whitelist');
    }

    async setVotemapWhitelist(maps) {
        return this.post('set_votemap_whitelist', { map_names: maps });
    }

    async addToVotemapWhitelist(mapId) {
        return this.post('add_map_to_votemap_whitelist', { map_name: mapId });
    }

    async removeFromVotemapWhitelist(mapId) {
        return this.post('remove_map_from_votemap_whitelist', { map_name: mapId });
    }

    async resetVotemapWhitelist() {
        return this.post('reset_map_votemap_whitelist', {});
    }

    async resetVotemapState() {
        return this.post('reset_votemap_state');
    }

    async getVotemapStatus() {
        return this.get('get_votemap_status');
    }

    async setVotemapEnabled(enabled) {
        return this.post('set_votemap_config', { enabled });
    }

    // Broadcast message
    async broadcast(message) {
        return this.post('set_broadcast', { message });
    }

    // Map history
    async getMapHistory() {
        return this.get('get_map_history');
    }

    // Auto Mod - Solo Tank
    async describeAutoModSoloTankConfig() {
        return this.get('describe_auto_mod_solo_tank_config');
    }

    async getAutoModSoloTankConfig() {
        return this.get('get_auto_mod_solo_tank_config');
    }

    async validateAutoModSoloTankConfig(by, config, resetToDefault = false) {
        return this.post('validate_auto_mod_solo_tank_config', {
            by,
            config,
            reset_to_default: resetToDefault
        });
    }

    async setAutoModSoloTankConfig(by, config, resetToDefault = false) {
        return this.post('set_auto_mod_solo_tank_config', {
            by,
            config,
            reset_to_default: resetToDefault
        });
    }

    // Auto Mod - No Leader
    async describeAutoModNoLeaderConfig() {
        return this.get('describe_auto_mod_no_leader_config');
    }

    async getAutoModNoLeaderConfig() {
        return this.get('get_auto_mod_no_leader_config');
    }

    async validateAutoModNoLeaderConfig(by, config, resetToDefault = false) {
        return this.post('validate_auto_mod_no_leader_config', {
            by,
            config,
            reset_to_default: resetToDefault
        });
    }

    async setAutoModNoLeaderConfig(by, config, resetToDefault = false) {
        return this.post('set_auto_mod_no_leader_config', {
            by,
            config,
            reset_to_default: resetToDefault
        });
    }

    // Auto Mod - Level
    async describeAutoModLevelConfig() {
        return this.get('describe_auto_mod_level_config');
    }

    async getAutoModLevelConfig() {
        return this.get('get_auto_mod_level_config');
    }

    async validateAutoModLevelConfig(by, config, resetToDefault = false) {
        return this.post('validate_auto_mod_level_config', {
            by,
            config,
            reset_to_default: resetToDefault
        });
    }

    async setAutoModLevelConfig(by, config, resetToDefault = false) {
        return this.post('set_auto_mod_level_config', {
            by,
            config,
            reset_to_default: resetToDefault
        });
    }

    // General server settings
    async getTeamSwitchCooldown() {
        return this.get('get_team_switch_cooldown');
    }

    async setTeamSwitchCooldown(minutes) {
        const response = await this.post('set_team_switch_cooldown', { minutes });
        this.assertCommandSucceeded(response, 'set_team_switch_cooldown');
        return response;
    }

    async getIdleAutokickTime() {
        return this.get('get_idle_autokick_time');
    }

    async setIdleAutokickTime(minutes) {
        const response = await this.post('set_idle_autokick_time', { minutes });
        this.assertCommandSucceeded(response, 'set_idle_autokick_time');
        return response;
    }

    async getMaxPingAutokick() {
        return this.get('get_max_ping_autokick');
    }

    async setMaxPingAutokick(maxMs) {
        const response = await this.post('set_max_ping_autokick', { max_ms: maxMs });
        this.assertCommandSucceeded(response, 'set_max_ping_autokick');
        return response;
    }
}

// Create service instances
const crconService = new CRCONService(
    process.env.CRCON_API_URL,
    process.env.CRCON_API_TOKEN,
    'Server 1'
);

const crconService2 = process.env.CRCON_API_URL_2 ? new CRCONService(
    process.env.CRCON_API_URL_2,
    process.env.CRCON_API_TOKEN_2,
    'Server 2'
) : null;

const crconService3 = process.env.CRCON_API_URL_3 ? new CRCONService(
    process.env.CRCON_API_URL_3,
    process.env.CRCON_API_TOKEN_3,
    'Server 3'
) : null;

const crconService4 = process.env.CRCON_API_URL_4 ? new CRCONService(
    process.env.CRCON_API_URL_4,
    process.env.CRCON_API_TOKEN_4,
    'Server 4'
) : null;

module.exports = {
    CRCONService,
    crconService,
    crconService2,
    crconService3,
    crconService4
};
