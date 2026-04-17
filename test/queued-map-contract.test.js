const test = require('node:test');
const assert = require('node:assert/strict');

const { MapVotingService } = require('../src/services/mapVoting');
const queuedMapStore = require('../src/services/queuedMapStore');
const { CRCONService, TRANSPORT_MODES } = require('../src/services/crcon');

function buildSnapshot(overrides = {}) {
    return {
        currentMapId: 'foy_warfare',
        nextMapId: 'utahbeach_warfare',
        currentPlayers: 95,
        gameActive: true,
        matchStartEpochSeconds: 1000,
        ...overrides
    };
}

async function clearServer(serverNum) {
    queuedMapStore.clearQueuedMap(serverNum);
}

test('queued map contract reapplies the voted winner when live next map drifts before match start', async () => {
    const serverNum = 91;
    await clearServer(serverNum);

    const service = new MapVotingService(serverNum);
    service.lastObservedMatchMapId = 'foy_warfare';
    service.lastObservedMatchStartEpochSeconds = 1000;

    const liveState = buildSnapshot({
        currentMapId: 'foy_warfare',
        nextMapId: 'stmariedumont_warfare',
        matchStartEpochSeconds: 1000
    });

    let queueCalls = 0;
    service.crcon = {
        getMatchSnapshot: async () => ({ ...liveState }),
        getPublicInfoState: async () => ({ ...liveState }),
        queueNextMap: async (mapId) => {
            queueCalls += 1;
            liveState.nextMapId = mapId;
        }
    };

    queuedMapStore.upsertQueuedMap(serverNum, {
        desiredMapId: 'omahabeach_warfare',
        source: 'seeded-vote',
        gameStart: 1000,
        voteMessageId: 'vote-91'
    });

    const gameActive = await service.getGameState();
    const pendingEntry = queuedMapStore.getQueuedMap(serverNum);

    assert.equal(gameActive, false);
    assert.equal(queueCalls, 1);
    assert.equal(pendingEntry.desiredMapId, 'omahabeach_warfare');
    assert.equal(pendingEntry.lastObservedNextMapId, 'omahabeach_warfare');

    await clearServer(serverNum);
});

test('queued map contract survives restart until the voted winner actually becomes live', async () => {
    const serverNum = 92;
    await clearServer(serverNum);

    const service = new MapVotingService(serverNum);

    const liveState = buildSnapshot({
        currentMapId: 'foy_warfare',
        nextMapId: 'carentan_warfare',
        matchStartEpochSeconds: 2000
    });

    service.crcon = {
        getMatchSnapshot: async () => ({ ...liveState }),
        getPublicInfoState: async () => ({ ...liveState }),
        queueNextMap: async () => {}
    };

    queuedMapStore.upsertQueuedMap(serverNum, {
        desiredMapId: 'carentan_warfare',
        source: 'seeded-vote',
        gameStart: 2000,
        voteMessageId: 'vote-92'
    });

    const beforeTransition = await service.getGameState();
    assert.equal(beforeTransition, false);
    assert.equal(service.queuedNextMapId, 'carentan_warfare');

    liveState.currentMapId = 'carentan_warfare';
    liveState.nextMapId = 'utahbeach_warfare';
    liveState.matchStartEpochSeconds = 3000;

    const transitionTick = await service.getGameState();
    assert.equal(transitionTick, false);
    assert.equal(queuedMapStore.getQueuedMap(serverNum), null);

    const afterTransition = await service.getGameState();
    assert.equal(afterTransition, true);
    assert.equal(service.queuedNextMapId, null);

    await clearServer(serverNum);
});

test('queued map contract records a failure when the wrong map starts instead of the voted winner', async () => {
    const serverNum = 93;
    await clearServer(serverNum);

    const service = new MapVotingService(serverNum);
    service.lastObservedMatchMapId = 'foy_warfare';
    service.lastObservedMatchStartEpochSeconds = 4000;

    const liveState = buildSnapshot({
        currentMapId: 'stmariedumont_warfare',
        nextMapId: 'utahbeach_warfare',
        matchStartEpochSeconds: 5000
    });

    service.crcon = {
        getMatchSnapshot: async () => ({ ...liveState }),
        getPublicInfoState: async () => ({ ...liveState }),
        queueNextMap: async () => {}
    };

    queuedMapStore.upsertQueuedMap(serverNum, {
        desiredMapId: 'omahabeach_warfare',
        source: 'seeded-vote',
        gameStart: 4000,
        voteMessageId: 'vote-93'
    });

    const gameActive = await service.getGameState();
    const lastEntry = queuedMapStore.getLastEntry(serverNum);

    assert.equal(gameActive, false);
    assert.equal(queuedMapStore.getQueuedMap(serverNum), null);
    assert.equal(lastEntry.state, 'failed');
    assert.equal(lastEntry.failureReason, 'wrong_map_started');
    assert.equal(lastEntry.actualMapId, 'stmariedumont_warfare');

    await clearServer(serverNum);
});

test('queued map contract verifies a direct-RCON queued winner through sequence state', async () => {
    const serverNum = 94;
    await clearServer(serverNum);

    const crcon = new CRCONService({
        serverName: 'Direct Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        rconHost: '127.0.0.1',
        rconPort: 27015,
        rconPassword: 'secret'
    });

    const liveSequence = [
        { MapName: 'Utah Beach', MapId: 'utahbeach_warfare', position: 0 },
        { MapName: 'Foy', MapId: 'foy_warfare', position: 9 },
        { MapName: 'Omaha Beach', MapId: 'omahabeach_warfare', position: 10 },
        { MapName: 'Kharkov', MapId: 'kharkov_warfare', position: 11 }
    ];

    crcon.hasDirectRconConfigured = () => true;
    crcon.executeDirectCommand = async (command, payload) => {
        if (command !== 'GetServerInformation' && command !== 'MoveMapInSequence' && command !== 'AddMapToSequence') {
            throw new Error(`Unexpected command ${command}`);
        }

        if (command === 'GetServerInformation' && payload?.Name === 'session') {
            return {
                result: {
                    playerCount: 95,
                    MapName: 'Omaha Beach',
                    CurrentMapName: 'Omaha Beach'
                }
            };
        }

        if (command === 'GetServerInformation' && payload?.Name === 'mapsequence') {
            return {
                result: {
                    currentIndex: 10,
                    MapSequence: liveSequence.map((entry) => ({ ...entry }))
                }
            };
        }

        if (command === 'AddMapToSequence') {
            for (const entry of liveSequence) {
                if (entry.position >= payload.Index) {
                    entry.position += 1;
                }
            }
            liveSequence.push({
                MapName: payload.MapName,
                MapId: payload.MapName,
                position: payload.Index
            });
            return { result: { ok: true } };
        }

        if (command === 'MoveMapInSequence') {
            const entry = liveSequence.find((item) => item.position === payload.CurrentIndex);
            if (entry) {
                for (const item of liveSequence) {
                    if (item === entry) {
                        continue;
                    }

                    if (payload.NewIndex > payload.CurrentIndex &&
                        item.position > payload.CurrentIndex &&
                        item.position <= payload.NewIndex) {
                        item.position -= 1;
                    } else if (payload.NewIndex < payload.CurrentIndex &&
                        item.position >= payload.NewIndex &&
                        item.position < payload.CurrentIndex) {
                        item.position += 1;
                    }
                }
                entry.position = payload.NewIndex;
            }
            return { result: { ok: true } };
        }

        throw new Error(`Unexpected payload ${JSON.stringify(payload)}`);
    };

    const service = new MapVotingService(serverNum);
    service.crcon = crcon;
    service.gameStart = 6000;
    service.voteMessageId = 'vote-94';

    const result = await service.ensureDesiredNextMap('stmariedumont_warfare', 'seeded-vote');
    const pendingEntry = queuedMapStore.getQueuedMap(serverNum);

    assert.equal(result.queued, true);
    assert.equal(result.consumed, false);
    assert.equal(result.liveState.nextMapId, 'stmariedumont_warfare');
    assert.equal(pendingEntry.desiredMapId, 'stmariedumont_warfare');
    assert.equal(pendingEntry.lastObservedNextMapId, 'stmariedumont_warfare');
    assert.ok(pendingEntry.lastVerifiedAt);

    await clearServer(serverNum);
});
