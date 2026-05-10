const test = require('node:test');
const assert = require('node:assert/strict');
const { MapVotingService } = require('../src/services/mapVoting');
const { CRCONService, TRANSPORT_MODES } = require('../src/services/crcon');

function buildPollMessage(answerTexts) {
    return {
        poll: {
            answers: new Map(
                answerTexts.map((text, index) => [
                    String(index + 1),
                    {
                        text,
                        voteCount: 0,
                        voters: {
                            fetch: async () => new Map()
                        }
                    }
                ])
            )
        }
    };
}

function buildMapCatalog() {
    return [
        {
            id: 'stmariedumont_warfare',
            pretty_name: 'St. Marie Du Mont Warfare',
            game_mode: 'warfare',
            environment: 'day',
            map: { name: 'St. Marie Du Mont', pretty_name: 'St. Marie Du Mont Warfare' }
        },
        {
            id: 'stmereeglise_warfare',
            pretty_name: 'St. Mere Eglise Warfare',
            game_mode: 'warfare',
            environment: 'day',
            map: { name: 'St. Mere Eglise', pretty_name: 'St. Mere Eglise Warfare' }
        },
        {
            id: 'utahbeach_warfare',
            pretty_name: 'Utah Beach Warfare',
            game_mode: 'warfare',
            environment: 'day',
            map: { name: 'Utah Beach', pretty_name: 'Utah Beach Warfare' }
        }
    ];
}

function buildVotingService(crcon) {
    const service = new MapVotingService(1);
    service.voteMessageId = 'poll-message-1';
    service.crcon = crcon;
    service.channel = {
        messages: {
            fetch: async () => buildPollMessage([
                'St. Marie Du Mont Warfare',
                'St. Mere Eglise Warfare',
                'Utah Beach Warfare'
            ])
        }
    };
    service.getAllMaps = async () => buildMapCatalog();
    service.getRecentExcludedMapIds = async () => new Set();
    service.getCurrentMapId = async () => 'foy_warfare';
    service.getResults = async () => [
        ['St. Mere Eglise Warfare', 5],
        ['Utah Beach Warfare', 2],
        ['St. Marie Du Mont Warfare', 1]
    ];
    return service;
}

test('vote finalization in direct RCON mode moves an existing winner into the slot after currentIndex', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    const commands = [];
    const sequenceState = {
        currentIndex: 10,
        MapSequence: [
            { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 0 },
            { MapName: 'Foy', MapId: 'foy_warfare', position: 9 },
            { MapName: 'Omaha Beach', MapId: 'omahabeach_warfare', position: 10 },
            { MapName: 'Kharkov', MapId: 'kharkov_warfare', position: 11 },
            { MapName: 'St. Mere Eglise', MapId: 'stmereeglise_warfare', position: 15 },
            { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 22 }
        ]
    };
    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command, payload, endpoint) => {
        commands.push({ command, payload, endpoint });

        if (command === 'GetServerInformation') {
            return {
                result: sequenceState
            };
        }

        if (command === 'MoveMapInSequence') {
            sequenceState.MapSequence = sequenceState.MapSequence
                .map((entry) => {
                    if (entry.position === payload.CurrentIndex) {
                        return { ...entry, position: payload.NewIndex };
                    }
                    if (entry.position >= payload.NewIndex && entry.position < payload.CurrentIndex) {
                        return { ...entry, position: entry.position + 1 };
                    }
                    return entry;
                });
            return { result: { ok: true } };
        }

        return { result: { ok: true } };
    };

    const service = buildVotingService(crcon);

    const mapId = await service.setVoteResult();

    assert.equal(mapId, 'stmereeglise_warfare');
    assert.deepEqual(commands, [
        {
            command: 'GetServerInformation',
            payload: { Name: 'mapsequence', Value: '' },
            endpoint: 'get_map_rotation'
        },
        {
            command: 'MoveMapInSequence',
            payload: { CurrentIndex: 15, NewIndex: 11 },
            endpoint: 'set_map_rotation'
        },
        {
            command: 'GetServerInformation',
            payload: { Name: 'mapsequence', Value: '' },
            endpoint: 'get_map_rotation'
        }
    ]);
});

test('vote finalization in direct RCON mode adds a missing winner into the slot after currentIndex', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    const commands = [];
    const sequenceState = {
        currentIndex: 10,
        MapSequence: [
            { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 0 },
            { MapName: 'Foy', MapId: 'foy_warfare', position: 9 },
            { MapName: 'Omaha Beach', MapId: 'omahabeach_warfare', position: 10 },
            { MapName: 'Kharkov', MapId: 'kharkov_warfare', position: 11 }
        ]
    };
    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command, payload, endpoint) => {
        commands.push({ command, payload, endpoint });

        if (command === 'GetServerInformation') {
            return {
                result: sequenceState
            };
        }

        if (command === 'AddMapToSequence') {
            sequenceState.MapSequence = sequenceState.MapSequence.map((entry) => {
                if (entry.position >= payload.Index) {
                    return { ...entry, position: entry.position + 1 };
                }
                return entry;
            });
            sequenceState.MapSequence.push({
                MapName: payload.MapName,
                MapId: payload.MapName,
                position: payload.Index
            });
            return { result: { ok: true } };
        }

        return { result: { ok: true } };
    };

    const service = buildVotingService(crcon);
    service.getResults = async () => [
        ['St. Marie Du Mont Warfare', 6],
        ['Utah Beach Warfare', 1]
    ];

    const mapId = await service.setVoteResult();

    assert.equal(mapId, 'stmariedumont_warfare');
    assert.deepEqual(commands, [
        {
            command: 'GetServerInformation',
            payload: { Name: 'mapsequence', Value: '' },
            endpoint: 'get_map_rotation'
        },
        {
            command: 'AddMapToSequence',
            payload: { MapName: 'stmariedumont_warfare', Index: 11 },
            endpoint: 'set_map_rotation'
        },
        {
            command: 'GetServerInformation',
            payload: { Name: 'mapsequence', Value: '' },
            endpoint: 'get_map_rotation'
        }
    ]);
});

test('vote finalization in fallback mode sends the voted winner through direct RCON when CRCON API fails', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_WITH_FALLBACK,
        crconUrl: 'http://example.invalid',
        crconToken: 'token',
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    const commands = [];
    const sequenceState = {
        currentIndex: 10,
        MapSequence: [
            { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 0 },
            { MapName: 'Foy', MapId: 'foy_warfare', position: 9 },
            { MapName: 'Omaha Beach', MapId: 'omahabeach_warfare', position: 10 },
            { MapName: 'Kharkov', MapId: 'kharkov_warfare', position: 11 }
        ]
    };
    crcon.client = {
        post: async () => {
            const error = new Error('Request failed with status code 500');
            error.response = { status: 500, statusText: 'Internal Server Error', data: {} };
            error.config = { method: 'post', url: '/api/set_map_rotation' };
            throw error;
        }
    };
    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command, payload, endpoint) => {
        commands.push({ command, payload, endpoint });

        if (command === 'GetServerInformation') {
            return {
                result: sequenceState
            };
        }

        if (command === 'AddMapToSequence') {
            sequenceState.MapSequence = sequenceState.MapSequence.map((entry) => {
                if (entry.position >= payload.Index) {
                    return { ...entry, position: entry.position + 1 };
                }
                return entry;
            });
            sequenceState.MapSequence.push({
                MapName: payload.MapName,
                MapId: payload.MapName,
                position: payload.Index
            });
            return { result: { ok: true } };
        }

        return { result: { ok: true } };
    };

    const service = buildVotingService(crcon);

    const mapId = await service.setVoteResult();

    assert.equal(mapId, 'stmereeglise_warfare');
    assert.deepEqual(commands, [
        {
            command: 'GetServerInformation',
            payload: { Name: 'mapsequence', Value: '' },
            endpoint: 'get_map_rotation'
        },
        {
            command: 'AddMapToSequence',
            payload: { MapName: 'stmereeglise_warfare', Index: 11 },
            endpoint: 'set_map_rotation'
        },
        {
            command: 'GetServerInformation',
            payload: { Name: 'mapsequence', Value: '' },
            endpoint: 'get_map_rotation'
        }
    ]);
});

test('setVoteResult randomly selects one of the tied highest-vote maps', async () => {
    const queuedMapIds = [];
    const crcon = {
        queueNextMap: async (mapId) => {
            queuedMapIds.push(mapId);
            return { ok: true };
        }
    };

    const service = buildVotingService(crcon);
    service.getResults = async () => [
        ['St. Mere Eglise Warfare', 6],
        ['Utah Beach Warfare', 6],
        ['St. Marie Du Mont Warfare', 2]
    ];

    const originalRandom = Math.random;

    try {
        Math.random = () => 0;
        const firstSelectedMapId = await service.setVoteResult();

        Math.random = () => 0.999999;
        const secondSelectedMapId = await service.setVoteResult();

        assert.equal(firstSelectedMapId, 'stmereeglise_warfare');
        assert.equal(secondSelectedMapId, 'utahbeach_warfare');
        assert.deepEqual(queuedMapIds, [
            'stmereeglise_warfare',
            'utahbeach_warfare'
        ]);
    } finally {
        Math.random = originalRandom;
    }
});

test('direct RCON next-map selection uses currentIndex instead of sequence position zero', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    const commands = [];
    const sequenceState = {
        currentIndex: 10,
        mAPS: [
            { name: 'UTAH BEACH', iD: '/Game/Maps/utahbeach_warfare', position: 0 },
            { name: 'KURSK', iD: '/Game/Maps/kursk_warfare_night', position: 9 },
            { name: 'OMAHA BEACH', iD: '/Game/Maps/omahabeach_warfare', position: 10 },
            { name: 'KHARKOV', iD: '/Game/Maps/kharkov_warfare', position: 11 }
        ]
    };
    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command, payload, endpoint) => {
        commands.push({ command, payload, endpoint });

        if (command === 'GetServerInformation') {
            return {
                result: sequenceState
            };
        }

        if (command === 'AddMapToSequence') {
            sequenceState.mAPS.push({
                name: payload.MapName,
                iD: `/Game/Maps/${payload.MapName}`,
                position: payload.Index
            });
            return { result: { ok: true } };
        }

        return { result: { ok: true } };
    };

    await crcon.post('set_map_rotation', { map_names: ['stmereeglise_warfare'] });

    assert.deepEqual(commands, [
        {
            command: 'GetServerInformation',
            payload: { Name: 'mapsequence', Value: '' },
            endpoint: 'get_map_rotation'
        },
        {
            command: 'AddMapToSequence',
            payload: { MapName: 'stmereeglise_warfare', Index: 11 },
            endpoint: 'set_map_rotation'
        }
    ]);
});

test('queueNextMap verifies the queued next map via CRCON public info in API mode', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_ONLY,
        crconUrl: 'http://example.invalid',
        crconToken: 'token'
    });

    const requests = [];
    crcon.client = {
        post: async (url, payload) => {
            requests.push({ method: 'post', url, payload });
            return { data: { result: { ok: true } } };
        },
        get: async (url) => {
            requests.push({ method: 'get', url });
            return {
                data: {
                    result: {
                        currentMapName: 'Foy Warfare',
                        nextMapName: 'St. Mere Eglise Warfare'
                    }
                }
            };
        }
    };

    const result = await crcon.queueNextMap('stmereeglise_warfare');

    assert.equal(result.queuedState.nextMapId, 'stmereeglise_warfare');
    assert.deepEqual(requests, [
        {
            method: 'post',
            url: '/api/set_map_rotation',
            payload: { map_names: ['stmereeglise_warfare'] }
        },
        {
            method: 'get',
            url: '/api/get_public_info'
        }
    ]);
});

test('queueNextMap throws when verified queued map does not match the requested winner', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_ONLY,
        crconUrl: 'http://example.invalid',
        crconToken: 'token'
    });

    let verificationReads = 0;
    crcon.client = {
        post: async () => ({ data: { result: { ok: true } } }),
        get: async () => {
            verificationReads += 1;
            return {
                data: {
                    result: {
                        currentMapName: 'Foy Warfare',
                        nextMapName: 'Utah Beach Warfare'
                    }
                }
            };
        }
    };

    await assert.rejects(
        () => crcon.queueNextMap('stmereeglise_warfare'),
        /Queued next map mismatch/
    );
    assert.equal(verificationReads, 4);
});

test('queueNextMap tolerates a stale public-info read before the queued map settles', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_ONLY,
        crconUrl: 'http://example.invalid',
        crconToken: 'token'
    });

    const requests = [];
    let readIndex = 0;
    crcon.delay = async () => {};
    crcon.client = {
        post: async (url, payload) => {
            requests.push({ method: 'post', url, payload });
            return { data: { result: { ok: true } } };
        },
        get: async (url) => {
            requests.push({ method: 'get', url, readIndex });
            readIndex += 1;

            if (readIndex === 1) {
                return {
                    data: {
                        result: {
                            currentMapName: 'Kharkov Warfare',
                            nextMapName: 'St. Marie Du Mont Warfare'
                        }
                    }
                };
            }

            return {
                data: {
                    result: {
                        currentMapName: 'Kharkov Warfare',
                        nextMapName: 'St. Mere Eglise Warfare'
                    }
                }
            };
        }
    };

    const result = await crcon.queueNextMap('stmereeglise_warfare');

    assert.equal(result.queuedState.nextMapId, 'stmereeglise_warfare');
    assert.equal(result.verification.verified, true);
    assert.equal(result.verification.attempts, 2);
    assert.deepEqual(requests, [
        {
            method: 'post',
            url: '/api/set_map_rotation',
            payload: { map_names: ['stmereeglise_warfare'] }
        },
        {
            method: 'get',
            url: '/api/get_public_info',
            readIndex: 0
        },
        {
            method: 'get',
            url: '/api/get_public_info',
            readIndex: 1
        }
    ]);
});

test('queueNextMap accepts direct sequence verification when public-info remains stale', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_WITH_FALLBACK,
        crconUrl: 'http://example.invalid',
        crconToken: 'token',
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    let publicInfoReads = 0;
    crcon.client = {
        post: async () => ({ data: { result: { ok: true } } }),
        get: async () => {
            publicInfoReads += 1;
            return {
                data: {
                    result: {
                        currentMapName: 'Foy Warfare',
                        nextMapName: 'Omaha Beach Warfare'
                    }
                }
            };
        }
    };

    crcon.executeDirectCommand = async (command) => {
        if (command === 'GetServerInformation') {
            return {
                result: {
                    currentIndex: 10,
                    MapSequence: [
                        { MapName: 'Foy', MapId: 'foy_warfare', position: 10 },
                        { MapName: 'St. Mere Eglise', MapId: 'stmereeglise_warfare', position: 11 }
                    ]
                }
            };
        }

        return { result: { ok: true } };
    };

    const result = await crcon.queueNextMap('stmereeglise_warfare');

    assert.equal(result.queuedState.nextMapId, 'stmereeglise_warfare');
    assert.equal(result.verification.source, 'direct-sequence');
    assert.equal(result.verification.verified, true);
    assert.equal(publicInfoReads, 1);
});

test('queueNextMap can send a full managed rotation while verifying the selected next map', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_ONLY,
        crconUrl: 'http://example.invalid',
        crconToken: 'token'
    });

    const requests = [];
    crcon.client = {
        post: async (url, payload) => {
            requests.push({ method: 'post', url, payload });
            return { data: { result: { ok: true } } };
        },
        get: async (url) => {
            requests.push({ method: 'get', url });
            return {
                data: {
                    result: {
                        currentMapName: 'Foy Warfare',
                        nextMapName: 'Utah Beach Warfare'
                    }
                }
            };
        }
    };

    const result = await crcon.queueNextMap('utahbeach_warfare', [
        'utahbeach_warfare',
        'foy_warfare',
        'omahabeach_warfare'
    ]);

    assert.equal(result.queuedState.nextMapId, 'utahbeach_warfare');
    assert.deepEqual(requests[0], {
        method: 'post',
        url: '/api/set_map_rotation',
        payload: {
            map_names: [
                'utahbeach_warfare',
                'foy_warfare',
                'omahabeach_warfare'
            ]
        }
    });
});

test('queueNextMap throws in direct RCON mode when the next sequence slot does not become the requested map', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command) => {
        if (command === 'GetServerInformation') {
            return {
                result: {
                    currentIndex: 10,
                    MapSequence: [
                        { MapName: 'Foy', MapId: 'foy_warfare', position: 10 },
                        { MapName: 'Kharkov', MapId: 'kharkov_warfare', position: 11 }
                    ]
                }
            };
        }

        return { result: { ok: true } };
    };

    await assert.rejects(
        () => crcon.queueNextMap('stmereeglise_warfare'),
        /Queued next map mismatch/
    );
});

test('queueNextMap accepts direct RCON aliases that refer to the same queued map', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command) => {
        if (command === 'GetServerInformation') {
            return {
                result: {
                    currentIndex: 10,
                    MapSequence: [
                        { MapName: 'Foy', MapId: 'foy_warfare', position: 10 },
                        { MapName: 'Sainte-Marie-du-Mont', position: 11 }
                    ]
                }
            };
        }

        return { result: { ok: true } };
    };

    const result = await crcon.queueNextMap('stmariedumont_warfare');

    assert.equal(result.queuedState.nextMapId, 'stmariedumont_warfare');
});

test('queueNextMapAtSequenceStart moves the voted map to sequence position 0 for session-end queueing', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_WITH_FALLBACK,
        crconUrl: 'http://example.invalid',
        crconToken: 'token',
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    const commands = [];
    const sequenceState = {
        currentIndex: 10,
        MapSequence: [
            { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 0 },
            { MapName: 'Foy', MapId: 'foy_warfare', position: 9 },
            { MapName: 'Omaha Beach', MapId: 'omahabeach_warfare', position: 10 },
            { MapName: 'Kharkov', MapId: 'kharkov_warfare', position: 11 },
            { MapName: 'St. Mere Eglise', MapId: 'stmereeglise_warfare', position: 15 }
        ]
    };

    crcon.executeDirectCommand = async (command, payload, endpoint) => {
        commands.push({ command, payload, endpoint });

        if (command === 'GetServerInformation') {
            return { result: sequenceState };
        }

        if (command === 'MoveMapInSequence') {
            sequenceState.MapSequence = sequenceState.MapSequence
                .map((entry) => {
                    if (entry.position === payload.CurrentIndex) {
                        return { ...entry, position: payload.NewIndex };
                    }
                    if (entry.position >= payload.NewIndex && entry.position < payload.CurrentIndex) {
                        return { ...entry, position: entry.position + 1 };
                    }
                    return entry;
                });
            return { result: { ok: true } };
        }

        return { result: { ok: true } };
    };

    const result = await crcon.queueNextMapAtSequenceStart('stmereeglise_warfare');

    assert.equal(result.queuedState.nextMapId, 'stmereeglise_warfare');
    assert.deepEqual(commands, [
        {
            command: 'GetServerInformation',
            payload: { Name: 'mapsequence', Value: '' },
            endpoint: 'get_map_rotation'
        },
        {
            command: 'MoveMapInSequence',
            payload: { CurrentIndex: 15, NewIndex: 0 },
            endpoint: 'set_map_rotation'
        },
        {
            command: 'GetServerInformation',
            payload: { Name: 'mapsequence', Value: '' },
            endpoint: 'get_map_rotation'
        }
    ]);
});

test('queueNextMapAtSequenceStart accepts loose-equivalent map variants at sequence position 0', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_WITH_FALLBACK,
        crconUrl: 'http://example.invalid',
        crconToken: 'token',
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    const sequenceState = {
        currentIndex: 10,
        MapSequence: [
            { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 0 },
            { MapName: 'Foy', MapId: 'foy_warfare', position: 9 },
            { MapName: 'Omaha Beach', MapId: 'omahabeach_warfare', position: 10 }
        ]
    };

    crcon.executeDirectCommand = async (command, payload) => {
        if (command === 'GetServerInformation') {
            return { result: sequenceState };
        }

        if (command === 'MoveMapInSequence') {
            sequenceState.MapSequence = sequenceState.MapSequence
                .map((entry) => {
                    if (entry.position === payload.CurrentIndex) {
                        return { ...entry, position: payload.NewIndex };
                    }
                    if (entry.position >= payload.NewIndex && entry.position < payload.CurrentIndex) {
                        return { ...entry, position: entry.position + 1 };
                    }
                    return entry;
                });
            return { result: { ok: true } };
        }

        return { result: { ok: true } };
    };

    const result = await crcon.queueNextMapAtSequenceStart('utahbeach_warfare_night');

    assert.equal(result.queuedState.nextMapId, 'utahbeach_warfare');
});
