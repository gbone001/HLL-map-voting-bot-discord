const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function requireFresh(modulePath) {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
}

test('catalog sync persists offensive and skirmish entries in the runtime map file', () => {
    const previousDataDir = process.env.DATA_DIR;
    const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hll-map-catalog-'));
    process.env.DATA_DIR = tempDataDir;

    try {
        requireFresh('../src/utils/dataPath');
        const { HllMapCatalogService } = requireFresh('../src/services/hllMapCatalog');
        const catalogService = new HllMapCatalogService();

        const syncStatus = catalogService.syncFromCrconMaps([
            {
                id: 'carentan_warfare',
                game_mode: 'warfare',
                environment: 'day',
                pretty_name: 'Carentan Warfare',
                map: { name: 'Carentan' }
            },
            {
                id: 'stmereeglise_offensive_us',
                game_mode: 'offensive',
                environment: 'night',
                pretty_name: 'St. Mere Eglise Offensive (US Night)',
                map: { name: 'St. Mere Eglise' }
            },
            {
                id: 'mortain_skirmish_overcast',
                game_mode: 'skirmish',
                environment: 'overcast',
                pretty_name: 'Mortain Skirmish (Overcast)',
                map: { name: 'Mortain' }
            }
        ]);

        const syncedMaps = catalogService.getMaps();
        const syncedMapIds = syncedMaps.map((map) => map.id);

        assert.equal(syncStatus.hasRuntimeCatalog, true);
        assert.equal(syncStatus.source, 'runtime');
        assert.equal(syncStatus.entryCount, 3);
        assert.deepEqual(syncedMapIds, [
            'carentan_warfare',
            'mortain_skirmish_overcast',
            'stmereeglise_offensive_us'
        ]);
        assert.equal(
            syncedMaps.find((map) => map.id === 'stmereeglise_offensive_us')?.game_mode,
            'offensive'
        );
        assert.equal(
            syncedMaps.find((map) => map.id === 'mortain_skirmish_overcast')?.game_mode,
            'skirmish'
        );
        assert.deepEqual(
            syncedMaps.find((map) => map.id === 'stmereeglise_offensive_us'),
            {
                id: 'stmereeglise_offensive_us',
                pretty_name: 'St. Mere Eglise Offensive (US Night)',
                game_mode: 'offensive',
                environment: 'night',
                map_name: 'St. Mere Eglise',
                mode: 'offensive',
                variant: 'Allies (Night)',
                vote_label: 'St. Mere Eglise | Offensive | Allies (Night)',
                weight: null,
                seeding: null,
                stress: null,
                map: {
                    id: 'stmereeglise_offensive_us',
                    name: 'St. Mere Eglise',
                    pretty_name: 'St. Mere Eglise Offensive (US Night)'
                }
            }
        );
        assert.equal(fs.existsSync(catalogService.runtimeCatalogPath), true);
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.DATA_DIR;
        } else {
            process.env.DATA_DIR = previousDataDir;
        }
    }
});

test('map vote settings panel shows local catalog status and manual sync button', () => {
    const { MapVotePanelService } = require('../src/services/mapVotePanel');
    const panelService = new MapVotePanelService();
    const fakeMapVotingService = {
        getConfig() {
            return {
                minimumPlayers: 25,
                deactivatePlayers: 10,
                mapsPerVote: 6,
                nightMapCount: 1,
                modeWeights: {
                    warfare: 5,
                    offensive: 2,
                    skirmish: 1
                },
                nonSeededMapListCount: 12
            };
        }
    };

    const panel = panelService.buildSettingsPanel(
        fakeMapVotingService,
        {
            teamSwitchCooldown: 10,
            idleAutokickTime: 15,
            maxPingAutokick: 250
        },
        {
            source: 'runtime',
            entryCount: 42,
            syncedAt: '2026-04-20T00:00:00.000Z'
        }
    );

    const fieldNames = panel.embeds[0].data.fields.map((field) => field.name);
    const thirdRowLabels = panel.components[2].components.map((component) => component.data.label);

    assert.ok(fieldNames.includes('🗂️ Local Map Catalog'));
    assert.deepEqual(thirdRowLabels, ['Sync Maps From CRCON', 'Load Pool Rotation', 'Back to Main']);
    assert.match(panel.embeds[0].data.description, /master map list/i);
  });

test('bundled catalog exposes structured voting metadata for weighted entries', () => {
    const previousDataDir = process.env.DATA_DIR;
    const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hll-map-catalog-bundled-'));
    process.env.DATA_DIR = tempDataDir;

    try {
        requireFresh('../src/utils/dataPath');
        const { hllMapCatalog } = requireFresh('../src/services/hllMapCatalog');

        const bundledMap = hllMapCatalog.getMaps().find((map) => map.id === 'stmariedumont_warfare');

        assert.deepEqual(bundledMap, {
            id: 'stmariedumont_warfare',
            pretty_name: 'St. Marie Du Mont Warfare',
            game_mode: 'warfare',
            environment: 'day',
            map_name: 'St. Marie Du Mont',
            mode: 'warfare',
            variant: 'Day',
            vote_label: 'St. Marie Du Mont | Warfare | Day',
            weight: 90,
            seeding: true,
            stress: null,
            map: {
                id: 'stmariedumont_warfare',
                name: 'St. Marie Du Mont',
                pretty_name: 'St. Marie Du Mont Warfare'
            }
        });
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.DATA_DIR;
        } else {
            process.env.DATA_DIR = previousDataDir;
        }
    }
});
