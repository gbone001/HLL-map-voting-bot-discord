/**
 * Seeding Bot - Map Vote Control Panel Service
 * Interactive panel for managing map voting settings, whitelist, and blacklist
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const logger = require('../utils/logger');
const scheduleManager = require('./scheduleManager');

const SOLO_TANK_FIELD_DEFS = [
    { key: 'dry_run', label: 'Dry Run', type: 'boolean' },
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
    { key: 'kick_message', label: 'Kick Message', type: 'string', multiline: true },
    { key: 'punish_message', label: 'Punish Message', type: 'string', multiline: true },
    { key: 'number_of_notes', label: 'Number Of Notes', type: 'integer' },
    { key: 'warning_message', label: 'Warning Message', type: 'string', multiline: true },
    { key: 'whitelist_flags', label: 'Whitelist Flags', type: 'string_array' },
    { key: 'number_of_warnings', label: 'Number Of Warnings', type: 'integer' },
    { key: 'discord_webhook_url', label: 'Discord Webhook Url', type: 'nullable_string' },
    { key: 'immune_player_level', label: 'Immune Player Level', type: 'integer' },
    { key: 'kick_after_max_punish', label: 'Kick After Max Punish', type: 'boolean' },
    { key: 'number_of_punishments', label: 'Number Of Punishments', type: 'integer' },
    { key: 'notes_interval_seconds', label: 'Notes Interval Seconds', type: 'integer' },
    { key: 'punish_interval_seconds', label: 'Punish Interval Seconds', type: 'integer' },
    { key: 'warning_interval_seconds', label: 'Warning Interval Seconds', type: 'integer' },
    { key: 'kick_grace_period_seconds', label: 'Kick Grace Period Seconds', type: 'integer' },
    { key: 'min_server_players_for_kick', label: 'Min Server Players For Kick', type: 'integer' },
    { key: 'min_server_players_for_punish', label: 'Min Server Players For Punish', type: 'integer' },
    { key: 'dont_do_anything_below_this_number_of_players', label: 'Minimum Players For Any Action', type: 'integer' }
];

const NO_LEADER_FIELD_DEFS = [
    { key: 'dry_run', label: 'Dry Run', type: 'boolean' },
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
    { key: 'immune_roles', label: 'Immune Roles', type: 'string_array' },
    { key: 'kick_message', label: 'Kick Message', type: 'string', multiline: true },
    { key: 'punish_message', label: 'Punish Message', type: 'string', multiline: true },
    { key: 'number_of_notes', label: 'Number Of Notes', type: 'integer' },
    { key: 'warning_message', label: 'Warning Message', type: 'string', multiline: true },
    { key: 'whitelist_flags', label: 'Whitelist Flags', type: 'string_array' },
    { key: 'number_of_warnings', label: 'Number Of Warnings', type: 'integer' },
    { key: 'discord_webhook_url', label: 'Discord Webhook Url', type: 'nullable_string' },
    { key: 'immune_player_level', label: 'Immune Player Level', type: 'integer' },
    { key: 'kick_after_max_punish', label: 'Kick After Max Punish', type: 'boolean' },
    { key: 'number_of_punishments', label: 'Number Of Punishments', type: 'integer' },
    { key: 'notes_interval_seconds', label: 'Notes Interval Seconds', type: 'integer' },
    { key: 'punish_interval_seconds', label: 'Punish Interval Seconds', type: 'integer' },
    { key: 'warning_interval_seconds', label: 'Warning Interval Seconds', type: 'integer' },
    { key: 'kick_grace_period_seconds', label: 'Kick Grace Period Seconds', type: 'integer' },
    { key: 'min_squad_players_for_kick', label: 'Min Squad Players For Kick', type: 'integer' },
    { key: 'min_server_players_for_kick', label: 'Min Server Players For Kick', type: 'integer' },
    { key: 'min_squad_players_for_punish', label: 'Min Squad Players For Punish', type: 'integer' },
    { key: 'min_server_players_for_punish', label: 'Min Server Players For Punish', type: 'integer' },
    { key: 'dont_do_anything_below_this_number_of_players', label: 'Minimum Players For Any Action', type: 'integer' }
];

const LEVEL_GENERAL_FIELD_DEFS = [
    { key: 'dry_run', label: 'Dry Run', type: 'boolean' },
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
    { key: 'max_level', label: 'Max Level', type: 'integer' },
    { key: 'min_level', label: 'Min Level', type: 'integer' },
    { key: 'kick_message', label: 'Kick Message', type: 'string', multiline: true },
    { key: 'punish_message', label: 'Punish Message', type: 'string', multiline: true },
    { key: 'warning_message', label: 'Warning Message', type: 'string', multiline: true },
    { key: 'whitelist_flags', label: 'Whitelist Flags', type: 'string_array' },
    { key: 'levelbug_enabled', label: 'Levelbug Enabled', type: 'boolean' },
    { key: 'max_level_message', label: 'Max Level Message', type: 'string', multiline: true },
    { key: 'min_level_message', label: 'Min Level Message', type: 'string', multiline: true },
    { key: 'violation_message', label: 'Violation Message', type: 'string', multiline: true },
    { key: 'force_kick_message', label: 'Force Kick Message', type: 'string', multiline: true },
    { key: 'number_of_warnings', label: 'Number Of Warnings', type: 'integer' },
    { key: 'discord_webhook_url', label: 'Discord Webhook Url', type: 'nullable_string' },
    { key: 'announcement_enabled', label: 'Announcement Enabled', type: 'boolean' },
    { key: 'announcement_message', label: 'Announcement Message', type: 'string', multiline: true },
    { key: 'kick_after_max_punish', label: 'Kick After Max Punish', type: 'boolean' },
    { key: 'number_of_punishments', label: 'Number Of Punishments', type: 'integer' },
    { key: 'punish_interval_seconds', label: 'Punish Interval Seconds', type: 'integer' },
    { key: 'warning_interval_seconds', label: 'Warning Interval Seconds', type: 'integer' },
    { key: 'kick_grace_period_seconds', label: 'Kick Grace Period Seconds', type: 'integer' },
    { key: 'min_squad_players_for_kick', label: 'Min Squad Players For Kick', type: 'integer' },
    { key: 'min_server_players_for_kick', label: 'Min Server Players For Kick', type: 'integer' },
    { key: 'min_squad_players_for_punish', label: 'Min Squad Players For Punish', type: 'integer' },
    { key: 'min_server_players_for_punish', label: 'Min Server Players For Punish', type: 'integer' },
    { key: 'only_announce_impacted_players', label: 'Only Announce Impacted Players', type: 'boolean' },
    { key: 'dont_do_anything_below_this_number_of_players', label: 'Minimum Players For Any Action', type: 'integer' }
];

const LEVEL_ROLE_KEYS = ['officer', 'spotter', 'armycommander', 'tankcommander'];

// Map categories for organization
const MAP_CATEGORIES = {
    western_front: {
        name: 'Western Front',
        emoji: '🇫🇷',
        maps: ['stmariedumont', 'stmereeglise', 'utahbeach', 'omahabeach', 'purpleheartlane', 'carentan', 'foy', 'hurtgenforest', 'hill400', 'remagen']
    },
    eastern_front: {
        name: 'Eastern Front',
        emoji: '🇷🇺',
        maps: ['stalingrad', 'kursk', 'kharkov', 'smolensk']
    },
    north_africa: {
        name: 'North Africa',
        emoji: '🏜️',
        maps: ['elalamein', 'tobruk', 'driel']
    },
    pacific: {
        name: 'Pacific',
        emoji: '🌴',
        maps: ['iwo', 'mortain']
    }
};

class MapVotePanelService {
    constructor() {
        this.cachedMaps = null;
        this.cacheTime = 0;
        this.cacheDuration = 60000; // 1 minute cache
    }

    /**
     * Build the main control panel embed
     */
    async buildControlPanel(mapVotingService, crconService, serverName = 'Server') {
        try {
            const config = mapVotingService.getConfig();
            const status = mapVotingService.getStatus();

            const embed = new EmbedBuilder()
                .setTitle(`🗺️ Map Vote Control Panel - ${serverName}`)
                .setColor(0x3498DB)
                .setTimestamp();

            // Get all relevant data in parallel
            let playerCount = 0;
            let currentMap = 'Unknown';
            let votemapConfig = null;
            let votemapStatus = null;
            let whitelistCount = 0;
            let totalMaps = 0;
            let mapHistory = [];

            try {
                const [serverStatus, vmConfig, vmStatus, whitelist, allMaps, history] = await Promise.all([
                    crconService.getStatus().catch(() => null),
                    crconService.getVotemapConfig().catch(() => null),
                    crconService.getVotemapStatus().catch(() => null),
                    crconService.getVotemapWhitelist().catch(() => null),
                    crconService.getMaps().catch(() => null),
                    crconService.getMapHistory ? crconService.getMapHistory().catch(() => null) : null
                ]);

                if (serverStatus?.result) {
                    playerCount = serverStatus.result.current_players || 0;
                    currentMap = serverStatus.result.map?.pretty_name || serverStatus.result.name || 'Unknown';
                }
                votemapConfig = vmConfig?.result;
                votemapStatus = vmStatus?.result;
                whitelistCount = whitelist?.result?.length || 0;
                totalMaps = allMaps?.result?.length || 0;
                mapHistory = history?.result || [];
            } catch (e) {
                logger.warn(`[MapVotePanel] Error fetching data: ${e.message}`);
            }

            // Seeding Bot Status
            embed.addFields({
                name: '🗳️ Seeding Bot',
                value: `**Status:** ${status === 'running' ? '🟢 Running' : '🔴 Paused'}\n` +
                       `**Vote Active:** ${config.voteActive ? '✅ Yes' : '❌ No'}\n` +
                       `**Seeded:** ${config.seeded ? '✅ Yes' : '❌ No'}\n` +
                       `**Activate at:** ${config.minimumPlayers} players\n` +
                       `**Deactivate at:** ${config.deactivatePlayers} players`,
                inline: true
            });

            const providerLabel = crconService?.constructor?.name === 'RCONService' ? 'RCON' : 'CRCON';
            embed.addFields({
                name: '🔌 Provider',
                value: `**Mode:** ${providerLabel}`,
                inline: true
            });

            // Provider Votemap Status
            if (votemapConfig) {
                embed.addFields({
                    name: '🖥️ Server Votemap',
                    value: `**Enabled:** ${votemapConfig.enabled ? '✅ Yes' : '❌ No'}\n` +
                           `**Default Method:** ${votemapConfig.default_method || 'N/A'}\n` +
                           `**Num Options:** ${votemapConfig.num_options || 'N/A'}\n` +
                           `**Allow Opt Out:** ${votemapConfig.allow_opt_out ? '✅' : '❌'}`,
                    inline: true
                });
            } else {
                embed.addFields({
                    name: '🖥️ Server Status',
                    value: `**Players:** ${playerCount}\n` +
                           `**Current Map:** ${currentMap.substring(0, 30)}`,
                    inline: true
                });
            }

            // Current Vote Status
            if (votemapStatus) {
                const votes = votemapStatus.votes || {};
                const totalVotes = Object.values(votes).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
                embed.addFields({
                    name: '📊 Current Vote',
                    value: `**Total Votes:** ${totalVotes}\n` +
                           `**Selection:** ${votemapStatus.selection || 'None'}\n` +
                           `**Options:** ${Object.keys(votes).length}`,
                    inline: true
                });
            }

            // Whitelist Summary
            embed.addFields({
                name: '📋 Whitelist',
                value: `**Whitelisted:** ${whitelistCount}\n` +
                       `**Total Available:** ${totalMaps}\n` +
                       `**Blacklisted:** ${totalMaps - whitelistCount}`,
                inline: true
            });

            // Map History (last 3)
            if (mapHistory && mapHistory.length > 0) {
                const recentMaps = mapHistory.slice(0, 3).map((m, i) => {
                    const mapName = m.map?.pretty_name || m.name || m.id || 'Unknown';
                    return `${i + 1}. ${mapName}`;
                }).join('\n');
                embed.addFields({
                    name: '📜 Recent Maps',
                    value: recentMaps || 'No history',
                    inline: true
                });
            }

            // Settings Summary
            embed.addFields({
                name: '⚙️ Settings',
                value: `**Maps/Vote:** ${config.mapsPerVote}\n` +
                       `**Night Maps:** ${config.nightMapCount}\n` +
                       `**Warfare:** ${config.modeWeights?.warfare || 0} | **Offensive:** ${config.modeWeights?.offensive || 0}\n` +
                       `**Map Cooldown Votes:** ${config.excludeRecentMaps ?? 3}`,
                inline: true
            });

            // Active Schedule - use config from service
            if (config.activeSchedule) {
                const sched = config.activeSchedule;
                let scheduleValue = '';

                if (sched.isOverride) {
                    scheduleValue = `**${sched.name}** (Override)\n`;
                    scheduleValue += sched.hasCustomWhitelist ? '*Custom map pool*' : '*Using server whitelist*';
                } else if (sched.isDefault) {
                    scheduleValue = '**Default**\n*No schedule active*';
                } else {
                    scheduleValue = `**${sched.name}**\n`;
                    scheduleValue += sched.hasCustomWhitelist ? '*Custom map pool*' : '*Using server whitelist*';
                }

                if (config.pendingScheduleTransition) {
                    scheduleValue += '\n⚠️ *Transition pending*';
                }

                embed.addFields({
                    name: '⏰ Active Schedule',
                    value: scheduleValue,
                    inline: true
                });
            }

            embed.setDescription(
                'Control map voting settings, manage whitelist/blacklist, and configure voting behavior.\n\n' +
                '**Quick Actions:**\n' +
                '• Toggle map voting on/off\n' +
                '• Manage map whitelist\n' +
                '• Configure voting thresholds'
            );

            embed.setFooter({ text: 'HLL Map Vote Bot • Use the buttons below to manage' });
            const supportsAutomod = !!crconService &&
                crconService.supportsAutomod !== false &&
                typeof crconService.getAutoModLevelConfig === 'function';
            const supportsHistory = !!crconService &&
                crconService.supportsHistory !== false &&
                typeof crconService.getMapHistory === 'function';

            // Control buttons - Row 1
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('mapvote_toggle')
                    .setLabel(status === 'running' ? 'Pause Voting' : 'Start Voting')
                    .setEmoji(status === 'running' ? '⏸️' : '▶️')
                    .setStyle(status === 'running' ? ButtonStyle.Danger : ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('mapvote_whitelist')
                    .setLabel('Whitelist')
                    .setEmoji('📋')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('mapvote_blacklist')
                    .setLabel('Blacklist')
                    .setEmoji('🚫')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('mapvote_schedules')
                    .setLabel('Schedules')
                    .setEmoji('⏰')
                    .setStyle(ButtonStyle.Secondary)
            );

            // Row 2 - Quick actions
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('mapvote_settings')
                    .setLabel('Settings')
                    .setEmoji('⚙️')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('mapvote_history')
                    .setLabel('History')
                    .setEmoji('📜')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!supportsHistory),
                new ButtonBuilder()
                    .setCustomId('mapvote_automods')
                    .setLabel('Automods')
                    .setEmoji('🤖')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!supportsAutomod),
                new ButtonBuilder()
                    .setCustomId('mapvote_export_schedule')
                    .setLabel('Export Schedule')
                    .setEmoji('📤')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('mapvote_refresh')
                    .setLabel('Refresh')
                    .setEmoji('🔄')
                    .setStyle(ButtonStyle.Success)
            );

            // Row 3 - Reset actions
            const row3 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('mapvote_reset_whitelist')
                    .setLabel('Reset Whitelist')
                    .setEmoji('🔄')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('mapvote_reset_vote')
                    .setLabel('Reset Vote')
                    .setEmoji('🗑️')
                    .setStyle(ButtonStyle.Danger)
            );

            return { embeds: [embed], components: [row1, row2, row3] };
        } catch (error) {
            logger.error('[MapVotePanel] Error building control panel:', error);
            return { content: 'Error building control panel' };
        }
    }

    /**
     * Build whitelist management embed
     */
    async buildWhitelistPanel(crconService, page = 0, filter = null) {
        try {
            // Get all maps
            const mapsResponse = await crconService.getMaps();
            const allMaps = mapsResponse?.result || [];

            // Get current whitelist
            const whitelistResponse = await crconService.getVotemapWhitelist();
            const whitelist = new Set(whitelistResponse?.result || []);

            // Filter maps
            let filteredMaps = allMaps;
            if (filter === 'warfare') {
                filteredMaps = allMaps.filter(m => m.game_mode === 'warfare');
            } else if (filter === 'offensive') {
                filteredMaps = allMaps.filter(m => m.game_mode === 'offensive');
            } else if (filter === 'night') {
                filteredMaps = allMaps.filter(m => m.environment === 'night');
            } else if (filter === 'day') {
                filteredMaps = allMaps.filter(m => m.environment !== 'night');
            }

            // Paginate
            const mapsPerPage = 15;
            const totalPages = Math.ceil(filteredMaps.length / mapsPerPage);
            const startIndex = page * mapsPerPage;
            const pageMaps = filteredMaps.slice(startIndex, startIndex + mapsPerPage);

            // Build map list
            const mapLines = pageMaps.map(map => {
                const isWhitelisted = whitelist.has(map.id);
                const icon = isWhitelisted ? '✅' : '❌';
                const mode = map.game_mode === 'warfare' ? '⚔️' : map.game_mode === 'offensive' ? '🎯' : '🔫';
                const time = map.environment === 'night' ? '🌙' : map.environment === 'day' ? '☀️' : '🌤️';
                return `${icon} ${mode}${time} ${map.pretty_name}`;
            });

            const embed = new EmbedBuilder()
                .setTitle('📋 Map Whitelist Management')
                .setDescription(
                    `**Legend:** ✅ = Whitelisted, ❌ = Blacklisted\n` +
                    `**Modes:** ⚔️ = Warfare, 🎯 = Offensive, 🔫 = Skirmish\n` +
                    `**Time:** ☀️ = Day, 🌤️ = Overcast, 🌙 = Night\n\n` +
                    `Page ${page + 1}/${totalPages}\n\n` +
                    (mapLines.join('\n') || 'No maps found')
                )
                .setColor(0x2ECC71)
                .addFields({
                    name: 'Summary',
                    value: `**Whitelisted:** ${whitelist.size}\n**Blacklisted:** ${allMaps.length - whitelist.size}\n**Total:** ${allMaps.length}`,
                    inline: true
                })
                .setFooter({ text: 'Use the select menu to toggle maps' });

            // Navigation and filter row
            const filterRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`mapvote_wl_prev_${page}_${filter || 'all'}`)
                    .setLabel('◀ Prev')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId(`mapvote_wl_next_${page}_${filter || 'all'}`)
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page >= totalPages - 1),
                new ButtonBuilder()
                    .setCustomId('mapvote_wl_warfare')
                    .setLabel('Warfare')
                    .setEmoji('⚔️')
                    .setStyle(filter === 'warfare' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('mapvote_wl_offensive')
                    .setLabel('Offensive')
                    .setEmoji('🎯')
                    .setStyle(filter === 'offensive' ? ButtonStyle.Primary : ButtonStyle.Secondary)
            );

            // Quick toggle row
            const toggleRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('mapvote_wl_night')
                    .setLabel('Night')
                    .setEmoji('🌙')
                    .setStyle(filter === 'night' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('mapvote_wl_day')
                    .setLabel('Day')
                    .setEmoji('☀️')
                    .setStyle(filter === 'day' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('mapvote_wl_all_on')
                    .setLabel('Whitelist All')
                    .setEmoji('✅')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('mapvote_wl_all_off')
                    .setLabel('Blacklist All')
                    .setEmoji('❌')
                    .setStyle(ButtonStyle.Danger)
            );

            // Map toggle select menu
            const selectOptions = pageMaps.slice(0, 25).map(map => ({
                label: (map.pretty_name || map.id).substring(0, 100),
                value: map.id,
                description: `${whitelist.has(map.id) ? '✅ Whitelisted' : '❌ Blacklisted'} - ${map.game_mode}`,
                emoji: whitelist.has(map.id) ? '✅' : '❌'
            }));

            const selectRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('mapvote_wl_toggle_map')
                    .setPlaceholder('Toggle individual map...')
                    .addOptions(selectOptions.length > 0 ? selectOptions : [{ label: 'No maps', value: 'none' }])
            );

            // Back button
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('mapvote_back')
                    .setLabel('Back to Main')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
            );

            return { embeds: [embed], components: [filterRow, toggleRow, selectRow, backRow] };
        } catch (error) {
            logger.error('[MapVotePanel] Error building whitelist panel:', error);
            return { content: 'Error building whitelist panel' };
        }
    }

    /**
     * Build blacklist view embed
     */
    async buildBlacklistPanel(crconService) {
        try {
            const [whitelistResponse, mapsResponse] = await Promise.all([
                crconService.getVotemapWhitelist(),
                crconService.getMaps()
            ]);

            const whitelist = new Set(whitelistResponse?.result || []);
            const allMaps = mapsResponse?.result || [];
            const blacklistedMaps = allMaps.filter(m => !whitelist.has(m.id));

            const embed = new EmbedBuilder()
                .setTitle('🚫 Blacklisted Maps')
                .setColor(0xE74C3C)
                .setTimestamp();

            if (blacklistedMaps.length === 0) {
                embed.setDescription('No maps are currently blacklisted. All maps are available for voting.');
            } else {
                // Group by game mode
                const byMode = { warfare: [], offensive: [], skirmish: [] };

                for (const map of blacklistedMaps) {
                    const mode = map.game_mode || 'other';
                    if (byMode[mode]) {
                        byMode[mode].push(map);
                    }
                }

                for (const [mode, maps] of Object.entries(byMode)) {
                    if (maps.length > 0) {
                        const modeEmoji = mode === 'warfare' ? '⚔️' : mode === 'offensive' ? '🎯' : '🔫';
                        const mapNames = maps.map(m => {
                            const timeBadge = m.environment === 'night' ? '🌙' : m.environment === 'day' ? '☀️' : '🌤️';
                            return `${timeBadge} ${m.pretty_name || m.id}`;
                        }).join('\n');

                        embed.addFields({
                            name: `${modeEmoji} ${mode.charAt(0).toUpperCase() + mode.slice(1)} (${maps.length})`,
                            value: mapNames.substring(0, 1024) || 'None',
                            inline: false
                        });
                    }
                }

                embed.setDescription(
                    `**Total Blacklisted:** ${blacklistedMaps.length} maps\n` +
                    `These maps will NOT appear in map voting.\n\n` +
                    `Use the Whitelist Manager to re-enable maps.`
                );
            }

            embed.setFooter({ text: 'Blacklisted maps are excluded from voting' });

            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('mapvote_back')
                    .setLabel('Back to Main')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
            );

            return { embeds: [embed], components: [backRow] };
        } catch (error) {
            logger.error('[MapVotePanel] Error building blacklist panel:', error);
            return { content: 'Error building blacklist panel' };
        }
    }

    /**
     * Build map history embed
     */
    async buildHistoryPanel(crconService) {
        try {
            let history = [];
            if (crconService.getMapHistory) {
                const response = await crconService.getMapHistory();
                history = response?.result || [];
            }

            const embed = new EmbedBuilder()
                .setTitle('📜 Map History')
                .setColor(0xF39C12)
                .setTimestamp();

            if (!history || history.length === 0) {
                embed.setDescription('No map history available.');
            } else {
                const historyList = history.slice(0, 15).map((entry, i) => {
                    const mapName = entry.map?.pretty_name || entry.name || entry.id || 'Unknown';
                    const startTime = entry.start ? new Date(entry.start * 1000).toLocaleString() : 'N/A';
                    return `**${i + 1}.** ${mapName}\n   Started: ${startTime}`;
                }).join('\n\n');

                embed.setDescription(historyList.substring(0, 4096));
            }

            embed.setFooter({ text: 'Last 15 maps played' });

            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('mapvote_back')
                    .setLabel('Back to Main')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
            );

            return { embeds: [embed], components: [backRow] };
        } catch (error) {
            logger.error('[MapVotePanel] Error building history panel:', error);
            return { content: 'Error building history panel' };
        }
    }

    /**
     * Build settings panel
     */
    buildSettingsPanel(mapVotingService, generalSettings = {}) {
        const config = mapVotingService.getConfig();
        const teamSwitchCooldown = generalSettings.teamSwitchCooldown;
        const idleAutokickTime = generalSettings.idleAutokickTime;
        const maxPingAutokick = generalSettings.maxPingAutokick;

        const embed = new EmbedBuilder()
            .setTitle('⚙️ Map Vote Settings')
            .setColor(0x9B59B6)
            .setTimestamp();

        embed.addFields(
            {
                name: '👥 Player Thresholds',
                value: `**Activate at:** ${config.minimumPlayers} players\n` +
                       `**Deactivate at:** ${config.deactivatePlayers} players`,
                inline: true
            },
            {
                name: '🗺️ Vote Options',
                value: `**Maps per Vote:** ${config.mapsPerVote}\n` +
                       `**Night Maps:** ${config.nightMapCount}`,
                inline: true
            },
            {
                name: '⚖️ Mode Weights',
                value: `**Warfare:** ${config.modeWeights?.warfare || 0}\n` +
                       `**Offensive:** ${config.modeWeights?.offensive || 0}\n` +
                       `**Skirmish:** ${config.modeWeights?.skirmish || 0}`,
                inline: true
            },
            {
                name: '🧩 Server General Settings',
                value:
                    `**Team Switch Cooldown:** ${teamSwitchCooldown ?? 'Unknown'} min\n` +
                    `**Idle Autokick Time:** ${idleAutokickTime ?? 'Unknown'} min\n` +
                    `**Max Ping Autokick:** ${maxPingAutokick ?? 'Unknown'} ms`
            }
        );

        embed.setDescription(
            'Configure Seeding Bot voting behavior.\n\n' +
            'Click a button below to edit a setting.'
        );

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('mapvote_set_activate')
                .setLabel('Min Players')
                .setEmoji('📈')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('mapvote_set_deactivate')
                .setLabel('Deactivate')
                .setEmoji('📉')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('mapvote_set_maps_count')
                .setLabel('Maps/Vote')
                .setEmoji('🗺️')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('mapvote_set_night_count')
                .setLabel('Night Maps')
                .setEmoji('🌙')
                .setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('mapvote_set_team_switch_cooldown')
                .setLabel('Team Switch')
                .setEmoji('🔁')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('mapvote_set_idle_autokick')
                .setLabel('Idle Kick')
                .setEmoji('🛌')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('mapvote_set_max_ping')
                .setLabel('Max Ping')
                .setEmoji('📶')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('mapvote_back')
                .setLabel('Back to Main')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row1, row2] };
    }

    getSoloTankFieldDefinitions() {
        return SOLO_TANK_FIELD_DEFS;
    }

    getNoLeaderFieldDefinitions() {
        return NO_LEADER_FIELD_DEFS;
    }

    getLevelGeneralFieldDefinitions() {
        return LEVEL_GENERAL_FIELD_DEFS;
    }

    getLevelRoleKeys() {
        return LEVEL_ROLE_KEYS;
    }

    buildAutomodsPanel(serverNum, serverName = 'Server') {
        const embed = new EmbedBuilder()
            .setTitle(`🤖 Automods - ${serverName}`)
            .setColor(0x5865F2)
            .setDescription(
                'Manage server automod modules.\n\n' +
                'Choose a module below:\n' +
                '• Level - General Settings\n' +
                '• Level - Role Levels\n' +
                '• No Leader\n' +
                '• No Solo Tank'
            )
            .setFooter({ text: 'Automods settings panel' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`automod_level_general_${serverNum}`)
                .setLabel('Level - General Settings')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`automod_level_roles_${serverNum}`)
                .setLabel('Level - Role Levels')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`automod_no_leader_${serverNum}`)
                .setLabel('No Leader')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`automod_solo_tank_${serverNum}`)
                .setLabel('No Solo Tank')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`automod_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row] };
    }

    buildAutoModSoloTankPanel(serverNum, serverName = 'Server', draftConfig = {}, source = 'server') {
        const embed = new EmbedBuilder()
            .setTitle(`🚫 No Solo Tank Config - ${serverName}`)
            .setColor(0xE67E22)
            .setDescription(
                `Source: **${source}**\n` +
                'Select a field from the dropdown to edit it, then click **Commit Changes** to apply to the server provider.\n\n' +
                this.buildSoloTankConfigTable(draftConfig)
            )
            .setFooter({ text: 'Edits are local until Commit Changes is pressed' });

        const selectOptions = SOLO_TANK_FIELD_DEFS.map(field => ({
            label: field.label.substring(0, 100),
            value: field.key,
            description: this.formatAutoModValueForSelect(draftConfig[field.key], field.type)
        }));

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`automod_solo_tank_field_${serverNum}`)
                .setPlaceholder('Select a field to edit...')
                .addOptions(selectOptions)
        );

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`automod_solo_tank_refresh_${serverNum}`)
                .setLabel('Refresh')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`automod_solo_tank_commit_${serverNum}`)
                .setLabel('Commit Changes')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`automod_solo_tank_save_${serverNum}`)
                .setLabel('Save Config')
                .setEmoji('💾')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`automod_solo_tank_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, actionRow] };
    }

    buildAutoModLevelGeneralPanel(serverNum, serverName = 'Server', draftConfig = {}, source = 'server') {
        const embed = new EmbedBuilder()
            .setTitle(`📈 Level Config - General - ${serverName}`)
            .setColor(0x8E44AD)
            .setDescription(
                `Source: **${source}**\n` +
                'Edit the general level automod settings. Role thresholds are managed in the Level - Role Levels panel.\n\n' +
                this.buildLevelGeneralConfigTable(draftConfig)
            )
            .setFooter({ text: 'Edits are local until Commit Changes is pressed' });

        const selectOptions = LEVEL_GENERAL_FIELD_DEFS.map(field => ({
            label: field.label.substring(0, 100),
            value: field.key,
            description: this.formatAutoModValueForSelect(draftConfig[field.key], field.type)
        }));

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`automod_level_general_field_${serverNum}`)
                .setPlaceholder('Select a general field to edit...')
                .addOptions(selectOptions)
        );

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`automod_level_general_refresh_${serverNum}`)
                .setLabel('Refresh')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`automod_level_general_commit_${serverNum}`)
                .setLabel('Commit Changes')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`automod_level_general_save_${serverNum}`)
                .setLabel('Save Config')
                .setEmoji('💾')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`automod_level_general_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, actionRow] };
    }

    buildAutoModLevelRolesPanel(serverNum, serverName = 'Server', draftConfig = {}, source = 'server') {
        const embed = new EmbedBuilder()
            .setTitle(`📊 Level Config - Role Levels - ${serverName}`)
            .setColor(0x2C3E50)
            .setDescription(
                `Source: **${source}**\n` +
                'Select a role threshold to edit label/min_level/min_players.\n\n' +
                this.buildLevelRolesTable(draftConfig.level_thresholds || {})
            )
            .setFooter({ text: 'Edits are local until Commit Changes is pressed' });

        const options = LEVEL_ROLE_KEYS.map(role => {
            const value = draftConfig.level_thresholds?.[role] || {};
            return {
                label: role.substring(0, 100),
                value: role,
                description: `L=${value.min_level ?? 0}, P=${value.min_players ?? 0}, ${String(value.label || role).slice(0, 45)}`
            };
        });

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`automod_level_roles_select_${serverNum}`)
                .setPlaceholder('Select a role threshold to edit...')
                .addOptions(options)
        );

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`automod_level_roles_refresh_${serverNum}`)
                .setLabel('Refresh')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`automod_level_roles_commit_${serverNum}`)
                .setLabel('Commit Changes')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`automod_level_roles_save_${serverNum}`)
                .setLabel('Save Config')
                .setEmoji('💾')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`automod_level_roles_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, actionRow] };
    }

    buildAutoModNoLeaderPanel(serverNum, serverName = 'Server', draftConfig = {}, source = 'server') {
        const embed = new EmbedBuilder()
            .setTitle(`🧭 No Leader Config - ${serverName}`)
            .setColor(0x1ABC9C)
            .setDescription(
                `Source: **${source}**\n` +
                'Select a field from the dropdown to edit it, then click **Commit Changes** to apply to the server provider.\n\n' +
                this.buildNoLeaderConfigTable(draftConfig)
            )
            .setFooter({ text: 'Edits are local until Commit Changes is pressed' });

        const selectOptions = NO_LEADER_FIELD_DEFS.map(field => ({
            label: field.label.substring(0, 100),
            value: field.key,
            description: this.formatAutoModValueForSelect(draftConfig[field.key], field.type)
        }));

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`automod_no_leader_field_${serverNum}`)
                .setPlaceholder('Select a field to edit...')
                .addOptions(selectOptions)
        );

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`automod_no_leader_refresh_${serverNum}`)
                .setLabel('Refresh')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`automod_no_leader_commit_${serverNum}`)
                .setLabel('Commit Changes')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`automod_no_leader_save_${serverNum}`)
                .setLabel('Save Config')
                .setEmoji('💾')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`automod_no_leader_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, actionRow] };
    }

    buildSoloTankConfigTable(config) {
        const lines = SOLO_TANK_FIELD_DEFS.map(field => {
            const value = this.formatAutoModValueForTable(config[field.key], field.type);
            return `${field.key}: ${value}`;
        });
        return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
    }

    buildNoLeaderConfigTable(config) {
        const lines = NO_LEADER_FIELD_DEFS.map(field => {
            const value = this.formatAutoModValueForTable(config[field.key], field.type);
            return `${field.key}: ${value}`;
        });
        return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
    }

    buildLevelGeneralConfigTable(config) {
        const lines = LEVEL_GENERAL_FIELD_DEFS.map(field => {
            const value = this.formatAutoModValueForTable(config[field.key], field.type);
            return `${field.key}: ${value}`;
        });
        return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
    }

    buildLevelRolesTable(levelThresholds) {
        const lines = LEVEL_ROLE_KEYS.map(role => {
            const value = levelThresholds?.[role] || {};
            const label = value.label || role;
            const minLevel = value.min_level ?? 0;
            const minPlayers = value.min_players ?? 0;
            return `${role}: { label: "${label}", min_level: ${minLevel}, min_players: ${minPlayers} }`;
        });
        return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
    }

    formatAutoModValueForSelect(value, type) {
        const raw = this.formatAutoModValueForTable(value, type);
        return raw.length > 95 ? `${raw.slice(0, 92)}...` : raw;
    }

    formatAutoModValueForTable(value, type) {
        if (value === null || value === undefined) {
            return 'null';
        }
        if (type === 'string_array') {
            return Array.isArray(value) ? `[${value.join(', ')}]` : '[]';
        }
        let text = String(value).replace(/\n/g, '\\n');
        if (text.length > 120) {
            text = `${text.slice(0, 117)}...`;
        }
        return text;
    }
}

module.exports = { MapVotePanelService };

