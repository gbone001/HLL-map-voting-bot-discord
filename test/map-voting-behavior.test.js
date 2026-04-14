const test = require('node:test');
const assert = require('node:assert/strict');
const { MapVotingService } = require('../src/services/mapVoting');

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
