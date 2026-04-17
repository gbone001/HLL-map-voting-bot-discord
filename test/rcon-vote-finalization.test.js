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
    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command, payload, endpoint) => {
        commands.push({ command, payload, endpoint });

        if (command === 'GetServerInformation') {
            return {
                result: {
                    currentIndex: 10,
                    MapSequence: [
                        { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 0 },
                        { MapName: 'Foy', MapId: 'foy_warfare', position: 9 },
                        { MapName: 'Omaha Beach', MapId: 'omahabeach_warfare', position: 10 },
                        { MapName: 'Kharkov', MapId: 'kharkov_warfare', position: 11 },
                        { MapName: 'St. Mere Eglise', MapId: 'stmereeglise_warfare', position: 15 },
                        { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 22 }
                    ]
                }
            };
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
    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command, payload, endpoint) => {
        commands.push({ command, payload, endpoint });

        if (command === 'GetServerInformation') {
            return {
                result: {
                    currentIndex: 10,
                    MapSequence: [
                        { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 0 },
                        { MapName: 'Foy', MapId: 'foy_warfare', position: 9 },
                        { MapName: 'Omaha Beach', MapId: 'omahabeach_warfare', position: 10 },
                        { MapName: 'Kharkov', MapId: 'kharkov_warfare', position: 11 }
                    ]
                }
            };
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
    crcon.client = {
        get: async (url) => {
            if (url === '/api/get_map_rotation') {
                return {
                    data: {
                        result: {
                            maps: [
                                { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare' },
                                { id: 'foy_warfare', pretty_name: 'Foy Warfare' },
                                { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare' },
                                { id: 'kharkov_warfare', pretty_name: 'Kharkov Warfare' }
                            ],
                            current_index: 0,
                            next_index: 1
                        }
                    }
                };
            }

            throw new Error(`Unexpected GET ${url}`);
        },
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
                result: {
                    currentIndex: 10,
                    MapSequence: [
                        { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 0 },
                        { MapName: 'Foy', MapId: 'foy_warfare', position: 9 },
                        { MapName: 'Omaha Beach', MapId: 'omahabeach_warfare', position: 10 },
                        { MapName: 'Kharkov', MapId: 'kharkov_warfare', position: 11 }
                    ]
                }
            };
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
        }
    ]);
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
    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command, payload, endpoint) => {
        commands.push({ command, payload, endpoint });

        if (command === 'GetServerInformation') {
            return {
                result: {
                    currentIndex: 10,
                    mAPS: [
                        { name: 'UTAH BEACH', iD: '/Game/Maps/utahbeach_warfare', position: 0 },
                        { name: 'KURSK', iD: '/Game/Maps/kursk_warfare_night', position: 9 },
                        { name: 'OMAHA BEACH', iD: '/Game/Maps/omahabeach_warfare', position: 10 },
                        { name: 'KHARKOV', iD: '/Game/Maps/kharkov_warfare', position: 11 }
                    ]
                }
            };
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

test('API queueNextMap preserves the existing rotation instead of collapsing it to one map', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_ONLY,
        crconUrl: 'http://example.invalid',
        crconToken: 'token'
    });

    const getCalls = [];
    const postCalls = [];
    crcon.client = {
        get: async (url) => {
            getCalls.push(url);
            if (url === '/api/get_map_rotation') {
                return {
                    data: {
                        result: {
                            maps: [
                                { id: 'foy_warfare', pretty_name: 'Foy Warfare' },
                                { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare' },
                                { id: 'kharkov_warfare', pretty_name: 'Kharkov Warfare' }
                            ],
                            current_index: 0,
                            next_index: 1
                        }
                    }
                };
            }

            if (url === '/api/get_public_info') {
                return {
                    data: {
                        result: {
                            current_map: {
                                map: {
                                    id: 'foy_warfare',
                                    pretty_name: 'Foy Warfare'
                                },
                                start: 1776401500
                            },
                            next_map: {
                                map: {
                                    id: 'utahbeach_warfare',
                                    pretty_name: 'Utah Beach Warfare'
                                }
                            },
                            player_count: 50
                        }
                    }
                };
            }

            throw new Error(`Unexpected GET ${url}`);
        },
        post: async (url, payload) => {
            postCalls.push({ url, payload });
            return {
                data: {
                    result: {
                        ok: true
                    }
                }
            };
        }
    };

    await crcon.queueNextMap('kharkov_warfare');

    assert.deepEqual(getCalls, ['/api/get_map_rotation', '/api/get_public_info']);
    assert.deepEqual(postCalls, [
        {
            url: '/api/set_map_rotation',
            payload: {
                map_names: ['foy_warfare', 'kharkov_warfare', 'utahbeach_warfare']
            }
        }
    ]);
});

test('API queueNextMap reconciles stale rotation indexes against live public info', async () => {
    const crcon = new CRCONService({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.API_ONLY,
        crconUrl: 'http://example.invalid',
        crconToken: 'token'
    });

    const getCalls = [];
    const postCalls = [];
    crcon.client = {
        get: async (url) => {
            getCalls.push(url);
            if (url === '/api/get_map_rotation') {
                return {
                    data: {
                        result: {
                            maps: [
                                { id: 'foy_warfare', pretty_name: 'Foy Warfare' },
                                { id: 'foy_warfare_night', pretty_name: 'Foy Warfare (Night)' },
                                { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare' },
                                { id: 'stmereeglise_warfare', pretty_name: 'St. Mere Eglise Warfare' },
                                { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare' }
                            ],
                            current_index: 3,
                            next_index: 4
                        }
                    }
                };
            }

            if (url === '/api/get_public_info') {
                return {
                    data: {
                        result: {
                            current_map: {
                                map: {
                                    id: 'omahabeach_warfare',
                                    pretty_name: 'Omaha Beach Warfare'
                                },
                                start: 1776401600
                            },
                            next_map: {
                                map: {
                                    id: 'utahbeach_warfare',
                                    pretty_name: 'Utah Beach Warfare'
                                }
                            },
                            player_count: 89
                        }
                    }
                };
            }

            throw new Error(`Unexpected GET ${url}`);
        },
        post: async (url, payload) => {
            postCalls.push({ url, payload });
            return {
                data: {
                    result: {
                        ok: true
                    }
                }
            };
        }
    };

    await crcon.queueNextMap('carentan_warfare');

    assert.deepEqual(getCalls, ['/api/get_map_rotation', '/api/get_public_info']);
    assert.deepEqual(postCalls, [
        {
            url: '/api/set_map_rotation',
            payload: {
                map_names: [
                    'foy_warfare',
                    'foy_warfare_(night)',
                    'omahabeach_warfare',
                    'stmereeglise_warfare',
                    'carentan_warfare',
                    'utahbeach_warfare'
                ]
            }
        }
    ]);
});
