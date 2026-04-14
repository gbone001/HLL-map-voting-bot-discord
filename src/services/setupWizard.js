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
const logger = require('../utils/logger');
const { HLLRconClient } = require('./hllRconClient');
const { TRANSPORT_MODES } = require('./crcon');

const TRANSPORT_MODE_LABELS = {
    [TRANSPORT_MODES.API_ONLY]: 'CRCON API only',
    [TRANSPORT_MODES.DIRECT_RCON]: 'Direct RCON only',
    [TRANSPORT_MODES.API_WITH_FALLBACK]: 'CRCON API with RCON fallback'
};

class SetupWizard {
    constructor() {
        this.pendingSetups = new Map();
    }

    buildSetupPanel() {
        const servers = configManager.getAllServers();
        const serverCount = Object.keys(servers).length;
        const adminRoleId = configManager.getAdminRoleId();

        const embed = new EmbedBuilder()
            .setTitle('Seeding Bot Setup')
            .setDescription('Configure CRCON access, direct RCON fallback, and permissions for map voting')
            .setColor(serverCount > 0 ? 0x00FF00 : 0xFF6600);

        const roleDisplay = adminRoleId ? `<@&${adminRoleId}>` : '`Not set (Server Owner only)`';
        embed.addFields({
            name: 'Admin Role',
            value: `${roleDisplay}\nUsers with this role can use all bot commands.`,
            inline: false
        });

        if (serverCount > 0) {
            let serverList = '';
            for (const [num, config] of Object.entries(servers)) {
                const transportMode = config.transportMode || TRANSPORT_MODES.API_ONLY;
                const rconSummary = config.rconHost && config.rconPort
                    ? `${config.rconHost}:${config.rconPort}`
                    : 'Not set';

                serverList += `**Server ${num}** - ${config.serverName || 'Unnamed'}\n`;
                serverList += `Mode: \`${TRANSPORT_MODE_LABELS[transportMode] || transportMode}\`\n`;
                serverList += `CRCON: \`${config.crconUrl || 'Not set'}\`\n`;
                serverList += `RCON: \`${rconSummary}\`\n`;
                serverList += `Channel: ${config.channelId ? `<#${config.channelId}>` : '`Not set`'}\n\n`;
            }
            embed.addFields({ name: 'Configured Servers', value: serverList || 'None' });
        } else {
            embed.addFields({
                name: 'Getting Started',
                value: 'Click **Add Server** to configure your first HLL server.\n\nYou will need:\n- A Discord channel ID for map voting\n- CRCON URL/token for API-backed features\n- Optional direct RCON host/port/password for failover'
            });
        }

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
                .setCustomId('setup_edit_rcon')
                .setLabel('Edit RCON')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔐')
                .setDisabled(serverCount === 0),
            new ButtonBuilder()
                .setCustomId('setup_remove_server')
                .setLabel('Remove Server')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️')
                .setDisabled(serverCount === 0)
        );

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

    buildAdminRolePanel(roles) {
        const embed = new EmbedBuilder()
            .setTitle('Select Admin Role')
            .setDescription('Choose a role that will have access to all Seeding Bot commands.\n\n**Note:** Server owners always have access regardless of role.')
            .setColor(0x5865F2);

        const selectableRoles = Array.from(roles.values())
            .filter(role => role.name !== '@everyone' && !role.managed)
            .sort((a, b) => b.position - a.position)
            .slice(0, 25);

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

    setAdminRole(roleId) {
        return configManager.setAdminRoleId(roleId);
    }

    clearAdminRole() {
        return configManager.clearAdminRole();
    }

    buildServerSelectMenu(action) {
        const servers = configManager.getAllServers();

        if (Object.keys(servers).length === 0) {
            return null;
        }

        const options = Object.entries(servers).map(([num, config]) => ({
            label: `Server ${num} - ${config.serverName || 'Unnamed'}`,
            description: TRANSPORT_MODE_LABELS[config.transportMode || TRANSPORT_MODES.API_ONLY] || 'Configured',
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

        const modeInput = new TextInputBuilder()
            .setCustomId('transport_mode')
            .setLabel('Transport Mode')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(`${TRANSPORT_MODES.API_ONLY} | ${TRANSPORT_MODES.API_WITH_FALLBACK} | ${TRANSPORT_MODES.DIRECT_RCON}`)
            .setValue(existingConfig?.transportMode || TRANSPORT_MODES.API_ONLY)
            .setRequired(true)
            .setMaxLength(64);

        const urlInput = new TextInputBuilder()
            .setCustomId('crcon_url')
            .setLabel('CRCON URL')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('http://your-crcon.com:8010')
            .setValue(existingConfig?.crconUrl || '')
            .setRequired(false);

        const tokenInput = new TextInputBuilder()
            .setCustomId('crcon_token')
            .setLabel('CRCON API Token')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Optional unless using CRCON API transport')
            .setValue(existingConfig?.crconToken || '')
            .setRequired(false);

        const channelInput = new TextInputBuilder()
            .setCustomId('channel_id')
            .setLabel('Map Vote Channel ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Right-click channel > Copy ID')
            .setValue(existingConfig?.channelId || '')
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput),
            new ActionRowBuilder().addComponents(modeInput),
            new ActionRowBuilder().addComponents(urlInput),
            new ActionRowBuilder().addComponents(tokenInput),
            new ActionRowBuilder().addComponents(channelInput)
        );

        return modal;
    }

    buildRconModal(serverNum, existingConfig = null) {
        const modal = new ModalBuilder()
            .setCustomId(`setup_modal_rcon_${serverNum}`)
            .setTitle(`Edit RCON - Server ${serverNum}`);

        const hostInput = new TextInputBuilder()
            .setCustomId('rcon_host')
            .setLabel('RCON Host')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. 203.0.113.10')
            .setValue(existingConfig?.rconHost || '')
            .setRequired(false);

        const portInput = new TextInputBuilder()
            .setCustomId('rcon_port')
            .setLabel('RCON Port')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. 27015')
            .setValue(existingConfig?.rconPort ? String(existingConfig.rconPort) : '')
            .setRequired(false);

        const passwordInput = new TextInputBuilder()
            .setCustomId('rcon_password')
            .setLabel('RCON Password')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Optional unless using direct RCON transport')
            .setValue(existingConfig?.rconPassword || '')
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(hostInput),
            new ActionRowBuilder().addComponents(portInput),
            new ActionRowBuilder().addComponents(passwordInput)
        );

        return modal;
    }

    getNextServerNumber() {
        const servers = configManager.getAllServers();
        for (let i = 1; i <= 4; i += 1) {
            if (!servers[i]) return i;
        }
        return null;
    }

    async testConnection(serverConfig) {
        const result = {
            transportMode: serverConfig.transportMode || TRANSPORT_MODES.API_ONLY,
            api: null,
            rcon: null
        };

        if (serverConfig.crconUrl || serverConfig.crconToken) {
            result.api = await this.testCrconConnection(serverConfig.crconUrl, serverConfig.crconToken);
        }

        if (serverConfig.rconHost || serverConfig.rconPort || serverConfig.rconPassword) {
            result.rcon = await this.testDirectRconConnection(
                serverConfig.rconHost,
                serverConfig.rconPort,
                serverConfig.rconPassword
            );
        }

        result.success = this.isTransportSatisfied(result.transportMode, result.api, result.rcon);
        if (!result.success) {
            result.error = this.getTransportFailureMessage(result.transportMode, result.api, result.rcon);
        }

        return result;
    }

    async testCrconConnection(crconUrl, crconToken) {
        if (!crconUrl || !crconToken) {
            return { success: false, error: 'CRCON URL/token not configured' };
        }

        try {
            const baseUrl = crconUrl.replace(/\/$/, '');
            const response = await axios.get(`${baseUrl}/api/get_status`, {
                headers: {
                    Authorization: `Bearer ${crconToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            if (response.data?.result) {
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

    async testDirectRconConnection(host, port, password) {
        if (!host || !port || !password) {
            return { success: false, error: 'RCON host/port/password not configured' };
        }

        const client = new HLLRconClient({ host, port, password, connectTimeoutMs: 10000, socketTimeoutMs: 15000 });

        try {
            const response = await client.execute('GetServerInformation', { Name: 'session', Value: '' });
            const body = this.parseRconContentBody(response.contentBody);
            return {
                success: true,
                serverName: body?.ServerName || body?.Name || 'Unknown Server',
                players: parseInt(body?.PlayerCount ?? body?.Players ?? 0, 10) || 0,
                maxPlayers: parseInt(body?.MaxPlayers ?? 0, 10) || 0
            };
        } catch (error) {
            return { success: false, error: error.message };
        } finally {
            await client.close();
        }
    }

    parseRconContentBody(contentBody) {
        if (typeof contentBody !== 'string') {
            return contentBody;
        }
        if (!contentBody.trim()) {
            return '';
        }
        try {
            return JSON.parse(contentBody);
        } catch (error) {
            return contentBody;
        }
    }

    async testAllConnections() {
        const servers = configManager.getAllServers();
        const results = [];

        for (const [num, config] of Object.entries(servers)) {
            const result = await this.testConnection(config);
            results.push({
                serverNum: num,
                serverName: config.serverName,
                ...result
            });
        }

        return results;
    }

    isTransportSatisfied(transportMode, apiResult, rconResult) {
        if (transportMode === TRANSPORT_MODES.DIRECT_RCON) {
            return Boolean(rconResult?.success);
        }
        if (transportMode === TRANSPORT_MODES.API_WITH_FALLBACK) {
            return Boolean(apiResult?.success || rconResult?.success);
        }
        return Boolean(apiResult?.success);
    }

    getTransportFailureMessage(transportMode, apiResult, rconResult) {
        if (transportMode === TRANSPORT_MODES.DIRECT_RCON) {
            return rconResult?.error || 'Direct RCON connection failed';
        }
        if (transportMode === TRANSPORT_MODES.API_WITH_FALLBACK) {
            const errors = [apiResult?.error, rconResult?.error].filter(Boolean);
            return errors.join(' | ') || 'Neither CRCON nor direct RCON is reachable';
        }
        return apiResult?.error || 'CRCON API connection failed';
    }

    buildTestResultsEmbed(results) {
        const embed = new EmbedBuilder()
            .setTitle('Connection Test Results')
            .setColor(results.every(r => r.success) ? 0x00FF00 : 0xFF0000);

        for (const result of results) {
            const apiLine = result.api
                ? (result.api.success
                    ? `CRCON: ✅ ${result.api.serverName} (${result.api.players}/${result.api.maxPlayers})`
                    : `CRCON: ❌ ${result.api.error}`)
                : 'CRCON: not configured';
            const rconLine = result.rcon
                ? (result.rcon.success
                    ? `RCON: ✅ ${result.rcon.serverName} (${result.rcon.players}/${result.rcon.maxPlayers})`
                    : `RCON: ❌ ${result.rcon.error}`)
                : 'RCON: not configured';

            embed.addFields({
                name: `Server ${result.serverNum} - ${result.serverName}`,
                value:
                    `Mode: **${TRANSPORT_MODE_LABELS[result.transportMode] || result.transportMode}**\n` +
                    `${apiLine}\n${rconLine}\n` +
                    `Overall: ${result.success ? '✅ Ready' : `❌ ${result.error || 'Not ready'}`}`,
                inline: false
            });
        }

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('setup_back')
                .setLabel('Back to Setup')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [backRow] };
    }

    async saveServerFromModal(interaction) {
        const serverNum = interaction.customId.split('_').pop();
        let transportMode;
        try {
            transportMode = this.normalizeTransportMode(interaction.fields.getTextInputValue('transport_mode'));
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }

        const existingConfig = configManager.getServerConfig(serverNum) || {};
        const config = {
            ...existingConfig,
            serverName: interaction.fields.getTextInputValue('server_name'),
            transportMode,
            crconUrl: interaction.fields.getTextInputValue('crcon_url').trim().replace(/\/$/, ''),
            crconToken: interaction.fields.getTextInputValue('crcon_token').trim(),
            channelId: interaction.fields.getTextInputValue('channel_id').trim()
        };

        if (!/^\d+$/.test(config.channelId)) {
            return {
                success: false,
                message: 'Channel ID must be a number. Right-click the channel and select "Copy ID".'
            };
        }

        if (transportMode === TRANSPORT_MODES.API_ONLY && (!config.crconUrl || !config.crconToken)) {
            return {
                success: false,
                message: 'CRCON API mode requires both CRCON URL and CRCON token.'
            };
        }

        if ((transportMode === TRANSPORT_MODES.DIRECT_RCON || transportMode === TRANSPORT_MODES.API_WITH_FALLBACK)
            && (!config.rconHost || !config.rconPort || !config.rconPassword)) {
            return {
                success: false,
                message: 'This transport mode requires RCON host, port, and password. Save the server in CRCON mode first or open **Edit RCON** to add direct RCON details.'
            };
        }

        const testResult = await this.testConnection(config);
        if (!testResult.success) {
            return {
                success: false,
                message: `Connection test failed: ${testResult.error}\n\nConfiguration NOT saved.`
            };
        }

        configManager.setServerConfig(serverNum, config);

        return {
            success: true,
            message:
                `Server ${serverNum} configured successfully!\n\n` +
                `Mode: **${TRANSPORT_MODE_LABELS[transportMode] || transportMode}**\n` +
                `CRCON: ${testResult.api?.success ? '✅ connected' : 'not in use'}\n` +
                `RCON: ${testResult.rcon?.success ? '✅ connected' : 'not in use'}\n\n` +
                'Click **Apply & Restart** to activate the changes.'
        };
    }

    async saveRconFromModal(interaction) {
        const serverNum = interaction.customId.split('_').pop();
        const existingConfig = configManager.getServerConfig(serverNum);

        if (!existingConfig) {
            return {
                success: false,
                message: `Server ${serverNum} is not configured yet. Add the server first.`
            };
        }

        const rconHost = interaction.fields.getTextInputValue('rcon_host').trim();
        const rconPort = interaction.fields.getTextInputValue('rcon_port').trim();
        const rconPassword = interaction.fields.getTextInputValue('rcon_password').trim();

        if ((rconHost || rconPort || rconPassword) && (!rconHost || !rconPort || !rconPassword)) {
            return {
                success: false,
                message: 'RCON host, port, and password must all be provided together, or all left blank.'
            };
        }

        if (rconPort && !/^\d+$/.test(rconPort)) {
            return {
                success: false,
                message: 'RCON port must be a number.'
            };
        }

        const nextConfig = {
            ...existingConfig,
            rconHost: rconHost || null,
            rconPort: rconPort || null,
            rconPassword: rconPassword || null
        };

        if (
            (nextConfig.transportMode === TRANSPORT_MODES.DIRECT_RCON ||
                nextConfig.transportMode === TRANSPORT_MODES.API_WITH_FALLBACK) &&
            (!nextConfig.rconHost || !nextConfig.rconPort || !nextConfig.rconPassword)
        ) {
            return {
                success: false,
                message: 'This server currently uses a transport mode that requires direct RCON. Add valid RCON details before saving.'
            };
        }

        if (nextConfig.rconHost && nextConfig.rconPort && nextConfig.rconPassword) {
            const testResult = await this.testDirectRconConnection(
                nextConfig.rconHost,
                nextConfig.rconPort,
                nextConfig.rconPassword
            );
            if (!testResult.success) {
                return {
                    success: false,
                    message: `Direct RCON test failed: ${testResult.error}\n\nConfiguration NOT saved.`
                };
            }
        }

        configManager.setServerConfig(serverNum, nextConfig);
        return {
            success: true,
            message: `Direct RCON settings saved for Server ${serverNum}. Click **Apply & Restart** to activate the changes.`
        };
    }

    normalizeTransportMode(value) {
        const normalized = String(value || '').trim();
        if (Object.values(TRANSPORT_MODES).includes(normalized)) {
            return normalized;
        }

        throw new Error(
            `Transport mode must be one of: ${Object.values(TRANSPORT_MODES).join(', ')}`
        );
    }

    removeServer(serverNum) {
        return configManager.removeServerConfig(serverNum);
    }
}

module.exports = new SetupWizard();
