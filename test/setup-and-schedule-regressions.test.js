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

test('schedule manager normalizes legacy schedule records into the current shape', () => {
    const normalized = scheduleManager.normalizeData({
        servers: {
            1: {
                timezone: '',
                schedules: [
                    {
                        id: '',
                        name: '',
                        startTime: '',
                        endTime: '',
                        days: ['fri', 'bogus', 'mon', 'all'],
                        priority: '999',
                        enabled: undefined,
                        settings: { minimumPlayers: 30 },
                        whitelist: ['utahbeach_warfare', '', 'utahbeach_warfare', null],
                        generalSettings: null,
                        automodConfigs: {},
                        automodProfiles: null
                    }
                ],
                defaultSchedule: null,
                activeOverride: null
            }
        }
    });

    const serverConfig = normalized.data.servers['1'];
    const schedule = serverConfig.schedules[0];

    assert.equal(normalized.changed, true);
    assert.equal(serverConfig.timezone, 'America/New_York');
    assert.equal(schedule.name, 'Unnamed Schedule');
    assert.equal(schedule.startTime, '00:00');
    assert.equal(schedule.endTime, '23:59');
    assert.deepEqual(schedule.days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    assert.equal(schedule.priority, 100);
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.settings.minimumPlayers, 30);
    assert.equal(schedule.settings.deactivatePlayers, 10);
    assert.deepEqual(schedule.whitelist, ['utahbeach_warfare']);
    assert.deepEqual(schedule.generalSettings, {
        teamSwitchCooldown: null,
        idleAutokickTime: null,
        maxPingAutokick: null,
        mapVoteCooldownVotes: null
    });
    assert.deepEqual(schedule.automodProfiles, {
        level: null,
        no_leader: null,
        solo_tank: null
    });
});

test('initServer normalizes existing server schedule data before returning it', () => {
    const originalData = scheduleManager.data;
    const originalSaveData = scheduleManager.saveData;

    scheduleManager.data = {
        servers: {
            1: {
                timezone: 'UTC',
                schedules: [
                    {
                        id: 'legacy-schedule',
                        name: 'Legacy',
                        startTime: '18:00',
                        endTime: '23:00',
                        days: ['sun', 'foo', 'tue'],
                        priority: -5,
                        enabled: true,
                        settings: {},
                        whitelist: 'not-an-array'
                    }
                ],
                defaultSchedule: null,
                activeOverride: null
            }
        }
    };
    scheduleManager.saveData = () => true;

    try {
        const serverConfig = scheduleManager.initServer(1);
        assert.deepEqual(serverConfig.schedules[0].days, ['tue', 'sun']);
        assert.equal(serverConfig.schedules[0].priority, 0);
        assert.equal(serverConfig.schedules[0].whitelist, null);
        assert.deepEqual(serverConfig.schedules[0].automodConfigs, {
            level: null,
            no_leader: null,
            solo_tank: null
        });
    } finally {
        scheduleManager.data = originalData;
        scheduleManager.saveData = originalSaveData;
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

test('higher schedule priority wins when multiple schedules overlap', () => {
    const originalData = scheduleManager.data;
    const originalGetCurrentTime = scheduleManager.getCurrentTime;

    scheduleManager.data = {
        servers: {
            1: {
                timezone: 'UTC',
                schedules: [
                    {
                        id: 'sched-low-priority',
                        name: 'Lower Priority',
                        startTime: '18:00',
                        endTime: '23:00',
                        days: ['mon'],
                        priority: 10,
                        enabled: true,
                        createdAt: '2026-04-01T00:00:00.000Z',
                        settings: {},
                        whitelist: null,
                        generalSettings: {},
                        automodConfigs: {},
                        automodProfiles: {}
                    },
                    {
                        id: 'sched-high-priority',
                        name: 'Higher Priority',
                        startTime: '18:00',
                        endTime: '23:00',
                        days: ['mon'],
                        priority: 80,
                        enabled: true,
                        createdAt: '2026-03-01T00:00:00.000Z',
                        settings: {},
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
        time: '19:30',
        day: 'mon',
        timezone: 'UTC'
    });

    try {
        const activeSchedule = scheduleManager.getActiveSchedule(1);
        assert.equal(activeSchedule.id, 'sched-high-priority');
        assert.equal(activeSchedule.name, 'Higher Priority');
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

test('main schedule panel exposes the new top-row schedule actions', () => {
    const originalData = scheduleManager.data;
    const originalGetCurrentTime = scheduleManager.getCurrentTime;
    scheduleManager.data = {
        servers: {
            1: {
                timezone: 'UTC',
                schedules: [
                    {
                        id: 'sched-edit-days',
                        name: 'Edit Days Schedule',
                        startTime: '18:00',
                        endTime: '23:00',
                        days: ['mon', 'wed'],
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
    scheduleManager.getCurrentTime = () => ({ time: '18:30', day: 'mon', timezone: 'UTC' });

    try {
        const panel = schedulePanel.buildSchedulePanel(1, 'Test Server');
        const firstRowLabels = panel.components[0].components.map(component => component.data.label);
        const description = panel.embeds[0].data.description;

        assert.deepEqual(firstRowLabels, ['Edit/Create Schedule', 'Assign Map Pools', 'Assign Server Rules', 'Delete']);
        assert.match(description, /one guided workflow/i);
    } finally {
        scheduleManager.data = originalData;
        scheduleManager.getCurrentTime = originalGetCurrentTime;
    }
});

test('main schedule panel exposes schedule priority controls and display', () => {
    const originalData = scheduleManager.data;
    const originalGetCurrentTime = scheduleManager.getCurrentTime;
    scheduleManager.data = {
        servers: {
            1: {
                timezone: 'UTC',
                schedules: [
                    {
                        id: 'sched-priority',
                        name: 'Priority Schedule',
                        startTime: '18:00',
                        endTime: '23:00',
                        days: ['mon', 'wed'],
                        priority: 55,
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
    scheduleManager.getCurrentTime = () => ({ time: '18:30', day: 'mon', timezone: 'UTC' });

    try {
        const panel = schedulePanel.buildSchedulePanel(1, 'Test Server');
        const secondRowLabels = panel.components[1].components.map(component => component.data.label);
        const thirdRowLabels = panel.components[2].components.map(component => component.data.label);
        const scheduleField = panel.embeds[0].data.fields.find(field => field.name.includes('Schedules'));

        assert.deepEqual(secondRowLabels, ['General Settings', 'Priority', 'Set Timezone']);
        assert.deepEqual(thirdRowLabels, ['Override', 'Clear Override', 'Back']);
        assert.match(scheduleField.value, /Priority: 55/);
    } finally {
        scheduleManager.data = originalData;
        scheduleManager.getCurrentTime = originalGetCurrentTime;
    }
});

test('schedule editor selector includes existing schedules and a create-new option', () => {
    const originalData = scheduleManager.data;
    scheduleManager.data = {
        servers: {
            1: {
                timezone: 'UTC',
                schedules: [
                    {
                        id: 'sched-existing',
                        name: 'Existing Schedule',
                        startTime: '18:00',
                        endTime: '23:00',
                        days: ['mon', 'tue'],
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
        const panel = schedulePanel.buildScheduleEditorSelectPanel(1);
        const options = panel.components[0].components[0].options.map(option => option.data);

        assert.equal(options[0].label, 'Existing Schedule');
        assert.equal(options[options.length - 1].label, 'Create New Schedule');
        assert.equal(options[options.length - 1].value, '__create_new_schedule__');
    } finally {
        scheduleManager.data = originalData;
    }
});

test('schedule editor panel keeps name, days, and time in one workflow', () => {
    const draft = schedulePanel.startScheduleEditor(1, 'user-1');

    try {
        const panel = schedulePanel.buildScheduleEditorPanel(1, 'user-1');
        const rowOneLabels = panel.components[0].components.map(component => component.data.label);
        const rowFourLabels = panel.components[3].components.map(component => component.data.label);

        assert.equal(draft.isNew, true);
        assert.deepEqual(rowOneLabels, ['Edit Name', 'Edit Time', 'Edit Vote Settings']);
        assert.deepEqual(rowFourLabels, ['Create Schedule', 'Cancel']);
        assert.match(panel.embeds[0].data.description, /\*\*Name:\*\* New Schedule/);
        assert.match(panel.embeds[0].data.description, /\*\*Days:\*\* All Days/);
        assert.match(panel.embeds[0].data.description, /\*\*Time Range:\*\* 18:00 - 23:00/);
    } finally {
        schedulePanel.clearScheduleEditorDraft(1, 'user-1');
    }
});

test('index entrypoint handles schedule editor day multi-select interactions', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /schedule_editor_days_select_/);
    assert.match(fileContent, /Draft days updated:/);
});

test('index entrypoint routes schedule management through the unified editor workflow', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /schedule_manage_/);
    assert.match(fileContent, /buildScheduleEditorSelectPanel\(schedServerNum\)/);
    assert.match(fileContent, /schedule_select_manage_/);
    assert.match(fileContent, /startScheduleEditor\(srvNum, interaction\.user\.id/);
    assert.match(fileContent, /buildScheduleEditorPanel\(srvNum, interaction\.user\.id\)/);
});

test('index entrypoint routes schedule priority editing through selection and modal flows', () => {
    const filePath = path.join(__dirname, '..', 'src', 'index.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /schedule_priority_/);
    assert.match(fileContent, /buildScheduleSelectPanel\(srvNum, 'priority'\)/);
    assert.match(fileContent, /schedule_select_priority_/);
    assert.match(fileContent, /buildSchedulePriorityModal\(srvNum, schedule\)/);
    assert.match(fileContent, /schedule_priority_modal_/);
    assert.match(fileContent, /Priority must be a whole number between 0 and 100\./);
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

test('main schedule panel renames automod management to server rules', () => {
    const filePath = path.join(__dirname, '..', 'src', 'services', 'schedulePanel.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');

    assert.match(fileContent, /Assign Server Rules/);
    assert.match(fileContent, /Assign Map Pools/);
    assert.match(fileContent, /Edit\/Create Schedule/);
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
