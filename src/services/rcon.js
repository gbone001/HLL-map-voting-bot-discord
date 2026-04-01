/**
 * RCON Service
 * Implements a CRCON-like interface using direct HLL RCON commands.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getDataFilePath } = require('../utils/dataPath');
const { RconConnection } = require('../rcon/connection');

const STATE_PATH = getDataFilePath('rcon-state.json');

function toMapId(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
}

function toPrettyName(mapId) {
    const text = String(mapId || '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    return text || 'Unknown';
}

function inferGameMode(mapId) {
    const id = String(mapId || '').toLowerCase();
    if (id.includes('offensive')) return 'offensive';
    if (id.includes('skirmish')) return 'skirmish';
    return 'warfare';
}

function inferEnvironment(mapId) {
    const id = String(mapId || '').toLowerCase();
    return id.includes('night') ? 'night' : 'day';
}

function firstNumber(...values) {
    for (const value of values) {
        const num = Number(value);
        if (Number.isFinite(num)) {
            return num;
        }
    }
    return null;
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

class RCONService {
    constructor(host, password, serverName = 'Server', port = 27015) {
        this.host = host;
        this.password = password;
        this.serverName = serverName;
        this.port = Number(port) || 27015;
        this.supportsAutomod = false;
        this.supportsHistory = false;
        this.connection = null;
        this.state = this.loadState();
    }

    isConfigured() {
        return !!(this.host && this.password);
    }

    get stateKey() {
        return `${this.serverName}|${this.host}:${this.port}`;
    }

    loadState() {
        try {
            if (!fs.existsSync(STATE_PATH)) {
                return this.defaultState();
            }

            const raw = fs.readFileSync(STATE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed[this.stateKey] || this.defaultState();
        } catch (error) {
            logger.warn(`[RCON ${this.serverName}] Could not load state: ${error.message}`);
            return this.defaultState();
        }
    }

    defaultState() {
        return {
            votemapEnabled: true,
            whitelist: null,
            teamSwitchCooldown: null,
            idleAutokickTime: null,
            maxPingAutokick: null,
            lastPublicInfoMapName: null,
            lastPublicInfoStart: null
        };
    }

    saveState() {
        try {
            const dir = path.dirname(STATE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            let parsed = {};
            if (fs.existsSync(STATE_PATH)) {
                parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
            }
            parsed[this.stateKey] = this.state;
            fs.writeFileSync(STATE_PATH, JSON.stringify(parsed, null, 2), 'utf8');
        } catch (error) {
            logger.warn(`[RCON ${this.serverName}] Could not save state: ${error.message}`);
        }
    }

    async ensureConnection() {
        if (!this.isConfigured()) {
            throw new Error('RCON not configured');
        }

        if (this.connection && !this.connection.closed) {
            return this.connection;
        }

        this.connection = new RconConnection({
            host: this.host,
            port: this.port,
            password: this.password
        });
        await this.connection.connect();
        return this.connection;
    }

    close() {
        if (this.connection) {
            this.connection.close();
            this.connection = null;
        }
    }

    async withConnection(handler) {
        try {
            const conn = await this.ensureConnection();
            return await handler(conn);
        } catch (error) {
            if (this.connection) {
                this.connection.close();
                this.connection = null;
            }
            throw error;
        }
    }

    async get(endpoint) {
        if (endpoint === 'get_public_info') {
            const status = await this.getStatus();
            const mapName = status?.result?.current_map?.name || 'unknown';
            const reportedStart = status?.result?.current_map?.start || null;
            const now = Math.floor(Date.now() / 1000);

            if (this.state.lastPublicInfoMapName !== mapName) {
                this.state.lastPublicInfoMapName = mapName;
                this.state.lastPublicInfoStart = Number.isFinite(Number(reportedStart))
                    ? Number(reportedStart)
                    : now;
                this.saveState();
            }

            return {
                result: {
                    current_map: {
                        start: this.state.lastPublicInfoStart || now
                    }
                }
            };
        }

        throw new Error(`RCON provider does not support GET endpoint "${endpoint}"`);
    }

    async post(endpoint, data = {}) {
        if (endpoint === 'get_recent_logs') {
            return { result: [] };
        }

        if (endpoint === 'set_map_rotation') {
            const next = Array.isArray(data?.map_names) ? data.map_names[0] : null;
            if (!next) {
                throw new Error('set_map_rotation requires map_names[0]');
            }
            await this.setNextMap(next);
            return { failed: false, result: true };
        }

        throw new Error(`RCON provider does not support POST endpoint "${endpoint}"`);
    }

    async getMaps() {
        const sequence = await this.withConnection((conn) => conn.getMapSequence());
        let mapNames = Array.isArray(sequence)
            ? sequence
            : sequence?.MapNames || sequence?.map_names || sequence?.maps || [];

        if (!Array.isArray(mapNames) || mapNames.length === 0) {
            const rotation = await this.withConnection((conn) => conn.getMapRotation());
            mapNames = Array.isArray(rotation)
                ? rotation
                : rotation?.MapNames || rotation?.map_names || rotation?.maps || [];
        }

        const uniqueMapNames = [...new Set(mapNames)];

        const result = uniqueMapNames.map((name) => {
            const id = toMapId(name);
            return {
                id,
                pretty_name: toPrettyName(id),
                game_mode: inferGameMode(id),
                environment: inferEnvironment(id)
            };
        });

        return { result };
    }

    async getMapRotation() {
        const rotation = await this.withConnection((conn) => conn.getMapRotation());
        return { result: rotation };
    }

    async getCurrentMap() {
        const session = await this.withConnection((conn) => conn.getSessionInfo());
        return {
            result: {
                map: firstString(
                    session?.CurrentMapName,
                    session?.currentMapName,
                    session?.CurrentMap,
                    session?.current_map
                )
            }
        };
    }

    async getGameState() {
        const session = await this.withConnection((conn) => conn.getSessionInfo());
        return { result: session };
    }

    async getStatus() {
        const [session, players] = await Promise.all([
            this.withConnection((conn) => conn.getSessionInfo()),
            this.withConnection((conn) => conn.getPlayers())
        ]);

        const playerCount = firstNumber(
            players?.PlayerCount,
            players?.playerCount,
            players?.current_players,
            Array.isArray(players) ? players.length : null
        ) || 0;

        const maxPlayers = firstNumber(
            session?.MaxPlayers,
            session?.maxPlayers,
            session?.max_players
        ) || 100;

        const currentMap = firstString(
            session?.CurrentMapName,
            session?.currentMapName,
            session?.CurrentMap,
            session?.current_map
        );

        const mapStart = firstNumber(
            session?.MapStartTimestamp,
            session?.mapStartTimestamp,
            session?.currentMapStart,
            session?.start,
            session?.Start
        ) || Math.floor(Date.now() / 1000);

        return {
            result: {
                name: firstString(session?.ServerName, session?.serverName, this.serverName) || this.serverName,
                current_players: playerCount,
                max_players: maxPlayers,
                current_map: {
                    name: currentMap,
                    start: mapStart
                }
            }
        };
    }

    async getDetailedPlayers() {
        const players = await this.withConnection((conn) => conn.getPlayers());
        return { result: players };
    }

    async setNextMap(mapId) {
        await this.withConnection((conn) => conn.changeMap(mapId));
        return { failed: false, result: true };
    }

    async addMapToRotation() {
        throw new Error('RCON provider does not support add_map_to_rotation');
    }

    async removeMapFromRotation() {
        throw new Error('RCON provider does not support remove_map_from_rotation');
    }

    async getVotemapConfig() {
        return {
            result: {
                enabled: this.state.votemapEnabled
            }
        };
    }

    async getVotemapWhitelist() {
        if (!Array.isArray(this.state.whitelist)) {
            const maps = await this.getMaps();
            return { result: maps.result.map((m) => m.id) };
        }
        return { result: [...this.state.whitelist] };
    }

    async setVotemapWhitelist(maps) {
        this.state.whitelist = Array.isArray(maps) ? maps.map(toMapId) : [];
        this.saveState();
        return { failed: false, result: true };
    }

    async addToVotemapWhitelist(mapId) {
        const list = await this.getVotemapWhitelist();
        const set = new Set(list.result);
        set.add(toMapId(mapId));
        this.state.whitelist = Array.from(set);
        this.saveState();
        return { failed: false, result: true };
    }

    async removeFromVotemapWhitelist(mapId) {
        const list = await this.getVotemapWhitelist();
        const target = toMapId(mapId);
        this.state.whitelist = list.result.filter((id) => id !== target);
        this.saveState();
        return { failed: false, result: true };
    }

    async resetVotemapWhitelist() {
        this.state.whitelist = null;
        this.saveState();
        return { failed: false, result: true };
    }

    async resetVotemapState() {
        return { failed: false, result: true };
    }

    async getVotemapStatus() {
        return {
            result: {
                enabled: this.state.votemapEnabled
            }
        };
    }

    async setVotemapEnabled(enabled) {
        this.state.votemapEnabled = !!enabled;
        this.saveState();
        return { failed: false, result: true };
    }

    async broadcast(message) {
        await this.withConnection((conn) => conn.serverBroadcast(String(message || '')));
        return { failed: false, result: true };
    }

    async getMapHistory() {
        // Raw RCON does not expose CRCON's map history endpoint.
        return { result: [] };
    }

    async describeAutoModSoloTankConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async getAutoModSoloTankConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async validateAutoModSoloTankConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async setAutoModSoloTankConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async describeAutoModNoLeaderConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async getAutoModNoLeaderConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async validateAutoModNoLeaderConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async setAutoModNoLeaderConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async describeAutoModLevelConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async getAutoModLevelConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async validateAutoModLevelConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async setAutoModLevelConfig() {
        throw new Error('Automod config is not supported via direct RCON in this build');
    }

    async getTeamSwitchCooldown() {
        return { result: this.state.teamSwitchCooldown };
    }

    async setTeamSwitchCooldown(minutes) {
        await this.withConnection((conn) => conn.setTeamSwitchCooldown(minutes));
        this.state.teamSwitchCooldown = Number(minutes);
        this.saveState();
        return { failed: false, result: this.state.teamSwitchCooldown };
    }

    async getIdleAutokickTime() {
        try {
            const response = await this.withConnection((conn) => conn.getIdleKickDuration());
            const value = firstNumber(
                response?.IdleTimeoutMinutes,
                response?.idleTimeoutMinutes,
                response?.minutes
            );
            if (value !== null) {
                this.state.idleAutokickTime = value;
                this.saveState();
            }
            return { result: value };
        } catch {
            return { result: this.state.idleAutokickTime };
        }
    }

    async setIdleAutokickTime(minutes) {
        await this.withConnection((conn) => conn.setIdleKickDuration(minutes));
        this.state.idleAutokickTime = Number(minutes);
        this.saveState();
        return { failed: false, result: this.state.idleAutokickTime };
    }

    async getMaxPingAutokick() {
        return { result: this.state.maxPingAutokick };
    }

    async setMaxPingAutokick(maxMs) {
        await this.withConnection((conn) => conn.setHighPingThreshold(maxMs));
        this.state.maxPingAutokick = Number(maxMs);
        this.saveState();
        return { failed: false, result: this.state.maxPingAutokick };
    }
}

module.exports = {
    RCONService
};
