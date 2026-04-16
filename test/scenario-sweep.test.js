const test = require('node:test');
const assert = require('node:assert/strict');

const { MapVotingService } = require('../src/services/mapVoting');
const voteStore = require('../src/services/voteStore');

function createPollingService() {
    const service = new MapVotingService(1);
    service.voteMapActive = true;
    service.applyScheduleSettings = async () => {};
    service.applyScheduleSettingsNow = async () => {};
    service.clearAllMessages = async () => {};
    service.sendSeedingMsg = async () => {};
    service.startVote = async () => {};
    service.stopVote = async () => null;
    service.applyNonSeededRotation = async () => false;
    return service;
}

test('scenario sweep: repeated full-server polling only starts one vote on an unknown live map', async () => {
    const service = createPollingService();
    let startVoteCalls = 0;

    service.crcon = {
        getMatchSnapshot: async () => ({
            currentMapId: 'smolensk_warfare',
            currentPlayers: 97,
            gameActive: true,
            matchStartEpochSeconds: 2000
        }),
        getStatus: async () => ({
            result: {
                current_players: 97,
                current_map: {
                    id: 'smolensk_warfare',
                    pretty_name: 'Smolensk Warfare'
                }
            }
        })
    };
    service.checkActiveVote = async () => false;
    service.startVote = async () => {
        startVoteCalls += 1;
        service.voteActive = true;
    };

    for (let index = 0; index < 8; index += 1) {
        await service.doMapVote();
    }

    assert.equal(startVoteCalls, 1);
    assert.equal(service.seeded, true);
    assert.equal(service.voteActive, true);
    assert.equal(service.sendSeedingMessage, true);
});

test('scenario sweep: repeated low-pop polling only sends one seeding message', async () => {
    const service = createPollingService();
    let seedingMessageCalls = 0;

    service.crcon = {
        getMatchSnapshot: async () => ({
            currentMapId: 'foy_warfare',
            currentPlayers: 5,
            gameActive: true,
            matchStartEpochSeconds: 3000
        }),
        getStatus: async () => ({
            result: {
                current_players: 5,
                current_map: {
                    id: 'foy_warfare',
                    pretty_name: 'Foy Warfare'
                }
            }
        })
    };
    service.sendSeedingMsg = async () => {
        seedingMessageCalls += 1;
    };

    for (let index = 0; index < 8; index += 1) {
        await service.doMapVote();
    }

    assert.equal(seedingMessageCalls, 1);
    assert.equal(service.seeded, false);
    assert.equal(service.voteActive, false);
    assert.equal(service.sendSeedingMessage, false);
});

test('scenario sweep: seeded state follows hysteresis thresholds across repeated polls', async () => {
    const service = createPollingService();
    const observedSeededStates = [];
    const playerSequence = [39, 40, 97, 45, 11, 9, 50];
    service.minimumPlayers = 40;
    service.deactivatePlayers = 10;

    service.sendSeedingMsg = async () => {};
    service.startVote = async () => {
        service.voteActive = true;
    };
    service.stopVote = async () => {
        service.voteActive = false;
        return 'utahbeach_warfare';
    };
    service.crcon = {
        getMatchSnapshot: async () => ({
            currentMapId: 'utahbeach_warfare',
            currentPlayers: playerSequence[0],
            gameActive: true,
            matchStartEpochSeconds: 4000
        }),
        getStatus: async () => ({
            result: {
                current_players: playerSequence.shift(),
                current_map: {
                    id: 'utahbeach_warfare',
                    pretty_name: 'Utah Beach Warfare'
                }
            }
        })
    };
    service.checkActiveVote = async () => false;

    for (let index = 0; index < 7; index += 1) {
        await service.doMapVote();
        observedSeededStates.push(service.seeded);
    }

    assert.deepEqual(observedSeededStates, [false, true, true, true, true, false, true]);
});

test('scenario sweep: stale stored vote is cleaned up when the Discord poll message is gone', async () => {
    const serverNum = 1;
    const gameStart = 777001;
    const staleMessageId = 'stale-poll-message';
    const service = new MapVotingService(serverNum);

    voteStore.deleteVote(gameStart, serverNum);
    voteStore.setVote(staleMessageId, gameStart, serverNum, [
        { id: 'foy_warfare', pretty_name: 'Foy Warfare' }
    ]);

    service.crcon = {
        getMatchSnapshot: async () => ({
            currentMapId: 'foy_warfare',
            currentPlayers: 97,
            gameActive: true,
            matchStartEpochSeconds: gameStart
        })
    };
    service.channel = {
        messages: {
            fetch: async () => {
                throw new Error('Unknown Message');
            }
        }
    };

    try {
        const resumed = await service.checkActiveVote();

        assert.equal(resumed, false);
        assert.equal(voteStore.getVote(gameStart, serverNum), null);
    } finally {
        voteStore.deleteVote(gameStart, serverNum);
    }
});

test('scenario sweep: queued next map blocks a new vote until the live map actually rotates', async () => {
    const service = createPollingService();
    let startVoteCalls = 0;
    const snapshots = [
        {
            currentMapId: 'hill400_warfare',
            currentPlayers: 97,
            gameActive: true,
            matchStartEpochSeconds: 5000
        },
        {
            currentMapId: 'hill400_warfare',
            currentPlayers: 97,
            gameActive: true,
            matchStartEpochSeconds: 5000
        },
        {
            currentMapId: 'carentan_warfare',
            currentPlayers: 97,
            gameActive: true,
            matchStartEpochSeconds: 6000
        },
        {
            currentMapId: 'carentan_warfare',
            currentPlayers: 97,
            gameActive: true,
            matchStartEpochSeconds: 6000
        }
    ];

    service.queuedNextMapId = 'carentan_warfare';
    service.lastObservedMatchMapId = 'hill400_warfare';
    service.crcon = {
        getMatchSnapshot: async () => snapshots.shift(),
        getStatus: async () => ({
            result: {
                current_players: 97,
                current_map: {
                    id: 'carentan_warfare',
                    pretty_name: 'Carentan Warfare'
                }
            }
        })
    };
    service.checkActiveVote = async () => false;
    service.startVote = async () => {
        startVoteCalls += 1;
        service.voteActive = true;
    };

    await service.doMapVote();
    assert.equal(startVoteCalls, 0);
    assert.equal(service.gameActive, false);
    assert.equal(service.queuedNextMapId, 'carentan_warfare');

    await service.doMapVote();
    assert.equal(startVoteCalls, 0);
    assert.equal(service.gameActive, false);
    assert.equal(service.queuedNextMapId, 'carentan_warfare');

    await service.doMapVote();
    assert.equal(startVoteCalls, 0);
    assert.equal(service.gameActive, false);
    assert.equal(service.queuedNextMapId, null);

    await service.doMapVote();
    assert.equal(startVoteCalls, 1);
    assert.equal(service.gameActive, true);
    assert.equal(service.queuedNextMapId, null);
});
