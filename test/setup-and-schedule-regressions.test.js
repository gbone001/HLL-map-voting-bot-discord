const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const setupWizard = require('../src/services/setupWizard');
const configManager = require('../src/services/configManager');
const scheduleManager = require('../src/services/scheduleManager');
const { MapVotingService } = require('../src/services/mapVoting');
const schedulePanel = require('../src/services/schedulePanel');
const { TRANSPORT_MODES } = require('../src/services/crcon');
const logger = require('../src/utils/logger');

function createServerModalInteraction({
    customId = `setup_modal_server_1__${TRANSPORT_MODES.API_WITH_FALLBACK}`,
    serverName = 'Test Server',
    crconUrl = 'https://crcon.example',
    crconToken = 'token',
    channelId = '1234567890'
} = {}) {
    const values = {
        server_name: serverName,
        crcon_url: crconUrl,
        crcon_token: crconToken,
        channel_id: channelId
    };

    return {
        customId,
        fields: {
            getTextInputValue(fieldId) {
                return values[fieldId] || '';
            }
        }
    };
}

function createRconModalInteraction({
    customId = 'setup_modal_rcon_1',
    rconHost = '127.0.0.1',
    rconPort = '27015',
    rconPassword = 'secret'
} = {}) {
    const values = {
        rcon_host: rconHost,
        rcon_port: rconPort,
        rcon_password: rconPassword
    };

    return {
        customId,
        fields: {
            getTextInputValue(fieldId) {
                return values[fieldId] || '';
            }
        }
    };
}

test('desktop entrypoint uses object-based CRCONService construction', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index-AMD-desktop.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /new CRCONService\(config\)/);
});

test('setup wizard saves incomplete fallback server and instructs admin to add RCON details', async () => {
    const originalGetServerConfig = configManager.getServerConfig;
    const originalSetServerConfig = configManager.setServerConfig;
    const originalTestConnection = setupWizard.testConnection;
    let savedConfig = null;

    configManager.getServerConfig = () => null;
    configManager.setServerConfig = (serverNum, config) => {
        savedConfig = { serverNum, config };
        return true;
    };
    setupWizard.testConnection = async () => {
        throw new Error('testConnection should not run before RCON details exist');
    };

    try {
        const result = await setupWizard.saveServerFromModal(
            createServerModalInteraction({
                customId: `setup_modal_server_1__${TRANSPORT_MODES.API_WITH_FALLBACK}`
            })
        );

        assert.equal(result.success, true);
        assert.match(result.message, /direct RCON details are still required/i);
        assert.match(result.message, /Edit RCON/i);
        assert.deepEqual(savedConfig, {
            serverNum: '1',
            config: {
                serverName: 'Test Server',
                transportMode: TRANSPORT_MODES.API_WITH_FALLBACK,
                crconUrl: 'https://crcon.example',
                crconToken: 'token',
                channelId: '1234567890'
            }
        });
    } finally {
        configManager.getServerConfig = originalGetServerConfig;
        configManager.setServerConfig = originalSetServerConfig;
        setupWizard.testConnection = originalTestConnection;
    }
});

test('setup wizard reports config save failure instead of claiming success', async () => {
    const originalGetServerConfig = configManager.getServerConfig;
    const originalSetServerConfig = configManager.setServerConfig;
    const originalTestConnection = setupWizard.testConnection;

    configManager.getServerConfig = () => null;
    configManager.setServerConfig = () => false;
    setupWizard.testConnection = async () => ({
        success: true,
        api: { success: true },
        rcon: null
    });

    try {
        const result = await setupWizard.saveServerFromModal(
            createServerModalInteraction({
                customId: `setup_modal_server_1__${TRANSPORT_MODES.API_ONLY}`
            })
        );

        assert.equal(result.success, false);
        assert.match(result.message, /Failed to save server configuration/i);
    } finally {
        configManager.getServerConfig = originalGetServerConfig;
        configManager.setServerConfig = originalSetServerConfig;
        setupWizard.testConnection = originalTestConnection;
    }
});

test('setup wizard reports RCON save failure instead of claiming success', async () => {
    const originalGetServerConfig = configManager.getServerConfig;
    const originalSetServerConfig = configManager.setServerConfig;
    const originalTestDirectRconConnection = setupWizard.testDirectRconConnection;

    configManager.getServerConfig = () => ({
        serverName: 'Test Server',
        transportMode: TRANSPORT_MODES.DIRECT_RCON,
        channelId: '1234567890'
    });
    configManager.setServerConfig = () => false;
    setupWizard.testDirectRconConnection = async () => ({ success: true });

    try {
        const result = await setupWizard.saveRconFromModal(createRconModalInteraction());

        assert.equal(result.success, false);
        assert.match(result.message, /Failed to save RCON settings/i);
    } finally {
        configManager.getServerConfig = originalGetServerConfig;
        configManager.setServerConfig = originalSetServerConfig;
        setupWizard.testDirectRconConnection = originalTestDirectRconConnection;
    }
});

test('schedule display formatting does not mutate stored day arrays', () => {
    const originalData = scheduleManager.data;
    scheduleManager.data = {
        servers: {
            1: {
                timezone: 'UTC',
                schedules: [],
                defaultSchedule: null,
                activeOverride: null
            }
        }
    };

    try {
        const schedule = {
            name: 'Weekday Rotation',
            startTime: '18:00',
            endTime: '22:00',
            days: ['wed', 'mon', 'fri', 'thu', 'tue'],
            whitelist: null,
            settings: {}
        };
        const originalDays = [...schedule.days];

        const display = scheduleManager.formatScheduleDisplay(schedule, 1);

        assert.equal(display.days, 'Weekdays');
        assert.deepEqual(schedule.days, originalDays);
    } finally {
        scheduleManager.data = originalData;
    }
});

test('overnight schedules remain active after midnight for the previous scheduled day', () => {
    const originalData = scheduleManager.data;
    const originalGetCurrentTime = scheduleManager.getCurrentTime;

    scheduleManager.data = {
        servers: {
            1: {
                timezone: 'UTC',
                schedules: [
                    {
                        id: 'sched-mon-late',
                        name: 'Monday Late Night',
                        startTime: '22:00',
                        endTime: '06:00',
                        days: ['mon'],
                        enabled: true,
                        settings: { minimumPlayers: 25, mapsPerVote: 4, nightMapCount: 1 },
                        whitelist: null,
                        generalSettings: {},
                        automodConfigs: {},
                        automodProfiles: {}
                    }
                ],
                defaultSchedule: null,
                activeOverride: null
            }
        }
    };

    scheduleManager.getCurrentTime = () => ({
        time: '01:30',
        day: 'tue',
        timezone: 'UTC'
    });

    try {
        const activeSchedule = scheduleManager.getActiveSchedule(1);
        assert.equal(activeSchedule.id, 'sched-mon-late');
        assert.equal(activeSchedule.name, 'Monday Late Night');
    } finally {
        scheduleManager.data = originalData;
        scheduleManager.getCurrentTime = originalGetCurrentTime;
    }
});

test('day selection panel exposes seven explicit day options while keeping presets', () => {
    const originalData = scheduleManager.data;
    scheduleManager.data = {
        servers: {
            1: {
                timezone: 'UTC',
                schedules: [
                    {
                        id: 'sched-custom-days',
                        name: 'Custom Days',
                        startTime: '18:00',
                        endTime: '23:00',
                        days: ['mon', 'wed', 'fri'],
                        enabled: true,
                        settings: { minimumPlayers: 25, mapsPerVote: 4, nightMapCount: 1 },
                        whitelist: null,
                        generalSettings: {},
                        automodConfigs: {},
                        automodProfiles: {}
                    }
                ],
                defaultSchedule: null,
                activeOverride: null
            }
        }
    };

    try {
        const panel = schedulePanel.buildDaySelectPanel(1, 'sched-custom-days');

        assert.equal(panel.components.length, 3);
        assert.equal(panel.components[0].components.length, 3);
        assert.equal(panel.components[0].components[0].data.label, 'All Days');
        assert.equal(panel.components[0].components[1].data.label, 'Weekdays');
        assert.equal(panel.components[0].components[2].data.label, 'Weekend');

        const selectMenu = panel.components[1].components[0];
        const optionValues = selectMenu.options.map(option => option.data.value);
        const selectedValues = selectMenu.options
            .filter(option => option.data.default === true)
            .map(option => option.data.value);

        assert.deepEqual(optionValues, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
        assert.deepEqual(selectedValues, ['mon', 'wed', 'fri']);
    } finally {
        scheduleManager.data = originalData;
    }
});

test('index entrypoint handles schedule day multi-select interactions', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /schedule_days_select_/);
    assert.match(fileContent, /Schedule days updated:/);
    assert.match(fileContent, /Failed to save schedule days:/);
});

test('index entrypoint validates schedule day preset updates before reporting success', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /const updateResult = scheduleManager\.updateSchedule\(srvNum, scheduleId, \{ days \}\);/);
    assert.match(fileContent, /if \(!updateResult\.success\) \{\s*return replyEphemeralAutoDelete\(interaction, `Failed to save schedule days: \$\{updateResult\.error\}`\);/);
});

test('index entrypoint validates schedule day multi-select updates before reporting success', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /const updateResult = scheduleManager\.updateSchedule\(srvNum, scheduleId, \{ days: selectedDays \}\);/);
    assert.match(fileContent, /if \(!updateResult\.success\) \{\s*return replyEphemeralAutoDelete\(interaction, `Failed to save schedule days: \$\{updateResult\.error\}`\);/);
});

test('schedule automod application warns instead of erroring for unsupported direct RCON actions', async () => {
    const service = new MapVotingService(1);
    const originalWarn = logger.warn;
    const originalError = logger.error;
    const warnMessages = [];
    const errorMessages = [];
    const unsupportedError = new Error('Direct RCON does not support set_auto_mod_no_leader_config for Test Server');
    unsupportedError.code = 'UNSUPPORTED_TRANSPORT';

    service.crcon = {
        setAutoModNoLeaderConfig: async () => {
            throw unsupportedError;
        },
        setAutoModLevelConfig: async () => {
            throw new Error('level setter should not be called');
        },
        setAutoModSoloTankConfig: async () => {
            throw new Error('solo tank setter should not be called');
        }
    };

    logger.warn = (message) => {
        warnMessages.push(message);
    };
    logger.error = (message) => {
        errorMessages.push(message);
    };

    try {
        await service.applyScheduleAutomods({
            scheduleName: 'Off Peak Weekday',
            automodConfigs: {
                no_leader: { enabled: true }
            },
            automodProfiles: {}
        });

        assert.equal(errorMessages.length, 0);
        assert.equal(warnMessages.length, 1);
        assert.match(warnMessages[0], /Skipping no_leader schedule config/i);
        assert.match(warnMessages[0], /Direct RCON does not support set_auto_mod_no_leader_config/i);
    } finally {
        logger.warn = originalWarn;
        logger.error = originalError;
    }
});
