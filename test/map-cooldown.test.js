const test = require('node:test');
const assert = require('node:assert/strict');
const { MapVotingService } = require('../src/services/mapVoting');

function createMap(id, prettyName, mode = 'warfare', environment = 'day') {
    return {
        id,
        pretty_name: prettyName,
        game_mode: mode,
        environment,
        map: {
            name: prettyName
        }
    };
}

test('recently played maps are excluded even when CRCON history only returns pretty names', async () => {
    const service = new MapVotingService(1);
    const maps = [
        createMap('foy_warfare', 'Foy Warfare'),
        createMap('hurtgenforest_warfare', 'Hurtgen Forest Warfare'),
        createMap('stmariedumont_warfare', 'St. Marie Du Mont Warfare')
    ];

    service.mapsPerVote = 3;
    service.nightMapCount = 0;
    service.modeWeights = { warfare: 3, offensive: 0, skirmish: 0 };
    service.excludeRecentMaps = 1;
    service.shuffleArray = (items) => [...items];
    service.getAllMaps = async () => maps;
    service.getEffectiveWhitelist = async () => null;
    service.crcon = {
        getMapHistory: async () => ({
            result: [
                {
                    map: {
                        pretty_name: 'Foy Warfare'
                    }
                }
            ]
        })
    };

    const result = await service.getMapsToVote();

    assert.equal(result.some(map => map.id === 'foy_warfare'), false);
    assert.deepEqual(
        result.map(map => map.id).sort(),
        ['hurtgenforest_warfare', 'stmariedumont_warfare'].sort()
    );
});

test('current map is excluded even when map history does not include it yet', async () => {
    const service = new MapVotingService(1);
    const maps = [
        createMap('foy_warfare', 'Foy Warfare'),
        createMap('hurtgenforest_warfare', 'Hurtgen Forest Warfare'),
        createMap('stmariedumont_warfare', 'St. Marie Du Mont Warfare')
    ];

    service.mapsPerVote = 3;
    service.nightMapCount = 0;
    service.modeWeights = { warfare: 3, offensive: 0, skirmish: 0 };
    service.excludeRecentMaps = 1;
    service.shuffleArray = (items) => [...items];
    service.getAllMaps = async () => maps;
    service.getEffectiveWhitelist = async () => null;
    service.lastServerStatus = {
        result: {
            map: {
                id: 'foy_warfare',
                pretty_name: 'Foy Warfare'
            }
        }
    };
    service.crcon = {
        getMapHistory: async () => ({ result: [] }),
        getStatus: async () => service.lastServerStatus
    };

    const result = await service.getMapsToVote();

    assert.equal(result.some(map => map.id === 'foy_warfare'), false);
    assert.deepEqual(
        result.map(map => map.id).sort(),
        ['hurtgenforest_warfare', 'stmariedumont_warfare'].sort()
    );
});

test('recently played base maps are excluded across different variants and modes', async () => {
    const service = new MapVotingService(1);
    const maps = [
        {
            id: 'carentan_warfare',
            pretty_name: 'Carentan Warfare',
            game_mode: 'warfare',
            environment: 'day',
            map_name: 'Carentan',
            map: { name: 'Carentan' }
        },
        {
            id: 'carentan_offensive_us',
            pretty_name: 'Carentan Offensive (US)',
            game_mode: 'offensive',
            environment: 'day',
            map_name: 'Carentan',
            map: { name: 'Carentan' }
        },
        {
            id: 'utahbeach_warfare',
            pretty_name: 'Utah Beach Warfare',
            game_mode: 'warfare',
            environment: 'day',
            map_name: 'Utah Beach',
            map: { name: 'Utah Beach' }
        }
    ];

    service.mapsPerVote = 3;
    service.nightMapCount = 0;
    service.modeWeights = { warfare: 2, offensive: 1, skirmish: 0 };
    service.excludeRecentMaps = 1;
    service.shuffleArray = (items) => [...items];
    service.getAllMaps = async () => maps;
    service.getEffectiveWhitelist = async () => null;
    service.crcon = {
        getMapHistory: async () => ({
            result: [
                {
                    map: {
                        id: 'carentan_warfare',
                        pretty_name: 'Carentan Warfare',
                        name: 'Carentan'
                    }
                }
            ]
        }),
        getStatus: async () => ({
            result: {
                map: {
                    id: 'foy_warfare',
                    pretty_name: 'Foy Warfare'
                }
            }
        })
    };

    const result = await service.getMapsToVote();

    assert.equal(result.some((map) => map.id === 'carentan_warfare'), false);
    assert.equal(result.some((map) => map.id === 'carentan_offensive_us'), false);
    assert.deepEqual(result.map((map) => map.id), ['utahbeach_warfare']);
});

test('vote generation fails closed when both history and current map resolution are unavailable', async () => {
    const service = new MapVotingService(1);
    const maps = [
        createMap('foy_warfare', 'Foy Warfare'),
        createMap('hurtgenforest_warfare', 'Hurtgen Forest Warfare')
    ];

    service.mapsPerVote = 2;
    service.nightMapCount = 0;
    service.modeWeights = { warfare: 2, offensive: 0, skirmish: 0 };
    service.excludeRecentMaps = 1;
    service.shuffleArray = (items) => [...items];
    service.getAllMaps = async () => maps;
    service.getEffectiveWhitelist = async () => null;
    service.crcon = {
        getMapHistory: async () => {
            throw new Error('history unavailable');
        },
        getStatus: async () => ({ result: {} })
    };

    const result = await service.getMapsToVote();

    assert.deepEqual(result, []);
});
