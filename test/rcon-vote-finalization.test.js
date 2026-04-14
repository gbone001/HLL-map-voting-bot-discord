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

test('vote finalization in direct RCON mode moves an existing winner to the next map slot', async () => {
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
                    MapSequence: [
                        { MapName: 'Foy', MapId: 'foy_warfare' },
                        { MapName: 'St. Mere Eglise', MapId: 'stmereeglise_warfare' },
                        { MapName: 'Utah Beach', MapId: 'utahbeach_warfare' }
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
            payload: { CurrentIndex: 1, NewIndex: 0 },
            endpoint: 'set_map_rotation'
        }
    ]);
});

test('vote finalization in direct RCON mode adds a missing winner to the next map slot', async () => {
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
                    MapSequence: [
                        { MapName: 'Foy', MapId: 'foy_warfare' },
                        { MapName: 'Utah Beach', MapId: 'utahbeach_warfare' }
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
            payload: { MapName: 'stmariedumont_warfare', Index: 0 },
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
                    MapSequence: [
                        { MapName: 'Foy', MapId: 'foy_warfare' },
                        { MapName: 'Utah Beach', MapId: 'utahbeach_warfare' }
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
            payload: { MapName: 'stmereeglise_warfare', Index: 0 },
            endpoint: 'set_map_rotation'
        }
    ]);
});
