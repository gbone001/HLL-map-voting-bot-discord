const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CRCONService, TRANSPORT_MODES } = require('../src/services/crcon');
const { HLLRconClient } = require('../src/services/hllRconClient');
const { MapVotePanelService } = require('../src/services/mapVotePanel');
const schedulePanel = require('../src/services/schedulePanel');
const scheduleManager = require('../src/services/scheduleManager');

function createApiFailure(status = 500) {
    const error = new Error(`Request failed with status code ${status}`);
    error.response = { status, statusText: 'Internal Server Error', data: {} };
    error.config = { method: 'get', url: '/api/get_status' };
    return error;
}

test('CRCON service falls back to direct RCON for get_status when API fails', async () => {
    const service = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_WITH_FALLBACK,
        crconUrl: 'http://example.invalid',
        crconToken: 'token',
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    service.client = {
        get: async () => {
            throw createApiFailure();
        }
    };
    service.hasDirectRconConfigured = () => true;
    service.executeDirectEndpoint = async (method, endpoint) => {
        assert.equal(method, 'get');
        assert.equal(endpoint, 'get_status');
        return {
            result: {
                current_players: 48,
                max_players: 100,
                map: {
                    id: 'foy_warfare',
                    pretty_name: 'Foy Warfare'
                }
            }
        };
    };

    const response = await service.getStatus();

    assert.equal(response.result.current_players, 48);
    assert.equal(response.result.map.id, 'foy_warfare');
});

test('fallback mode opens a CRCON circuit after repeated API failures and bypasses further supported calls', async () => {
    const service = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_WITH_FALLBACK,
        crconUrl: 'http://example.invalid',
        crconToken: 'token',
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret',
        crconCircuitThreshold: 2,
        crconCircuitCooldownMs: 60_000
    });

    let apiCalls = 0;
    let directCalls = 0;

    service.client = {
        get: async () => {
            apiCalls += 1;
            throw createApiFailure();
        }
    };
    service.executeDirectEndpoint = async () => {
        directCalls += 1;
        return { result: { current_players: 48 } };
    };

    await service.getStatus();
    await service.getStatus();
    await service.getStatus();

    assert.equal(apiCalls, 2);
    assert.equal(directCalls, 3);
    assert.equal(service.isCrconCircuitOpen(), true);
});

test('fallback mode probes CRCON again after cooldown and closes the circuit on success', async () => {
    const originalNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;

    try {
        const service = new CRCONService({
            serverName: 'Test Server',
            transportMode: TRANSPORT_MODES.API_WITH_FALLBACK,
            crconUrl: 'http://example.invalid',
            crconToken: 'token',
            rconHost: '127.0.0.1',
            rconPort: 27015,
            rconPassword: 'secret',
            crconCircuitThreshold: 2,
            crconCircuitCooldownMs: 10
        });

        let apiCalls = 0;
        service.client = {
            get: async () => {
                apiCalls += 1;
                if (apiCalls <= 2) {
                    throw createApiFailure();
                }
                return {
                    data: {
                        result: {
                            current_players: 77,
                            map: { id: 'foy_warfare', pretty_name: 'Foy Warfare' }
                        }
                    }
                };
            }
        };
        service.executeDirectEndpoint = async () => ({
            result: {
                current_players: 48,
                map: { id: 'foy_warfare', pretty_name: 'Foy Warfare' }
            }
        });

        await service.getStatus();
        await service.getStatus();
        assert.equal(service.isCrconCircuitOpen(), true);

        fakeNow += 11;
        const response = await service.getStatus();

        assert.equal(apiCalls, 3);
        assert.equal(response.result.current_players, 77);
        assert.equal(service.isCrconCircuitOpen(), false);
        assert.equal(service.crconFailureCount, 0);
    } finally {
        Date.now = originalNow;
    }
});

test('direct transport map catalog is warfare-only', async () => {
    const service = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    service.hasDirectRconConfigured = () => true;

    const response = await service.getMaps();

    assert.ok(response.result.length > 0);
    assert.ok(response.result.every(map => map.game_mode === 'warfare'));
});

test('direct status updates local map history when the live map changes', async () => {
    const service = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    service.hasDirectRconConfigured = () => true;

    const sessionStates = [
        {
            ServerName: 'Test Server',
            PlayerCount: 30,
            MaxPlayers: 100,
            MapName: 'Foy'
        },
        {
            ServerName: 'Test Server',
            PlayerCount: 32,
            MaxPlayers: 100,
            MapName: 'St. Marie Du Mont'
        }
    ];

    service.executeDirectCommand = async (command) => {
        assert.equal(command, 'GetServerInformation');
        return { result: sessionStates.shift() };
    };

    await service.getStatus();
    await service.getStatus();
    const history = await service.getMapHistory();

    assert.equal(history.result.length, 1);
    assert.equal(history.result[0].map_id, 'foy_warfare');
});

test('direct status normalizes lowercase RCON V2 session fields', async () => {
    const service = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    service.hasDirectRconConfigured = () => true;
    service.executeDirectCommand = async () => ({
        result: {
            serverName: 'ANZR.org | Warfare 24/7 | AUS',
            mapName: 'FOY',
            mapId: 'foy_warfare',
            playerCount: 99,
            maxPlayerCount: 100
        }
    });

    const response = await service.getStatus();

    assert.equal(response.result.name, 'ANZR.org | Warfare 24/7 | AUS');
    assert.equal(response.result.current_players, 99);
    assert.equal(response.result.max_players, 100);
    assert.equal(response.result.map.id, 'foy_warfare');
});

test('direct map rotation normalizes lowercase V2 collection fields', async () => {
    const service = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    service.hasDirectRconConfigured = () => true;
    service.executeDirectCommand = async () => ({
        result: {
            currentIndex: 0,
            mAPS: [
                { name: 'FOY', gameMode: 'Warfare', timeOfDay: 'Day', iD: 'foy_warfare', position: 0 },
                { name: 'CARENTAN', gameMode: 'Warfare', timeOfDay: 'Night', iD: 'carentan_warfare_night', position: 1 }
            ]
        }
    });

    const response = await service.getMapRotation();

    assert.equal(response.result.length, 2);
    assert.equal(response.result[0].id, 'foy_warfare');
    assert.match(response.result[1].id, /carentan_warfare/);
});

test('direct RCON read fails fast when the socket times out', async () => {
    const client = new HLLRconClient({
        host: '127.0.0.1',
        port: 27015,
        password: 'secret',
        socketTimeoutMs: 25
    });

    const fakeSocket = new EventEmitter();
    fakeSocket.destroyed = false;
    client.socket = fakeSocket;

    setImmediate(() => {
        fakeSocket.emit('timeout');
    });

    await assert.rejects(client.readExactly(1), /RCON socket timed out after 25ms/);
});

test('direct RCON read cleanup does not accumulate socket listeners across partial reads', async () => {
    const client = new HLLRconClient({
        host: '127.0.0.1',
        port: 27015,
        password: 'secret'
    });

    const fakeSocket = new EventEmitter();
    fakeSocket.destroyed = false;
    client.socket = fakeSocket;

    const pendingRead = client.readExactly(3);

    setImmediate(() => {
        client.readBuffer = Buffer.from([1]);
        fakeSocket.emit('data', Buffer.from([1]));
        setImmediate(() => {
            client.readBuffer = Buffer.from([1, 2, 3]);
            fakeSocket.emit('data', Buffer.from([2, 3]));
        });
    });

    const chunk = await pendingRead;

    assert.deepEqual([...chunk], [1, 2, 3]);
    assert.equal(fakeSocket.listenerCount('data'), 0);
    assert.equal(fakeSocket.listenerCount('error'), 0);
    assert.equal(fakeSocket.listenerCount('close'), 0);
    assert.equal(fakeSocket.listenerCount('timeout'), 0);
});

test('blacklist panel shows explicit unsupported transport messaging', async () => {
    const panel = new MapVotePanelService();
    const unsupportedError = new Error('Unsupported transport');
    unsupportedError.code = 'UNSUPPORTED_TRANSPORT';

    const response = await panel.buildBlacklistPanel({
        getVotemapWhitelist: async () => {
            throw unsupportedError;
        },
        getMaps: async () => ({ result: [] })
    });

    assert.equal(response.embeds[0].data.title, '🚫 Blacklisted Maps');
    assert.match(response.embeds[0].data.description, /unavailable in the current transport mode/i);
});

test('schedule export fails explicitly when CRCON whitelist is unavailable in direct transport', async () => {
    const originalData = scheduleManager.data;
    scheduleManager.data = {
        servers: {
            1: {
                timezone: 'UTC',
                schedules: [
                    {
                        id: 'sched-1',
                        name: 'Use All Maps',
                        startTime: '18:00',
                        endTime: '20:00',
                        days: ['mon'],
                        whitelist: null,
                        generalSettings: {},
                        automodConfigs: {},
                        automodProfiles: {}
                    }
                ],
                defaultSchedule: null,
                activeOverride: null
            }
        }
    };

    try {
        const unsupportedError = new Error('Unsupported transport');
        unsupportedError.code = 'UNSUPPORTED_TRANSPORT';

        const response = await schedulePanel.buildScheduleExport(1, 'sched-1', {
            getMaps: async () => ({ result: [] }),
            getVotemapWhitelist: async () => {
                throw unsupportedError;
            }
        }, 'Test Server');

        assert.equal(response.success, false);
        assert.match(response.error, /requires the CRCON votemap whitelist API/i);
    } finally {
        scheduleManager.data = originalData;
    }
});
