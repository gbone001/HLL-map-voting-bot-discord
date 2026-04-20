/**
 * CRCON Service
 *
 * Acts as a transport facade over:
 * - the CRCON HTTP API
 * - direct Hell Let Loose RCON
 * - CRCON API with direct RCON fallback for supported commands
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { HLLRconClient } = require('./hllRconClient');
const { hllMapCatalog } = require('./hllMapCatalog');

const TRANSPORT_MODES = {
    API_ONLY: 'crcon-api',
    DIRECT_RCON: 'direct-rcon',
    API_WITH_FALLBACK: 'crcon-api-with-rcon-fallback'
};

const DEFAULT_CRCON_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CRCON_CIRCUIT_COOLDOWN_MS = 60 * 1000;

class CRCONService {
    constructor(configOrBaseUrl, apiToken, serverName = 'Server') {
        const config = typeof configOrBaseUrl === 'object' && configOrBaseUrl !== null
            ? { ...configOrBaseUrl }
            : {
                crconUrl: configOrBaseUrl,
                crconToken: apiToken,
                serverName
            };

        this.serverName = config.serverName || serverName;
        this.baseUrl = config.crconUrl?.replace(/\/$/, '');
        this.apiToken = config.crconToken;
        this.transportMode = normalizeTransportMode(config.transportMode);
        this.rconHost = config.rconHost || null;
        this.rconPort = config.rconPort || null;
        this.rconPassword = config.rconPassword || null;

        this.client = null;
        this.directClient = new HLLRconClient({
            host: this.rconHost,
            port: this.rconPort,
            password: this.rconPassword
        });

        this.localMapCatalog = this.loadLocalMapCatalog();
        this.mapLookup = this.buildMapLookup(this.localMapCatalog);
        this.localMapHistory = [];
        this.currentMatchMapId = null;
        this.matchStartEpochMs = null;
        this.crconFailureCount = 0;
        this.crconCircuitOpenUntil = 0;
        this.crconCircuitThreshold = Number.isFinite(config.crconCircuitThreshold)
            ? config.crconCircuitThreshold
            : DEFAULT_CRCON_CIRCUIT_THRESHOLD;
        this.crconCircuitCooldownMs = Number.isFinite(config.crconCircuitCooldownMs)
            ? config.crconCircuitCooldownMs
            : DEFAULT_CRCON_CIRCUIT_COOLDOWN_MS;

        if (this.hasApiConfigured()) {
            this.client = axios.create({
                baseURL: this.baseUrl,
                headers: {
                    Authorization: `Bearer ${this.apiToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
        }
    }

    isConfigured() {
        if (this.transportMode === TRANSPORT_MODES.DIRECT_RCON) {
            return this.hasDirectRconConfigured();
        }

        if (this.transportMode === TRANSPORT_MODES.API_WITH_FALLBACK) {
            return this.hasApiConfigured() || this.hasDirectRconConfigured();
        }

        return this.hasApiConfigured();
    }

    hasApiConfigured() {
        return Boolean(this.baseUrl && this.apiToken);
    }

    hasDirectRconConfigured() {
        return this.directClient.isConfigured();
    }

    loadLocalMapCatalog() {
        return hllMapCatalog.getMaps().map((map) => ({ ...map, map: { ...map.map } }));
    }

    refreshLocalMapCatalog() {
        this.localMapCatalog = this.loadLocalMapCatalog();
        this.mapLookup = this.buildMapLookup(this.localMapCatalog);
        return this.localMapCatalog;
    }

    isDirectFallbackEnabled() {
        return this.transportMode === TRANSPORT_MODES.DIRECT_RCON ||
            this.transportMode === TRANSPORT_MODES.API_WITH_FALLBACK;
    }

    supportsDirectSessionPolling() {
        return this.isDirectFallbackEnabled() && this.hasDirectRconConfigured();
    }

    supportsCapability(capability) {
        const supportMatrix = {
            get_status: true,
            get_maps: true,
            get_map: true,
            get_map_rotation: true,
            set_map: true,
            set_map_rotation: true,
            add_map_to_rotation: true,
            remove_map_from_rotation: true,
            set_broadcast: true,
            set_team_switch_cooldown: true,
            set_idle_autokick_time: true,
            set_max_ping_autokick: true,
            get_map_history: true,
            match_tracking: true,
            get_team_switch_cooldown: false,
            get_idle_autokick_time: false,
            get_max_ping_autokick: false,
            get_votemap_config: false,
            get_votemap_whitelist: false,
            set_votemap_whitelist: false,
            add_map_to_votemap_whitelist: false,
            remove_map_from_votemap_whitelist: false,
            reset_map_votemap_whitelist: false,
            reset_votemap_state: false,
            get_votemap_status: false,
            set_votemap_config: false,
            describe_auto_mod_solo_tank_config: false,
            get_auto_mod_solo_tank_config: false,
            validate_auto_mod_solo_tank_config: false,
            set_auto_mod_solo_tank_config: false,
            describe_auto_mod_no_leader_config: false,
            get_auto_mod_no_leader_config: false,
            validate_auto_mod_no_leader_config: false,
            set_auto_mod_no_leader_config: false,
            describe_auto_mod_level_config: false,
            get_auto_mod_level_config: false,
            validate_auto_mod_level_config: false,
            set_auto_mod_level_config: false,
            get_recent_logs: false,
            get_public_info: false
        };

        return supportMatrix[capability] === true;
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
        return this.executeEndpoint('get', endpoint);
    }

    async post(endpoint, data = {}) {
        return this.executeEndpoint('post', endpoint, data);
    }

    async executeEndpoint(method, endpoint, data = {}) {
        const apiExecutor = async () => {
            if (!this.client) {
                throw new Error('CRCON not configured');
            }

            try {
                logger.debug(`CRCON ${method.toUpperCase()}: ${endpoint}`);
                const response = method === 'get'
                    ? await this.client.get(`/api/${endpoint}`)
                    : await this.client.post(`/api/${endpoint}`, data);

                const normalizedResponse = endpoint === 'get_status'
                    ? this.normalizeApiStatusResponse(response.data)
                    : response.data;

                if (endpoint === 'get_status') {
                    this.updateLocalMatchStateFromStatus(normalizedResponse);
                }
                return normalizedResponse;
            } catch (error) {
                const isStatusEndpointFailure = endpoint === 'get_status' && (error.response?.status || 0) >= 500;
                const logMethod = isStatusEndpointFailure ? logger.warn.bind(logger) : logger.error.bind(logger);
                logMethod(
                    `[CRCON ${this.serverName}] ${method.toUpperCase()} ${endpoint} failed: ${this.formatRequestError(error)}`
                );
                throw error;
            }
        };

        const directExecutor = () => this.executeDirectEndpoint(method, endpoint, data);
        return this.executeWithTransport(method, endpoint, apiExecutor, directExecutor);
    }

    async executeWithTransport(method, endpoint, apiExecutor, directExecutor) {
        if (this.transportMode === TRANSPORT_MODES.DIRECT_RCON) {
            return directExecutor();
        }

        if (this.transportMode === TRANSPORT_MODES.API_ONLY) {
            return apiExecutor();
        }

        if (this.transportMode === TRANSPORT_MODES.API_WITH_FALLBACK) {
            const canUseDirect = this.hasDirectRconConfigured() && this.supportsCapability(endpoint);
            if (this.hasApiConfigured()) {
                if (canUseDirect && this.isCrconCircuitOpen()) {
                    return directExecutor();
                }

                try {
                    const result = await apiExecutor();
                    this.recordApiSuccess();
                    return result;
                } catch (error) {
                    this.recordApiFailure(error);

                    if (!canUseDirect) {
                        throw error;
                    }

                    logger.warn(
                        `[CRCON ${this.serverName}] Falling back to direct RCON for ${method.toUpperCase()} ${endpoint}`
                    );
                    return directExecutor();
                }
            }

            return directExecutor();
        }

        throw new Error(`Unknown transport mode: ${this.transportMode}`);
    }

    isCrconCircuitOpen() {
        return this.crconCircuitOpenUntil > Date.now();
    }

    recordApiSuccess() {
        if (this.crconFailureCount > 0 || this.crconCircuitOpenUntil > 0) {
            logger.info(`[CRCON ${this.serverName}] CRCON API recovered; closing fallback circuit`);
        }

        this.crconFailureCount = 0;
        this.crconCircuitOpenUntil = 0;
    }

    recordApiFailure(error) {
        if (!this.shouldTripCrconCircuit(error)) {
            return;
        }

        this.crconFailureCount += 1;
        if (this.crconFailureCount < this.crconCircuitThreshold) {
            return;
        }

        const nextOpenUntil = Date.now() + this.crconCircuitCooldownMs;
        if (nextOpenUntil <= this.crconCircuitOpenUntil) {
            return;
        }

        this.crconCircuitOpenUntil = nextOpenUntil;
        logger.warn(
            `[CRCON ${this.serverName}] CRCON API unhealthy; bypassing API for ${Math.round(this.crconCircuitCooldownMs / 1000)}s`
        );
    }

    shouldTripCrconCircuit(error) {
        const status = error?.response?.status;
        if (typeof status === 'number' && status >= 500) {
            return true;
        }

        return Boolean(error?.request && !error?.response);
    }

    async executeDirectEndpoint(method, endpoint, data = {}) {
        if (!this.hasDirectRconConfigured()) {
            throw new Error(`Direct RCON is not configured for ${this.serverName}`);
        }

        if (!this.supportsCapability(endpoint)) {
            throw createUnsupportedTransportError(
                endpoint,
                `Direct RCON does not support ${endpoint} for ${this.serverName}`
            );
        }

        switch (`${method}:${endpoint}`) {
            case 'get:get_status':
                return this.getDirectStatus();
            case 'get:get_maps':
                return { result: this.localMapCatalog };
            case 'get:get_map':
                return this.getDirectCurrentMap();
            case 'get:get_map_rotation':
                return this.getDirectMapRotation();
            case 'get:get_map_history':
                return { result: this.localMapHistory };
            case 'post:set_broadcast':
                return this.executeDirectCommand('ServerBroadcast', { Message: data.message || '' }, endpoint);
            case 'post:set_map':
                return this.executeDirectCommand('ChangeMap', { MapName: data.map_name }, endpoint);
            case 'post:set_map_rotation':
                return this.setDirectNextMap(data.map_names || []);
            case 'post:add_map_to_rotation':
                return this.executeDirectCommand(
                    'AddMapToRotation',
                    { MapName: data.map_name, Index: 0 },
                    endpoint
                );
            case 'post:remove_map_from_rotation':
                return this.removeDirectMapFromRotation(data.map_name);
            case 'post:set_team_switch_cooldown':
                return this.executeDirectCommand(
                    'SetTeamSwitchCooldown',
                    { TeamSwitchTimer: data.minutes },
                    endpoint
                );
            case 'post:set_idle_autokick_time':
                return this.executeDirectCommand(
                    'SetIdleKickDuration',
                    { IdleTimeoutMinutes: data.minutes },
                    endpoint
                );
            case 'post:set_max_ping_autokick':
                return this.executeDirectCommand(
                    'SetHighPingThreshold',
                    { HighPingThresholdMs: data.max_ms },
                    endpoint
                );
            default:
                throw createUnsupportedTransportError(
                    endpoint,
                    `Direct RCON transport handler missing for ${method.toUpperCase()} ${endpoint}`
                );
        }
    }

    async executeDirectCommand(command, contentBody, endpoint = command) {
        const response = await this.directClient.execute(command, contentBody);
        if (response.statusCode !== 200) {
            throw new Error(response.statusMessage || `${command} failed`);
        }

        const parsedBody = this.parseDirectContentBody(response.contentBody);
        const normalizedResponse = {
            result: parsedBody
        };

        this.assertCommandSucceeded(parsedBody, endpoint);

        if (endpoint === 'get_status') {
            this.updateLocalMatchStateFromStatus(normalizedResponse);
        }

        return normalizedResponse;
    }

    normalizeApiStatusResponse(responseData) {
        const session = responseData?.result || {};
        const currentMapId = this.resolveMapIdFromValues([
            session.map?.id,
            session.map?.pretty_name,
            session.map?.name,
            session.current_map?.id,
            session.current_map?.pretty_name,
            session.current_map?.name,
            session.mapId,
            session.map_id,
            session.MapId,
            session.mapName,
            session.MapName,
            session.currentMap,
            session.CurrentMap,
            session.CurrentMapName,
            session.map
        ]);
        const rawMapName = session.map?.pretty_name ||
            session.map?.name ||
            session.current_map?.pretty_name ||
            session.current_map?.name ||
            session.mapName ||
            session.MapName ||
            session.currentMap ||
            session.CurrentMap ||
            session.CurrentMapName;
        const resolvedMap = this.findMapById(currentMapId);

        return {
            ...responseData,
            result: {
                ...session,
                name: session.name || session.serverName || session.ServerName || session.Name || this.serverName,
                current_players: readInt(
                    session.current_players ??
                    session.currentPlayers ??
                    session.CurrentPlayers ??
                    session.playerCount ??
                    session.PlayerCount ??
                    session.players ??
                    session.Players
                ),
                max_players: readInt(
                    session.max_players ??
                    session.maxPlayers ??
                    session.MaxPlayers ??
                    session.maxPlayerCount ??
                    session.MaxPlayerCount
                ),
                map: resolvedMap || session.map || session.current_map || buildMapStub(currentMapId, rawMapName),
                current_map: resolvedMap || session.current_map || session.map || buildMapStub(currentMapId, rawMapName),
                raw: session
            }
        };
    }

    async getDirectStatus() {
        const statusResponse = await this.executeDirectCommand(
            'GetServerInformation',
            { Name: 'session', Value: '' },
            'get_status'
        );

        const session = statusResponse.result || {};
        const currentMapId = this.resolveMapIdFromValues([
            session.mapId,
            session.MapName,
            session.mapName,
            session.CurrentMapName,
            session.Map,
            session.CurrentMap,
            session.currentMap
        ]);
        const resolvedMap = this.findMapById(currentMapId);
        const rawMapName = session.mapName || session.MapName || session.currentMap || session.CurrentMapName;

        const normalized = {
            result: {
                name: session.serverName || session.ServerName || session.name || session.Name || this.serverName,
                current_players: readInt(
                    session.playerCount ?? session.PlayerCount ?? session.Players ?? session.CurrentPlayers
                ),
                max_players: readInt(session.maxPlayerCount ?? session.MaxPlayers ?? session.MaxPlayerCount),
                map: resolvedMap || buildMapStub(currentMapId, rawMapName),
                current_map: resolvedMap || buildMapStub(currentMapId, rawMapName),
                raw: session
            }
        };

        this.updateLocalMatchStateFromStatus(normalized);
        return normalized;
    }

    async getDirectCurrentMap() {
        const status = await this.getDirectStatus();
        return {
            result: status.result.map || status.result.current_map || null
        };
    }

    async getDirectMapRotation() {
        const response = await this.executeDirectCommand(
            'GetServerInformation',
            { Name: 'maprotation', Value: '' },
            'get_map_rotation'
        );

        return {
            result: this.normalizeMapCollection(response.result)
        };
    }

    async removeDirectMapFromRotation(mapName) {
        const rotation = await this.getDirectMapRotation();
        const mapIds = (rotation.result || []).map((entry) => entry.id);
        const index = mapIds.findIndex((entryId) => entryId === mapName);
        if (index === -1) {
            return {
                result: {
                    removed: false,
                    reason: 'map not found in rotation'
                }
            };
        }

        return this.executeDirectCommand('RemoveMapFromRotation', { Index: index }, 'remove_map_from_rotation');
    }

    async readDirectSequenceState() {
        const sequenceResponse = await this.executeDirectCommand(
            'GetServerInformation',
            { Name: 'mapsequence', Value: '' },
            'get_map_rotation'
        );

        return this.normalizeDirectSequenceState(sequenceResponse.result);
    }

    async moveDirectMapToSequenceIndex(mapId, targetIndex, endpoint = 'set_map_rotation', existingSequenceState = null) {
        if (!mapId) {
            throw new Error(`${endpoint} requires a map id`);
        }

        const sequenceState = existingSequenceState || await this.readDirectSequenceState();
        const sequence = sequenceState.entries;

        if (sequence.length === 0) {
            await this.executeDirectCommand(
                'AddMapToSequence',
                { MapName: mapId, Index: targetIndex },
                endpoint
            );

            return {
                sequenceState,
                action: 'sequence-add-empty'
            };
        }

        const currentIndex = Number.isInteger(sequenceState.currentIndex)
            ? sequenceState.currentIndex
            : 0;
        const existingIndex = this.findPreferredSequenceIndex(sequence, mapId, currentIndex);

        if (existingIndex === targetIndex) {
            return {
                sequenceState,
                action: 'sequence-noop'
            };
        }

        if (existingIndex >= 0) {
            await this.executeDirectCommand(
                'MoveMapInSequence',
                { CurrentIndex: existingIndex, NewIndex: targetIndex },
                endpoint
            );

            return {
                sequenceState,
                action: 'sequence-move-existing'
            };
        }

        await this.executeDirectCommand(
            'AddMapToSequence',
            { MapName: mapId, Index: targetIndex },
            endpoint
        );

        return {
            sequenceState,
            action: 'sequence-add-new'
        };
    }

    async setDirectNextMap(mapNames) {
        const mapId = Array.isArray(mapNames) ? mapNames[0] : null;
        if (!mapId) {
            throw new Error('set_map_rotation requires at least one map name');
        }

        const sequenceState = await this.readDirectSequenceState();
        const currentIndex = Number.isInteger(sequenceState.currentIndex)
            ? sequenceState.currentIndex
            : 0;
        const nextIndex = this.getDirectNextSequencePosition(sequenceState);
        const moveResult = await this.moveDirectMapToSequenceIndex(
            mapId,
            nextIndex,
            'set_map_rotation',
            sequenceState
        );

        return {
            result: {
                map_names: [mapId],
                method: moveResult.action,
                current_index: currentIndex,
                next_index: nextIndex
            }
        };
    }

    async getDirectSessionInfo() {
        if (!this.supportsDirectSessionPolling()) {
            throw createUnsupportedTransportError(
                'match_tracking',
                `Direct RCON session polling is not enabled for ${this.serverName}`
            );
        }

        const response = await this.executeDirectCommand(
            'GetServerInformation',
            { Name: 'session', Value: '' },
            'match_tracking'
        );
        const session = response.result || {};
        const mapId = this.resolveMapIdFromValues([
            session.mapId,
            session.MapId,
            session.mapName,
            session.MapName,
            session.CurrentMapName,
            session.currentMap
        ]);
        const mapName = session.mapName || session.MapName || session.CurrentMapName || session.currentMap || null;

        this.updateLocalMatchStateFromStatus({
            result: {
                map: this.findMapById(mapId) || buildMapStub(mapId, mapName),
                current_map: this.findMapById(mapId) || buildMapStub(mapId, mapName),
                raw: session
            }
        });

        return {
            serverName: session.serverName || session.ServerName || this.serverName,
            mapId,
            mapName,
            gameMode: session.gameMode || session.GameMode || null,
            remainingMatchTime: readInt(session.remainingMatchTime ?? session.RemainingMatchTime),
            matchTime: readInt(session.matchTime ?? session.MatchTime),
            alliedScore: readInt(session.alliedScore ?? session.AlliedScore),
            axisScore: readInt(session.axisScore ?? session.AxisScore),
            playerCount: readInt(session.playerCount ?? session.PlayerCount)
        };
    }

    parseDirectContentBody(contentBody) {
        if (typeof contentBody !== 'string') {
            return contentBody;
        }

        if (!contentBody.trim()) {
            return '';
        }

        try {
            return JSON.parse(contentBody);
        } catch (error) {
            return contentBody;
        }
    }

    buildMapLookup(maps) {
        const lookup = new Map();
        for (const map of maps) {
            for (const alias of [
                map.id,
                map.vote_label,
                map.pretty_name,
                map.map?.pretty_name
            ]) {
                const normalized = normalizeMapValue(alias);
                if (normalized && !lookup.has(normalized)) {
                    lookup.set(normalized, map.id);
                }
            }

            if (map.game_mode !== 'warfare') {
                continue;
            }

            for (const alias of [
                map.map?.name,
                map.id?.replace(/_(warfare|offensive|skirmish)(_.+)?$/i, ''),
                map.pretty_name?.replace(/\s+(warfare|offensive|skirmish)(\s+\(.+\))?$/i, '')
            ]) {
                const normalized = normalizeMapValue(alias);
                if (normalized && !lookup.has(normalized)) {
                    lookup.set(normalized, map.id);
                }
            }
        }
        return lookup;
    }

    resolveMapIdFromValues(values = []) {
        for (const value of values) {
            const normalized = normalizeMapValue(value);
            if (normalized && this.mapLookup.has(normalized)) {
                return this.mapLookup.get(normalized);
            }
        }
        return null;
    }

    resolveCanonicalMapId(value) {
        if (!value) {
            return null;
        }

        if (this.localMapCatalog.some((entry) => entry.id === value)) {
            return value;
        }

        return this.resolveMapIdFromValues([value]);
    }

    areMapReferencesEquivalent(leftValue, rightValue) {
        if (!leftValue || !rightValue) {
            return false;
        }

        const leftCanonical = this.resolveCanonicalMapId(leftValue);
        const rightCanonical = this.resolveCanonicalMapId(rightValue);
        if (leftCanonical && rightCanonical) {
            return leftCanonical === rightCanonical;
        }

        return normalizeLooseMapIdentity(leftValue) === normalizeLooseMapIdentity(rightValue);
    }

    findMapById(mapId) {
        if (!mapId) {
            return null;
        }

        const matchedMap = this.localMapCatalog.find((entry) => entry.id === mapId);
        return matchedMap ? { ...matchedMap, map: { ...matchedMap.map } } : null;
    }

    normalizeMapCollection(rawValue) {
        const items = Array.isArray(rawValue)
            ? rawValue
            : Array.isArray(rawValue?.Entries)
                ? rawValue.Entries
                : Array.isArray(rawValue?.entries)
                    ? rawValue.entries
                    : Array.isArray(rawValue?.mAPS)
                        ? rawValue.mAPS
                    : Array.isArray(rawValue?.MapSequence)
                        ? rawValue.MapSequence
                        : Array.isArray(rawValue?.MapRotation)
                            ? rawValue.MapRotation
                            : typeof rawValue === 'string'
                                ? rawValue.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
                                : [];

        return items.map((entry) => {
            const mapId = this.resolveMapIdFromValues([
                entry?.MapName,
                entry?.MapId,
                entry?.iD,
                entry?.map_name,
                entry?.map_id,
                entry?.Name,
                entry?.name,
                entry
            ]);

            return this.findMapById(mapId) || buildMapStub(
                mapId,
                entry?.MapName || entry?.name || entry?.Name || String(entry)
            );
        });
    }

    normalizeDirectSequenceState(rawValue) {
        const items = Array.isArray(rawValue)
            ? rawValue
            : Array.isArray(rawValue?.Entries)
                ? rawValue.Entries
                : Array.isArray(rawValue?.entries)
                    ? rawValue.entries
                    : Array.isArray(rawValue?.mAPS)
                        ? rawValue.mAPS
                        : Array.isArray(rawValue?.MapSequence)
                            ? rawValue.MapSequence
                            : Array.isArray(rawValue?.MapRotation)
                                ? rawValue.MapRotation
                                : typeof rawValue === 'string'
                                    ? rawValue.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
                                    : [];

        const entries = items.map((entry, arrayIndex) => {
            const mapId = this.resolveMapIdFromValues([
                entry?.MapName,
                entry?.MapId,
                entry?.iD,
                entry?.map_name,
                entry?.map_id,
                entry?.Name,
                entry?.name,
                entry
            ]);
            const normalizedMap = this.findMapById(mapId) || buildMapStub(
                mapId,
                entry?.MapName || entry?.name || entry?.Name || String(entry)
            );
            const parsedPosition = Number.parseInt(entry?.position, 10);

            return {
                ...normalizedMap,
                sequencePosition: Number.isNaN(parsedPosition) ? arrayIndex : parsedPosition
            };
        });

        entries.sort((left, right) => left.sequencePosition - right.sequencePosition);

        const rawCurrentIndex = rawValue?.currentIndex ?? rawValue?.CurrentIndex;
        const parsedCurrentIndex = Number.parseInt(rawCurrentIndex, 10);
        const fallbackCurrentIndex = entries.find((entry) => entry.sequencePosition === 0)?.sequencePosition ?? 0;

        return {
            currentIndex: Number.isNaN(parsedCurrentIndex) ? fallbackCurrentIndex : parsedCurrentIndex,
            entries
        };
    }

    findPreferredSequenceIndex(sequence, mapId, currentIndex) {
        const matchingIndexes = sequence
            .filter((entry) => entry.id === mapId)
            .map((entry) => entry.sequencePosition);

        if (matchingIndexes.length === 0) {
            return -1;
        }

        const upcomingIndex = matchingIndexes.find((index) => index > currentIndex);
        if (upcomingIndex !== undefined) {
            return upcomingIndex;
        }

        return matchingIndexes[0];
    }

    updateLocalMatchStateFromStatus(statusPayload) {
        const currentMapId = this.resolveMapIdFromValues([
            statusPayload?.result?.map?.id,
            statusPayload?.result?.map?.pretty_name,
            statusPayload?.result?.current_map?.id,
            statusPayload?.result?.current_map?.pretty_name,
            statusPayload?.result?.raw?.mapId,
            statusPayload?.result?.raw?.mapName,
            statusPayload?.result?.raw?.MapName,
            statusPayload?.result?.raw?.CurrentMapName,
            statusPayload?.result?.raw?.currentMap
        ]);

        if (!currentMapId) {
            return;
        }

        if (!this.currentMatchMapId) {
            this.currentMatchMapId = currentMapId;
            this.matchStartEpochMs = Date.now();
            return;
        }

        if (this.currentMatchMapId !== currentMapId) {
            const previousMap = this.findMapById(this.currentMatchMapId) || buildMapStub(this.currentMatchMapId);
            this.localMapHistory.unshift({
                map_id: previousMap.id,
                name: previousMap.map?.name || previousMap.id,
                pretty_name: previousMap.pretty_name || previousMap.id,
                changed_at: new Date().toISOString(),
                map: {
                    id: previousMap.id,
                    name: previousMap.map?.name || previousMap.id,
                    pretty_name: previousMap.pretty_name || previousMap.id
                }
            });
            this.localMapHistory = this.localMapHistory.slice(0, 10);
            this.currentMatchMapId = currentMapId;
            this.matchStartEpochMs = Date.now();
        }
    }

    async getMatchSnapshot() {
        const status = await this.getStatus();
        const publicInfo = await this.getPublicInfo();
        const queuedState = publicInfo
            ? {
                currentMapId: publicInfo.result.current_map?.id || null,
                nextMapId: publicInfo.result.next_map?.id || null
            }
            : await this.readQueuedNextMapState();

        const statusCurrentMapId = this.resolveMapIdFromValues([
            status?.result?.map?.id,
            status?.result?.map?.pretty_name,
            status?.result?.current_map?.id,
            status?.result?.current_map?.pretty_name
        ]);
        const currentMapId = queuedState?.currentMapId || statusCurrentMapId || null;

        return {
            currentMapId,
            currentPlayers: status?.result?.current_players ?? 0,
            gameActive: Boolean(currentMapId || status?.result?.map || status?.result?.current_map),
            nextMapId: queuedState?.nextMapId || null,
            matchStartEpochSeconds: this.matchStartEpochMs
                ? Math.floor(this.matchStartEpochMs / 1000)
                : null
        };
    }

    normalizePublicInfoResponse(responseData) {
        const payload = responseData?.result || responseData || {};
        const currentMapId = this.resolveMapIdFromValues([
            payload.current_map?.id,
            payload.current_map?.map?.id,
            payload.current_map?.map?.pretty_name,
            payload.current_map?.map?.name,
            payload.current_map?.pretty_name,
            payload.current_map?.name,
            payload.currentMap,
            payload.currentMapName,
            payload.map,
            payload.mapName
        ]);
        const nextMapId = this.resolveMapIdFromValues([
            payload.next_map?.id,
            payload.next_map?.map?.id,
            payload.next_map?.map?.pretty_name,
            payload.next_map?.map?.name,
            payload.next_map?.pretty_name,
            payload.next_map?.name,
            payload.nextMap,
            payload.nextMapName
        ]);

        return {
            result: {
                current_map: this.findMapById(currentMapId) || buildMapStub(currentMapId, payload.currentMapName),
                next_map: this.findMapById(nextMapId) || buildMapStub(nextMapId, payload.nextMapName),
                raw: payload
            }
        };
    }

    async getPublicInfo() {
        if (!this.client) {
            return null;
        }

        try {
            const response = await this.client.get('/api/get_public_info');
            return this.normalizePublicInfoResponse(response.data);
        } catch (error) {
            logger.warn(
                `[CRCON ${this.serverName}] GET get_public_info failed: ${this.formatRequestError(error)}`
            );
            return null;
        }
    }

    getDirectNextSequencePosition(sequenceState) {
        const currentIndex = Number.isInteger(sequenceState?.currentIndex)
            ? sequenceState.currentIndex
            : 0;
        const sequence = Array.isArray(sequenceState?.entries) ? sequenceState.entries : [];
        const maxPosition = sequence.reduce(
            (highestPosition, entry) => Math.max(highestPosition, entry.sequencePosition),
            0
        );

        return currentIndex >= maxPosition ? 0 : currentIndex + 1;
    }

    async readQueuedNextMapState() {
        const publicInfo = await this.getPublicInfo();
        if (publicInfo?.result?.next_map?.id || publicInfo?.result?.current_map?.id) {
            return {
                currentMapId: publicInfo.result.current_map?.id || null,
                nextMapId: publicInfo.result.next_map?.id || null,
                source: 'public-info',
                authoritative: true
            };
        }

        if (!this.hasDirectRconConfigured()) {
            return {
                currentMapId: this.currentMatchMapId,
                nextMapId: null,
                source: 'unavailable',
                authoritative: false
            };
        }

        const sequenceResponse = await this.executeDirectCommand(
            'GetServerInformation',
            { Name: 'mapsequence', Value: '' },
            'get_map_rotation'
        );
        const sequenceState = this.normalizeDirectSequenceState(sequenceResponse.result);
        const nextPosition = this.getDirectNextSequencePosition(sequenceState);
        const nextEntry = sequenceState.entries.find((entry) => entry.sequencePosition === nextPosition) || null;
        const currentEntry = sequenceState.entries.find(
            (entry) => entry.sequencePosition === sequenceState.currentIndex
        ) || null;

        return {
            currentMapId: currentEntry?.id || this.currentMatchMapId,
            nextMapId: nextEntry?.id || null,
            source: 'direct-sequence',
            authoritative: false
        };
    }

    async queueNextMap(mapId) {
        const response = await this.post('set_map_rotation', { map_names: [mapId] });
        this.assertCommandSucceeded(response, 'set_map_rotation');

        const queuedState = await this.readQueuedNextMapState();
        const verification = {
            expectedMapId: mapId,
            observedMapId: queuedState?.nextMapId || null,
            source: queuedState?.source || 'unknown',
            authoritative: Boolean(queuedState?.authoritative),
            verified: false
        };

        if (queuedState?.nextMapId && !this.areMapReferencesEquivalent(queuedState.nextMapId, mapId)) {
            throw new Error(
                `Queued next map mismatch: expected ${mapId} but observed ${queuedState.nextMapId} via ${queuedState.source}`
            );
        }

        if (!queuedState?.nextMapId) {
            if (!queuedState?.authoritative && queuedState?.source === 'direct-sequence') {
                logger.warn(
                    `[CRCON ${this.serverName}] Could not verify queued next map authoritatively after set_map_rotation; direct sequence did not expose a next entry for expected=${mapId}`
                );

                return {
                    response,
                    queuedState,
                    verification
                };
            }

            throw new Error(`Queued next map could not be verified for ${mapId}`);
        }

        verification.verified = true;

        return {
            response,
            queuedState,
            verification
        };
    }

    async queueNextMapAtSequenceStart(mapId) {
        if (!this.supportsDirectSessionPolling()) {
            throw new Error(`Direct RCON sequence-start queueing is not enabled for ${this.serverName}`);
        }

        const response = await this.moveDirectMapToSequenceIndex(mapId, 0, 'set_map_rotation');
        const sequenceState = await this.readDirectSequenceState();
        const queuedEntry = sequenceState.entries.find((entry) => entry.sequencePosition === 0) || null;

        if (!queuedEntry?.id || !this.areMapReferencesEquivalent(queuedEntry.id, mapId)) {
            throw new Error(
                `Queued next map mismatch at sequence position 0: expected ${mapId} but observed ${queuedEntry?.id || 'none'}`
            );
        }

        return {
            response,
            queuedState: {
                currentMapId: this.currentMatchMapId,
                nextMapId: queuedEntry.id,
                source: 'direct-sequence-position-0'
            }
        };
    }

    async replaceDirectMapRotation(mapIds) {
        const desiredMapIds = [...new Set(mapIds.filter(Boolean))];
        if (desiredMapIds.length === 0) {
            throw new Error('replaceDirectMapRotation requires at least one map id');
        }

        const rotation = await this.getDirectMapRotation();
        const currentMapIds = (rotation.result || []).map((entry) => entry.id).filter(Boolean);

        for (let index = currentMapIds.length - 1; index >= 0; index -= 1) {
            const currentMapId = currentMapIds[index];
            if (!desiredMapIds.includes(currentMapId)) {
                await this.executeDirectCommand(
                    'RemoveMapFromRotation',
                    { Index: index },
                    'set_map_rotation'
                );
                currentMapIds.splice(index, 1);
            }
        }

        for (let targetIndex = 0; targetIndex < desiredMapIds.length; targetIndex += 1) {
            const desiredMapId = desiredMapIds[targetIndex];
            const existingIndex = currentMapIds.indexOf(desiredMapId);

            if (existingIndex === targetIndex) {
                continue;
            }

            if (existingIndex >= 0) {
                await this.executeDirectCommand(
                    'RemoveMapFromRotation',
                    { Index: existingIndex },
                    'set_map_rotation'
                );
                currentMapIds.splice(existingIndex, 1);
            }

            await this.executeDirectCommand(
                'AddMapToRotation',
                { MapName: desiredMapId, Index: targetIndex },
                'set_map_rotation'
            );
            currentMapIds.splice(targetIndex, 0, desiredMapId);
        }

        return {
            result: {
                map_names: desiredMapIds,
                method: 'direct-rotation-sync'
            }
        };
    }

    async replaceMapRotation(mapIds) {
        const desiredMapIds = hllMapCatalog.normalizeMapIds(mapIds || [], {
            dropUnknown: false
        });

        if (desiredMapIds.length === 0) {
            throw new Error('replaceMapRotation requires at least one valid map id');
        }

        const apiExecutor = async () => {
            if (!this.client) {
                throw new Error(`CRCON API is not configured for ${this.serverName}`);
            }

            const response = await this.client.post('/api/set_map_rotation', {
                map_names: desiredMapIds
            });
            this.assertCommandSucceeded(response.data, 'set_map_rotation');

            return {
                response: response.data,
                rotationMapIds: desiredMapIds
            };
        };

        const directExecutor = async () => {
            if (!this.hasDirectRconConfigured()) {
                throw new Error(`Direct RCON is not configured for ${this.serverName}`);
            }

            const response = await this.replaceDirectMapRotation(desiredMapIds);
            return {
                response,
                rotationMapIds: desiredMapIds
            };
        };

        return this.executeWithTransport('post', 'set_map_rotation', apiExecutor, directExecutor);
    }

    getLocalMapCatalogStatus() {
        return hllMapCatalog.getCatalogStatus();
    }

    async syncLocalMapCatalogFromCrcon() {
        if (!this.client) {
            throw new Error('CRCON API is not configured for catalog sync');
        }

        const response = await this.client.get('/api/get_maps');
        const syncedStatus = hllMapCatalog.syncFromCrconMaps(response?.data?.result || []);
        this.refreshLocalMapCatalog();

        return syncedStatus;
    }

    assertCommandSucceeded(response, endpoint) {
        if (response && typeof response === 'object' && response.failed === true) {
            const err = response.error || `CRCON command ${endpoint} returned failed=true`;
            throw new Error(err);
        }
    }

    async getMaps() {
        const catalogStatus = this.getLocalMapCatalogStatus();
        if (catalogStatus.hasRuntimeCatalog) {
            return { result: this.loadLocalMapCatalog() };
        }

        try {
            return await this.get('get_maps');
        } catch (error) {
            const localCatalog = this.loadLocalMapCatalog();
            if (localCatalog.length > 0) {
                logger.warn(
                    `[CRCON ${this.serverName}] Falling back to bundled local map catalog because get_maps failed: ${error.message}`
                );
                return { result: localCatalog };
            }

            throw error;
        }
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

    async broadcast(message) {
        return this.post('set_broadcast', { message });
    }

    async getMapHistory() {
        return this.get('get_map_history');
    }

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

function normalizeTransportMode(value) {
    const normalized = String(value || '').trim();
    if (Object.values(TRANSPORT_MODES).includes(normalized)) {
        return normalized;
    }
    return TRANSPORT_MODES.API_ONLY;
}

function normalizeMapValue(value) {
    if (value === undefined || value === null) {
        return null;
    }
    return String(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\bsaint(e)?\b/g, 'st')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function normalizeLooseMapIdentity(value) {
    const normalized = normalizeMapValue(value);
    if (!normalized) {
        return null;
    }

    return normalized
        .replace(/\bwarfare\b/g, ' ')
        .replace(/\boffensive\b/g, ' ')
        .replace(/\bskirmish\b/g, ' ')
        .replace(/\bday\b/g, ' ')
        .replace(/\bnight\b/g, ' ')
        .replace(/\bv\s*2\b/g, ' ')
        .replace(/\bl\b/g, ' ')
        .replace(/\b19\d{2}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildMapStub(mapId, displayName = null) {
    if (!mapId && !displayName) {
        return null;
    }

    const fallbackId = mapId || normalizeMapValue(displayName)?.replace(/\s+/g, '_');
    return {
        id: fallbackId,
        pretty_name: displayName || fallbackId,
        game_mode: 'warfare',
        environment: 'day',
        map_name: displayName || fallbackId,
        mode: 'warfare',
        variant: 'Day',
        vote_label: `${displayName || fallbackId} | Warfare | Day`,
        weight: null,
        seeding: null,
        stress: null,
        map: {
            id: fallbackId,
            name: displayName || fallbackId,
            pretty_name: displayName || fallbackId
        }
    };
}

function createUnsupportedTransportError(endpoint, message) {
    const error = new Error(message);
    error.code = 'UNSUPPORTED_TRANSPORT';
    error.endpoint = endpoint;
    return error;
}

function readInt(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function buildServiceFromEnv(serverNum = 1) {
    const suffix = serverNum === 1 ? '' : `_${serverNum}`;
    return new CRCONService({
        serverName: `Server ${serverNum}`,
        crconUrl: process.env[`CRCON_API_URL${suffix}`],
        crconToken: process.env[`CRCON_API_TOKEN${suffix}`],
        rconHost: process.env[`HLL_RCON_HOST${suffix}`],
        rconPort: process.env[`HLL_RCON_PORT${suffix}`],
        rconPassword: process.env[`HLL_RCON_PASSWORD${suffix}`],
        transportMode: process.env[`TRANSPORT_MODE${suffix}`] || process.env.TRANSPORT_MODE
    });
}

const crconService = buildServiceFromEnv(1);
const crconService2 = buildServiceFromEnv(2);
const crconService3 = buildServiceFromEnv(3);
const crconService4 = buildServiceFromEnv(4);

module.exports = {
    CRCONService,
    TRANSPORT_MODES,
    crconService,
    crconService2,
    crconService3,
    crconService4
};
