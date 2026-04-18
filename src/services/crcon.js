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
const { WARFARE_MAP_CATALOG } = require('./hllMapCatalog');

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

        this.localMapCatalog = WARFARE_MAP_CATALOG.map((map) => ({ ...map, map: { ...map.map } }));
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

    isDirectFallbackEnabled() {
        return this.transportMode === TRANSPORT_MODES.DIRECT_RCON ||
            this.transportMode === TRANSPORT_MODES.API_WITH_FALLBACK;
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

    async getDirectSequenceState() {
        const response = await this.executeDirectCommand(
            'GetServerInformation',
            { Name: 'mapsequence', Value: '' },
            'get_map_rotation'
        );

        return this.normalizeDirectSequenceState(response.result);
    }

    getDirectSequenceNextMapId(sequenceState, currentMapId = null) {
        if (!sequenceState || !Array.isArray(sequenceState.entries) || sequenceState.entries.length === 0) {
            return null;
        }

        let currentIndex = Number.isInteger(sequenceState.currentIndex)
            ? sequenceState.currentIndex
            : 0;

        if (currentMapId) {
            const matchingEntry = sequenceState.entries.find((entry) => entry.id === currentMapId);
            if (matchingEntry && Number.isInteger(matchingEntry.sequencePosition)) {
                currentIndex = matchingEntry.sequencePosition;
            }
        }

        const nextIndex = this.getDirectNextSequencePosition(sequenceState.entries, currentIndex);
        const nextEntry = sequenceState.entries.find((entry) => entry.sequencePosition === nextIndex)
            || null;

        return nextEntry?.id || null;
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

    async setDirectNextMap(mapNames) {
        const mapId = Array.isArray(mapNames) ? mapNames[0] : null;
        if (!mapId) {
            throw new Error('set_map_rotation requires at least one map name');
        }

        const sequenceState = await this.getDirectSequenceState();
        const sequence = sequenceState.entries;

        if (sequence.length === 0) {
            await this.executeDirectCommand(
                'AddMapToSequence',
                { MapName: mapId, Index: 0 },
                'set_map_rotation'
            );
            return {
                result: {
                    map_names: [mapId],
                    method: 'sequence-add-empty'
                }
            };
        }

        const currentIndex = Number.isInteger(sequenceState.currentIndex)
            ? sequenceState.currentIndex
            : 0;
        const nextIndex = this.getDirectNextSequencePosition(sequence, currentIndex);
        const existingIndex = this.findPreferredSequenceIndex(sequence, mapId, currentIndex);

        if (existingIndex === nextIndex) {
            return {
                result: {
                    map_names: [mapId],
                    method: 'sequence-noop'
                }
            };
        }

        if (existingIndex >= 0) {
            await this.executeDirectCommand(
                'MoveMapInSequence',
                { CurrentIndex: existingIndex, NewIndex: nextIndex },
                'set_map_rotation'
            );
        } else {
            await this.executeDirectCommand(
                'AddMapToSequence',
                { MapName: mapId, Index: nextIndex },
                'set_map_rotation'
            );
        }

        return {
            result: {
                map_names: [mapId],
                method: 'sequence-next-index',
                current_index: currentIndex,
                next_index: nextIndex
            }
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
                map.pretty_name,
                map.map?.name,
                map.map?.pretty_name,
                map.id?.replace(/_warfare$/i, ''),
                map.pretty_name?.replace(/\s+warfare$/i, '')
            ]) {
                const normalized = normalizeMapValue(alias);
                if (normalized) {
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

    findMapById(mapId) {
        if (!mapId) {
            return null;
        }

        const matchedMap = this.localMapCatalog.find((entry) => entry.id === mapId);
        return matchedMap ? { ...matchedMap, map: { ...matchedMap.map } } : null;
    }

    resolveObservedMapId(values = []) {
        const canonicalMapId = this.resolveMapIdFromValues(values);
        if (canonicalMapId) {
            return canonicalMapId;
        }

        for (const value of values) {
            const normalized = normalizeMapValue(value);
            if (normalized) {
                return normalized.replace(/\s+/g, '_');
            }
        }

        return null;
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
        const currentMapId = this.resolveObservedMapId([
            statusPayload?.result?.map?.id,
            statusPayload?.result?.map?.pretty_name,
            statusPayload?.result?.map?.name,
            statusPayload?.result?.current_map?.id,
            statusPayload?.result?.current_map?.pretty_name,
            statusPayload?.result?.current_map?.name,
            statusPayload?.result?.raw?.mapId,
            statusPayload?.result?.raw?.map_id,
            statusPayload?.result?.raw?.MapId,
            statusPayload?.result?.raw?.mapName,
            statusPayload?.result?.raw?.MapName,
            statusPayload?.result?.raw?.CurrentMapName,
            statusPayload?.result?.raw?.currentMap,
            statusPayload?.result?.raw?.CurrentMap,
            statusPayload?.result?.raw?.map
        ]);

        this.updateLocalMatchState(currentMapId);
    }

    updateLocalMatchState(currentMapId, matchStartEpochSeconds = null) {
        if (!currentMapId) {
            return;
        }

        if (!this.currentMatchMapId) {
            this.currentMatchMapId = currentMapId;
            this.matchStartEpochMs = Number.isFinite(matchStartEpochSeconds)
                ? matchStartEpochSeconds * 1000
                : Date.now();
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
            this.matchStartEpochMs = Number.isFinite(matchStartEpochSeconds)
                ? matchStartEpochSeconds * 1000
                : Date.now();
            return;
        }

        if (Number.isFinite(matchStartEpochSeconds)) {
            this.matchStartEpochMs = matchStartEpochSeconds * 1000;
        }
    }

    normalizePublicInfoState(rawValue) {
        const currentMap = rawValue?.current_map;
        const nextMap = rawValue?.next_map;

        const currentMapId = this.resolveObservedMapId([
            currentMap?.map?.id,
            currentMap?.id,
            currentMap?.map?.pretty_name,
            currentMap?.map?.name,
            currentMap?.pretty_name,
            currentMap?.name
        ]);

        const nextMapId = this.resolveObservedMapId([
            nextMap?.map?.id,
            nextMap?.id,
            nextMap?.map?.pretty_name,
            nextMap?.map?.name,
            nextMap?.pretty_name,
            nextMap?.name
        ]);

        const currentMapStart = currentMap?.start;
        const matchStartEpochSeconds = typeof currentMapStart === 'number'
            ? currentMapStart
            : Number.isFinite(Date.parse(currentMapStart))
                ? Math.floor(Date.parse(currentMapStart) / 1000)
                : null;

        return {
            currentMapId,
            nextMapId,
            currentPlayers: rawValue?.player_count ?? rawValue?.playerCount ?? null,
            gameActive: currentMapId ? Boolean(currentMap) : null,
            matchStartEpochSeconds
        };
    }

    normalizeGameStateState(rawValue) {
        const value = rawValue?.result ?? rawValue;

        if (typeof value === 'boolean') {
            return { gameActive: value };
        }

        const objectCandidate = value && typeof value === 'object' ? value : null;
        if (objectCandidate) {
            const booleanFields = [
                objectCandidate.game_active,
                objectCandidate.gameActive,
                objectCandidate.active,
                objectCandidate.in_progress,
                objectCandidate.inProgress,
                objectCandidate.started,
                objectCandidate.running
            ];

            for (const fieldValue of booleanFields) {
                if (typeof fieldValue === 'boolean') {
                    return { gameActive: fieldValue };
                }
            }

            const stringFields = [
                objectCandidate.state,
                objectCandidate.status,
                objectCandidate.phase,
                objectCandidate.name,
                objectCandidate.value
            ];

            for (const fieldValue of stringFields) {
                const normalized = this.normalizeGameStateString(fieldValue);
                if (normalized !== null) {
                    return { gameActive: normalized };
                }
            }
        }

        const normalizedString = this.normalizeGameStateString(value);
        return {
            gameActive: normalizedString
        };
    }

    normalizeGameStateString(value) {
        if (typeof value !== 'string') {
            return null;
        }

        const normalized = value.trim().toLowerCase();
        if (!normalized) {
            return null;
        }

        if (
            normalized.includes('match ended') ||
            normalized.includes('game over') ||
            normalized.includes('round over') ||
            normalized.includes('ended') ||
            normalized.includes('postmatch') ||
            normalized.includes('post_match') ||
            normalized.includes('warmup') ||
            normalized.includes('waiting')
        ) {
            return false;
        }

        if (
            normalized.includes('match start') ||
            normalized.includes('in progress') ||
            normalized.includes('in_progress') ||
            normalized.includes('playing') ||
            normalized.includes('started') ||
            normalized.includes('active') ||
            normalized.includes('live')
        ) {
            return true;
        }

        return null;
    }

    async getPublicInfoState() {
        if (!this.client) {
            return null;
        }

        try {
            const response = await this.client.get('/api/get_public_info');
            return this.normalizePublicInfoState(response?.data?.result);
        } catch (error) {
            logger.warn(
                `[CRCON ${this.serverName}] GET get_public_info failed during state sync: ${this.formatRequestError(error)}`
            );
            return null;
        }
    }

    async getGameStateState() {
        if (!this.client) {
            return null;
        }

        try {
            const response = await this.client.get('/api/get_gamestate');
            return this.normalizeGameStateState(response?.data);
        } catch (error) {
            logger.warn(
                `[CRCON ${this.serverName}] GET get_gamestate failed during state sync: ${this.formatRequestError(error)}`
            );
            return null;
        }
    }

    findRotationIndexForMap(entries, mapId, preferredIndex = null, excludedIndexes = []) {
        if (!mapId || !Array.isArray(entries) || entries.length === 0) {
            return -1;
        }

        const excludedIndexSet = new Set(excludedIndexes.filter(Number.isInteger));
        const matchingIndexes = entries
            .map((entry, index) => ({ id: entry?.id, index }))
            .filter((entry) => entry.id === mapId && !excludedIndexSet.has(entry.index))
            .map((entry) => entry.index);

        if (matchingIndexes.length === 0) {
            return -1;
        }

        if (Number.isInteger(preferredIndex) && matchingIndexes.includes(preferredIndex)) {
            return preferredIndex;
        }

        if (Number.isInteger(preferredIndex)) {
            const nearestUpcomingIndex = matchingIndexes.find((index) => index > preferredIndex);
            if (nearestUpcomingIndex !== undefined) {
                return nearestUpcomingIndex;
            }

            const nearestPriorIndex = [...matchingIndexes].reverse().find((index) => index < preferredIndex);
            if (nearestPriorIndex !== undefined) {
                return nearestPriorIndex;
            }
        }

        return matchingIndexes[0];
    }

    reconcileRotationStateWithLiveState(rotationState, publicInfoState) {
        if (!rotationState || !Array.isArray(rotationState.entries) || rotationState.entries.length === 0 || !publicInfoState) {
            return rotationState;
        }

        let currentIndex = rotationState.currentIndex;
        let nextIndex = rotationState.nextIndex;

        if (publicInfoState.currentMapId) {
            const observedCurrentIndex = this.findRotationIndexForMap(
                rotationState.entries,
                publicInfoState.currentMapId,
                currentIndex
            );

            if (observedCurrentIndex >= 0 && observedCurrentIndex !== currentIndex) {
                logger.warn(
                    `[CRCON ${this.serverName}] Rotation current_index ${currentIndex} is stale; using live current map ${publicInfoState.currentMapId} at index ${observedCurrentIndex}`
                );
                currentIndex = observedCurrentIndex;
            }
        }

        if (publicInfoState.nextMapId) {
            const observedNextIndex = this.findRotationIndexForMap(
                rotationState.entries,
                publicInfoState.nextMapId,
                nextIndex,
                [currentIndex]
            );

            if (observedNextIndex >= 0 && observedNextIndex !== nextIndex) {
                logger.warn(
                    `[CRCON ${this.serverName}] Rotation next_index ${nextIndex} is stale; using live next map ${publicInfoState.nextMapId} at index ${observedNextIndex}`
                );
                nextIndex = observedNextIndex;
            }
        }

        if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= rotationState.entries.length || nextIndex === currentIndex) {
            nextIndex = this.getWrappedNextIndex(currentIndex, rotationState.entries.length);
        }

        return {
            ...rotationState,
            currentIndex,
            nextIndex
        };
    }

    async getMatchSnapshot() {
        const [status, publicInfoState, gameStateState] = await Promise.all([
            this.getStatus(),
            this.getPublicInfoState(),
            this.getGameStateState()
        ]);
        const statusCurrentMapId = this.resolveObservedMapId([
            status?.result?.map?.id,
            status?.result?.map?.pretty_name,
            status?.result?.map?.name,
            status?.result?.current_map?.id,
            status?.result?.current_map?.pretty_name,
            status?.result?.current_map?.name,
            status?.result?.raw?.mapId,
            status?.result?.raw?.map_id,
            status?.result?.raw?.MapId,
            status?.result?.raw?.mapName,
            status?.result?.raw?.MapName,
            status?.result?.raw?.CurrentMapName,
            status?.result?.raw?.currentMap,
            status?.result?.raw?.CurrentMap,
            status?.result?.raw?.map
        ]);
        const currentMapId = publicInfoState?.currentMapId || statusCurrentMapId || null;
        let directNextMapId = null;

        if (!publicInfoState?.nextMapId && this.hasDirectRconConfigured()) {
            try {
                const directSequenceState = await this.getDirectSequenceState();
                directNextMapId = this.getDirectSequenceNextMapId(directSequenceState, currentMapId);
            } catch (error) {
                logger.warn(
                    `[CRCON ${this.serverName}] Direct sequence read failed during match snapshot: ${error.message}`
                );
            }
        }

        if (currentMapId) {
            this.updateLocalMatchState(currentMapId, publicInfoState?.matchStartEpochSeconds ?? null);
        }

        return {
            currentMapId,
            nextMapId: publicInfoState?.nextMapId || directNextMapId || null,
            currentPlayers: status?.result?.current_players ?? publicInfoState?.currentPlayers ?? 0,
            gameActive: gameStateState?.gameActive ?? publicInfoState?.gameActive ?? Boolean(status?.result?.map || status?.result?.current_map),
            matchStartEpochSeconds: this.matchStartEpochMs
                ? Math.floor(this.matchStartEpochMs / 1000)
                : null
        };
    }

    assertCommandSucceeded(response, endpoint) {
        if (response && typeof response === 'object' && response.failed === true) {
            const err = response.error || `CRCON command ${endpoint} returned failed=true`;
            throw new Error(err);
        }
    }

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

    async queueNextMap(mapId) {
        if (!mapId) {
            throw new Error('queueNextMap requires a map ID');
        }

        const queueDirectNextMap = () => this.executeDirectEndpoint('post', 'set_map_rotation', { map_names: [mapId] });
        const canUseDirectQueue = this.hasDirectRconConfigured() && this.isDirectFallbackEnabled();

        if (this.transportMode === TRANSPORT_MODES.DIRECT_RCON) {
            return queueDirectNextMap();
        }

        if (!this.hasApiConfigured()) {
            if (canUseDirectQueue) {
                return queueDirectNextMap();
            }
            throw new Error(`CRCON API is not configured for ${this.serverName}`);
        }

        if (this.transportMode === TRANSPORT_MODES.API_WITH_FALLBACK && this.isCrconCircuitOpen()) {
            if (canUseDirectQueue) {
                return queueDirectNextMap();
            }
        }

        try {
            const response = await this.queueNextMapViaApi(mapId);
            if (this.transportMode === TRANSPORT_MODES.API_WITH_FALLBACK) {
                this.recordApiSuccess();
            }
            return response;
        } catch (error) {
            if (this.transportMode !== TRANSPORT_MODES.API_WITH_FALLBACK || !canUseDirectQueue) {
                throw error;
            }

            this.recordApiFailure(error);
            logger.warn(
                `[CRCON ${this.serverName}] Falling back to direct RCON for POST set_map_rotation`
            );
            return queueDirectNextMap();
        }
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

    normalizeRotationState(rawValue) {
        if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
            const maps = Array.isArray(rawValue.maps)
                ? rawValue.maps
                : Array.isArray(rawValue.Maps)
                    ? rawValue.Maps
                    : [];

            if (maps.length > 0) {
                const entries = maps.map((entry, index) => {
                    const mapId = this.resolveMapIdFromValues([
                        entry?.id,
                        entry?.pretty_name,
                        entry?.map?.id,
                        entry?.map?.pretty_name,
                        entry?.map?.name,
                        entry
                    ]);
                    const normalizedMap = this.findMapById(mapId) || buildMapStub(
                        mapId,
                        entry?.pretty_name || entry?.map?.pretty_name || entry?.map?.name || String(entry)
                    );

                    return {
                        ...normalizedMap,
                        sequencePosition: index
                    };
                });

                const parsedCurrentIndex = Number.parseInt(rawValue.current_index ?? rawValue.CurrentIndex, 10);
                const parsedNextIndex = Number.parseInt(rawValue.next_index ?? rawValue.NextIndex, 10);
                return {
                    currentIndex: Number.isNaN(parsedCurrentIndex) ? 0 : parsedCurrentIndex,
                    nextIndex: Number.isNaN(parsedNextIndex) ? null : parsedNextIndex,
                    entries
                };
            }
        }

        const directSequence = this.normalizeDirectSequenceState(rawValue);
        return {
            currentIndex: directSequence.currentIndex,
            nextIndex: null,
            entries: directSequence.entries
        };
    }

    getWrappedNextIndex(currentIndex, entryCount) {
        if (!entryCount || entryCount <= 0) {
            return 0;
        }

        if (!Number.isInteger(currentIndex) || currentIndex < 0) {
            return 0;
        }

        return currentIndex >= entryCount - 1 ? 0 : currentIndex + 1;
    }

    getDirectNextSequencePosition(entries, currentIndex) {
        if (!Array.isArray(entries) || entries.length === 0) {
            return 0;
        }

        const maxPosition = entries.reduce(
            (highestPosition, entry) => Math.max(highestPosition, entry.sequencePosition),
            0
        );

        if (!Number.isInteger(currentIndex) || currentIndex < 0) {
            return entries[0]?.sequencePosition ?? 0;
        }

        return currentIndex >= maxPosition ? 0 : currentIndex + 1;
    }

    buildRotationWithQueuedNextMap(entries, nextIndex, mapId) {
        const existingMapIds = entries.map((entry) => entry.id).filter(Boolean);
        const filteredMapIds = existingMapIds.filter((entryId) => entryId !== mapId);
        const normalizedNextIndex = Math.min(Math.max(nextIndex, 0), filteredMapIds.length);

        filteredMapIds.splice(normalizedNextIndex, 0, mapId);
        return filteredMapIds;
    }

    async queueNextMapViaApi(mapId) {
        try {
            const [rotationResponse, publicInfoState] = await Promise.all([
                this.client.get('/api/get_map_rotation'),
                this.getPublicInfoState()
            ]);
            const rotationState = this.reconcileRotationStateWithLiveState(
                this.normalizeRotationState(rotationResponse?.data?.result),
                publicInfoState
            );

            const mapNames = rotationState.entries.length
                ? this.buildRotationWithQueuedNextMap(
                    rotationState.entries,
                    Number.isInteger(rotationState.nextIndex)
                        ? rotationState.nextIndex
                        : this.getWrappedNextIndex(rotationState.currentIndex, rotationState.entries.length),
                    mapId
                )
                : [mapId];

            const response = await this.client.post('/api/set_map_rotation', { map_names: mapNames });
            return response.data;
        } catch (error) {
            logger.error(
                `[CRCON ${this.serverName}] queueNextMap failed: ${this.formatRequestError(error)}`
            );
            throw error;
        }
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
    return String(value).trim().toLowerCase();
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
