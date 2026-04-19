const test = require('node:test');
const assert = require('node:assert/strict');
const { MapVotingService } = require('../src/services/mapVoting');
const voteStore = require('../src/services/voteStore');
const configManager = require('../src/services/configManager');

test('non-seeded rotation still applies on match end when voting is disabled', async () => {
    const service = new MapVotingService(1);
    let nonSeededRotationCalls = 0;
    let seedingMessageCalls = 0;

    service.voteMapActive = false;
    service.minimumPlayers = 50;
    service.deactivatePlayers = 40;
    service.gameActive = true;
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => {
        service.gameActive = false;
        return false;
    };
    service.crcon = {
        getStatus: async () => ({ result: { current_players: 10 } })
    };
    service.applyNonSeededRotation = async () => {
        nonSeededRotationCalls += 1;
        return true;
    };
    service.clearAllMessages = async () => {};
    service.sendSeedingMsg = async () => {
        seedingMessageCalls += 1;
    };

    await service.doMapVote();

    assert.equal(nonSeededRotationCalls, 1);
    assert.equal(seedingMessageCalls, 0);
});

test('active vote is finalized when seeded state is lost mid-match', async () => {
    const service = new MapVotingService(1);
    let stopVoteCalls = 0;
    let seedingMessageCalls = 0;

    service.voteMapActive = true;
    service.seeded = true;
    service.voteActive = true;
    service.gameActive = true;
    service.minimumPlayers = 50;
    service.deactivatePlayers = 40;
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => true;
    service.crcon = {
        getStatus: async () => ({ result: { current_players: 10 } })
    };
    service.stopVote = async () => {
        stopVoteCalls += 1;
        service.voteActive = false;
    };
    service.clearAllMessages = async () => {};
    service.sendSeedingMsg = async () => {
        seedingMessageCalls += 1;
    };
    service.applyNonSeededRotation = async () => false;

    await service.doMapVote();

    assert.equal(stopVoteCalls, 1);
    assert.equal(seedingMessageCalls, 1);
    assert.equal(service.voteActive, false);
    assert.equal(service.seeded, false);
});

test('non-seeded rotation does not overwrite a vote finalized during seeded drop at match end', async () => {
    const service = new MapVotingService(1);
    let stopVoteCalls = 0;
    let nonSeededRotationCalls = 0;

    service.voteMapActive = true;
    service.seeded = true;
    service.voteActive = true;
    service.gameActive = true;
    service.minimumPlayers = 50;
    service.deactivatePlayers = 40;
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => {
        service.gameActive = false;
        return false;
    };
    service.crcon = {
        getStatus: async () => ({ result: { current_players: 10 } })
    };
    service.stopVote = async () => {
        stopVoteCalls += 1;
        service.voteActive = false;
    };
    service.clearAllMessages = async () => {};
    service.sendSeedingMsg = async () => {};
    service.applyNonSeededRotation = async () => {
        nonSeededRotationCalls += 1;
        return true;
    };

    await service.doMapVote();

    assert.equal(stopVoteCalls, 1);
    assert.equal(nonSeededRotationCalls, 0);
});

test('non-seeded rotation does not overwrite a vote finalized on seeded drop during a later match-end tick', async () => {
    const service = new MapVotingService(1);
    let stopVoteCalls = 0;
    let nonSeededRotationCalls = 0;
    let gameStateCallCount = 0;

    service.voteMapActive = true;
    service.seeded = true;
    service.voteActive = true;
    service.gameActive = true;
    service.minimumPlayers = 50;
    service.deactivatePlayers = 40;
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => {
        gameStateCallCount += 1;
        service.gameActive = gameStateCallCount === 1;
        return service.gameActive;
    };
    service.crcon = {
        getStatus: async () => ({ result: { current_players: 10 } })
    };
    service.stopVote = async () => {
        stopVoteCalls += 1;
        service.voteActive = false;
        return 'utahbeach_warfare';
    };
    service.clearAllMessages = async () => {};
    service.sendSeedingMsg = async () => {};
    service.applyNonSeededRotation = async () => {
        nonSeededRotationCalls += 1;
        return true;
    };

    await service.doMapVote();
    await service.doMapVote();

    assert.equal(stopVoteCalls, 1);
    assert.equal(nonSeededRotationCalls, 0);
    assert.equal(service.skipNextUnseededMatchEndRotation, false);
});

test('get_status failures enter backoff and skip repeated polling attempts', async () => {
    const service = new MapVotingService(1);
    let statusCalls = 0;

    service.crcon = {
        getStatus: async () => {
            statusCalls += 1;
            throw new Error('Request failed with status code 500');
        }
    };

    const firstStatus = await service.getServerStatus();
    const secondStatus = await service.getServerStatus();

    assert.equal(firstStatus, null);
    assert.equal(secondStatus, null);
    assert.equal(statusCalls, 1);
    assert.equal(service.statusFailureCount, 1);
    assert.ok(service.statusBackoffUntil > Date.now());
});

test('successful get_status clears degraded mode after failure', async () => {
    const service = new MapVotingService(1);
    let shouldFail = true;

    service.crcon = {
        getStatus: async () => {
            if (shouldFail) {
                throw new Error('Request failed with status code 500');
            }
            return { result: { current_players: 12 } };
        }
    };

    await service.getServerStatus();
    service.statusBackoffUntil = 0;
    shouldFail = false;

    const status = await service.getServerStatus();

    assert.deepEqual(status, { result: { current_players: 12 } });
    assert.equal(service.statusFailureCount, 0);
    assert.equal(service.statusBackoffUntil, 0);
});

test('match snapshot fallback detects a map change as a match boundary', async () => {
    const service = new MapVotingService(1);
    const snapshots = [
        {
            currentMapId: 'foy_warfare',
            currentPlayers: 52,
            gameActive: true,
            matchStartEpochSeconds: 1000
        },
        {
            currentMapId: 'stmariedumont_warfare',
            currentPlayers: 48,
            gameActive: true,
            matchStartEpochSeconds: 2000
        },
        {
            currentMapId: 'stmariedumont_warfare',
            currentPlayers: 48,
            gameActive: true,
            matchStartEpochSeconds: 2000
        }
    ];

    service.crcon = {
        getMatchSnapshot: async () => snapshots.shift()
    };

    const firstTick = await service.getGameState();
    const boundaryTick = await service.getGameState();
    const resumedTick = await service.getGameState();

    assert.equal(firstTick, true);
    assert.equal(boundaryTick, false);
    assert.equal(resumedTick, true);
});

test('duplicate vote finalization claims do not overwrite the first selected map', async () => {
    const gameStart = Date.now() + Math.floor(Math.random() * 100000);
    const serverNum = 1;
    const messageId = `vote-${gameStart}`;
    let releaseFirstFinalizer;
    let firstSetVoteResultCalls = 0;
    let secondSetVoteResultCalls = 0;

    voteStore.deleteVote(gameStart, serverNum);
    voteStore.setVote(messageId, gameStart, serverNum, [
        { id: 'foy_warfare', pretty_name: 'Foy Warfare' }
    ]);

    const firstService = new MapVotingService(serverNum);
    firstService.gameStart = gameStart;
    firstService.voteMessageId = messageId;
    firstService.voteActive = true;
    firstService.voteMessage = {
        poll: {
            end: async () => {}
        }
    };
    firstService.setVoteResult = async () => {
        firstSetVoteResultCalls += 1;
        await new Promise((resolve) => {
            releaseFirstFinalizer = resolve;
        });
        return 'foy_warfare';
    };

    const secondService = new MapVotingService(serverNum);
    secondService.gameStart = gameStart;
    secondService.voteMessageId = messageId;
    secondService.voteActive = true;
    secondService.voteMessage = {
        poll: {
            end: async () => {}
        }
    };
    secondService.setVoteResult = async () => {
        secondSetVoteResultCalls += 1;
        return 'kursk_warfare';
    };

    try {
        const firstStopPromise = firstService.stopVote();
        await new Promise((resolve) => setImmediate(resolve));
        await secondService.stopVote();

        assert.equal(firstSetVoteResultCalls, 1);
        assert.equal(secondSetVoteResultCalls, 0);

        releaseFirstFinalizer();
        await firstStopPromise;

        assert.equal(voteStore.getVote(gameStart, serverNum), null);
    } finally {
        voteStore.deleteVote(gameStart, serverNum);
    }
});

test('stopVote still finalizes the next map when the Discord poll has already expired', async () => {
    const gameStart = Date.now() + Math.floor(Math.random() * 100000);
    const serverNum = 1;
    const messageId = `vote-${gameStart}`;
    let setVoteResultCalls = 0;

    voteStore.deleteVote(gameStart, serverNum);
    voteStore.setVote(messageId, gameStart, serverNum, [
        { id: 'stmariedumont_warfare', pretty_name: 'St. Marie Du Mont Warfare' }
    ]);

    const service = new MapVotingService(serverNum);
    service.gameStart = gameStart;
    service.voteMessageId = messageId;
    service.voteActive = true;
    service.voteMessage = {
        poll: {
            end: async () => {
                throw new Error('This poll has already expired.');
            }
        }
    };
    service.setVoteResult = async () => {
        setVoteResultCalls += 1;
        return 'stmariedumont_warfare';
    };

    try {
        const finalizedMapId = await service.stopVote();

        assert.equal(finalizedMapId, 'stmariedumont_warfare');
        assert.equal(setVoteResultCalls, 1);
        assert.equal(service.voteActive, false);
        assert.equal(voteStore.getVote(gameStart, serverNum), null);
    } finally {
        voteStore.deleteVote(gameStart, serverNum);
    }
});

test('vote finalization skips the live current map and picks the next highest eligible winner', async () => {
    const service = new MapVotingService(1);
    let selectedRotationMap = null;

    service.voteMessageId = 'poll-message-current-map';
    service.maps = [
        { id: 'stmariedumont_warfare', pretty_name: 'St. Marie Du Mont Warfare' },
        { id: 'carentan_warfare', pretty_name: 'Carentan Warfare' },
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare' }
    ];
    service.channel = {
        messages: {
            fetch: async () => ({
                poll: {
                    answers: new Map([
                        ['1', { text: 'St. Marie Du Mont Warfare', voteCount: 3 }],
                        ['2', { text: 'Carentan Warfare', voteCount: 2 }],
                        ['3', { text: 'Omaha Beach Warfare', voteCount: 1 }]
                    ])
                }
            })
        }
    };
    service.crcon = {
        queueNextMap: async (mapId) => {
            selectedRotationMap = mapId;
        }
    };
    service.getAllMaps = async () => ([
        { id: 'stmariedumont_warfare', pretty_name: 'St. Marie Du Mont Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'St. Marie Du Mont' } },
        { id: 'carentan_warfare', pretty_name: 'Carentan Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Carentan' } },
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Omaha Beach' } }
    ]);
    service.getRecentExcludedMapIds = async () => new Set(['stmariedumont_warfare']);
    service.getCurrentMapId = async () => 'stmariedumont_warfare';
    service.getResults = async () => [
        ['St. Marie Du Mont Warfare', 3],
        ['Carentan Warfare', 2],
        ['Omaha Beach Warfare', 1]
    ];

    const mapId = await service.setVoteResult();

    assert.equal(mapId, 'carentan_warfare');
    assert.equal(selectedRotationMap, 'carentan_warfare');
});

test('vote finalization prefers match snapshot current map over stale status when excluding the live map', async () => {
    const service = new MapVotingService(1);
    let selectedRotationMap = null;

    service.voteMessageId = 'poll-message-stale-status';
    service.maps = [
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare' },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare' }
    ];
    service.channel = {
        messages: {
            fetch: async () => ({
                poll: {
                    answers: new Map([
                        ['1', { text: 'Omaha Beach Warfare', voteCount: 3 }],
                        ['2', { text: 'Utah Beach Warfare', voteCount: 2 }]
                    ])
                }
            })
        }
    };
    service.crcon = {
        getMatchSnapshot: async () => ({
            currentMapId: 'omahabeach_warfare',
            nextMapId: 'carentan_warfare',
            currentPlayers: 90,
            gameActive: true,
            matchStartEpochSeconds: 1776591000
        }),
        getStatus: async () => ({
            result: {
                current_map: {
                    id: 'stmereeglise_warfare',
                    pretty_name: 'St. Mere Eglise Warfare'
                }
            }
        }),
        queueNextMap: async (mapId) => {
            selectedRotationMap = mapId;
        }
    };
    service.getAllMaps = async () => ([
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Omaha Beach' } },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Utah Beach' } },
        { id: 'stmereeglise_warfare', pretty_name: 'St. Mere Eglise Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'St. Mere Eglise' } }
    ]);
    service.getRecentExcludedMapIds = async () => new Set();
    service.getResults = async () => [
        ['Omaha Beach Warfare', 3],
        ['Utah Beach Warfare', 2]
    ];

    const mapId = await service.setVoteResult();

    assert.equal(mapId, 'utahbeach_warfare');
    assert.equal(selectedRotationMap, 'utahbeach_warfare');
});

test('vote finalization random fallback uses live poll options instead of stale in-memory maps', async () => {
    const originalRandom = Math.random;
    const service = new MapVotingService(1);
    let selectedRotationMap = null;

    service.voteMessageId = 'poll-message-1';
    service.maps = [
        { id: 'kursk_warfare', pretty_name: 'Kursk Warfare' },
        { id: 'foy_warfare', pretty_name: 'Foy Warfare' }
    ];
    service.channel = {
        messages: {
            fetch: async () => ({
                poll: {
                    answers: new Map([
                        ['1', { text: 'St. Marie Du Mont Warfare', voteCount: 0 }],
                        ['2', { text: 'St. Mere Eglise Warfare', voteCount: 0 }],
                        ['3', { text: 'Utah Beach Warfare', voteCount: 0 }]
                    ])
                }
            })
        }
    };
    service.crcon = {
        queueNextMap: async (mapId) => {
            selectedRotationMap = mapId;
        }
    };
    service.getAllMaps = async () => ([
        { id: 'stmariedumont_warfare', pretty_name: 'St. Marie Du Mont Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'St. Marie Du Mont' } },
        { id: 'stmereeglise_warfare', pretty_name: 'St. Mere Eglise Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'St. Mere Eglise' } },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Utah Beach' } },
        { id: 'kursk_warfare', pretty_name: 'Kursk Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Kursk' } }
    ]);
    service.getRecentExcludedMapIds = async () => new Set();
    service.getCurrentMapId = async () => null;
    service.getResults = async () => null;

    Math.random = () => 0.99;

    try {
        const mapId = await service.setVoteResult();

        assert.equal(mapId, 'utahbeach_warfare');
        assert.equal(selectedRotationMap, 'utahbeach_warfare');
    } finally {
        Math.random = originalRandom;
    }
});

test('vote finalization uses the live Discord poll winner and queues that map', async () => {
    const service = new MapVotingService(1);
    let queuedMapId = null;

    service.voteMessageId = 'poll-message-live-winner';
    service.maps = [
        { id: 'kursk_warfare', pretty_name: 'Kursk Warfare' },
        { id: 'foy_warfare', pretty_name: 'Foy Warfare' }
    ];
    service.channel = {
        messages: {
            fetch: async () => ({
                poll: {
                    answers: new Map([
                        ['1', { text: 'Omaha Beach Warfare', voteCount: 4 }],
                        ['2', { text: 'Utah Beach Warfare', voteCount: 2 }],
                        ['3', { text: 'Carentan Warfare', voteCount: 1 }]
                    ])
                }
            })
        }
    };
    service.crcon = {
        queueNextMap: async (mapId) => {
            queuedMapId = mapId;
        }
    };
    service.getAllMaps = async () => ([
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Omaha Beach' } },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Utah Beach' } },
        { id: 'carentan_warfare', pretty_name: 'Carentan Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Carentan' } },
        { id: 'kursk_warfare', pretty_name: 'Kursk Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Kursk' } }
    ]);
    service.getRecentExcludedMapIds = async () => new Set();
    service.getCurrentMapId = async () => 'foy_warfare';

    const mapId = await service.setVoteResult();

    assert.equal(mapId, 'omahabeach_warfare');
    assert.equal(queuedMapId, 'omahabeach_warfare');
});

test('vote finalization random fallback excludes the live current map when no votes were cast', async () => {
    const originalRandom = Math.random;
    const service = new MapVotingService(1);
    let selectedRotationMap = null;

    service.voteMessageId = 'poll-message-random-current-map';
    service.maps = [
        { id: 'stmariedumont_warfare', pretty_name: 'St. Marie Du Mont Warfare' },
        { id: 'carentan_warfare', pretty_name: 'Carentan Warfare' }
    ];
    service.channel = {
        messages: {
            fetch: async () => ({
                poll: {
                    answers: new Map([
                        ['1', { text: 'St. Marie Du Mont Warfare', voteCount: 0 }],
                        ['2', { text: 'Carentan Warfare', voteCount: 0 }]
                    ])
                }
            })
        }
    };
    service.crcon = {
        queueNextMap: async (mapId) => {
            selectedRotationMap = mapId;
        }
    };
    service.getAllMaps = async () => ([
        { id: 'stmariedumont_warfare', pretty_name: 'St. Marie Du Mont Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'St. Marie Du Mont' } },
        { id: 'carentan_warfare', pretty_name: 'Carentan Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Carentan' } }
    ]);
    service.getRecentExcludedMapIds = async () => new Set();
    service.getCurrentMapId = async () => 'stmariedumont_warfare';
    service.getResults = async () => null;

    Math.random = () => 0;

    try {
        const mapId = await service.setVoteResult();

        assert.equal(mapId, 'carentan_warfare');
        assert.equal(selectedRotationMap, 'carentan_warfare');
    } finally {
        Math.random = originalRandom;
    }
});

test('non-seeded rotation falls back to available maps when no non-seeded list is configured', async () => {
    const originalConfig = JSON.parse(JSON.stringify(configManager.config));
    const service = new MapVotingService(1);
    let selectedRotationMap = null;

    configManager.config.servers = {
        ...configManager.config.servers,
        1: {
            ...(configManager.config.servers?.[1] || {}),
            nonSeededMapList: []
        }
    };

    service.blacklist = [];
    service.getAllMaps = async () => ([
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Omaha Beach' } },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Utah Beach' } }
    ]);
    service.getEffectiveWhitelist = async () => null;
    service.getRecentExcludedMapIds = async () => new Set(['omahabeach_warfare']);
    service.getCurrentMapId = async () => 'omahabeach_warfare';
    service.crcon = {
        queueNextMap: async (mapId) => {
            selectedRotationMap = mapId;
        }
    };

    try {
        const applied = await service.applyNonSeededRotation();

        assert.equal(applied, true);
        assert.equal(selectedRotationMap, 'utahbeach_warfare');
    } finally {
        configManager.config = originalConfig;
    }
});

test('non-seeded rotation avoids re-selecting the current map when alternatives exist', async () => {
    const originalConfig = JSON.parse(JSON.stringify(configManager.config));
    const service = new MapVotingService(1);
    let selectedRotationMap = null;

    configManager.config.servers = {
        ...configManager.config.servers,
        1: {
            ...(configManager.config.servers?.[1] || {}),
            nonSeededMapList: ['omahabeach_warfare', 'utahbeach_warfare']
        }
    };

    service.blacklist = [];
    service.getAllMaps = async () => ([
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Omaha Beach' } },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Utah Beach' } }
    ]);
    service.getRecentExcludedMapIds = async () => new Set(['omahabeach_warfare', 'utahbeach_warfare']);
    service.getCurrentMapId = async () => 'omahabeach_warfare';
    service.crcon = {
        queueNextMap: async (mapId) => {
            selectedRotationMap = mapId;
        }
    };

    try {
        const applied = await service.applyNonSeededRotation();

        assert.equal(applied, true);
        assert.equal(selectedRotationMap, 'utahbeach_warfare');
    } finally {
        configManager.config = originalConfig;
    }
});

test('non-seeded rotation returns false when verified queueing rejects the selected map', async () => {
    const originalConfig = JSON.parse(JSON.stringify(configManager.config));
    const service = new MapVotingService(1);

    configManager.config.servers = {
        ...configManager.config.servers,
        1: {
            ...(configManager.config.servers?.[1] || {}),
            nonSeededMapList: ['utahbeach_warfare']
        }
    };

    service.blacklist = [];
    service.getAllMaps = async () => ([
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Omaha Beach' } },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Utah Beach' } }
    ]);
    service.getRecentExcludedMapIds = async () => new Set(['omahabeach_warfare']);
    service.getCurrentMapId = async () => 'omahabeach_warfare';
    service.crcon = {
        queueNextMap: async () => {
            throw new Error('Queued next map mismatch: expected utahbeach_warfare but observed omahabeach_warfare via public-info');
        }
    };

    try {
        const applied = await service.applyNonSeededRotation();

        assert.equal(applied, false);
    } finally {
        configManager.config = originalConfig;
    }
});
