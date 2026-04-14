const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const configManager = require('../src/services/configManager');
const automodPresetManager = require('../src/services/automodPresetManager');

test('desktop entrypoint routes setup_add_server through transport selection', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index-AMD-desktop.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /setup_buildTransportModeSelectPanel|buildTransportModeSelectPanel\('add', nextNum\)/);
    assert.doesNotMatch(
        fileContent,
        /if \(customId === 'setup_add_server'\)[\s\S]{0,400}buildServerModal\(\)/
    );
});

test('desktop entrypoint handles setup_edit_rcon button', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index-AMD-desktop.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /else if \(customId === 'setup_edit_rcon'\)/);
    assert.match(fileContent, /buildServerSelectMenu\('rcon'\)/);
});

test('desktop entrypoint handles setup_modal_rcon submissions', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index-AMD-desktop.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /if \(customId\.startsWith\('setup_modal_rcon_'\)\)/);
    assert.match(fileContent, /saveRconFromModal\(interaction\)/);
});

test('configManager rolls back in-memory server config when save fails', () => {
    const originalConfig = JSON.parse(JSON.stringify(configManager.config));
    const originalSaveConfig = configManager.saveConfig;

    configManager.config = {
        setupComplete: false,
        adminRoleId: null,
        servers: {
            1: {
                serverName: 'Original Server',
                channelId: '100'
            }
        }
    };
    configManager.saveConfig = () => false;

    try {
        const result = configManager.setServerConfig(1, {
            serverName: 'Mutated Server',
            channelId: '200'
        });

        assert.equal(result, false);
        assert.deepEqual(configManager.config, {
            setupComplete: false,
            adminRoleId: null,
            servers: {
                1: {
                    serverName: 'Original Server',
                    channelId: '100'
                }
            }
        });
    } finally {
        configManager.config = originalConfig;
        configManager.saveConfig = originalSaveConfig;
    }
});

test('configManager removes newly added server from memory when save fails', () => {
    const originalConfig = JSON.parse(JSON.stringify(configManager.config));
    const originalSaveConfig = configManager.saveConfig;

    configManager.config = {
        setupComplete: false,
        adminRoleId: null,
        servers: {}
    };
    configManager.saveConfig = () => false;

    try {
        const result = configManager.setServerConfig(2, {
            serverName: 'New Server',
            channelId: '200'
        });

        assert.equal(result, false);
        assert.deepEqual(configManager.config, {
            setupComplete: false,
            adminRoleId: null,
            servers: {}
        });
    } finally {
        configManager.config = originalConfig;
        configManager.saveConfig = originalSaveConfig;
    }
});

test('automodPresetManager rolls back preset and reports failure when save fails', () => {
    const originalData = JSON.parse(JSON.stringify(automodPresetManager.data));
    const originalSaveData = automodPresetManager.saveData;

    automodPresetManager.data = { servers: {} };
    automodPresetManager.saveData = () => false;

    try {
        const result = automodPresetManager.createPreset(1, 'level', 'Test Preset', { enabled: true });

        assert.equal(result.success, false);
        assert.match(result.error, /Failed to save preset data/i);
        assert.deepEqual(automodPresetManager.data, {
            servers: {
                '1': {
                    level: [],
                    no_leader: [],
                    solo_tank: []
                }
            }
        });
    } finally {
        automodPresetManager.data = originalData;
        automodPresetManager.saveData = originalSaveData;
    }
});
