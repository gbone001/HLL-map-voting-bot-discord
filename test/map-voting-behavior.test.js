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

test('match-end detection finalizes an active vote before status polling succeeds', async () => {
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
        getStatus: async () => {
            throw new Error('Request failed with status code 500');
        }
    };
    service.stopVote = async () => {
        stopVoteCalls += 1;
        service.voteActive = false;
        return 'utahbeach_warfare';
    };
    service.applyNonSeededRotation = async () => {
        nonSeededRotationCalls += 1;
        return true;
    };

    await service.doMapVote();

    assert.equal(stopVoteCalls, 1);
    assert.equal(nonSeededRotationCalls, 0);
    assert.equal(service.voteActive, false);
});

test('direct RCON session timer reaching zero finalizes an active vote with sequence-start queueing', async () => {
    const service = new MapVotingService(1);
    const stopVoteCalls = [];

    service.voteMapActive = true;
    service.seeded = true;
    service.voteActive = true;
    service.gameActive = true;
    service.minimumPlayers = 50;
    service.deactivatePlayers = 40;
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => true;
    service.crcon = {
        supportsDirectSessionPolling: () => true,
        getDirectSessionInfo: async () => ({
            remainingMatchTime: 0,
            matchTime: 5400,
            mapId: 'carentan_warfare'
        }),
        getStatus: async () => ({ result: { current_players: 70 } })
    };
    service.stopVote = async (options = {}) => {
        stopVoteCalls.push(options);
        service.voteActive = false;
        return 'utahbeach_warfare';
    };
    service.clearAllMessages = async () => {};
    service.startVote = async () => {
        throw new Error('startVote should not run in the same tick as timer-zero finalization');
    };

    await service.doMapVote();

    assert.deepEqual(stopVoteCalls, [
        {
            keepVoteActiveOnFailure: true,
            queueStrategy: 'direct-sequence-start'
        }
    ]);
    assert.equal(service.voteActive, false);
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

test('active vote is finalized when player count drops below minimumPlayers mid-match', async () => {
    const service = new MapVotingService(1);
    let stopVoteCalls = 0;
    let seedingMessageCalls = 0;

    service.voteMapActive = true;
    service.seeded = true;
    service.voteActive = true;
    service.gameActive = true;
    service.minimumPlayers = 25;
    service.deactivatePlayers = 10;
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => true;
    service.crcon = {
        getStatus: async () => ({ result: { current_players: 24 } })
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

test('failed match-end finalization is retried on the next tick before any new vote starts', async () => {
    const service = new MapVotingService(1);
    let stopVoteCalls = 0;
    let startVoteCalls = 0;
    let seedingMessageCalls = 0;
    let statusCallCount = 0;

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
        getStatus: async () => {
            statusCallCount += 1;
            if (statusCallCount === 1) {
                throw new Error('Request failed with status code 500');
            }
            return { result: { current_players: 10 } };
        }
    };
    service.stopVote = async () => {
        stopVoteCalls += 1;
        if (stopVoteCalls === 1) {
            service.voteActive = true;
            return null;
        }

        service.voteActive = false;
        return 'stmariedumont_warfare';
    };
    service.startVote = async () => {
        startVoteCalls += 1;
    };
    service.clearAllMessages = async () => {};
    service.sendSeedingMsg = async () => {
        seedingMessageCalls += 1;
    };

    await service.doMapVote();
    service.statusBackoffUntil = 0;
    await service.doMapVote();

    assert.equal(stopVoteCalls, 2);
    assert.equal(startVoteCalls, 0);
    assert.equal(seedingMessageCalls, 1);
    assert.equal(service.voteActive, false);
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
        return 'utahbeach_warfare';
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

test('seeded polling defers starting a new vote while a queued winner is still pending', async () => {
    const service = new MapVotingService(1);
    let startVoteCalls = 0;
    let pendingQueuedMap = {
        mapId: 'foy_warfare',
        source: 'vote-result',
        queuedAt: Date.now()
    };

    service.voteMapActive = true;
    service.seeded = true;
    service.voteActive = false;
    service.gameActive = true;
    service.minimumPlayers = 25;
    service.deactivatePlayers = 10;
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => true;
    service.getAllMaps = async () => [];
    service.getCurrentMapId = async () => 'carentan_warfare';
    service.crcon = {
        getStatus: async () => ({ result: { current_players: 40 } }),
        readQueuedNextMapState: async () => ({
            currentMapId: 'carentan_warfare',
            nextMapId: 'foy_warfare',
            source: 'public-info'
        })
    };
    service.clearAllMessages = async () => {};
    service.startVote = async () => {
        startVoteCalls += 1;
    };
    service.getPendingQueuedMap = () => pendingQueuedMap;
    service.clearPendingQueuedMap = () => {
        pendingQueuedMap = null;
    };

    await service.doMapVote();

    assert.equal(startVoteCalls, 0);
    assert.equal(service.getPendingQueuedMap().mapId, 'foy_warfare');
});

test('seeded polling clears an overwritten queued winner and allows a new vote', async () => {
    const service = new MapVotingService(1);
    let startVoteCalls = 0;
    let pendingQueuedMap = {
        mapId: 'foy_warfare',
        source: 'vote-result',
        queuedAt: Date.now()
    };

    service.voteMapActive = true;
    service.seeded = true;
    service.voteActive = false;
    service.gameActive = true;
    service.minimumPlayers = 25;
    service.deactivatePlayers = 10;
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => true;
    service.getAllMaps = async () => [];
    service.getCurrentMapId = async () => 'carentan_warfare';
    service.crcon = {
        getStatus: async () => ({ result: { current_players: 40 } }),
        readQueuedNextMapState: async () => ({
            currentMapId: 'carentan_warfare',
            nextMapId: 'omahabeach_warfare',
            source: 'public-info'
        })
    };
    service.clearAllMessages = async () => {};
    service.startVote = async () => {
        startVoteCalls += 1;
    };
    service.getPendingQueuedMap = () => pendingQueuedMap;
    service.clearPendingQueuedMap = () => {
        pendingQueuedMap = null;
    };

    await service.doMapVote();

    assert.equal(startVoteCalls, 1);
    assert.equal(service.getPendingQueuedMap(), null);
});

test('managed rotation sync preserves pending queued winner at the front of rotation', async () => {
    const service = new MapVotingService(1);
    const appliedRotations = [];

    service.crcon = {
        replaceMapRotation: async (mapIds) => {
            appliedRotations.push([...mapIds]);
        }
    };
    service.getManagedRotationPoolMapIds = async () => [
        'foy_warfare',
        'carentan_warfare',
        'utahbeach_warfare'
    ];
    service.getPendingQueuedMap = () => ({
        mapId: 'stmereeglise_warfare',
        source: 'vote-result',
        queuedAt: Date.now()
    });

    const synced = await service.syncManagedRotationPool();

    assert.equal(synced, true);
    assert.equal(appliedRotations.length, 1);
    assert.deepEqual(appliedRotations[0], [
        'stmereeglise_warfare',
        'foy_warfare',
        'carentan_warfare',
        'utahbeach_warfare'
    ]);
});

test('getMapsToVote includes skirmish options when skirmish weight is enabled', async () => {
    const service = new MapVotingService(1);
    service.mapsPerVote = 4;
    service.nightMapCount = 0;
    service.modeWeights = {
        warfare: 1,
        offensive: 1,
        skirmish: 1
    };
    service.blacklist = [];
    service.getAllMaps = async () => ([
        {
            id: 'carentan_warfare',
            pretty_name: 'Carentan Warfare',
            game_mode: 'warfare',
            environment: 'day',
            map: { name: 'Carentan' }
        },
        {
            id: 'stmereeglise_offensive_us',
            pretty_name: 'St. Mere Eglise Offensive (US)',
            game_mode: 'offensive',
            environment: 'day',
            map: { name: 'St. Mere Eglise' }
        },
        {
            id: 'mortain_skirmish_overcast',
            pretty_name: 'Mortain Skirmish (Overcast)',
            game_mode: 'skirmish',
            environment: 'overcast',
            map: { name: 'Mortain' }
        },
        {
            id: 'elsenbornridge_skirmish_night',
            pretty_name: 'Elsenborn Ridge Skirmish (Night)',
            game_mode: 'skirmish',
            environment: 'night',
            map: { name: 'Elsenborn Ridge' }
        }
    ]);
    service.getRecentExcludedMapIds = async () => new Set();
    service.getCurrentMapId = async () => 'foy_warfare';
    service.getEffectiveWhitelist = async () => null;

    const voteMaps = await service.getMapsToVote();
    const voteMapIds = voteMaps.map((map) => map.id);

    assert.ok(voteMapIds.includes('mortain_skirmish_overcast'));
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

test('getGameState uses MATCH ENDED and MATCH START log entries to detect round state', async () => {
    const service = new MapVotingService(1);
    const recentLogResponses = [
        {
            result: {
                logs: [
                    { raw: '2026-04-20T07:00:00Z MATCH ENDED' }
                ]
            }
        },
        {
            result: {
                logs: [
                    { raw: '2026-04-20T07:02:00Z MATCH START' }
                ]
            }
        }
    ];

    service.crcon = {
        post: async (endpoint) => {
            assert.equal(endpoint, 'get_recent_logs');
            return recentLogResponses.shift();
        }
    };

    const endedTick = await service.getGameState();
    const startedTick = await service.getGameState();

    assert.equal(endedTick, false);
    assert.equal(startedTick, true);
});

test('seeded polling waits for a confirmed live map change before starting the next vote', async () => {
    const service = new MapVotingService(1);
    let startVoteCalls = 0;
    let currentMapId = 'foy_warfare';

    service.voteMapActive = true;
    service.seeded = true;
    service.voteActive = false;
    service.gameActive = true;
    service.minimumPlayers = 25;
    service.deactivatePlayers = 10;
    service.lastVoteStartedForCurrentMapId = 'foy_warfare';
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => true;
    service.getAllMaps = async () => [];
    service.getCurrentMapId = async () => currentMapId;
    service.crcon = {
        getStatus: async () => ({ result: { current_players: 40 } })
    };
    service.clearAllMessages = async () => {};
    service.startVote = async () => {
        startVoteCalls += 1;
    };

    await service.doMapVote();

    currentMapId = 'utahbeach_warfare';
    await service.doMapVote();

    assert.equal(startVoteCalls, 1);
});

test('API-only transport does not use direct session timer polling for vote finalization', async () => {
    const service = new MapVotingService(1);
    let directSessionInfoCalls = 0;
    let stopVoteCalls = 0;

    service.voteMapActive = true;
    service.seeded = true;
    service.voteActive = true;
    service.gameActive = true;
    service.minimumPlayers = 50;
    service.deactivatePlayers = 40;
    service.applyScheduleSettings = async () => {};
    service.getGameState = async () => true;
    service.crcon = {
        supportsDirectSessionPolling: () => false,
        getDirectSessionInfo: async () => {
            directSessionInfoCalls += 1;
            return {
                remainingMatchTime: 0
            };
        },
        getStatus: async () => ({ result: { current_players: 60 } })
    };
    service.stopVote = async () => {
        stopVoteCalls += 1;
        return 'utahbeach_warfare';
    };

    await service.doMapVote();

    assert.equal(directSessionInfoCalls, 0);
    assert.equal(stopVoteCalls, 0);
    assert.equal(service.voteActive, true);
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

test('stopVote clears active vote state on non-retryable queued-map mismatch failures', async () => {
    const gameStart = Date.now() + Math.floor(Math.random() * 100000);
    const serverNum = 1;
    const messageId = `vote-${gameStart}`;

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
            end: async () => {}
        }
    };
    service.setVoteResult = async () => {
        throw new Error('Queued next map mismatch: expected stmariedumont_warfare but observed foy_warfare via public-info');
    };

    try {
        const finalizedMapId = await service.stopVote({ keepVoteActiveOnFailure: true });

        assert.equal(finalizedMapId, null);
        assert.equal(service.voteActive, false);
        assert.equal(voteStore.getVote(gameStart, serverNum), null);
        assert.equal(service.voteFinalizationFailureCount, 0);
    } finally {
        voteStore.deleteVote(gameStart, serverNum);
    }
});

test('vote finalization skips the live current map and picks the next highest eligible winner', async () => {
    const service = new MapVotingService(1);
    let appliedRotationMapIds = null;

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
        replaceMapRotation: async (mapIds) => {
            appliedRotationMapIds = mapIds;
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
    assert.deepEqual(appliedRotationMapIds.slice(0, 2), ['stmariedumont_warfare', 'carentan_warfare']);
});

test('vote finalization prefers the live current map over stale status when excluding the live map', async () => {
    const service = new MapVotingService(1);
    let appliedRotationMapIds = null;

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
        replaceMapRotation: async (mapIds) => {
            appliedRotationMapIds = mapIds;
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
    assert.deepEqual(appliedRotationMapIds.slice(0, 2), ['omahabeach_warfare', 'utahbeach_warfare']);
});

test('vote finalization random fallback uses live poll options instead of stale in-memory maps', async () => {
    const originalRandom = Math.random;
    const service = new MapVotingService(1);
    let appliedRotationMapIds = null;

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
        replaceMapRotation: async (mapIds) => {
            appliedRotationMapIds = mapIds;
        }
    };
    service.getAllMaps = async () => ([
        { id: 'stmariedumont_warfare', pretty_name: 'St. Marie Du Mont Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'St. Marie Du Mont' } },
        { id: 'stmereeglise_warfare', pretty_name: 'St. Mere Eglise Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'St. Mere Eglise' } },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Utah Beach' } },
        { id: 'kursk_warfare', pretty_name: 'Kursk Warfare', game_mode: 'warfare', environment: 'day', map: { name: 'Kursk' } }
    ]);
    service.getRecentExclusionContext = async () => ({
        recentMapIds: new Set(),
        recentGeneralMapKeys: new Set(),
        currentMapId: null,
        currentGeneralMapKey: null,
        historyAvailable: true,
        hasExactRepeatProtection: true,
        reliable: true
    });
    service.getResults = async () => null;

    Math.random = () => 0.99;

    try {
        const mapId = await service.setVoteResult();

        assert.equal(mapId, 'utahbeach_warfare');
        assert.equal(appliedRotationMapIds[0], 'utahbeach_warfare');
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
        replaceMapRotation: async (mapIds) => {
            queuedMapId = mapIds[0];
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

test('vote finalization skips same-base-map winners that repeat the live map', async () => {
    const service = new MapVotingService(1);
    let queuedMapId = null;

    service.voteMessageId = 'poll-message-same-base-map';
    service.maps = [
        { id: 'carentan_offensive_us', pretty_name: 'Carentan Offensive (US)', vote_label: 'Carentan | Offensive | Allies' },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', vote_label: 'Utah Beach | Warfare | Day' }
    ];
    service.channel = {
        messages: {
            fetch: async () => ({
                poll: {
                    answers: new Map([
                        ['1', { text: 'Carentan | Offensive | Allies', voteCount: 4 }],
                        ['2', { text: 'Utah Beach | Warfare | Day', voteCount: 3 }]
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
        { id: 'carentan_warfare', pretty_name: 'Carentan Warfare', game_mode: 'warfare', environment: 'day', map_name: 'Carentan', map: { name: 'Carentan' } },
        { id: 'carentan_offensive_us', pretty_name: 'Carentan Offensive (US)', game_mode: 'offensive', environment: 'day', map_name: 'Carentan', map: { name: 'Carentan' } },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day', map_name: 'Utah Beach', map: { name: 'Utah Beach' } }
    ]);
    service.getCurrentPollMaps = async () => service.maps;
    service.getResults = async () => [
        ['Carentan | Offensive | Allies', 4],
        ['Utah Beach | Warfare | Day', 3]
    ];
    service.getRecentExclusionContext = async () => ({
        recentMapIds: new Set(['carentan_warfare']),
        recentGeneralMapKeys: new Set(['carentan']),
        currentMapId: 'carentan_warfare',
        currentGeneralMapKey: 'carentan',
        historyAvailable: true,
        reliable: true
    });

    const mapId = await service.setVoteResult();

    assert.equal(mapId, 'utahbeach_warfare');
    assert.equal(queuedMapId, 'utahbeach_warfare');
});

test('vote finalization fails closed when current map exclusions are not reliable', async () => {
    const service = new MapVotingService(1);

    service.voteMessageId = 'poll-message-unreliable-exclusions';
    service.maps = [
        { id: 'carentan_warfare', pretty_name: 'Carentan Warfare', vote_label: 'Carentan | Warfare | Day' }
    ];
    service.channel = {
        messages: {
            fetch: async () => ({
                poll: {
                    answers: new Map([
                        ['1', { text: 'Carentan | Warfare | Day', voteCount: 1 }]
                    ])
                }
            })
        }
    };
    service.getAllMaps = async () => ([
        { id: 'carentan_warfare', pretty_name: 'Carentan Warfare', game_mode: 'warfare', environment: 'day', map_name: 'Carentan', map: { name: 'Carentan' } }
    ]);
    service.getCurrentPollMaps = async () => service.maps;
    service.getResults = async () => [['Carentan | Warfare | Day', 1]];
    service.getRecentExclusionContext = async () => ({
        recentMapIds: new Set(),
        recentGeneralMapKeys: new Set(),
        currentMapId: null,
        currentGeneralMapKey: null,
        historyAvailable: true,
        reliable: false
    });

    await assert.rejects(
        () => service.setVoteResult(),
        /Could not reliably resolve current\/recent map exclusions/
    );
});

test('vote finalization random fallback excludes the live current map when no votes were cast', async () => {
    const originalRandom = Math.random;
    const service = new MapVotingService(1);
    let appliedRotationMapIds = null;

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
        replaceMapRotation: async (mapIds) => {
            appliedRotationMapIds = mapIds;
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
        assert.deepEqual(appliedRotationMapIds.slice(0, 2), ['stmariedumont_warfare', 'carentan_warfare']);
    } finally {
        Math.random = originalRandom;
    }
});

test('non-seeded rotation fails closed when no non-seeded list is configured', async () => {
    const originalConfig = JSON.parse(JSON.stringify(configManager.config));
    const service = new MapVotingService(1);
    let replaceRotationCalls = 0;

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
        replaceMapRotation: async () => {
            replaceRotationCalls += 1;
        }
    };

    try {
        const applied = await service.applyNonSeededRotation();

        assert.equal(applied, false);
        assert.equal(replaceRotationCalls, 0);
    } finally {
        configManager.config = originalConfig;
    }
});

test('non-seeded rotation avoids re-selecting the current map when alternatives exist', async () => {
    const originalConfig = JSON.parse(JSON.stringify(configManager.config));
    const service = new MapVotingService(1);
    let appliedRotationMapIds = null;

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
        replaceMapRotation: async (mapIds) => {
            appliedRotationMapIds = mapIds;
        }
    };

    try {
        const applied = await service.applyNonSeededRotation();

        assert.equal(applied, true);
        assert.deepEqual(appliedRotationMapIds.slice(0, 2), ['omahabeach_warfare', 'utahbeach_warfare']);
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
        replaceMapRotation: async () => {
            throw new Error('Failed to replace managed rotation');
        }
    };

    try {
        const applied = await service.applyNonSeededRotation();

        assert.equal(applied, false);
    } finally {
        configManager.config = originalConfig;
    }
});

test('loading the active schedule map pool replaces the managed server rotation', async () => {
    const service = new MapVotingService(1);
    let appliedRotationMapIds = null;

    service.blacklist = ['kursk_warfare'];
    service.crcon = {
        replaceMapRotation: async (mapIds) => {
            appliedRotationMapIds = mapIds;
        }
    };
    service.getActiveScheduleSettings = () => ({
        whitelist: ['utahbeach_warfare', 'omahabeach_warfare', 'kursk_warfare']
    });
    service.getAllMaps = async () => ([
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day' },
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare', game_mode: 'warfare', environment: 'day' },
        { id: 'kursk_warfare', pretty_name: 'Kursk Warfare', game_mode: 'warfare', environment: 'day' }
    ]);
    service.getPendingQueuedMap = () => null;

    const applied = await service.loadScheduleMapPoolAsRotation();

    assert.equal(applied, true);
    assert.deepEqual(appliedRotationMapIds, ['utahbeach_warfare', 'omahabeach_warfare']);
    assert.deepEqual(service.managedRotationPoolMapIds, ['utahbeach_warfare', 'omahabeach_warfare']);
});

test('managed rotation queueing preserves the full map pool with the selected map after current map', async () => {
    const service = new MapVotingService(1);
    let queuedMapId = null;
    let queuedRotationMapIds = null;

    service.crcon = {
        queueNextMap: async (mapId, rotationMapIds) => {
            queuedMapId = mapId;
            queuedRotationMapIds = rotationMapIds;
        }
    };
    service.getActiveScheduleSettings = () => ({
        whitelist: ['foy_warfare', 'utahbeach_warfare', 'omahabeach_warfare']
    });
    service.getAllMaps = async () => ([
        { id: 'foy_warfare', pretty_name: 'Foy Warfare', game_mode: 'warfare', environment: 'day' },
        { id: 'utahbeach_warfare', pretty_name: 'Utah Beach Warfare', game_mode: 'warfare', environment: 'day' },
        { id: 'omahabeach_warfare', pretty_name: 'Omaha Beach Warfare', game_mode: 'warfare', environment: 'day' }
    ]);

    const rotationOrder = await service.applyManagedRotationSelection(
        'utahbeach_warfare',
        'test-selection',
        service.getActiveScheduleSettings(),
        await service.getAllMaps(),
        { currentMapId: 'foy_warfare' }
    );

    assert.equal(queuedMapId, 'utahbeach_warfare');
    assert.deepEqual(queuedRotationMapIds, [
        'foy_warfare',
        'utahbeach_warfare',
        'omahabeach_warfare'
    ]);
    assert.deepEqual(rotationOrder, queuedRotationMapIds);
});

test('formatMapForVote emits a structured vote label from map, mode, and variant', () => {
    const service = new MapVotingService(1);

    const formattedMap = service.formatMapForVote({
        id: 'carentan_warfare',
        pretty_name: 'Carentan Warfare',
        game_mode: 'warfare',
        environment: 'day',
        map_name: 'Carentan',
        mode: 'warfare',
        variant: 'Day',
        vote_label: 'Carentan | Warfare | Day',
        weight: 90,
        seeding: true,
        stress: null,
        map: { name: 'Carentan' }
    });

    assert.deepEqual(formattedMap, {
        id: 'carentan_warfare',
        name: 'Carentan',
        mode: 'warfare',
        variant: 'Day',
        time: 'day',
        pretty_name: 'Carentan Warfare',
        vote_label: 'Carentan | Warfare | Day',
        weight: 90,
        seeding: true,
        stress: null
    });
});

test('getVoteResult resolves winners by structured vote label', async () => {
    const service = new MapVotingService(1);

    const winner = await service.getVoteResult(
        [
            ['Carentan | Warfare | Day', 6],
            ['Foy | Warfare | Day', 2]
        ],
        [
            {
                id: 'carentan_warfare',
                pretty_name: 'Carentan Warfare',
                vote_label: 'Carentan | Warfare | Day'
            },
            {
                id: 'foy_warfare',
                pretty_name: 'Foy Warfare',
                vote_label: 'Foy | Warfare | Day'
            }
        ],
        'utahbeach_warfare'
    );

    assert.equal(winner, 'carentan_warfare');
});
