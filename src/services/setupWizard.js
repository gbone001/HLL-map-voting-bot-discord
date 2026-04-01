/**
 * Setup Wizard Service
 * Handles Discord-based configuration for the bot
 */

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder
} = require('discord.js');
const axios = require('axios');
const configManager = require('./configManager');
const { RCONService } = require('./rcon');
const logger = require('../utils/logger');

class SetupWizard {
    constructor() {
        this.pendingSetups = new Map(); // Track setup state per user
    }

    // Build the main setup panel
    buildSetupPanel() {
        const servers = configManager.getAllServers();
        const serverCount = Object.keys(servers).length;
        const adminRoleId = configManager.getAdminRoleId();

        const embed = new EmbedBuilder()
            .setTitle('Seeding Bot Setup')
            .setDescription('Configure your server providers (CRCON or RCON) and permissions for map voting')
            .setColor(serverCount > 0 ? 0x00FF00 : 0xFF6600);

        // Show admin role
        const roleDisplay = adminRoleId ? `<@&${adminRoleId}>` : '`Not set (Server Owner only)`';
        embed.addFields({
            name: 'Admin Role',
            value: `${roleDisplay}\nUsers with this role can use all bot commands.`,
            inline: false
        });

        // Show configured servers
        if (serverCount > 0) {
            let serverList = '';
            for (const [num, config] of Object.entries(servers)) {
                const provider = String(config.provider || 'crcon').toUpperCase();
                const endpoint = config.provider === 'rcon'
                    ? `${config.rconHost || 'Not set'}:${config.rconPort || 27015}`
                    : (config.crconUrl || 'Not set');
                serverList += `**Server ${num}** - ${config.serverName || 'Unnamed'}\n`;
                serverList += `Provider: \`${provider}\`\n`;
                serverList += `Endpoint: \`${endpoint}\`\n`;
                serverList += `Channel: ${config.channelId ? `<#${config.channelId}>` : '`Not set`'}\n\n`;
            }
            embed.addFields({ name: 'Configured Servers', value: serverList || 'None' });
        } else {
            embed.addFields({
                name: 'Getting Started',
                value: 'Click **Add Server** to configure your first HLL server.\n\nYou will need:\n- Provider: `crcon` or `rcon`\n- Endpoint: CRCON URL or RCON host:port\n- Secret: CRCON API token or RCON password\n- A Discord channel ID for map voting'
            });
        }

        // Buttons - Row 1: Admin Role
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('setup_set_admin_role')
                .setLabel('Set Admin Role')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('👑'),
            new ButtonBuilder()
                .setCustomId('setup_clear_admin_role')
                .setLabel('Clear Admin Role')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!adminRoleId)
        );

        // Buttons - Row 2: Server management
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('setup_add_server')
                .setLabel('Add Server')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('➕'),
            new ButtonBuilder()
                .setCustomId('setup_edit_server')
                .setLabel('Edit Server')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('✏️')
                .setDisabled(serverCount === 0),
            new ButtonBuilder()
                .setCustomId('setup_remove_server')
                .setLabel('Remove Server')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️')
                .setDisabled(serverCount === 0)
        );

        // Buttons - Row 3: Actions
        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('setup_test_connection')
                .setLabel('Test Connections')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔌')
                .setDisabled(serverCount === 0),
            new ButtonBuilder()
                .setCustomId('setup_refresh')
                .setLabel('Refresh')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔄'),
            new ButtonBuilder()
                .setCustomId('setup_apply_restart')
                .setLabel('Apply & Restart')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅')
                .setDisabled(serverCount === 0)
        );

        return { embeds: [embed], components: [row1, row2, row3] };
    }

    // Build admin role selection
    buildAdminRolePanel(roles) {
        const embed = new EmbedBuilder()
            .setTitle('Select Admin Role')
            .setDescription('Choose a role that will have access to all Seeding Bot commands.\n\n**Note:** Server owners always have access regardless of role.')
            .setColor(0x5865F2);

        // Filter to manageable roles (not @everyone, not bot roles)
        // Convert Collection to array since Collections don't have .slice()
        const selectableRoles = Array.from(roles.values())
            .filter(role => role.name !== '@everyone' && !role.managed)
            .sort((a, b) => b.position - a.position)
            .slice(0, 25); // Discord limit

        if (selectableRoles.length === 0) {
            embed.setDescription('No suitable roles found. Create a role first, then try again.');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('setup_back')
                    .setLabel('Back')
                    .setStyle(ButtonStyle.Secondary)
            );
            return { embeds: [embed], components: [row] };
        }

        const options = selectableRoles.map(role => ({
            label: role.name.slice(0, 100),
            description: `${role.members?.size || 0} members`,
            value: role.id
        }));

        const row1 = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('setup_select_admin_role')
                .setPlaceholder('Select a role...')
                .addOptions(options)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('setup_back')
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row1, row2] };
    }

    // Set admin role
    setAdminRole(roleId) {
        return configManager.setAdminRoleId(roleId);
    }

    // Clear admin role
    clearAdminRole() {
        return configManager.clearAdminRole();
    }

    // Build server selection menu
    buildServerSelectMenu(action) {
        const servers = configManager.getAllServers();

        if (Object.keys(servers).length === 0) {
            return null;
        }

        const options = Object.entries(servers).map(([num, config]) => ({
            label: `Server ${num} - ${config.serverName || 'Unnamed'}`,
            description: config.provider === 'rcon'
                ? `RCON ${config.rconHost || 'not set'}:${config.rconPort || 27015}`
                : (config.crconUrl || 'Not configured'),
            value: num
        }));

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`setup_select_${action}`)
                .setPlaceholder(`Select a server to ${action}`)
                .addOptions(options)
        );

        const embed = new EmbedBuilder()
            .setTitle(`Select Server to ${action.charAt(0).toUpperCase() + action.slice(1)}`)
            .setColor(0x5865F2);

        return { embeds: [embed], components: [row] };
    }

    // Build the add/edit server modal
    buildServerModal(serverNum = null, existingConfig = null) {
        const isEdit = serverNum !== null && existingConfig !== null;
        const nextServerNum = serverNum || this.getNextServerNumber();

        const modal = new ModalBuilder()
            .setCustomId(`setup_modal_server_${nextServerNum}`)
            .setTitle(isEdit ? `Edit Server ${serverNum}` : `Add Server ${nextServerNum}`);

        const nameInput = new TextInputBuilder()
            .setCustomId('server_name')
            .setLabel('Server Name (for display)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., My HLL Server')
            .setValue(existingConfig?.serverName || '')
            .setRequired(true)
            .setMaxLength(50);

        const providerInput = new TextInputBuilder()
            .setCustomId('connection_provider')
            .setLabel('Provider (crcon or rcon)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('crcon')
            .setValue(existingConfig?.provider || 'crcon')
            .setRequired(true);

        const endpointInput = new TextInputBuilder()
            .setCustomId('connection_endpoint')
            .setLabel('Endpoint (CRCON URL or RCON host[:port])')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('http://your-crcon.com:8010 OR 1.2.3.4:27015')
            .setValue(existingConfig?.provider === 'rcon'
                ? `${existingConfig?.rconHost || ''}${existingConfig?.rconPort ? `:${existingConfig.rconPort}` : ''}`
                : (existingConfig?.crconUrl || ''))
            .setRequired(true);

        const secretInput = new TextInputBuilder()
            .setCustomId('connection_secret')
            .setLabel('Secret (CRCON token or RCON password)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('API token or RCON password')
            .setValue(existingConfig?.provider === 'rcon'
                ? (existingConfig?.rconPassword || '')
                : (existingConfig?.crconToken || ''))
            .setRequired(true);

        const channelInput = new TextInputBuilder()
            .setCustomId('channel_id')
            .setLabel('Map Vote Channel ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Right-click channel > Copy ID')
            .setValue(existingConfig?.channelId || '')
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput),
            new ActionRowBuilder().addComponents(providerInput),
            new ActionRowBuilder().addComponents(endpointInput),
            new ActionRowBuilder().addComponents(secretInput),
            new ActionRowBuilder().addComponents(channelInput)
        );

        return modal;
    }

    getNextServerNumber() {
        const servers = configManager.getAllServers();
        for (let i = 1; i <= 4; i++) {
            if (!servers[i]) return i;
        }
        return null; // Max 4 servers
    }

    parseProviderConfig(provider, endpointRaw, secretRaw) {
        const normalizedProvider = String(provider || '').trim().toLowerCase();
        const endpoint = String(endpointRaw || '').trim();
        const secret = String(secretRaw || '').trim();

        if (!['crcon', 'rcon'].includes(normalizedProvider)) {
            return { valid: false, error: 'Provider must be `crcon` or `rcon`.' };
        }

        if (!endpoint) {
            return { valid: false, error: 'Endpoint is required.' };
        }

        if (!secret) {
            return { valid: false, error: 'Secret is required.' };
        }

        if (normalizedProvider === 'crcon') {
            return {
                valid: true,
                provider: 'crcon',
                crconUrl: endpoint.replace(/\/$/, ''),
                crconToken: secret
            };
        }

        const hostPortMatch = endpoint.match(/^(.+?)(?::(\d+))?$/);
        const host = hostPortMatch?.[1]?.trim();
        const port = hostPortMatch?.[2] ? parseInt(hostPortMatch[2], 10) : 27015;
        if (!host) {
            return { valid: false, error: 'RCON host is required.' };
        }

        return {
            valid: true,
            provider: 'rcon',
            rconHost: host,
            rconPort: Number.isNaN(port) ? 27015 : port,
            rconPassword: secret
        };
    }

    async testConnection(config) {
        if (config.provider === 'rcon') {
            let service = null;
            try {
                service = new RCONService(
                    config.rconHost,
                    config.rconPassword,
                    config.serverName || 'Server',
                    config.rconPort
                );
                const status = await service.getStatus();
                const result = status?.result || {};
                return {
                    success: true,
                    serverName: result.name || config.serverName || 'Unknown Server',
                    players: result.current_players || 0,
                    maxPlayers: result.max_players || 100
                };
            } catch (error) {
                return { success: false, error: `RCON connection failed: ${error.message}` };
            } finally {
                service?.close();
            }
        }

        try {
            const baseUrl = config.crconUrl.replace(/\/$/, '');
            const response = await axios.get(`${baseUrl}/api/get_status`, {
                headers: {
                    'Authorization': `Bearer ${config.crconToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            if (response.data && response.data.result) {
                return {
                    success: true,
                    serverName: response.data.result.name || 'Unknown Server',
                    players: response.data.result.current_players || 0,
                    maxPlayers: response.data.result.max_players || 100
                };
            }

            return { success: false, error: 'Invalid response from CRCON' };
        } catch (error) {
            let errorMsg = 'Connection failed';
            if (error.code === 'ECONNREFUSED') {
                errorMsg = 'Connection refused - check URL';
            } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
                errorMsg = 'Connection timed out';
            } else if (error.response?.status === 401 || error.response?.status === 403) {
                errorMsg = 'Invalid API token';
            } else if (error.response?.status === 404) {
                errorMsg = 'CRCON API not found at URL';
            }
            return { success: false, error: errorMsg };
        }
    }

    // Test all configured servers
    async testAllConnections() {
        const servers = configManager.getAllServers();
        const results = [];

        for (const [num, config] of Object.entries(servers)) {
            const provider = String(config.provider || 'crcon').toLowerCase();
            const isConfigured = provider === 'rcon'
                ? !!(config.rconHost && config.rconPassword)
                : !!(config.crconUrl && config.crconToken);

            if (isConfigured) {
                const result = await this.testConnection(config);
                results.push({
                    serverNum: num,
                    serverName: config.serverName,
                    ...result
                });
            }
        }

        return results;
    }

    // Build test results embed
    buildTestResultsEmbed(results) {
        const embed = new EmbedBuilder()
            .setTitle('Connection Test Results')
            .setColor(results.every(r => r.success) ? 0x00FF00 : 0xFF0000);

        for (const result of results) {
            if (result.success) {
                embed.addFields({
                    name: `Server ${result.serverNum} - ${result.serverName}`,
                    value: `Connected to: **${result.serverName}**\nPlayers: ${result.players}/${result.maxPlayers}`,
                    inline: true
                });
            } else {
                embed.addFields({
                    name: `Server ${result.serverNum} - ${result.serverName}`,
                    value: `**Failed:** ${result.error}`,
                    inline: true
                });
            }
        }

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('setup_back')
                .setLabel('Back to Setup')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [backRow] };
    }

    // Save server from modal submission
    async saveServerFromModal(interaction) {
        const serverNum = interaction.customId.split('_').pop();
        const provider = interaction.fields.getTextInputValue('connection_provider');
        const endpoint = interaction.fields.getTextInputValue('connection_endpoint');
        const secret = interaction.fields.getTextInputValue('connection_secret');
        const parsed = this.parseProviderConfig(provider, endpoint, secret);

        if (!parsed.valid) {
            return { success: false, message: parsed.error };
        }

        const config = {
            serverName: interaction.fields.getTextInputValue('server_name'),
            channelId: interaction.fields.getTextInputValue('channel_id'),
            provider: parsed.provider
        };

        if (parsed.provider === 'crcon') {
            config.crconUrl = parsed.crconUrl;
            config.crconToken = parsed.crconToken;
            config.rconHost = null;
            config.rconPort = null;
            config.rconPassword = null;
        } else {
            config.rconHost = parsed.rconHost;
            config.rconPort = parsed.rconPort;
            config.rconPassword = parsed.rconPassword;
            config.crconUrl = null;
            config.crconToken = null;
        }

        // Validate channel ID is numeric
        if (!/^\d+$/.test(config.channelId)) {
            return {
                success: false,
                message: 'Channel ID must be a number. Right-click the channel and select "Copy ID".'
            };
        }

        // Test connection before saving
        const testResult = await this.testConnection(config);
        if (!testResult.success) {
            const guidance = config.provider === 'rcon'
                ? 'Please check your RCON host/port/password.'
                : 'Please check your CRCON URL and token.';
            return {
                success: false,
                message: `Connection test failed: ${testResult.error}\n\nConfiguration NOT saved. ${guidance}`
            };
        }

        // Save config
        configManager.setServerConfig(serverNum, config);

        return {
            success: true,
            message: `Server ${serverNum} configured successfully!\n\n**Provider:** ${String(config.provider).toUpperCase()}\n**Connected to:** ${testResult.serverName}\n**Players:** ${testResult.players}/${testResult.maxPlayers}\n\nClick **Apply & Restart** to activate the changes.`
        };
    }

    // Remove a server
    removeServer(serverNum) {
        return configManager.removeServerConfig(serverNum);
    }
}

module.exports = new SetupWizard();

