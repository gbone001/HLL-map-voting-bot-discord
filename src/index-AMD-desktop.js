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
    getScheduleWhitelistServerNum
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
const autoModSoloTankDrafts = new Map();
const autoModNoLeaderDrafts = new Map();
const autoModLevelDrafts = new Map();
let initializeServersPromise = null;

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
    if (initializeServersPromise) {
        logger.warn('initializeServers already running; waiting for the active refresh to finish');
        return initializeServersPromise;
    }

    initializeServersPromise = (async () => {
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
    })();

    try {
        await initializeServersPromise;
    } finally {
        initializeServersPromise = null;
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

async function followUpEphemeralAutoDelete(interaction, content, delayMs = 5000) {
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
                const panel = mapVotePanelService.buildSettingsPanel(service);
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
                    scheduleManager.updateSchedule(srvNum, scheduleId, { days });
                    const panel = schedulePanel.buildSchedulePanel(srvNum, serverName);
                    await updatePanelMessage(interaction, panel);
                    await interaction.followUp({ content: `Days set to ${preset}.`, flags: MessageFlags.Ephemeral });
                }

                // Manage maps - show schedule selection
                else if (customId.startsWith('schedule_maps_')) {
                    await interaction.deferUpdate();
                    const srvNum = parseInt(customId.split('_').pop());
                    const panel = schedulePanel.buildScheduleMapSelectPanel(srvNum);
                    await updatePanelMessage(interaction, panel);
                }

                // Automod attachments - show schedule selection
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
                const modal = setupWizard.buildServerModal(serverNum, existingConfig);
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

            // Select schedule for automod attachments
            else if (customId.startsWith('schedule_select_automods_')) {
                const srvNum = parseInt(customId.split('_').pop(), 10);
                const scheduleId = interaction.values[0];
                await interaction.deferUpdate();
                const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                await updatePanelMessage(interaction, panel);
            }

            // Attach level preset to schedule
            else if (customId.startsWith('schedule_attach_level_')) {
                const parts = customId.split('_');
                const srvNum = parseInt(parts[3], 10);
                const scheduleId = parts[4];
                const presetId = interaction.values[0] === 'none' ? null : interaction.values[0];

                const schedules = scheduleManager.getSchedules(srvNum);
                const schedule = schedules.find(item => item.id === scheduleId);
                if (!schedule) {
                    return interaction.reply({ content: 'Schedule not found.', flags: MessageFlags.Ephemeral });
                }

                const attachments = {
                    level: presetId,
                    no_leader: schedule.automodProfiles?.no_leader || null,
                    solo_tank: schedule.automodProfiles?.solo_tank || null
                };
                scheduleManager.updateSchedule(srvNum, scheduleId, { automodProfiles: attachments });

                await interaction.deferUpdate();
                const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                await updatePanelMessage(interaction, panel);
            }

            // Attach no leader preset to schedule
            else if (customId.startsWith('schedule_attach_no_leader_')) {
                const parts = customId.split('_');
                const srvNum = parseInt(parts[4], 10);
                const scheduleId = parts[5];
                const presetId = interaction.values[0] === 'none' ? null : interaction.values[0];

                const schedules = scheduleManager.getSchedules(srvNum);
                const schedule = schedules.find(item => item.id === scheduleId);
                if (!schedule) {
                    return interaction.reply({ content: 'Schedule not found.', flags: MessageFlags.Ephemeral });
                }

                const attachments = {
                    level: schedule.automodProfiles?.level || null,
                    no_leader: presetId,
                    solo_tank: schedule.automodProfiles?.solo_tank || null
                };
                scheduleManager.updateSchedule(srvNum, scheduleId, { automodProfiles: attachments });

                await interaction.deferUpdate();
                const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                await updatePanelMessage(interaction, panel);
            }

            // Attach solo tank preset to schedule
            else if (customId.startsWith('schedule_attach_solo_tank_')) {
                const parts = customId.split('_');
                const srvNum = parseInt(parts[4], 10);
                const scheduleId = parts[5];
                const presetId = interaction.values[0] === 'none' ? null : interaction.values[0];

                const schedules = scheduleManager.getSchedules(srvNum);
                const schedule = schedules.find(item => item.id === scheduleId);
                if (!schedule) {
                    return interaction.reply({ content: 'Schedule not found.', flags: MessageFlags.Ephemeral });
                }

                const attachments = {
                    level: schedule.automodProfiles?.level || null,
                    no_leader: schedule.automodProfiles?.no_leader || null,
                    solo_tank: presetId
                };
                scheduleManager.updateSchedule(srvNum, scheduleId, { automodProfiles: attachments });

                await interaction.deferUpdate();
                const panel = schedulePanel.buildScheduleAutomodAttachPanel(srvNum, scheduleId);
                await updatePanelMessage(interaction, panel);
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

                const exportResult = await schedulePanel.buildScheduleExport(srvNum, scheduleId, crcon, serverName);
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

                await interaction.editReply({ content: `Updated **${fieldDef.label}**.` });
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

                await interaction.editReply({ content: `Updated **${fieldDef.label}**.` });
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

                await interaction.editReply({ content: `Updated **${fieldDef.label}**.` });
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

                const match = customId.match(/^automod_save_modal_(level|no_leader|solo_tank)_(\d+)$/);
                if (!match) {
                    await interaction.editReply({ content: 'Invalid save preset modal ID.' });
                    return;
                }

                const type = match[1];
                const srvNum = parseInt(match[2], 10);
                const name = interaction.fields.getTextInputValue('name');
                const draftKey = getAutoModDraftKey(srvNum, interaction.user.id);

                let draft = null;
                if (type === 'level') {
                    draft = autoModLevelDrafts.get(draftKey);
                } else if (type === 'no_leader') {
                    draft = autoModNoLeaderDrafts.get(draftKey);
                } else if (type === 'solo_tank') {
                    draft = autoModSoloTankDrafts.get(draftKey);
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

            const panel = mapVotePanelService.buildSettingsPanel(service);
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

    process.exit(0);
}

process.on('SIGTERM', () => {
    gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
    gracefulShutdown('SIGINT');
});

// Login
const token = process.env.DISCORD_TOKEN;
if (!token) {
    logger.error('DISCORD_TOKEN not set in environment');
    process.exit(1);
}

healthServer = startHealthServer();
client.login(token);

