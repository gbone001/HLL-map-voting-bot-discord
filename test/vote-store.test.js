const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadFreshVoteStore(tempDataDir) {
    const voteStorePath = require.resolve('../src/services/voteStore');
    const dataPathPath = require.resolve('../src/utils/dataPath');

    delete require.cache[voteStorePath];
    delete require.cache[dataPathPath];

    process.env.DATA_DIR = tempDataDir;
    return require('../src/services/voteStore');
}

test('vote store cleanup ignores state entries and malformed null values', () => {
    const previousDataDir = process.env.DATA_DIR;
    const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vote-store-cleanup-'));

    try {
        const votesPath = path.join(tempDataDir, 'votes.json');
        const now = Date.now();
        const oldTimestamp = now - (25 * 60 * 60 * 1000);

        fs.writeFileSync(votesPath, JSON.stringify({
            _state_voteMapActive_1: true,
            _state_pendingQueuedMap_1: null,
            '1_123': {
                messageId: 'old-vote',
                createdAt: oldTimestamp
            },
            '1_456': {
                messageId: 'current-vote',
                createdAt: now
            }
        }, null, 2));

        const voteStore = loadFreshVoteStore(tempDataDir);

        assert.doesNotThrow(() => voteStore.cleanup());

        const savedVotes = JSON.parse(fs.readFileSync(votesPath, 'utf8'));
        assert.equal(savedVotes._state_voteMapActive_1, true);
        assert.equal(savedVotes._state_pendingQueuedMap_1, null);
        assert.equal(savedVotes['1_123'], undefined);
        assert.equal(savedVotes['1_456'].messageId, 'current-vote');
    } finally {
        delete require.cache[require.resolve('../src/services/voteStore')];
        delete require.cache[require.resolve('../src/utils/dataPath')];

        if (previousDataDir === undefined) {
            delete process.env.DATA_DIR;
        } else {
            process.env.DATA_DIR = previousDataDir;
        }
    }
});
