/**
 * Seeding Bot
 * Discord bot for Hell Let Loose map voting
 * With Discord-based setup wizard for easy deployment
 */

require('dotenv').config();

const http = require('http');
const { Client, GatewayIntentBits, Partials, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const logger = require('./utils/logger');
const { CRCONService } = require('./services/crcon');
const { MapVotingService } = require('./services/mapVoting');
const { MapVotePanelService } = require('./services/mapVotePanel');
const configManager = require('./services/configManager');
const setupWizard = require('./services/setupWizard');
const scheduleManager = require('./services/scheduleManager');
const schedulePanel = require('./services/schedulePanel');
const automodPresetManager = require('./services/automodPresetManager');
const { registerCommands } = require('./commands/register');
const {
    isMapVoteToggleButton,
    getScheduleWhitelistServerNum,
    getNonSeededWhitelistServerNum
} = require('./utils/buttonRouting');

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessagePolls,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel]
});

// Service instances
const mapVotingServices = {};
const crconServices = {};
const mapVotePanelService = new MapVotePanelService();
let isDiscordReady = false;
let healthServer = null;
let isShuttingDown = false;
const autoModSoloTankDrafts = new Map();
const autoModNoLeaderDrafts = new Map();
const autoModLevelDrafts = new Map();
const scheduleAutoModSoloTankDrafts = new Map();
const scheduleAutoModNoLeaderDrafts = new Map();
const scheduleAutoModLevelDrafts = new Map();

function buildHealthPayload() {
    return {
        status: isDiscordReady ? 'ok' : 'starting',
        service: 'seeding-bot',
        discordReady: isDiscordReady,
        timestamp: new Date().toISOString()
    };
}

function startHealthServer() {
    const rawPort = process.env.PORT;
    if (!rawPort) {
        logger.info('PORT not set; skipping HTTP health server');
        return null;
    }

    const port = parseInt(rawPort, 10);
    if (Number.isNaN(port) || port <= 0) {
        logger.warn(`Invalid PORT value "${rawPort}", skipping HTTP health server`);
        return null;
    }

    const server = http.createServer((req, res) => {
        const path = req.url || '/';

        if (path === '/health' || path === '/ready' || path === '/') {
            const payload = buildHealthPayload();
            const statusCode = isDiscordReady ? 200 : 503;
            res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(payload));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, '0.0.0.0', () => {
        logger.info(`Health server listening on 0.0.0.0:${port}`);
    });

    server.on('error', (error) => {
        logger.error('Health server error:', error);
    });

    return server;
}

// Initialize servers from config
async function initializeServers() {
    // Stop and clear existing services
    for (const key of Object.keys(mapVotingServices)) {
        if (mapVotingServices[key] && mapVotingServices[key].stop) {
            mapVotingServices[key].stop();
        }
        delete mapVotingServices[key];
    }
    for (const key of Object.keys(crconServices)) {
        delete crconServices[key];
    }

    // Load servers from configManager (merges saved config with .env)
    for (let serverNum = 1; serverNum <= 4; serverNum++) {
        const config = configManager.getEffectiveServerConfig(serverNum);

        if (config.configured && config.channelId) {
            // Create CRCON service
            const crcon = new CRCONService(config);
            crconServices[serverNum] = crcon;

            // Create map voting service
            const service = new MapVotingService(serverNum);
            if (typeof config.excludePlayedMapForXvotes === 'number') {
                service.setConfig('excludeRecentMaps', config.excludePlayedMapForXvotes);
            }
            const success = await service.initialize(client, config.channelId, crcon);

            if (success) {
                mapVotingServices[serverNum] = service;
                logger.info(`${config.serverName} Map Voting initialized`);
            } else {
                logger.error(`${config.serverName} Map Voting failed to initialize`);
            }
        } else {
            logger.info(`Server ${serverNum} not configured, skipping`);
        }
    }
}

// Check if user has admin permissions
function isAdmin(member) {
    if (!member) return false;

    // Server owner always has access
    if (member.guild.ownerId === member.id) return true;

    // Check for Administrator permission
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

    // Check for configured admin role
    const adminRoleId = configManager.getAdminRoleId();
    if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;

    return false;
}

// Check if user is server owner (for setup command)
function isServerOwner(member) {
    if (!member) return false;
    return member.guild.ownerId === member.id ||
           member.permissions.has(PermissionFlagsBits.Administrator);
}

async function updatePanelMessage(interaction, payload, options = {}) {
    const { preferMessageEdit = false } = options;

    if (!preferMessageEdit && (interaction.deferred || interaction.replied)) {
        try {
            await interaction.editReply(payload);
            return;
        } catch (error) {
            logger.warn('Failed to edit interaction reply, falling back to message edit.', error);
        }
    }

    if (interaction.message) {
        await interaction.message.edit(payload);
        return;
    }

    throw new Error('Unable to update interaction panel message.');
}

async function followUpEphemeralAutoDelete(interaction, content, delayMs = 10000) {
    const reply = await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral
    });

    setTimeout(() => {
        interaction.webhook.deleteMessage(reply.id).catch(() => {
            // Ignore: message may already be dismissed or expired.
        });
    }, delayMs);
}

async function replyEphemeralAutoDelete(interaction, content, delayMs = 10000) {
    await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral
    });

    setTimeout(() => {
        interaction.deleteReply().catch(() => {
            // Ignore: message may already be dismissed or expired.
        });
    }, delayMs);
}

async function editReplyEphemeralAutoDelete(interaction, content, delayMs = 10000) {
    await interaction.editReply({ content });

    setTimeout(() => {
        interaction.deleteReply().catch(() => {
            // Ignore: message may already be dismissed or expired.
        });
    }, delayMs);
}

async function sendTemporaryScheduleExport(interaction, fileName, fileContent, delayMs = 30000) {
    if (!interaction.channel) {
        return { success: false, error: 'Channel unavailable for export.' };
    }

    const exportMessage = await interaction.channel.send({
        content: `📄 Schedule export generated by <@${interaction.user.id}>. This message will be deleted in ${Math.floor(delayMs / 1000)} seconds.`,
        files: [
            {
                attachment: Buffer.from(fileContent, 'utf8'),
                name: fileName
            }
        ]
    });

    setTimeout(() => {
        exportMessage.delete().catch(() => {
            // Ignore: message may already be deleted or bot lacks permissions.
        });
    }, delayMs);

    return { success: true };
}

function getAutoModDraftKey(serverNum, userId) {
    return `${serverNum}:${userId}`;
}

function parseAutoModValue(rawValue, fieldType) {
    const value = (rawValue || '').trim();

    if (fieldType === 'boolean') {
        const lowered = value.toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(lowered)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(lowered)) return false;
        throw new Error('Enter true/false, yes/no, on/off, or 1/0.');
    }

    if (fieldType === 'integer') {
        const parsed = parseInt(value, 10);
        if (Number.isNaN(parsed)) {
            throw new Error('Enter a valid integer value.');
        }
        return parsed;
    }

    if (fieldType === 'string_array') {
        if (!value) return [];
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }

    if (fieldType === 'nullable_string') {
        if (!value || value.toLowerCase() === 'null') return null;
        return value;
    }

    return value;
}

function getDefaultLevelThresholds() {
    return {
        officer: { label: 'Officer', min_level: 30, min_players: 75 },
        spotter: { label: 'Reco (spotter)', min_level: 30, min_players: 75 },
        armycommander: { label: 'Commander', min_level: 50, min_players: 75 },
        tankcommander: { label: 'Tank Commander', min_level: 30, min_players: 75 }
    };
}

function getScheduleAutomodFieldDefinitions(moduleType) {
    if (moduleType === 'level') {
        return mapVotePanelService.getLevelGeneralFieldDefinitions();
    }
    if (moduleType === 'no_leader') {
        return mapVotePanelService.getNoLeaderFieldDefinitions();
    }
    if (moduleType === 'solo_tank') {
        return mapVotePanelService.getSoloTankFieldDefinitions();
    }
    return null;
}

function getScheduleById(serverNum, scheduleId) {
    const schedules = scheduleManager.getSchedules(serverNum);
    return schedules.find(item => item.id === scheduleId) || null;
}

function getScheduleAutoModDraftKey(serverNum, scheduleId, userId) {
    return `${serverNum}:${scheduleId}:${userId}`;
}

function getScheduleAutoModDraftMap(moduleType) {
    if (moduleType === 'level') return scheduleAutoModLevelDrafts;
    if (moduleType === 'no_leader') return scheduleAutoModNoLeaderDrafts;
    return scheduleAutoModSoloTankDrafts;
}

async function getLiveAutoModConfig(crcon, moduleType) {
    if (!crcon) return {};
    if (moduleType === 'level') {
        const response = await crcon.getAutoModLevelConfig();
        const config = response?.result || {};
        config.level_thresholds = { ...getDefaultLevelThresholds(), ...(config.level_thresholds || {}) };
        return config;
    }
    if (moduleType === 'no_leader') {
        const response = await crcon.getAutoModNoLeaderConfig();
        return response?.result || {};
    }
    const response = await crcon.getAutoModSoloTankConfig();
    return response?.result || {};
}

function parseNonNegativeInteger(rawValue, fieldLabel) {
    const value = parseInt(String(rawValue || '').trim(), 10);
    if (Number.isNaN(value) || value < 0) {
        throw new Error(`${fieldLabel} must be a non-negative integer.`);
    }
    return value;
}

function extractApiResultInt(response) {
    if (typeof response?.result === 'number') return response.result;
    if (typeof response === 'number') return response;
    return null;
}

async function getLiveGeneralSettings(crcon, serverNum = 1) {
    const service = mapVotingServices[serverNum] || null;
    const config = configManager.getEffectiveServerConfig(serverNum);
    const fallbackCooldown = parseInt(config.excludePlayedMapForXvotes ?? 3, 10);
    const mapVoteCooldownVotes = Number.isNaN(fallbackCooldown)
        ? 3
        : Math.min(Math.max((service?.excludeRecentMaps ?? fallbackCooldown), 0), 10);

    if (!crcon) {
        return {
            teamSwitchCooldown: null,
            idleAutokickTime: null,
            maxPingAutokick: null,
            mapVoteCooldownVotes
        };
    }

    const [teamSwitch, idleKick, maxPing] = await Promise.all([
        crcon.getTeamSwitchCooldown().catch(() => null),
        crcon.getIdleAutokickTime().catch(() => null),
        crcon.getMaxPingAutokick().catch(() => null)
    ]);

    return {
        teamSwitchCooldown: extractApiResultInt(teamSwitch),
        idleAutokickTime: extractApiResultInt(idleKick),
        maxPingAutokick: extractApiResultInt(maxPing),
        mapVoteCooldownVotes
    };
}

async function setGeneralSetting(crcon, key, value) {
    if (key === 'teamSwitchCooldown') {
        await crcon.setTeamSwitchCooldown(value);
        return;
    }
    if (key === 'idleAutokickTime') {
        await crcon.setIdleAutokickTime(value);
        return;
    }
    if (key === 'maxPingAutokick') {
        await crcon.setMaxPingAutokick(value);
        return;
    }
    throw new Error('Unknown general setting key.');
}

// Ready event
client.once(Events.ClientReady, async () => {
    isDiscordReady = true;
    logger.info(`Seeding Bot logged in as ${client.user.tag}`);

    // Register slash commands
    await registerCommands(client);

    // Initialize servers
    await initializeServers();

    const serverCount = Object.keys(mapVotingServices).length;
    if (serverCount === 0) {
        logger.info('No servers configured. Use /mapvote setup to configure.');
    } else {
        logger.info(`Seeding Bot ready with ${serverCount} server(s)!`);
    }
});

// Poll vote events
client.on(Events.MessagePollVoteAdd, async (pollAnswer, userId) => {
    for (const [serverNum, service] of Object.entries(mapVotingServices)) {
        await service.onPollVoteAdd(pollAnswer, userId);
    }
});

client.on(Events.MessagePollVoteRemove, async (pollAnswer, userId) => {
    for (const [serverNum, service] of Object.entries(mapVotingServices)) {
        await service.onPollVoteRemove(pollAnswer, userId);
    }
});

// Interaction handler
client.on(Events.InteractionCreate, async (interaction) => {
    try {
        // ========== SLASH COMMANDS ==========
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName !== 'mapvote') return;

            const subcommand = interaction.options.getSubcommand();
            const serverNum = interaction.options.getInteger('server') || 1;

            // Setup command - Server Owner only
            if (subcommand === 'setup') {
                if (!isServerOwner(interaction.member)) {
                    return interaction.reply({
                        content: 'Only the server owner or administrators can use the setup wizard.',
                        flags: MessageFlags.Ephemeral
                    });
                }
                const panel = setupWizard.buildSetupPanel();
                await interaction.reply(panel);
                return;
            }

            // All other commands require admin role
            if (!isAdmin(interaction.member)) {
                const adminRoleId = configManager.getAdminRoleId();
                const roleMsg = adminRoleId
                    ? `You need the <@&${adminRoleId}> role to use this command.`
                    : 'No admin role is configured. Ask the server owner to set one up with `/mapvote setup`.';
                return interaction.reply({
                    content: roleMsg,
                    flags: MessageFlags.Ephemeral
                });
            }

            const service = mapVotingServices[serverNum];
            const crcon = crconServices[serverNum];
            const config = configManager.getEffectiveServerConfig(serverNum);
            const serverName = config.serverName || `Server ${serverNum}`;

            if (subcommand === 'panel') {
                if (!service) {
                    return interaction.reply({
                        content: `${serverName} is not configured. Use \`/mapvote setup\` to configure.`,
                        flags: MessageFlags.Ephemeral
                    });
                }
                await interaction.deferReply();
                const panel = await mapVotePanelService.buildControlPanel(service, crcon, serverName);
                await interaction.editReply(panel);
            }

            else if (subcommand === 'start') {
                if (!service) {
                    return interaction.reply({ content: `${serverName} is not configured`, flags: MessageFlags.Ephemeral });
                }
                const result = await service.resume(interaction.user.username);
                await interaction.reply({
                    content: result ? `Map voting started for ${serverName}` : `Map voting already running for ${serverName}`,
                    flags: MessageFlags.Ephemeral
                });
            }

            else if (subcommand === 'stop') {
                if (!service) {
                    return interaction.reply({ content: `${serverName} is not configured`, flags: MessageFlags.Ephemeral });
                }
                const result = await service.pause(interaction.user.username);
                await interaction.reply({
                    content: result ? `Map voting paused for ${serverName}` : `Map voting already paused for ${serverName}`,
                    flags: MessageFlags.Ephemeral
                });
            }

            else if (subcommand === 'status') {
                if (!service) {
                    return interaction.reply({ content: `${serverName} is not configured`, flags: MessageFlags.Ephemeral });
                }
                const serviceConfig = service.getConfig();
                await interaction.reply({
                    content: `**${serverName} Status:**\n` +
                        `Status: ${service.getStatus()}\n` +
                        `Vote Active: ${serviceConfig.voteActive}\n` +
                        `Seeded: ${serviceConfig.seeded}\n` +
                        `Min Players: ${serviceConfig.minimumPlayers}`,
                    flags: MessageFlags.Ephemeral
                });
            }

            else if (subcommand === 'help') {
                await interaction.reply({
                    content: '**Seeding Bot Commands:**\n' +
                        '`/mapvote setup` - Open setup wizard (Owner/Admin only)\n' +
                        '`/mapvote panel [server]` - Show control panel\n' +
                        '`/mapvote start [server]` - Start map voting\n' +
                        '`/mapvote stop [server]` - Stop map voting\n' +
                        '`/mapvote status [server]` - Show status\n' +
                        '`/mapvote help` - Show this help\n\n' +
                        '*[server] = 1, 2, 3, or 4 (default: 1)*',
                    flags: MessageFlags.Ephemeral
                });
            }

            return;
        }

        // ========== BUTTON INTERACTIONS ==========
        if (interaction.isButton()) {
            const customId = interaction.customId;

            // ========== SETUP WIZARD BUTTONS ==========
            if (customId.startsWith('setup_')) {
                // Setup requires server owner
                if (!isServerOwner(interaction.member)) {
                    return interaction.reply({
                        content: 'Only the server owner or administrators can modify setup.',
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (customId === 'setup_add_server') {
                    const nextNum = setupWizard.getNextServerNumber();
                    if (!nextNum) {
                        return interaction.reply({
                            content: 'Maximum of 4 servers reached. Remove a server first.',
                            flags: MessageFlags.Ephemeral
                        });
                    }
                    await interaction.update(setupWizard.buildTransportModeSelectPanel('add', nextNum));
                }

                else if (customId === 'setup_edit_server') {
                    const panel = setupWizard.buildServerSelectMenu('edit');
                    if (!panel) {
                        return interaction.reply({ content: 'No servers configured.', flags: MessageFlags.Ephemeral });
                    }
                    await interaction.update(panel);
                }

                else if (customId === 'setup_edit_rcon') {
                    const panel = setupWizard.buildServerSelectMenu('rcon');
                    if (!panel) {
                        return interaction.reply({ content: 'No servers configured.', flags: MessageFlags.Ephemeral });
                    }
                    await interaction.update(panel);
                }

                else if (customId === 'setup_remove_server') {
                    const panel = setupWizard.buildServerSelectMenu('remove');
                    if (!panel) {
                        return interaction.reply({ content: 'No servers configured.', flags: MessageFlags.Ephemeral });
                    }
                    await interaction.update(panel);
                }

                else if (customId === 'setup_set_admin_role') {
                    // Fetch guild roles
                    await interaction.guild.roles.fetch();
                    const panel = setupWizard.buildAdminRolePanel(interaction.guild.roles.cache);
                    await interaction.update(panel);
                }

                else if (customId === 'setup_clear_admin_role') {
                    setupWizard.clearAdminRole();
                    await interaction.update(setupWizard.buildSetupPanel());
                    await interaction.followUp({
                        content: 'Admin role cleared. Only the server owner can now use bot commands.',
                        flags: MessageFlags.Ephemeral
                    });
                }

                else if (customId === 'setup_test_connection') {
                    await interaction.deferUpdate();
                    const results = await setupWizard.testAllConnections();
                    const panel = setupWizard.buildTestResultsEmbed(results);
                    await interaction.message.edit(panel);
                }

                else if (customId === 'setup_refresh' || customId === 'setup_back') {
                    await interaction.update(setupWizard.buildSetupPanel());
                }

                else if (customId === 'setup_apply_restart') {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    await initializeServers();
                    const serverCount = Object.keys(mapVotingServices).length;
                    await interaction.editReply({
                        content: `Configuration applied! ${serverCount} server(s) initialized.\n\nYou can now use \`/mapvote panel\` to control map voting.`
                    });
                    await interaction.message.edit(setupWizard.buildSetupPanel());
                }

                return;
            }

            // ========== MAP VOTING BUTTONS ==========
            // Check admin permissions for map voting controls
            if (!isAdmin(interaction.member)) {
                return interaction.reply({
                    content: 'You do not have permission to use these controls.',
                    flags: MessageFlags.Ephemeral
                });
            }

            // Determine which server this is for (default to 1)
            let serverNum = 1;
            if (customId.includes('_s2') || customId.endsWith('_2')) serverNum = 2;
            if (customId.includes('_s3') || customId.endsWith('_3')) serverNum = 3;
            if (customId.includes('_s4') || customId.endsWith('_4')) serverNum = 4;

            const service = mapVotingServices[serverNum];
            const crcon = crconServices[serverNum];
            const config = configManager.getEffectiveServerConfig(serverNum);
            const serverName = config.serverName || `Server ${serverNum}`;

            if (!service) {
                return interaction.reply({ content: 'Map voting service not available for this server.', flags: MessageFlags.Ephemeral });
            }

            // Toggle map voting
            if (isMapVoteToggleButton(customId)) {
                await interaction.deferUpdate();

                let responseMessage = '';
                if (service.getStatus() === 'running') {
                    await service.pause(interaction.user.username);
                    responseMessage = `Map voting paused for ${serverName}`;
                } else {
                    await service.resume(interaction.user.username);
                    responseMessage = `Map voting started for ${serverName}`;
                }

                const panel = await mapVotePanelService.buildControlPanel(service, crcon, serverName);
                await updatePanelMessage(interaction, panel);
                await followUpEphemeralAutoDelete(interaction, responseMessage);
            }

            // Refresh panel
            else if (customId === 'mapvote_refresh' || customId.startsWith('mapvote_refresh_')) {
                await interaction.deferUpdate();
                const panel = await mapVotePanelService.buildControlPanel(service, crcon, serverName);
                await updatePanelMessage(interaction, panel);
            }

            // Show whitelist panel
            else if (customId === 'mapvote_whitelist' || customId.startsWith('mapvote_whitelist_')) {
                await interaction.deferUpdate();
                const panel = await mapVotePanelService.buildWhitelistPanel(crcon);
                await updatePanelMessage(interaction, panel);
            }

            // Show blacklist panel
            else if (customId === 'mapvote_blacklist' || customId.startsWith('mapvote_blacklist_')) {
                await interaction.deferUpdate();
                const panel = await mapVotePanelService.buildBlacklistPanel(crcon);
                await updatePanelMessage(interaction, panel);
            }

            // Show history panel
            else if (customId === 'mapvote_history' || customId.startsWith('mapvote_history_')) {
                await interaction.deferUpdate();
                const panel = await mapVotePanelService.buildHistoryPanel(crcon);
                await updatePanelMessage(interaction, panel);
            }

            // Show automods panel
            else if (customId === 'mapvote_automods' || customId.startsWith('mapvote_automods_')) {
                await interaction.deferUpdate();
                const panel = mapVotePanelService.buildAutomodsPanel(serverNum, serverName);
                await updatePanelMessage(interaction, panel);
            }

            // Show export schedule panel
            else if (customId === 'mapvote_export_schedule' || customId.startsWith('mapvote_export_schedule_')) {
                await interaction.deferUpdate();
                const panel = schedulePanel.buildScheduleExportSelectPanel(serverNum);
                await updatePanelMessage(interaction, panel);
            }

            // Show settings panel
            else if (customId === 'mapvote_settings' || customId.startsWith('mapvote_settings_')) {
                await interaction.deferUpdate();
                const generalSettings = await getLiveGeneralSettings(crcon, serverNum);
                const panel = mapVotePanelService.buildSettingsPanel(service, generalSettings);
                await updatePanelMessage(interaction, panel);
            }

            else if (customId === 'mapvote_non_seeded_maps' || customId.startsWith('mapvote_non_seeded_maps_')) {
                await interaction.deferUpdate();
                const existingList = configManager.getNonSeededMapList(serverNum);
                if (existingList.length === 0) {
                    try {
                        const mapsResponse = await crcon.getMaps();
                        const defaultMapList = (mapsResponse?.result || []).map(map => map.id);
                        configManager.setNonSeededMapList(serverNum, defaultMapList);
                    } catch (error) {
                        logger.error(`[Interaction] Failed to initialize non-seeded map list for server ${serverNum}:`, error);
                    }
                }
                const panel = await mapVotePanelService.buildNonSeededMapListPanel(serverNum, crcon);
                await updatePanelMessage(interaction, panel);
            }

            // Back to main panel
            else if (customId === 'mapvote_back') {
                await interaction.deferUpdate();
                const panel = await mapVotePanelService.buildControlPanel(service, crcon, serverName);
                await updatePanelMessage(interaction, panel);
            }

            // Reset current vote
            else if (customId === 'mapvote_reset_vote' || customId.startsWith('mapvote_reset_vote_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                try {
                    await crcon.resetVotemapState();
                    service.clearCache();
                    await interaction.editReply({ content: 'Vote state reset' });
                } catch (e) {
                    await interaction.editReply({ content: `Error: ${e.message}` });
                }
            }

            // Reset whitelist
            else if (customId === 'mapvote_reset_whitelist' || customId.startsWith('mapvote_reset_whitelist_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                try {
                    await crcon.resetVotemapWhitelist();
                    service.clearCache();
                    await interaction.editReply({ content: 'Whitelist reset to all maps' });
                } catch (e) {
                    await interaction.editReply({ content: `Error: ${e.message}` });
                }
            }

            // Whitelist filters
            else if (customId.startsWith('mapvote_wl_')) {
                await interaction.deferUpdate();

                let filter = null;
                let page = 0;

                if (customId === 'mapvote_wl_warfare') filter = 'warfare';
                else if (customId === 'mapvote_wl_offensive') filter = 'offensive';
                else if (customId === 'mapvote_wl_night') filter = 'night';
                else if (customId === 'mapvote_wl_day') filter = 'day';
                else if (customId.startsWith('mapvote_wl_prev_')) {
                    const parts = customId.split('_');
                    page = Math.max(0, parseInt(parts[3]) - 1);
                    filter = parts[4] !== 'all' ? parts[4] : null;
                }
                else if (customId.startsWith('mapvote_wl_next_')) {
                    const parts = customId.split('_');
                    page = parseInt(parts[3]) + 1;
                    filter = parts[4] !== 'all' ? parts[4] : null;
                }
                else if (customId === 'mapvote_wl_all_on') {
                    try {
                        await crcon.resetVotemapWhitelist();
                        service.clearCache();
                    } catch (e) {
                        logger.error('Error enabling all maps:', e);
                    }
                }
                else if (customId === 'mapvote_wl_all_off') {
                    try {
                        // Remove all maps from whitelist
                        const maps = await crcon.getMaps();
                        for (const map of (maps?.result || [])) {
                            await crcon.removeFromVotemapWhitelist(map.id);
                        }
                        service.clearCache();
                    } catch (e) {
                        logger.error('Error disabling all maps:', e);
                    }
                }

                const panel = await mapVotePanelService.buildWhitelistPanel(crcon, page, filter);
                await updatePanelMessage(interaction, panel);
            }

            // Settings modals
            else if (customId === 'mapvote_set_activate') {
                const modal = new ModalBuilder()
                    .setCustomId(`mapvote_modal_activate_${serverNum}`)
                    .setTitle('Set Minimum Players')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel('Minimum players to activate voting')
                                .setStyle(TextInputStyle.Short)
                                .setValue(String(service.minimumPlayers))
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
            }

            else if (customId === 'mapvote_set_deactivate') {
                const modal = new ModalBuilder()
                    .setCustomId(`mapvote_modal_deactivate_${serverNum}`)
                    .setTitle('Set Deactivate Players')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel('Player count to deactivate voting')
                                .setStyle(TextInputStyle.Short)
                                .setValue(String(service.deactivatePlayers))
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
            }

            else if (customId === 'mapvote_set_maps_count') {
                const modal = new ModalBuilder()
                    .setCustomId(`mapvote_modal_maps_count_${serverNum}`)
                    .setTitle('Set Maps Per Vote')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel('Number of maps in each vote')
                                .setStyle(TextInputStyle.Short)
                                .setValue(String(service.mapsPerVote))
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
            }

            else if (customId === 'mapvote_set_night_count') {
                const modal = new ModalBuilder()
                    .setCustomId(`mapvote_modal_night_count_${serverNum}`)
                    .setTitle('Set Night Map Count')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel('Number of night maps per vote')
                                .setStyle(TextInputStyle.Short)
                                .setValue(String(service.nightMapCount))
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
            }

            else if (customId === 'mapvote_set_cooldown') {
                const modal = new ModalBuilder()
                    .setCustomId(`mapvote_modal_cooldown_${serverNum}`)
                    .setTitle('Set Map Cooldown Votes')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel('Votes map stays out after being played')
                                .setStyle(TextInputStyle.Short)
                                .setValue(String(service.excludeRecentMaps ?? 3))
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
            }

            else if (customId === 'mapvote_set_team_switch_cooldown') {
                const generalSettings = await getLiveGeneralSettings(crcon, serverNum);
                const modal = new ModalBuilder()
                    .setCustomId(`mapvote_modal_team_switch_cooldown_${serverNum}`)
                    .setTitle('Set Team Switch Cooldown')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel('Minutes')
                                .setStyle(TextInputStyle.Short)
                                .setValue(String(generalSettings.teamSwitchCooldown ?? 0))
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
            }

            else if (customId === 'mapvote_set_idle_autokick') {
                const generalSettings = await getLiveGeneralSettings(crcon, serverNum);
                const modal = new ModalBuilder()
                    .setCustomId(`mapvote_modal_idle_autokick_${serverNum}`)
                    .setTitle('Set Idle Autokick Time')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel('Minutes')
                                .setStyle(TextInputStyle.Short)
                                .setValue(String(generalSettings.idleAutokickTime ?? 0))
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
            }

            else if (customId === 'mapvote_set_max_ping') {
                const generalSettings = await getLiveGeneralSettings(crcon, serverNum);
                const modal = new ModalBuilder()
                    .setCustomId(`mapvote_modal_max_ping_${serverNum}`)
                    .setTitle('Set Max Ping Autokick')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel('Milliseconds')
                                .setStyle(TextInputStyle.Short)
                                .setValue(String(generalSettings.maxPingAutokick ?? 0))
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
            }

            // ========== SCHEDULE BUTTONS ==========
            else if (customId === 'mapvote_schedules' || customId.startsWith('mapvote_schedules_')) {
                await interaction.deferUpdate();
                const panel = schedulePanel.buildSchedulePanel(serverNum, serverName);
                await updatePanelMessage(interaction, panel);
            }

            // ========== AUTOMOD BUTTONS ==========
            else if (customId.startsWith('automod_')) {
                const parts = customId.split('_');
                const maybeServerNum = parseInt(parts[parts.length - 1], 10);
                const automodServerNum = Number.isNaN(maybeServerNum) ? serverNum : maybeServerNum;
                const automodCrcon = crconServices[automodServerNum] || crconServices[1];
                const automodService = mapVotingServices[automodServerNum] || mapVotingServices[1];
                const automodConfig = configManager.getEffectiveServerConfig(automodServerNum);
                const automodServerName = automodConfig.serverName || `Server ${automodServerNum}`;

                if (!automodCrcon || !automodService) {
                    return interaction.reply({ content: 'Service not available for Automods.', flags: MessageFlags.Ephemeral });
                }

                if (customId.startsWith('automod_back_')) {
                    await interaction.deferUpdate();
                    const panel = await mapVotePanelService.buildControlPanel(automodService, automodCrcon, automodServerName);
                    await updatePanelMessage(interaction, panel);
                }

                else if (customId.startsWith('automod_level_general_back_') || customId.startsWith('automod_level_roles_back_')) {
                    await interaction.deferUpdate();
                    const panel = mapVotePanelService.buildAutomodsPanel(automodServerNum, automodServerName);
                    await updatePanelMessage(interaction, panel);
                }

                else if (
                    customId.startsWith('automod_level_general_save_') ||
                    customId.startsWith('automod_level_roles_save_') ||
                    customId.startsWith('automod_no_leader_save_') ||
                    customId.startsWith('automod_solo_tank_save_')
                ) {
                    const type = customId.includes('_level_')
                        ? 'level'
                        : customId.includes('_no_leader_')
                            ? 'no_leader'
                            : 'solo_tank';

                    const typeLabel = type === 'level'
                        ? 'Level'
                        : type === 'no_leader'
                            ? 'No Leader'
                            : 'No Solo Tank';

                    const modal = new ModalBuilder()
                        .setCustomId(`automod_save_modal_${type}_${automodServerNum}`)
                        .setTitle(`Save ${typeLabel} Config`)
                        .addComponents(
                            new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                    .setCustomId('name')
                                    .setLabel('Preset Name')
                                    .setStyle(TextInputStyle.Short)
                                    .setPlaceholder(`e.g. peakhours (saved as "peakhours - ${typeLabel}")`)
                                    .setRequired(true)
                                    .setMaxLength(80)
                            )
                        );

                    await interaction.showModal(modal);
                }

                else if (customId.startsWith('automod_level_general_refresh_') || customId.startsWith('automod_level_roles_refresh_')) {
                    await interaction.deferUpdate();
                    const response = await automodCrcon.getAutoModLevelConfig();
                    const draft = response?.result || {};
                    draft.level_thresholds = { ...getDefaultLevelThresholds(), ...(draft.level_thresholds || {}) };
                    autoModLevelDrafts.set(
                        getAutoModDraftKey(automodServerNum, interaction.user.id),
                        draft
                    );

                    const panel = customId.startsWith('automod_level_roles_')
                        ? mapVotePanelService.buildAutoModLevelRolesPanel(automodServerNum, automodServerName, draft, 'server')
                        : mapVotePanelService.buildAutoModLevelGeneralPanel(automodServerNum, automodServerName, draft, 'server');
                    await updatePanelMessage(interaction, panel);
                    await followUpEphemeralAutoDelete(interaction, 'Level config reloaded from server.');
                }

                else if (customId.startsWith('automod_level_general_commit_') || customId.startsWith('automod_level_roles_commit_')) {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                    const draftKey = getAutoModDraftKey(automodServerNum, interaction.user.id);
                    const draft = autoModLevelDrafts.get(draftKey);
                    if (!draft) {
                        await interaction.editReply({
                            content: 'No Level draft found. Open a Level panel first.'
                        });
                        return;
                    }

                    try {
                        await automodCrcon.setAutoModLevelConfig(interaction.user.username, draft, false);
                        await interaction.editReply({ content: 'Level config committed successfully.' });

                        const refreshed = await automodCrcon.getAutoModLevelConfig();
                        const serverConfig = refreshed?.result || draft;
                        serverConfig.level_thresholds = { ...getDefaultLevelThresholds(), ...(serverConfig.level_thresholds || {}) };
                        autoModLevelDrafts.set(draftKey, serverConfig);

                        const panel = customId.startsWith('automod_level_roles_')
                            ? mapVotePanelService.buildAutoModLevelRolesPanel(automodServerNum, automodServerName, serverConfig, 'server')
                            : mapVotePanelService.buildAutoModLevelGeneralPanel(automodServerNum, automodServerName, serverConfig, 'server');
                        await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                    } catch (e) {
                        await interaction.editReply({
                            content: `Failed to commit Level config: ${e.message}`
                        });
                    }
                }

                else if (customId.startsWith('automod_level_general_') || customId.startsWith('automod_level_roles_')) {
                    await interaction.deferUpdate();
                    const response = await automodCrcon.getAutoModLevelConfig();
                    const draft = response?.result || {};
                    draft.level_thresholds = { ...getDefaultLevelThresholds(), ...(draft.level_thresholds || {}) };
                    autoModLevelDrafts.set(
                        getAutoModDraftKey(automodServerNum, interaction.user.id),
                        draft
                    );

                    const panel = customId.startsWith('automod_level_roles_')
                        ? mapVotePanelService.buildAutoModLevelRolesPanel(automodServerNum, automodServerName, draft, 'server')
                        : mapVotePanelService.buildAutoModLevelGeneralPanel(automodServerNum, automodServerName, draft, 'server');
                    await updatePanelMessage(interaction, panel);
                }

                else if (customId.startsWith('automod_no_leader_back_')) {
                    await interaction.deferUpdate();
                    const panel = mapVotePanelService.buildAutomodsPanel(automodServerNum, automodServerName);
                    await updatePanelMessage(interaction, panel);
                }

                else if (customId.startsWith('automod_no_leader_refresh_')) {
                    await interaction.deferUpdate();
                    const response = await automodCrcon.getAutoModNoLeaderConfig();
                    const draft = response?.result || {};
                    autoModNoLeaderDrafts.set(
                        getAutoModDraftKey(automodServerNum, interaction.user.id),
                        draft
                    );
                    const panel = mapVotePanelService.buildAutoModNoLeaderPanel(
                        automodServerNum,
                        automodServerName,
                        draft,
                        'server'
                    );
                    await updatePanelMessage(interaction, panel);
                    await followUpEphemeralAutoDelete(interaction, 'No Leader config reloaded from server.');
                }

                else if (customId.startsWith('automod_no_leader_commit_')) {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                    const draftKey = getAutoModDraftKey(automodServerNum, interaction.user.id);
                    const draft = autoModNoLeaderDrafts.get(draftKey);
                    if (!draft) {
                        await interaction.editReply({
                            content: 'No draft found. Open No Leader panel and edit values first.'
                        });
                        return;
                    }

                    try {
                        await automodCrcon.setAutoModNoLeaderConfig(interaction.user.username, draft, false);
                        await interaction.editReply({ content: 'No Leader config committed successfully.' });

                        const refreshed = await automodCrcon.getAutoModNoLeaderConfig();
                        const serverConfig = refreshed?.result || draft;
                        autoModNoLeaderDrafts.set(draftKey, serverConfig);

                        const panel = mapVotePanelService.buildAutoModNoLeaderPanel(
                            automodServerNum,
                            automodServerName,
                            serverConfig,
                            'server'
                        );
                        await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                    } catch (e) {
                        await interaction.editReply({
                            content: `Failed to commit No Leader config: ${e.message}`
                        });
                    }
                }

                else if (customId.startsWith('automod_no_leader_')) {
                    await interaction.deferUpdate();
                    const response = await automodCrcon.getAutoModNoLeaderConfig();
                    const draft = response?.result || {};
                    autoModNoLeaderDrafts.set(
                        getAutoModDraftKey(automodServerNum, interaction.user.id),
                        draft
                    );
                    const panel = mapVotePanelService.buildAutoModNoLeaderPanel(
                        automodServerNum,
                        automodServerName,
                        draft,
                        'server'
                    );
                    await updatePanelMessage(interaction, panel);
                }

                else if (customId.startsWith('automod_solo_tank_back_')) {
                    await interaction.deferUpdate();
                    const panel = mapVotePanelService.buildAutomodsPanel(automodServerNum, automodServerName);
                    await updatePanelMessage(interaction, panel);
                }

                else if (customId.startsWith('automod_solo_tank_refresh_')) {
                    await interaction.deferUpdate();
                    const response = await automodCrcon.getAutoModSoloTankConfig();
                    const draft = response?.result || {};
                    autoModSoloTankDrafts.set(
                        getAutoModDraftKey(automodServerNum, interaction.user.id),
                        draft
                    );
                    const panel = mapVotePanelService.buildAutoModSoloTankPanel(
                        automodServerNum,
                        automodServerName,
                        draft,
                        'server'
                    );
                    await updatePanelMessage(interaction, panel);
                    await followUpEphemeralAutoDelete(interaction, 'No Solo Tank config reloaded from server.');
                }

                else if (customId.startsWith('automod_solo_tank_commit_')) {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                    const draftKey = getAutoModDraftKey(automodServerNum, interaction.user.id);
                    const draft = autoModSoloTankDrafts.get(draftKey);
                    if (!draft) {
                        await interaction.editReply({
                            content: 'No draft found. Open No Solo Tank panel and edit values first.'
                        });
                        return;
                    }

                    try {
                        await automodCrcon.setAutoModSoloTankConfig(interaction.user.username, draft, false);
                        await interaction.editReply({ content: 'No Solo Tank config committed successfully.' });

                        const refreshed = await automodCrcon.getAutoModSoloTankConfig();
                        const serverConfig = refreshed?.result || draft;
                        autoModSoloTankDrafts.set(draftKey, serverConfig);

                        const panel = mapVotePanelService.buildAutoModSoloTankPanel(
                            automodServerNum,
                            automodServerName,
                            serverConfig,
                            'server'
                        );
                        await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                    } catch (e) {
                        await interaction.editReply({
                            content: `Failed to commit No Solo Tank config: ${e.message}`
                        });
                    }
                }

                else if (customId.startsWith('automod_solo_tank_')) {
                    await interaction.deferUpdate();
                    const response = await automodCrcon.getAutoModSoloTankConfig();
                    const draft = response?.result || {};
                    autoModSoloTankDrafts.set(
                        getAutoModDraftKey(automodServerNum, interaction.user.id),
                        draft
                    );
                    const panel = mapVotePanelService.buildAutoModSoloTankPanel(
                        automodServerNum,
                        automodServerName,
                        draft,
                        'server'
                    );
                    await updatePanelMessage(interaction, panel);
                }
            }

            else if (customId.startsWith('schedule_')) {
                // Extract server number from customId if present
                const parts = customId.split('_');
                const lastPart = parts[parts.length - 1];
                const schedServerNum = /^\d+$/.test(lastPart) ? parseInt(lastPart) : serverNum;

                // Schedule back button
                if (customId.startsWith('schedule_back_')) {
                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildSchedulePanel(schedServerNum, serverName);
                    await updatePanelMessage(interaction, panel);
                }

                // Add schedule
                else if (customId.startsWith('schedule_add_')) {
                    const modal = schedulePanel.buildScheduleModal(schedServerNum);
                    await interaction.showModal(modal);
                }

                // Edit schedule - show selection
                else if (customId.startsWith('schedule_edit_') && !customId.includes('select')) {
                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleSelectPanel(schedServerNum, 'edit');
                    await updatePanelMessage(interaction, panel);
                }

                // Delete schedule - show selection
                else if (customId.startsWith('schedule_delete_') && !customId.includes('select')) {
                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleSelectPanel(schedServerNum, 'delete');
                    await updatePanelMessage(interaction, panel);
                }

                // Timezone selection
                else if (customId.startsWith('schedule_timezone_')) {
                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildTimezonePanel(schedServerNum);
                    await updatePanelMessage(interaction, panel);
                }

                // Override panel
                else if (customId.startsWith('schedule_override_') && !customId.includes('select') && !customId.includes('match') && !customId.includes('hours')) {
                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildOverridePanel(schedServerNum);
                    await updatePanelMessage(interaction, panel);
                }

                // Clear override
                else if (customId.startsWith('schedule_clear_override_')) {
                    await interaction.deferUpdate();
                    scheduleManager.clearOverride(schedServerNum);
                    const panel = schedulePanel.buildSchedulePanel(schedServerNum, serverName);
                    await updatePanelMessage(interaction, panel);
                    await interaction.followUp({ content: 'Override cleared.', flags: MessageFlags.Ephemeral });
                }

                // Override type: match
                else if (customId.startsWith('schedule_override_match_')) {
                    const idParts = customId.split('_');
                    const scheduleId = idParts[idParts.length - 1];
                    const srvNum = parseInt(idParts[idParts.length - 2]);

                    await interaction.deferUpdate();
                    scheduleManager.setOverride(srvNum, scheduleId, 'match');
                    const panel = schedulePanel.buildSchedulePanel(srvNum, serverName);
                    await updatePanelMessage(interaction, panel);
                    await interaction.followUp({ content: 'Override set until match ends.', flags: MessageFlags.Ephemeral });
                }

                // Override type: hours - show modal
                else if (customId.startsWith('schedule_override_hours_') && !customId.includes('modal')) {
                    const idParts = customId.split('_');
                    const scheduleId = idParts[idParts.length - 1];
                    const srvNum = parseInt(idParts[idParts.length - 2]);
                    const modal = schedulePanel.buildOverrideHoursModal(srvNum, scheduleId);
                    await interaction.showModal(modal);
                }

                // Days selection
                else if (customId.startsWith('schedule_days_')) {
                    const idParts = customId.split('_');
                    const scheduleId = idParts[idParts.length - 1];
                    const srvNum = parseInt(idParts[idParts.length - 2]);
                    const preset = idParts[2]; // all, weekdays, weekend

                    await interaction.deferUpdate();
                    const days = scheduleManager.getDayPresets()[preset];
                    const updateResult = scheduleManager.updateSchedule(srvNum, scheduleId, { days });
                    if (!updateResult.success) {
                        return replyEphemeralAutoDelete(interaction, `Failed to save schedule days: ${updateResult.error}`);
                    }
                    const panel = schedulePanel.buildSchedulePanel(srvNum, serverName);
                    await updatePanelMessage(interaction, panel);
                    await interaction.followUp({ content: `Days set to ${preset}.`, flags: MessageFlags.Ephemeral });
                }

                // Schedule general settings - show schedule selection
                else if (customId.startsWith('schedule_general_') && /^schedule_general_\d+$/.test(customId)) {
                    await interaction.deferUpdate();
                    const srvNum = parseInt(customId.split('_').pop(), 10);
                    const panel = schedulePanel.buildScheduleGeneralSelectPanel(srvNum);
                    await updatePanelMessage(interaction, panel);
                }

                // Schedule general settings - open editor
                else if (customId.startsWith('schedule_general_edit_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    const settingKey = idParts.slice(3, idParts.length - 2).join('_').replace('edit_', '');
                    const schedule = getScheduleById(srvNum, scheduleId);
                    if (!schedule) {
                        return replyEphemeralAutoDelete(interaction, 'Schedule not found.');
                    }

                    const labelMap = {
                        teamSwitchCooldown: 'Team Switch Cooldown',
                        idleAutokickTime: 'Idle Autokick Time',
                        maxPingAutokick: 'Max Ping Autokick',
                        mapVoteCooldownVotes: 'Map Vote Cooldown'
                    };
                    const unitMap = {
                        teamSwitchCooldown: 'minutes',
                        idleAutokickTime: 'minutes',
                        maxPingAutokick: 'milliseconds',
                        mapVoteCooldownVotes: 'votes'
                    };

                    if (!labelMap[settingKey]) {
                        return replyEphemeralAutoDelete(interaction, 'Unknown setting selected.');
                    }

                    const scheduleValues = {
                        teamSwitchCooldown: null,
                        idleAutokickTime: null,
                        maxPingAutokick: null,
                        mapVoteCooldownVotes: null,
                        ...(schedule.generalSettings || {})
                    };
                    const liveValues = await getLiveGeneralSettings(crconServices[srvNum] || crconServices[1], srvNum);
                    const currentValue = scheduleValues[settingKey] ?? liveValues[settingKey] ?? 0;

                    const modal = new ModalBuilder()
                        .setCustomId(`schedule_general_modal_${settingKey}_${srvNum}_${scheduleId}`)
                        .setTitle(`Schedule - ${labelMap[settingKey]}`)
                        .addComponents(
                            new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                    .setCustomId('value')
                                    .setLabel(unitMap[settingKey])
                                    .setStyle(TextInputStyle.Short)
                                    .setRequired(true)
                                    .setValue(String(currentValue))
                            )
                        );
                    await interaction.showModal(modal);
                }

                // Schedule general settings - toggle setting between server and schedule-specific
                else if (customId.startsWith('schedule_general_toggle_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    const settingKey = idParts.slice(3, idParts.length - 2).join('_').replace('toggle_', '');
                    const schedule = getScheduleById(srvNum, scheduleId);

                    if (!schedule) {
                        return replyEphemeralAutoDelete(interaction, 'Schedule not found.');
                    }

                    const currentGeneralSettings = {
                        teamSwitchCooldown: null,
                        idleAutokickTime: null,
                        maxPingAutokick: null,
                        mapVoteCooldownVotes: null,
                        ...(schedule.generalSettings || {})
                    };

                    let nextValue = null;
                    if (currentGeneralSettings[settingKey] === null || currentGeneralSettings[settingKey] === undefined) {
                        const liveValues = await getLiveGeneralSettings(crconServices[srvNum] || crconServices[1], srvNum);
                        nextValue = liveValues[settingKey];
                        if (nextValue === null || nextValue === undefined) {
                            return replyEphemeralAutoDelete(interaction, `Failed to load current ${settingKey} from server.`);
                        }
                    }

                    const updateResult = scheduleManager.updateSchedule(srvNum, scheduleId, {
                        generalSettings: {
                            ...currentGeneralSettings,
                            [settingKey]: nextValue
                        }
                    });
                    if (!updateResult.success) {
                        return replyEphemeralAutoDelete(interaction, `Failed to update setting: ${updateResult.error}`);
                    }

                    const generalSettings = await getLiveGeneralSettings(crconServices[srvNum] || crconServices[1], srvNum);
                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleGeneralPanel(srvNum, scheduleId, generalSettings);
                    await updatePanelMessage(interaction, panel);
                    await followUpEphemeralAutoDelete(
                        interaction,
                        nextValue === null
                            ? `${settingKey} now uses current server settings for this schedule.`
                            : `${settingKey} is now schedule-specific for this schedule.`,
                        10000
                    );
                }

                // Schedule automods - open selected schedule editor
                else if (customId.startsWith('schedule_automod_edit_') && !customId.startsWith('schedule_automod_edit_level_') && !customId.startsWith('schedule_automod_edit_no_leader_') && !customId.startsWith('schedule_automod_edit_solo_tank_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                    await updatePanelMessage(interaction, panel);
                }

                // Schedule automods - edit module
                else if (customId.startsWith('schedule_automod_edit_level_') || customId.startsWith('schedule_automod_edit_no_leader_') || customId.startsWith('schedule_automod_edit_solo_tank_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    const moduleType = idParts.slice(3, idParts.length - 2).join('_');
                    const schedule = getScheduleById(srvNum, scheduleId);
                    if (!schedule) {
                        return replyEphemeralAutoDelete(interaction, 'Schedule not found.');
                    }
                    const crcon = crconServices[srvNum] || crconServices[1];
                    const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                    const draftMap = getScheduleAutoModDraftMap(moduleType);

                    let draft = draftMap.get(draftKey);
                    if (!draft) {
                        let baseConfig = schedule.automodConfigs?.[moduleType];
                        if (!baseConfig || typeof baseConfig !== 'object') {
                            try {
                                baseConfig = await getLiveAutoModConfig(crcon, moduleType);
                                const updateResult = scheduleManager.updateSchedule(srvNum, scheduleId, {
                                    automodConfigs: {
                                        ...(schedule.automodConfigs || {}),
                                        [moduleType]: baseConfig
                                    }
                                });
                                if (!updateResult.success) {
                                    return replyEphemeralAutoDelete(interaction, `Failed to enable schedule-specific ${moduleType}: ${updateResult.error}`);
                                }
                            } catch (error) {
                                logger.error(`[Schedule Automods S${srvNum}] Failed to load ${moduleType} config:`, error.message);
                                return replyEphemeralAutoDelete(interaction, `Failed to load current ${moduleType} config from server.`);
                            }
                        }
                        draft = JSON.parse(JSON.stringify(baseConfig || {}));
                        if (moduleType === 'level') {
                            draft.level_thresholds = { ...getDefaultLevelThresholds(), ...(draft.level_thresholds || {}) };
                        }
                        draftMap.set(draftKey, draft);
                    }

                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleAutomodModulePanel(srvNum, scheduleId, moduleType, draft);
                    await updatePanelMessage(interaction, panel);
                }

                // Schedule automods - edit level role thresholds
                else if (customId.startsWith('schedule_automod_roles_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    await interaction.deferUpdate();
                    const levelDraftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                    const levelDraft = scheduleAutoModLevelDrafts.get(levelDraftKey) || null;
                    const panel = schedulePanel.buildScheduleAutomodRolesPanel(srvNum, scheduleId, levelDraft);
                    await updatePanelMessage(interaction, panel);
                }

                // Schedule automods - toggle module between server default and schedule-specific
                else if (customId.startsWith('schedule_automod_toggle_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    const moduleType = idParts.slice(3, idParts.length - 2).join('_').replace('toggle_', '');
                    const schedule = getScheduleById(srvNum, scheduleId);

                    if (!schedule) {
                        return replyEphemeralAutoDelete(interaction, 'Schedule not found.');
                    }

                    const crcon = crconServices[srvNum] || crconServices[1];
                    const currentConfigs = schedule.automodConfigs || {};
                    let nextModuleConfig = null;
                    if (!currentConfigs[moduleType]) {
                        try {
                            nextModuleConfig = await getLiveAutoModConfig(crcon, moduleType);
                        } catch (error) {
                            logger.error(`[Schedule Automods S${srvNum}] Failed to enable ${moduleType}:`, error.message);
                            return replyEphemeralAutoDelete(interaction, `Failed to load current ${moduleType} config from server.`);
                        }
                    }

                    const nextConfigs = {
                        ...currentConfigs,
                        [moduleType]: nextModuleConfig
                    };

                    const updateResult = scheduleManager.updateSchedule(srvNum, scheduleId, { automodConfigs: nextConfigs });
                    if (!updateResult.success) {
                        return replyEphemeralAutoDelete(interaction, `Failed to update automod module: ${updateResult.error}`);
                    }

                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                    await updatePanelMessage(interaction, panel);
                    await followUpEphemeralAutoDelete(
                        interaction,
                        nextModuleConfig
                            ? `${moduleType} is now schedule-specific for this schedule.`
                            : `${moduleType} now uses current server settings for this schedule.`,
                        10000
                    );
                }

                // Schedule automods - refresh module draft from current server settings
                else if (customId.startsWith('schedule_automod_refresh_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    const moduleType = idParts.slice(3, idParts.length - 2).join('_').replace('refresh_', '');
                    const crcon = crconServices[srvNum] || crconServices[1];
                    if (!crcon) {
                        return replyEphemeralAutoDelete(interaction, 'CRCON service unavailable for this server.');
                    }

                    await interaction.deferUpdate();
                    try {
                        const draft = await getLiveAutoModConfig(crcon, moduleType);
                        const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                        getScheduleAutoModDraftMap(moduleType).set(draftKey, draft);
                        const panel = schedulePanel.buildScheduleAutomodModulePanel(srvNum, scheduleId, moduleType, draft);
                        await updatePanelMessage(interaction, panel);
                        await followUpEphemeralAutoDelete(interaction, `${moduleType} draft reloaded from server.`);
                    } catch (error) {
                        logger.error(`[Schedule Automods S${srvNum}] Failed to refresh ${moduleType}:`, error.message);
                        await followUpEphemeralAutoDelete(interaction, `Failed to load current ${moduleType} config from server.`);
                    }
                }

                // Schedule automods - save current draft directly to this schedule
                else if (customId.startsWith('schedule_automod_save_') || customId.startsWith('schedule_automod_commit_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    const moduleType = idParts
                        .slice(3, idParts.length - 2)
                        .join('_')
                        .replace(/^save_/, '')
                        .replace(/^commit_/, '');
                    const schedule = getScheduleById(srvNum, scheduleId);
                    if (!schedule) {
                        return replyEphemeralAutoDelete(interaction, 'Schedule not found.');
                    }

                    const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                    const draft = getScheduleAutoModDraftMap(moduleType).get(draftKey);
                    if (!draft) {
                        return replyEphemeralAutoDelete(interaction, `No ${moduleType} draft found. Open the panel and edit values first.`);
                    }

                    const updateResult = scheduleManager.updateSchedule(srvNum, scheduleId, {
                        automodConfigs: {
                            ...(schedule.automodConfigs || {}),
                            [moduleType]: draft
                        }
                    });
                    if (!updateResult.success) {
                        return replyEphemeralAutoDelete(interaction, `Failed to save schedule ${moduleType} config: ${updateResult.error}`);
                    }

                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleAutomodModulePanel(srvNum, scheduleId, moduleType, draft);
                    await updatePanelMessage(interaction, panel);
                    await followUpEphemeralAutoDelete(interaction, `${moduleType} saved to this schedule.`, 10000);
                }

                // Schedule automods - go back from module panel
                else if (customId.startsWith('schedule_automod_back_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                    await updatePanelMessage(interaction, panel);
                }

                // Schedule automods - load existing schedule config into draft on demand
                else if (customId.startsWith('schedule_automod_load_current_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    const schedule = getScheduleById(srvNum, scheduleId);
                    if (!schedule) {
                        return replyEphemeralAutoDelete(interaction, 'Schedule not found.');
                    }

                    const modules = ['level', 'no_leader', 'solo_tank'];
                    for (const moduleType of modules) {
                        const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                        const config = schedule.automodConfigs?.[moduleType] || {};
                        const draft = JSON.parse(JSON.stringify(config));
                        if (moduleType === 'level') {
                            draft.level_thresholds = { ...getDefaultLevelThresholds(), ...(draft.level_thresholds || {}) };
                        }
                        getScheduleAutoModDraftMap(moduleType).set(draftKey, draft);
                    }

                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                    await updatePanelMessage(interaction, panel);
                    await followUpEphemeralAutoDelete(interaction, 'Loaded schedule automod values into drafts.', 10000);
                }

                // Schedule automods - clear all module configs
                else if (customId.startsWith('schedule_automod_clear_')) {
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    const updateResult = scheduleManager.updateSchedule(srvNum, scheduleId, {
                        automodConfigs: {
                            level: null,
                            no_leader: null,
                            solo_tank: null
                        }
                    });
                    if (!updateResult.success) {
                        return replyEphemeralAutoDelete(interaction, `Failed to clear schedule automods: ${updateResult.error}`);
                    }
                    const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                    scheduleAutoModLevelDrafts.delete(draftKey);
                    scheduleAutoModNoLeaderDrafts.delete(draftKey);
                    scheduleAutoModSoloTankDrafts.delete(draftKey);

                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                    await updatePanelMessage(interaction, panel);
                    await followUpEphemeralAutoDelete(interaction, 'All modules now use server settings for this schedule.', 10000);
                }

                else if (customId.startsWith('schedule_automod_reset_')) {
                    // Legacy route compatibility - treat as clear module config.
                    const idParts = customId.split('_');
                    const srvNum = parseInt(idParts[idParts.length - 2], 10);
                    const scheduleId = idParts[idParts.length - 1];
                    const moduleType = idParts.slice(3, idParts.length - 2).join('_').replace('reset_', '');
                    const schedule = getScheduleById(srvNum, scheduleId);
                    if (!schedule) {
                        return replyEphemeralAutoDelete(interaction, 'Schedule not found.');
                    }
                    const updateResult = scheduleManager.updateSchedule(srvNum, scheduleId, {
                        automodConfigs: {
                            ...(schedule.automodConfigs || {}),
                            [moduleType]: null
                        }
                    });
                    if (!updateResult.success) {
                        return replyEphemeralAutoDelete(interaction, `Failed to reset schedule ${moduleType}: ${updateResult.error}`);
                    }
                    const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                    getScheduleAutoModDraftMap(moduleType).delete(draftKey);
                    await interaction.deferUpdate();
                    const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                    await updatePanelMessage(interaction, panel);
                    await followUpEphemeralAutoDelete(interaction, `${moduleType} now uses server settings for this schedule.`, 10000);
                }

                // Manage maps - show schedule selection
                else if (customId.startsWith('schedule_maps_')) {
                    await interaction.deferUpdate();
                    const srvNum = parseInt(customId.split('_').pop());
                    const panel = schedulePanel.buildScheduleMapSelectPanel(srvNum);
                    await updatePanelMessage(interaction, panel);
                }

                // Schedule automods - show schedule selection
                else if (customId.startsWith('schedule_automods_')) {
                    await interaction.deferUpdate();
                    const srvNum = parseInt(customId.split('_').pop());
                    const panel = schedulePanel.buildScheduleAutomodSelectPanel(srvNum);
                    await updatePanelMessage(interaction, panel);
                }
            }

            // ========== SCHEDULE WHITELIST BUTTONS ==========
            else if (customId.startsWith('sched_wl_')) {
                const schedWlServerNum = getScheduleWhitelistServerNum(customId);
                const crcon = schedWlServerNum ? crconServices[schedWlServerNum] : null;
                if (!crcon) {
                    return interaction.reply({ content: 'CRCON service not available.', flags: MessageFlags.Ephemeral });
                }

                // Parse common parts
                const parts = customId.split('_');

                // Use all maps mode
                if (customId.startsWith('sched_wl_useall_')) {
                    const srvNum = parseInt(parts[3]);
                    const scheduleId = parts[4];
                    await interaction.deferUpdate();
                    schedulePanel.setScheduleUseAllMaps(srvNum, scheduleId);
                    const panel = await schedulePanel.buildScheduleWhitelistPanel(srvNum, scheduleId, crcon);
                    await updatePanelMessage(interaction, panel);
                }

                // Custom selection mode
                else if (customId.startsWith('sched_wl_custom_')) {
                    const srvNum = parseInt(parts[3]);
                    const scheduleId = parts[4];
                    await interaction.deferUpdate();
                    await schedulePanel.initScheduleCustomWhitelist(srvNum, scheduleId, crcon);
                    const panel = await schedulePanel.buildScheduleWhitelistPanel(srvNum, scheduleId, crcon);
                    await updatePanelMessage(interaction, panel);
                }

                // Filter buttons
                else if (customId.startsWith('sched_wl_filter_')) {
                    const srvNum = parseInt(parts[3]);
                    const scheduleId = parts[4];
                    const filterType = parts[5];
                    const filter = filterType === 'all' ? null : filterType;
                    await interaction.deferUpdate();
                    const panel = await schedulePanel.buildScheduleWhitelistPanel(srvNum, scheduleId, crcon, 0, filter);
                    await updatePanelMessage(interaction, panel);
                }

                // Pagination
                else if (customId.startsWith('sched_wl_prev_') || customId.startsWith('sched_wl_next_')) {
                    const srvNum = parseInt(parts[3]);
                    const scheduleId = parts[4];
                    const currentPage = parseInt(parts[5]);
                    const filterType = parts[6];
                    const filter = filterType === 'all' ? null : filterType;
                    const newPage = customId.includes('_prev_') ? currentPage - 1 : currentPage + 1;
                    await interaction.deferUpdate();
                    const panel = await schedulePanel.buildScheduleWhitelistPanel(srvNum, scheduleId, crcon, newPage, filter);
                    await updatePanelMessage(interaction, panel);
                }

                // Add all maps (with filter)
                else if (customId.startsWith('sched_wl_add_all_')) {
                    const srvNum = parseInt(parts[4]);
                    const scheduleId = parts[5];
                    const filterType = parts[6];
                    const filter = filterType === 'all' ? null : filterType;
                    await interaction.deferUpdate();

                    const mapsResponse = await crcon.getMaps();
                    const allMaps = mapsResponse?.result || [];
                    schedulePanel.addAllMapsToSchedule(srvNum, scheduleId, allMaps, filter);

                    const panel = await schedulePanel.buildScheduleWhitelistPanel(srvNum, scheduleId, crcon, 0, filter);
                    await updatePanelMessage(interaction, panel);
                }

                // Remove all maps (with filter)
                else if (customId.startsWith('sched_wl_remove_all_')) {
                    const srvNum = parseInt(parts[4]);
                    const scheduleId = parts[5];
                    const filterType = parts[6];
                    const filter = filterType === 'all' ? null : filterType;
                    await interaction.deferUpdate();

                    const mapsResponse = await crcon.getMaps();
                    const allMaps = mapsResponse?.result || [];
                    schedulePanel.removeAllMapsFromSchedule(srvNum, scheduleId, allMaps, filter);

                    const panel = await schedulePanel.buildScheduleWhitelistPanel(srvNum, scheduleId, crcon, 0, filter);
                    await updatePanelMessage(interaction, panel);
                }
            }

            else if (customId.startsWith('nonseed_wl_')) {
                const nonSeedServerNum = getNonSeededWhitelistServerNum(customId);
                const crcon = nonSeedServerNum ? crconServices[nonSeedServerNum] : null;
                if (!crcon) {
                    return interaction.reply({ content: 'CRCON service not available.', flags: MessageFlags.Ephemeral });
                }

                const parts = customId.split('_');
                const srvNum = parseInt(parts[3], 10);

                if (customId.startsWith('nonseed_wl_fill_')) {
                    await interaction.deferUpdate();
                    const mapsResponse = await crcon.getMaps();
                    const allMaps = (mapsResponse?.result || []).map(map => map.id);
                    configManager.setNonSeededMapList(srvNum, allMaps);
                    const panel = await mapVotePanelService.buildNonSeededMapListPanel(srvNum, crcon);
                    await updatePanelMessage(interaction, panel);
                }

                else if (customId.startsWith('nonseed_wl_clear_')) {
                    await interaction.deferUpdate();
                    configManager.setNonSeededMapList(srvNum, []);
                    const panel = await mapVotePanelService.buildNonSeededMapListPanel(srvNum, crcon);
                    await updatePanelMessage(interaction, panel);
                }

                else if (customId.startsWith('nonseed_wl_filter_')) {
                    const filterType = parts[4];
                    const filter = filterType === 'all' ? null : filterType;
                    await interaction.deferUpdate();
                    const panel = await mapVotePanelService.buildNonSeededMapListPanel(srvNum, crcon, 0, filter);
                    await updatePanelMessage(interaction, panel);
                }

                else if (customId.startsWith('nonseed_wl_prev_') || customId.startsWith('nonseed_wl_next_')) {
                    const currentPage = parseInt(parts[4], 10);
                    const filterType = parts[5];
                    const filter = filterType === 'all' ? null : filterType;
                    const newPage = customId.includes('_prev_') ? currentPage - 1 : currentPage + 1;
                    await interaction.deferUpdate();
                    const panel = await mapVotePanelService.buildNonSeededMapListPanel(srvNum, crcon, newPage, filter);
                    await updatePanelMessage(interaction, panel);
                }
            }
        }

        // ========== SELECT MENU INTERACTIONS ==========
        else if (interaction.isStringSelectMenu()) {
            const customId = interaction.customId;

            // ========== SETUP SELECT MENUS ==========
            if (customId === 'setup_select_edit') {
                if (!isServerOwner(interaction.member)) {
                    return interaction.reply({ content: 'Only server owners can modify setup.', flags: MessageFlags.Ephemeral });
                }
                const serverNum = interaction.values[0];
                const existingConfig = configManager.getServerConfig(serverNum);
                await interaction.update(setupWizard.buildTransportModeSelectPanel('edit', serverNum, existingConfig));
            }

            else if (customId === 'setup_select_transport_mode') {
                if (!isServerOwner(interaction.member)) {
                    return interaction.reply({ content: 'Only server owners can modify setup.', flags: MessageFlags.Ephemeral });
                }
                const [action, serverNum, transportMode] = interaction.values[0].split('|');
                const existingConfig = action === 'edit' ? configManager.getServerConfig(serverNum) : null;
                const modal = setupWizard.buildServerModal(serverNum, existingConfig, transportMode);
                await interaction.showModal(modal);
            }

            else if (customId === 'setup_select_rcon') {
                if (!isServerOwner(interaction.member)) {
                    return interaction.reply({ content: 'Only server owners can modify setup.', flags: MessageFlags.Ephemeral });
                }
                const serverNum = interaction.values[0];
                const existingConfig = configManager.getServerConfig(serverNum);
                const modal = setupWizard.buildRconModal(serverNum, existingConfig);
                await interaction.showModal(modal);
            }

            else if (customId === 'setup_select_remove') {
                if (!isServerOwner(interaction.member)) {
                    return interaction.reply({ content: 'Only server owners can modify setup.', flags: MessageFlags.Ephemeral });
                }
                const serverNum = interaction.values[0];
                const config = configManager.getServerConfig(serverNum);
                setupWizard.removeServer(serverNum);
                await interaction.update(setupWizard.buildSetupPanel());
                await interaction.followUp({
                    content: `Server ${serverNum} (${config?.serverName || 'Unnamed'}) removed. Click **Apply & Restart** to apply changes.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            else if (customId === 'setup_select_admin_role') {
                if (!isServerOwner(interaction.member)) {
                    return interaction.reply({ content: 'Only server owners can modify setup.', flags: MessageFlags.Ephemeral });
                }
                const roleId = interaction.values[0];
                const role = interaction.guild.roles.cache.get(roleId);
                setupWizard.setAdminRole(roleId);
                await interaction.update(setupWizard.buildSetupPanel());
                await interaction.followUp({
                    content: `Admin role set to **${role?.name || 'Unknown'}**. Users with this role can now use all bot commands.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // ========== SCHEDULE SELECT MENUS ==========
            else if (customId.startsWith('schedule_set_timezone_')) {
                const srvNum = parseInt(customId.split('_').pop());
                const timezone = interaction.values[0];
                scheduleManager.setTimezone(srvNum, timezone);
                await interaction.update(schedulePanel.buildSchedulePanel(srvNum));
                await interaction.followUp({
                    content: `Timezone set to ${timezone}.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            else if (customId.startsWith('schedule_days_select_')) {
                const idParts = customId.split('_');
                const scheduleId = idParts[idParts.length - 1];
                const srvNum = parseInt(idParts[idParts.length - 2], 10);
                const selectedDays = interaction.values;

                const updateResult = scheduleManager.updateSchedule(srvNum, scheduleId, { days: selectedDays });
                if (!updateResult.success) {
                    return replyEphemeralAutoDelete(interaction, `Failed to save schedule days: ${updateResult.error}`);
                }
                await interaction.update(schedulePanel.buildDaySelectPanel(srvNum, scheduleId));
                await interaction.followUp({
                    content: `Schedule days updated: ${selectedDays.join(', ')}.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            else if (customId.startsWith('schedule_select_edit_')) {
                const srvNum = parseInt(customId.split('_').pop());
                const scheduleId = interaction.values[0];
                const schedules = scheduleManager.getSchedules(srvNum);
                const schedule = schedules.find(s => s.id === scheduleId);
                const modal = schedulePanel.buildScheduleModal(srvNum, schedule);
                await interaction.showModal(modal);
            }

            else if (customId.startsWith('schedule_select_delete_')) {
                const srvNum = parseInt(customId.split('_').pop());
                const scheduleId = interaction.values[0];
                const schedules = scheduleManager.getSchedules(srvNum);
                const schedule = schedules.find(s => s.id === scheduleId);
                scheduleManager.deleteSchedule(srvNum, scheduleId);
                await interaction.update(schedulePanel.buildSchedulePanel(srvNum));
                await interaction.followUp({
                    content: `Schedule "${schedule?.name || 'Unknown'}" deleted.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            else if (customId.startsWith('schedule_override_select_')) {
                const srvNum = parseInt(customId.split('_').pop());
                const scheduleId = interaction.values[0];
                await interaction.deferUpdate();
                const panel = schedulePanel.buildOverrideTypePanel(srvNum, scheduleId);
                await updatePanelMessage(interaction, panel);
            }

            // Select schedule for map management
            else if (customId.startsWith('schedule_select_maps_')) {
                const srvNum = parseInt(customId.split('_').pop());
                const scheduleId = interaction.values[0];
                const crcon = crconServices[srvNum] || crconServices[1];
                await interaction.deferUpdate();
                const panel = await schedulePanel.buildScheduleWhitelistPanel(srvNum, scheduleId, crcon);
                await updatePanelMessage(interaction, panel);
            }

            // Select schedule for automod editing
            else if (customId.startsWith('schedule_select_automods_')) {
                const srvNum = parseInt(customId.split('_').pop(), 10);
                const scheduleId = interaction.values[0];
                await interaction.deferUpdate();
                const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                await updatePanelMessage(interaction, panel);
            }

            // Select schedule for general settings editing
            else if (customId.startsWith('schedule_select_general_')) {
                const srvNum = parseInt(customId.split('_').pop(), 10);
                const scheduleId = interaction.values[0];
                const generalSettings = await getLiveGeneralSettings(crconServices[srvNum] || crconServices[1], srvNum);
                await interaction.deferUpdate();
                const panel = schedulePanel.buildScheduleGeneralPanel(srvNum, scheduleId, generalSettings);
                await updatePanelMessage(interaction, panel);
            }

            // Select schedule automod module field to edit
            else if (customId.startsWith('schedule_automod_field_')) {
                const idParts = customId.split('_');
                const srvNum = parseInt(idParts[idParts.length - 2], 10);
                const scheduleId = idParts[idParts.length - 1];
                const moduleType = idParts.slice(3, idParts.length - 3).join('_');
                const fieldKey = interaction.values[0];
                const fieldDefs = getScheduleAutomodFieldDefinitions(moduleType);
                const fieldDef = fieldDefs?.find(field => field.key === fieldKey);

                if (!fieldDef) {
                    return replyEphemeralAutoDelete(interaction, 'Unknown schedule automod field selected.');
                }

                const schedule = getScheduleById(srvNum, scheduleId);
                if (!schedule) {
                    return replyEphemeralAutoDelete(interaction, 'Schedule not found.');
                }

                const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                const draftMap = getScheduleAutoModDraftMap(moduleType);
                let moduleConfig = draftMap.get(draftKey);
                if (!moduleConfig) {
                    moduleConfig = JSON.parse(JSON.stringify(schedule.automodConfigs?.[moduleType] || {}));
                    if (moduleType === 'level') {
                        moduleConfig.level_thresholds = { ...getDefaultLevelThresholds(), ...(moduleConfig.level_thresholds || {}) };
                    }
                    draftMap.set(draftKey, moduleConfig);
                }
                let currentValue = moduleConfig[fieldKey];
                if (fieldDef.type === 'string_array') {
                    currentValue = Array.isArray(currentValue) ? currentValue.join(', ') : '';
                } else if (currentValue === null || currentValue === undefined) {
                    currentValue = '';
                } else {
                    currentValue = String(currentValue);
                }

                const modal = new ModalBuilder()
                    .setCustomId(`schedule_automod_field_modal_${moduleType}_${srvNum}_${scheduleId}_${fieldKey}`)
                    .setTitle(`Schedule ${moduleType} - ${fieldDef.label}`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel(`${fieldDef.label} (${fieldDef.type})`)
                                .setStyle(fieldDef.multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
                                .setRequired(false)
                                .setValue(currentValue.substring(0, 4000))
                        )
                    );

                await interaction.showModal(modal);
            }

            // Select schedule level role threshold to edit
            else if (customId.startsWith('schedule_automod_role_select_')) {
                const idParts = customId.split('_');
                const srvNum = parseInt(idParts[idParts.length - 2], 10);
                const scheduleId = idParts[idParts.length - 1];
                const roleKey = interaction.values[0];
                const roleKeys = mapVotePanelService.getLevelRoleKeys();
                if (!roleKeys.includes(roleKey)) {
                    return replyEphemeralAutoDelete(interaction, 'Unknown role selected.');
                }

                const schedule = getScheduleById(srvNum, scheduleId);
                if (!schedule) {
                    return replyEphemeralAutoDelete(interaction, 'Schedule not found.');
                }

                const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                let levelCfg = scheduleAutoModLevelDrafts.get(draftKey);
                if (!levelCfg) {
                    levelCfg = JSON.parse(JSON.stringify(schedule.automodConfigs?.level || {}));
                }
                levelCfg = {
                    ...levelCfg,
                    level_thresholds: {
                        ...getDefaultLevelThresholds(),
                        ...(levelCfg.level_thresholds || {})
                    }
                };
                scheduleAutoModLevelDrafts.set(draftKey, levelCfg);
                const roleConfig = levelCfg.level_thresholds?.[roleKey] || getDefaultLevelThresholds()[roleKey];

                const modal = new ModalBuilder()
                    .setCustomId(`schedule_automod_role_modal_${srvNum}_${scheduleId}_${roleKey}`)
                    .setTitle(`Schedule Level Role - ${roleKey}`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('label')
                                .setLabel('Label')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setValue(String(roleConfig?.label || roleKey).substring(0, 100))
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('min_level')
                                .setLabel('Min Level')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setValue(String(roleConfig?.min_level ?? 0))
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('min_players')
                                .setLabel('Min Players')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setValue(String(roleConfig?.min_players ?? 0))
                        )
                    );

                await interaction.showModal(modal);
            }

            // Select schedule for export
            else if (customId.startsWith('schedule_select_export_')) {
                const srvNum = parseInt(customId.split('_').pop());
                const scheduleId = interaction.values[0];
                const crcon = crconServices[srvNum] || crconServices[1];
                const service = mapVotingServices[srvNum] || mapVotingServices[1];
                const config = configManager.getEffectiveServerConfig(srvNum);
                const serverName = config.serverName || `Server ${srvNum}`;

                if (!crcon) {
                    return interaction.reply({ content: 'CRCON service not available for export.', flags: MessageFlags.Ephemeral });
                }
                if (!service) {
                    return interaction.reply({ content: 'Map voting service not available for export.', flags: MessageFlags.Ephemeral });
                }

                await interaction.deferUpdate();

                const exportResult = scheduleId === '__all__'
                    ? await schedulePanel.buildAllSchedulesExport(srvNum, crcon, serverName)
                    : await schedulePanel.buildScheduleExport(srvNum, scheduleId, crcon, serverName);
                if (!exportResult.success) {
                    await followUpEphemeralAutoDelete(
                        interaction,
                        exportResult.error || 'Failed to export schedule.'
                    );
                    return;
                }

                const sendResult = await sendTemporaryScheduleExport(
                    interaction,
                    exportResult.filename,
                    exportResult.content,
                    30000
                );
                if (!sendResult.success) {
                    await followUpEphemeralAutoDelete(
                        interaction,
                        sendResult.error || 'Export file could not be posted to this channel.'
                    );
                    return;
                }

                const panel = await mapVotePanelService.buildControlPanel(service, crcon, serverName);
                await updatePanelMessage(interaction, panel);
                await followUpEphemeralAutoDelete(
                    interaction,
                    `Exported "${exportResult.scheduleName}" (${exportResult.mapCount} maps). File will auto-delete in 30 seconds.`,
                    5000
                );
            }

            // Select No Solo Tank field to edit
            else if (customId.startsWith('automod_solo_tank_field_')) {
                if (!isAdmin(interaction.member)) {
                    return interaction.reply({ content: 'You do not have permission.', flags: MessageFlags.Ephemeral });
                }

                const srvNum = parseInt(customId.split('_').pop(), 10);
                const fieldKey = interaction.values[0];
                const fieldDefs = mapVotePanelService.getSoloTankFieldDefinitions();
                const fieldDef = fieldDefs.find(field => field.key === fieldKey);
                if (!fieldDef) {
                    return interaction.reply({ content: 'Unknown field selected.', flags: MessageFlags.Ephemeral });
                }

                const draftKey = getAutoModDraftKey(srvNum, interaction.user.id);
                const draft = autoModSoloTankDrafts.get(draftKey) || {};
                let currentValue = draft[fieldKey];
                if (fieldDef.type === 'string_array') {
                    currentValue = Array.isArray(currentValue) ? currentValue.join(', ') : '';
                } else if (currentValue === null || currentValue === undefined) {
                    currentValue = '';
                } else {
                    currentValue = String(currentValue);
                }

                const modal = new ModalBuilder()
                    .setCustomId(`automod_solo_tank_modal_${srvNum}_${fieldKey}`)
                    .setTitle(`Edit ${fieldDef.label}`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel(`${fieldDef.label} (${fieldDef.type})`)
                                .setStyle(fieldDef.multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
                                .setRequired(false)
                                .setValue(currentValue.substring(0, 4000))
                        )
                    );

                await interaction.showModal(modal);
            }

            // Select No Leader field to edit
            else if (customId.startsWith('automod_no_leader_field_')) {
                if (!isAdmin(interaction.member)) {
                    return interaction.reply({ content: 'You do not have permission.', flags: MessageFlags.Ephemeral });
                }

                const srvNum = parseInt(customId.split('_').pop(), 10);
                const fieldKey = interaction.values[0];
                const fieldDefs = mapVotePanelService.getNoLeaderFieldDefinitions();
                const fieldDef = fieldDefs.find(field => field.key === fieldKey);
                if (!fieldDef) {
                    return interaction.reply({ content: 'Unknown field selected.', flags: MessageFlags.Ephemeral });
                }

                const draftKey = getAutoModDraftKey(srvNum, interaction.user.id);
                const draft = autoModNoLeaderDrafts.get(draftKey) || {};
                let currentValue = draft[fieldKey];
                if (fieldDef.type === 'string_array') {
                    currentValue = Array.isArray(currentValue) ? currentValue.join(', ') : '';
                } else if (currentValue === null || currentValue === undefined) {
                    currentValue = '';
                } else {
                    currentValue = String(currentValue);
                }

                const modal = new ModalBuilder()
                    .setCustomId(`automod_no_leader_modal_${srvNum}_${fieldKey}`)
                    .setTitle(`Edit ${fieldDef.label}`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel(`${fieldDef.label} (${fieldDef.type})`)
                                .setStyle(fieldDef.multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
                                .setRequired(false)
                                .setValue(currentValue.substring(0, 4000))
                        )
                    );

                await interaction.showModal(modal);
            }

            // Select Level general field to edit
            else if (customId.startsWith('automod_level_general_field_')) {
                if (!isAdmin(interaction.member)) {
                    return interaction.reply({ content: 'You do not have permission.', flags: MessageFlags.Ephemeral });
                }

                const srvNum = parseInt(customId.split('_').pop(), 10);
                const fieldKey = interaction.values[0];
                const fieldDefs = mapVotePanelService.getLevelGeneralFieldDefinitions();
                const fieldDef = fieldDefs.find(field => field.key === fieldKey);
                if (!fieldDef) {
                    return interaction.reply({ content: 'Unknown field selected.', flags: MessageFlags.Ephemeral });
                }

                const draftKey = getAutoModDraftKey(srvNum, interaction.user.id);
                const draft = autoModLevelDrafts.get(draftKey) || {};
                let currentValue = draft[fieldKey];
                if (fieldDef.type === 'string_array') {
                    currentValue = Array.isArray(currentValue) ? currentValue.join(', ') : '';
                } else if (currentValue === null || currentValue === undefined) {
                    currentValue = '';
                } else {
                    currentValue = String(currentValue);
                }

                const modal = new ModalBuilder()
                    .setCustomId(`automod_level_general_modal_${srvNum}_${fieldKey}`)
                    .setTitle(`Edit ${fieldDef.label}`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('value')
                                .setLabel(`${fieldDef.label} (${fieldDef.type})`)
                                .setStyle(fieldDef.multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
                                .setRequired(false)
                                .setValue(currentValue.substring(0, 4000))
                        )
                    );

                await interaction.showModal(modal);
            }

            // Select role threshold to edit
            else if (customId.startsWith('automod_level_roles_select_')) {
                if (!isAdmin(interaction.member)) {
                    return interaction.reply({ content: 'You do not have permission.', flags: MessageFlags.Ephemeral });
                }

                const srvNum = parseInt(customId.split('_').pop(), 10);
                const roleKey = interaction.values[0];
                const roleKeys = mapVotePanelService.getLevelRoleKeys();
                if (!roleKeys.includes(roleKey)) {
                    return interaction.reply({ content: 'Unknown role selected.', flags: MessageFlags.Ephemeral });
                }

                const draftKey = getAutoModDraftKey(srvNum, interaction.user.id);
                const draft = autoModLevelDrafts.get(draftKey) || { level_thresholds: getDefaultLevelThresholds() };
                const roleConfig = draft.level_thresholds?.[roleKey] || getDefaultLevelThresholds()[roleKey];

                const modal = new ModalBuilder()
                    .setCustomId(`automod_level_roles_modal_${srvNum}_${roleKey}`)
                    .setTitle(`Edit ${roleKey}`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('label')
                                .setLabel('Label')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setValue(String(roleConfig?.label || roleKey).substring(0, 100))
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('min_level')
                                .setLabel('Min Level')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setValue(String(roleConfig?.min_level ?? 0))
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('min_players')
                                .setLabel('Min Players')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setValue(String(roleConfig?.min_players ?? 0))
                        )
                    );

                await interaction.showModal(modal);
            }

            // Toggle maps in schedule whitelist
            else if (customId.startsWith('sched_wl_toggle_')) {
                const parts = customId.split('_');
                const srvNum = parseInt(parts[3]);
                const scheduleId = parts[4];
                const mapIds = interaction.values;
                const crcon = crconServices[srvNum] || crconServices[1];

                await interaction.deferUpdate();

                const mapsResponse = await crcon.getMaps();
                const allMaps = mapsResponse?.result || [];
                schedulePanel.toggleScheduleWhitelistMaps(srvNum, scheduleId, mapIds, allMaps);

                const panel = await schedulePanel.buildScheduleWhitelistPanel(srvNum, scheduleId, crcon);
                await updatePanelMessage(interaction, panel);
            }

            else if (customId.startsWith('nonseed_wl_toggle_')) {
                const srvNum = parseInt(customId.split('_')[3], 10);
                const mapIds = interaction.values;
                const crcon = crconServices[srvNum] || crconServices[1];
                const currentList = configManager.getNonSeededMapList(srvNum);
                const updatedSet = new Set(currentList);

                for (const mapId of mapIds) {
                    if (updatedSet.has(mapId)) {
                        updatedSet.delete(mapId);
                    } else {
                        updatedSet.add(mapId);
                    }
                }

                await interaction.deferUpdate();
                configManager.setNonSeededMapList(srvNum, [...updatedSet]);
                const panel = await mapVotePanelService.buildNonSeededMapListPanel(srvNum, crcon);
                await updatePanelMessage(interaction, panel);
            }

            // ========== MAP VOTING SELECT MENUS ==========
            else if (customId === 'mapvote_wl_toggle_map') {
                if (!isAdmin(interaction.member)) {
                    return interaction.reply({ content: 'You do not have permission.', flags: MessageFlags.Ephemeral });
                }

                await interaction.deferUpdate();

                const mapId = interaction.values[0];
                if (mapId === 'none') return;

                // Determine server
                let serverNum = 1;
                const crcon = crconServices[serverNum];
                const service = mapVotingServices[serverNum];

                try {
                    // Check current state
                    const whitelist = await crcon.getVotemapWhitelist();
                    const isWhitelisted = whitelist?.result?.includes(mapId);

                    if (isWhitelisted) {
                        await crcon.removeFromVotemapWhitelist(mapId);
                        logger.info(`Removed ${mapId} from whitelist`);
                    } else {
                        await crcon.addToVotemapWhitelist(mapId);
                        logger.info(`Added ${mapId} to whitelist`);
                    }

                    service.clearCache();
                } catch (e) {
                    logger.error(`Error toggling map ${mapId}:`, e);
                }

                const panel = await mapVotePanelService.buildWhitelistPanel(crcon);
                await updatePanelMessage(interaction, panel);
            }
        }

        // ========== MODAL SUBMISSIONS ==========
        else if (interaction.isModalSubmit()) {
            const customId = interaction.customId;

            // ========== SCHEDULE MODALS ==========
            if (customId.startsWith('schedule_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                // Parse server num and optional schedule id
                const idParts = customId.replace('schedule_modal_', '').split('_');
                const srvNum = parseInt(idParts[0]);
                const scheduleId = idParts[1] || null;

                const result = schedulePanel.processScheduleModal(interaction, srvNum, scheduleId);

                if (result.success) {
                    const action = result.isNew ? 'created' : 'updated';
                    await interaction.editReply({ content: `Schedule ${action} successfully!` });

                    // Show day selection after create/edit so days can be changed in the same flow
                    if (result.schedule) {
                        const panel = schedulePanel.buildDaySelectPanel(srvNum, result.schedule.id);
                        await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                    } else {
                        const panel = schedulePanel.buildSchedulePanel(srvNum);
                        await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                    }
                } else {
                    await interaction.editReply({ content: `Error: ${result.error}` });
                }
                return;
            }

            // Override hours modal
            if (customId.startsWith('schedule_override_hours_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const idParts = customId.replace('schedule_override_hours_modal_', '').split('_');
                const srvNum = parseInt(idParts[0]);
                const scheduleId = idParts[1];
                const hours = parseInt(interaction.fields.getTextInputValue('hours'));

                if (isNaN(hours) || hours < 1 || hours > 24) {
                    await interaction.editReply({ content: 'Hours must be between 1 and 24.' });
                    return;
                }

                scheduleManager.setOverride(srvNum, scheduleId, 'hours', hours);
                await interaction.editReply({ content: `Override set for ${hours} hour(s).` });
                const panel = schedulePanel.buildSchedulePanel(srvNum);
                await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                return;
            }

            if (customId.startsWith('schedule_general_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const idParts = customId.replace('schedule_general_modal_', '').split('_');
                const settingKey = idParts[0];
                const srvNum = parseInt(idParts[idParts.length - 2], 10);
                const scheduleId = idParts[idParts.length - 1];
                const schedule = getScheduleById(srvNum, scheduleId);
                if (!schedule) {
                    await interaction.editReply({ content: 'Schedule not found.' });
                    return;
                }

                const labelMap = {
                    teamSwitchCooldown: 'Team Switch Cooldown',
                    idleAutokickTime: 'Idle Autokick Time',
                    maxPingAutokick: 'Max Ping Autokick',
                    mapVoteCooldownVotes: 'Map Vote Cooldown'
                };
                if (!labelMap[settingKey]) {
                    await interaction.editReply({ content: 'Unknown setting key.' });
                    return;
                }

                let nextValue;
                try {
                    nextValue = parseNonNegativeInteger(interaction.fields.getTextInputValue('value'), labelMap[settingKey]);
                    if (settingKey === 'mapVoteCooldownVotes' && nextValue > 10) {
                        throw new Error('Map Vote Cooldown must be between 0 and 10 votes.');
                    }
                } catch (error) {
                    await interaction.editReply({ content: error.message });
                    return;
                }

                const currentGeneralSettings = {
                    teamSwitchCooldown: null,
                    idleAutokickTime: null,
                    maxPingAutokick: null,
                    mapVoteCooldownVotes: null,
                    ...(schedule.generalSettings || {})
                };

                const updateResult = scheduleManager.updateSchedule(srvNum, scheduleId, {
                    generalSettings: {
                        ...currentGeneralSettings,
                        [settingKey]: nextValue
                    }
                });
                if (!updateResult.success) {
                    await interaction.editReply({ content: `Failed to save schedule setting: ${updateResult.error}` });
                    return;
                }

                const generalSettings = await getLiveGeneralSettings(crconServices[srvNum] || crconServices[1], srvNum);
                const panel = schedulePanel.buildScheduleGeneralPanel(srvNum, scheduleId, generalSettings);
                await editReplyEphemeralAutoDelete(interaction, `Saved **${labelMap[settingKey]}** to this schedule.`, 10000);
                await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                return;
            }

            if (customId.startsWith('schedule_automod_field_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const match = customId.match(/^schedule_automod_field_modal_(level|no_leader|solo_tank)_(\d+)_([^_]+)_(.+)$/);
                if (!match) {
                    await interaction.editReply({ content: 'Invalid schedule automod modal ID.' });
                    return;
                }
                const moduleType = match[1];
                const srvNum = parseInt(match[2], 10);
                const scheduleId = match[3];
                const fieldKey = match[4];

                const fieldDefs = getScheduleAutomodFieldDefinitions(moduleType);
                const fieldDef = fieldDefs?.find(field => field.key === fieldKey);
                if (!fieldDef) {
                    await interaction.editReply({ content: 'Unknown schedule automod field.' });
                    return;
                }

                const schedule = getScheduleById(srvNum, scheduleId);
                if (!schedule) {
                    await interaction.editReply({ content: 'Schedule not found.' });
                    return;
                }

                let parsedValue;
                try {
                    const rawValue = interaction.fields.getTextInputValue('value');
                    parsedValue = parseAutoModValue(rawValue, fieldDef.type);
                } catch (error) {
                    await interaction.editReply({ content: `Invalid value: ${error.message}` });
                    return;
                }

                const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                const draftMap = getScheduleAutoModDraftMap(moduleType);
                let currentModule = draftMap.get(draftKey);
                if (!currentModule) {
                    currentModule = JSON.parse(JSON.stringify(schedule.automodConfigs?.[moduleType] || {}));
                }
                const nextModule = { ...currentModule, [fieldKey]: parsedValue };
                if (moduleType === 'level') {
                    nextModule.level_thresholds = {
                        ...getDefaultLevelThresholds(),
                        ...(nextModule.level_thresholds || {})
                    };
                }
                draftMap.set(draftKey, nextModule);

                const panel = schedulePanel.buildScheduleAutomodModulePanel(srvNum, scheduleId, moduleType, nextModule);
                await editReplyEphemeralAutoDelete(interaction, `Updated **${fieldDef.label}** in draft.`, 10000);
                await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                return;
            }

            if (customId.startsWith('schedule_automod_role_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const idParts = customId.replace('schedule_automod_role_modal_', '').split('_');
                const roleKey = idParts[idParts.length - 1];
                const scheduleId = idParts[idParts.length - 2];
                const srvNum = parseInt(idParts[idParts.length - 3], 10);

                const roleKeys = mapVotePanelService.getLevelRoleKeys();
                if (!roleKeys.includes(roleKey)) {
                    await interaction.editReply({ content: 'Unknown role submitted.' });
                    return;
                }

                const schedule = getScheduleById(srvNum, scheduleId);
                if (!schedule) {
                    await interaction.editReply({ content: 'Schedule not found.' });
                    return;
                }

                const label = interaction.fields.getTextInputValue('label').trim();
                if (!label) {
                    await interaction.editReply({ content: 'Label cannot be empty.' });
                    return;
                }

                let minLevel;
                let minPlayers;
                try {
                    minLevel = parseAutoModValue(interaction.fields.getTextInputValue('min_level'), 'integer');
                    minPlayers = parseAutoModValue(interaction.fields.getTextInputValue('min_players'), 'integer');
                } catch (error) {
                    await interaction.editReply({ content: `Invalid role threshold value: ${error.message}` });
                    return;
                }

                const draftKey = getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id);
                const baseLevel = scheduleAutoModLevelDrafts.get(draftKey) || JSON.parse(JSON.stringify(schedule.automodConfigs?.level || {}));
                const levelCfg = {
                    ...baseLevel,
                    level_thresholds: {
                        ...getDefaultLevelThresholds(),
                        ...(baseLevel.level_thresholds || {})
                    }
                };
                levelCfg.level_thresholds[roleKey] = {
                    label,
                    min_level: minLevel,
                    min_players: minPlayers
                };
                scheduleAutoModLevelDrafts.set(draftKey, levelCfg);

                const panel = schedulePanel.buildScheduleAutomodRolesPanel(srvNum, scheduleId, levelCfg);
                await editReplyEphemeralAutoDelete(interaction, `Updated role threshold **${roleKey}** in draft.`, 10000);
                await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                return;
            }

            if (customId.startsWith('automod_solo_tank_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const match = customId.match(/^automod_solo_tank_modal_(\d+)_(.+)$/);
                if (!match) {
                    await interaction.editReply({ content: 'Invalid automod modal ID.' });
                    return;
                }

                const srvNum = parseInt(match[1], 10);
                const fieldKey = match[2];
                const fieldDefs = mapVotePanelService.getSoloTankFieldDefinitions();
                const fieldDef = fieldDefs.find(field => field.key === fieldKey);

                if (!fieldDef) {
                    await interaction.editReply({ content: 'Unknown field submitted.' });
                    return;
                }

                const rawValue = interaction.fields.getTextInputValue('value');
                const draftKey = getAutoModDraftKey(srvNum, interaction.user.id);
                const draft = autoModSoloTankDrafts.get(draftKey) || {};

                let parsedValue;
                try {
                    parsedValue = parseAutoModValue(rawValue, fieldDef.type);
                } catch (e) {
                    await interaction.editReply({ content: `Invalid value: ${e.message}` });
                    return;
                }

                draft[fieldKey] = parsedValue;
                autoModSoloTankDrafts.set(draftKey, draft);

                const config = configManager.getEffectiveServerConfig(srvNum);
                const serverName = config.serverName || `Server ${srvNum}`;
                const panel = mapVotePanelService.buildAutoModSoloTankPanel(
                    srvNum,
                    serverName,
                    draft,
                    'draft'
                );

                await editReplyEphemeralAutoDelete(interaction, `Updated **${fieldDef.label}**.`, 10000);
                await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                return;
            }

            if (customId.startsWith('automod_no_leader_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const match = customId.match(/^automod_no_leader_modal_(\d+)_(.+)$/);
                if (!match) {
                    await interaction.editReply({ content: 'Invalid automod modal ID.' });
                    return;
                }

                const srvNum = parseInt(match[1], 10);
                const fieldKey = match[2];
                const fieldDefs = mapVotePanelService.getNoLeaderFieldDefinitions();
                const fieldDef = fieldDefs.find(field => field.key === fieldKey);

                if (!fieldDef) {
                    await interaction.editReply({ content: 'Unknown field submitted.' });
                    return;
                }

                const rawValue = interaction.fields.getTextInputValue('value');
                const draftKey = getAutoModDraftKey(srvNum, interaction.user.id);
                const draft = autoModNoLeaderDrafts.get(draftKey) || {};

                let parsedValue;
                try {
                    parsedValue = parseAutoModValue(rawValue, fieldDef.type);
                } catch (e) {
                    await interaction.editReply({ content: `Invalid value: ${e.message}` });
                    return;
                }

                draft[fieldKey] = parsedValue;
                autoModNoLeaderDrafts.set(draftKey, draft);

                const config = configManager.getEffectiveServerConfig(srvNum);
                const serverName = config.serverName || `Server ${srvNum}`;
                const panel = mapVotePanelService.buildAutoModNoLeaderPanel(
                    srvNum,
                    serverName,
                    draft,
                    'draft'
                );

                await editReplyEphemeralAutoDelete(interaction, `Updated **${fieldDef.label}**.`, 10000);
                await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                return;
            }

            if (customId.startsWith('automod_level_general_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const match = customId.match(/^automod_level_general_modal_(\d+)_(.+)$/);
                if (!match) {
                    await interaction.editReply({ content: 'Invalid automod modal ID.' });
                    return;
                }

                const srvNum = parseInt(match[1], 10);
                const fieldKey = match[2];
                const fieldDefs = mapVotePanelService.getLevelGeneralFieldDefinitions();
                const fieldDef = fieldDefs.find(field => field.key === fieldKey);

                if (!fieldDef) {
                    await interaction.editReply({ content: 'Unknown field submitted.' });
                    return;
                }

                const rawValue = interaction.fields.getTextInputValue('value');
                const draftKey = getAutoModDraftKey(srvNum, interaction.user.id);
                const draft = autoModLevelDrafts.get(draftKey) || { level_thresholds: getDefaultLevelThresholds() };

                let parsedValue;
                try {
                    parsedValue = parseAutoModValue(rawValue, fieldDef.type);
                } catch (e) {
                    await interaction.editReply({ content: `Invalid value: ${e.message}` });
                    return;
                }

                draft[fieldKey] = parsedValue;
                if (!draft.level_thresholds) {
                    draft.level_thresholds = getDefaultLevelThresholds();
                }
                autoModLevelDrafts.set(draftKey, draft);

                const config = configManager.getEffectiveServerConfig(srvNum);
                const serverName = config.serverName || `Server ${srvNum}`;
                const panel = mapVotePanelService.buildAutoModLevelGeneralPanel(
                    srvNum,
                    serverName,
                    draft,
                    'draft'
                );

                await editReplyEphemeralAutoDelete(interaction, `Updated **${fieldDef.label}**.`, 10000);
                await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                return;
            }

            if (customId.startsWith('automod_level_roles_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const match = customId.match(/^automod_level_roles_modal_(\d+)_(.+)$/);
                if (!match) {
                    await interaction.editReply({ content: 'Invalid automod modal ID.' });
                    return;
                }

                const srvNum = parseInt(match[1], 10);
                const roleKey = match[2];
                const roleKeys = mapVotePanelService.getLevelRoleKeys();
                if (!roleKeys.includes(roleKey)) {
                    await interaction.editReply({ content: 'Unknown role submitted.' });
                    return;
                }

                const label = interaction.fields.getTextInputValue('label').trim();
                const minLevelRaw = interaction.fields.getTextInputValue('min_level');
                const minPlayersRaw = interaction.fields.getTextInputValue('min_players');

                let minLevel;
                let minPlayers;
                try {
                    minLevel = parseAutoModValue(minLevelRaw, 'integer');
                    minPlayers = parseAutoModValue(minPlayersRaw, 'integer');
                } catch (e) {
                    await interaction.editReply({ content: `Invalid role threshold value: ${e.message}` });
                    return;
                }

                if (!label) {
                    await interaction.editReply({ content: 'Label cannot be empty.' });
                    return;
                }

                const draftKey = getAutoModDraftKey(srvNum, interaction.user.id);
                const draft = autoModLevelDrafts.get(draftKey) || {};
                draft.level_thresholds = { ...getDefaultLevelThresholds(), ...(draft.level_thresholds || {}) };
                draft.level_thresholds[roleKey] = {
                    label,
                    min_level: minLevel,
                    min_players: minPlayers
                };
                autoModLevelDrafts.set(draftKey, draft);

                const config = configManager.getEffectiveServerConfig(srvNum);
                const serverName = config.serverName || `Server ${srvNum}`;
                const panel = mapVotePanelService.buildAutoModLevelRolesPanel(
                    srvNum,
                    serverName,
                    draft,
                    'draft'
                );

                await interaction.editReply({ content: `Updated role threshold **${roleKey}**.` });
                await updatePanelMessage(interaction, panel, { preferMessageEdit: true });
                return;
            }

            if (customId.startsWith('automod_save_modal_')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const match = customId.match(/^automod_save_modal_(level|no_leader|solo_tank)_(\d+)(?:_sched_([^_]+))?$/);
                if (!match) {
                    await interaction.editReply({ content: 'Invalid save preset modal ID.' });
                    return;
                }

                const type = match[1];
                const srvNum = parseInt(match[2], 10);
                const scheduleId = match[3] || null;
                const name = interaction.fields.getTextInputValue('name');
                const draftKey = scheduleId
                    ? getScheduleAutoModDraftKey(srvNum, scheduleId, interaction.user.id)
                    : getAutoModDraftKey(srvNum, interaction.user.id);

                let draft = null;
                if (type === 'level') {
                    draft = scheduleId ? scheduleAutoModLevelDrafts.get(draftKey) : autoModLevelDrafts.get(draftKey);
                } else if (type === 'no_leader') {
                    draft = scheduleId ? scheduleAutoModNoLeaderDrafts.get(draftKey) : autoModNoLeaderDrafts.get(draftKey);
                } else if (type === 'solo_tank') {
                    draft = scheduleId ? scheduleAutoModSoloTankDrafts.get(draftKey) : autoModSoloTankDrafts.get(draftKey);
                }

                if (!draft) {
                    await interaction.editReply({ content: 'No draft found to save. Open that automod panel and edit or refresh first.' });
                    return;
                }

                const saved = automodPresetManager.createPreset(srvNum, type, name, draft);
                if (!saved.success) {
                    await interaction.editReply({ content: `Failed to save preset: ${saved.error}` });
                    return;
                }

                await interaction.editReply({ content: `Saved preset **${saved.preset.displayName}**.` });
                return;
            }

            // ========== SETUP MODAL ==========
            if (customId.startsWith('setup_modal_server_')) {
                if (!isServerOwner(interaction.member)) {
                    return interaction.reply({ content: 'Only server owners can modify setup.', flags: MessageFlags.Ephemeral });
                }

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const result = await setupWizard.saveServerFromModal(interaction);

                if (result.success) {
                    await interaction.editReply({ content: result.message });
                    // Update the setup panel
                    const channel = interaction.channel;
                    const messages = await channel.messages.fetch({ limit: 10 });
                    const setupMessage = messages.find(m =>
                        m.author.id === client.user.id &&
                        m.embeds[0]?.title === 'Seeding Bot Setup'
                    );
                    if (setupMessage) {
                        await setupMessage.edit(setupWizard.buildSetupPanel());
                    }
                } else {
                    await interaction.editReply({ content: result.message });
                }
                return;
            }

            if (customId.startsWith('setup_modal_rcon_')) {
                if (!isServerOwner(interaction.member)) {
                    return interaction.reply({ content: 'Only server owners can modify setup.', flags: MessageFlags.Ephemeral });
                }

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const result = await setupWizard.saveRconFromModal(interaction);

                if (result.success) {
                    await interaction.editReply({ content: result.message });
                    const channel = interaction.channel;
                    const messages = await channel.messages.fetch({ limit: 10 });
                    const setupMessage = messages.find(m =>
                        m.author.id === client.user.id &&
                        m.embeds[0]?.title === 'Seeding Bot Setup'
                    );
                    if (setupMessage) {
                        await setupMessage.edit(setupWizard.buildSetupPanel());
                    }
                } else {
                    await interaction.editReply({ content: result.message });
                }
                return;
            }

            // ========== MAP VOTING MODALS ==========
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'You do not have permission.', flags: MessageFlags.Ephemeral });
            }

            const value = interaction.fields.getTextInputValue('value');

            // Determine server
            let serverNum = 1;
            if (customId.startsWith('mapvote_modal_')) {
                const parsedServerNum = parseInt(customId.split('_').pop(), 10);
                if (!Number.isNaN(parsedServerNum)) {
                    serverNum = parsedServerNum;
                }
            }
            const service = mapVotingServices[serverNum];
            const crcon = crconServices[serverNum];
            const config = configManager.getEffectiveServerConfig(serverNum);
            const serverName = config.serverName || `Server ${serverNum}`;

            if (!service) {
                return interaction.reply({ content: 'Service not available', flags: MessageFlags.Ephemeral });
            }

            await interaction.deferUpdate();

            if (customId.startsWith('mapvote_modal_activate_')) {
                service.setConfig('minimumPlayers', value);
            }
            else if (customId.startsWith('mapvote_modal_deactivate_')) {
                service.setConfig('deactivatePlayers', value);
            }
            else if (customId.startsWith('mapvote_modal_maps_count_')) {
                service.setConfig('mapsPerVote', value);
            }
            else if (customId.startsWith('mapvote_modal_night_count_')) {
                service.setConfig('nightMapCount', value);
            }
            else if (customId.startsWith('mapvote_modal_cooldown_')) {
                service.setConfig('excludeRecentMaps', value);
                configManager.setServerConfig(serverNum, {
                    excludePlayedMapForXvotes: service.excludeRecentMaps
                });
            }

            else if (customId.startsWith('mapvote_modal_team_switch_cooldown_')) {
                const minutes = parseNonNegativeInteger(value, 'Team Switch Cooldown');
                await crcon.setTeamSwitchCooldown(minutes);
            }

            else if (customId.startsWith('mapvote_modal_idle_autokick_')) {
                const minutes = parseNonNegativeInteger(value, 'Idle Autokick Time');
                await crcon.setIdleAutokickTime(minutes);
            }

            else if (customId.startsWith('mapvote_modal_max_ping_')) {
                const maxMs = parseNonNegativeInteger(value, 'Max Ping Autokick');
                await crcon.setMaxPingAutokick(maxMs);
            }

            const generalSettings = await getLiveGeneralSettings(crcon, serverNum);
            const panel = mapVotePanelService.buildSettingsPanel(service, generalSettings);
            await updatePanelMessage(interaction, panel);
        }

    } catch (error) {
        logger.error('Interaction error:', error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'An error occurred', flags: MessageFlags.Ephemeral });
            }
        } catch (e) {
            // Ignore
        }
    }
});

// Error handling
client.on('error', (error) => {
    logger.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    logger.error('Unhandled rejection:', error);
});

async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;

    const stamp = new Date().toISOString();
    // Keep a plain console line so shutdown context is visible even if logger transport is interrupted.
    console.log(`${stamp} [shutdown] Received ${signal}, starting graceful shutdown`);
    logger.info(`Received ${signal}, shutting down...`);

    try {
        if (healthServer) {
            await new Promise((resolve) => healthServer.close(resolve));
        }
    } catch (error) {
        logger.warn('Error while closing health server:', error);
    }

    try {
        client.destroy();
    } catch (error) {
        logger.warn('Error while closing Discord client:', error);
    }

    console.log(`${new Date().toISOString()} [shutdown] Cleanup complete, exiting process`);
    process.exit(0);
}

process.on('SIGTERM', () => {
    logger.warn('[Shutdown] SIGTERM received from host/platform');
    gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
    logger.warn('[Shutdown] SIGINT received');
    gracefulShutdown('SIGINT');
});

process.on('beforeExit', (code) => {
    logger.warn(`[Shutdown] beforeExit fired with code ${code}`);
});

process.on('exit', (code) => {
    // Use console to guarantee visibility at process teardown.
    console.log(`${new Date().toISOString()} [shutdown] process exit with code ${code}`);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
});

// Login
const token = process.env.DISCORD_TOKEN;
if (!token) {
    logger.error('DISCORD_TOKEN not set in environment');
    process.exit(1);
}

healthServer = startHealthServer();
client.login(token);

