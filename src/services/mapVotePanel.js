/**
 * Frontline Democracy - Map Vote Control Panel Service
 * Interactive panel for managing map voting settings, whitelist, and blacklist
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const logger = require('../utils/logger');
const scheduleManager = require('./scheduleManager');

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

            // Frontline Democracy Status
            embed.addFields({
                name: '🗳️ Frontline Democracy',
                value: `**Status:** ${status === 'running' ? '🟢 Running' : '🔴 Paused'}\n` +
                       `**Vote Active:** ${config.voteActive ? '✅ Yes' : '❌ No'}\n` +
                       `**Seeded:** ${config.seeded ? '✅ Yes' : '❌ No'}\n` +
                       `**Activate at:** ${config.minimumPlayers} players\n` +
                       `**Deactivate at:** ${config.deactivatePlayers} players`,
                inline: true
            });

            // CRCON Votemap Status
            if (votemapConfig) {
                embed.addFields({
                    name: '🖥️ CRCON Votemap',
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
                    scheduleValue += sched.hasCustomWhitelist ? '*Custom map pool*' : '*Using CRCON whitelist*';
                } else if (sched.isDefault) {
                    scheduleValue = '**Default**\n*No schedule active*';
                } else {
                    scheduleValue = `**${sched.name}**\n`;
                    scheduleValue += sched.hasCustomWhitelist ? '*Custom map pool*' : '*Using CRCON whitelist*';
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

            embed.setFooter({ text: 'Frontline Democracy • Use the buttons below to manage' });

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
    buildSettingsPanel(mapVotingService) {
        const config = mapVotingService.getConfig();

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
                name: '♻️ Map Vote Cooldown After Playing',
                value: `${config.excludeRecentMaps ?? 3} vote(s)`
            }
        );

        embed.setDescription(
            'Configure Frontline Democracy voting behavior.\n\n' +
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
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('mapvote_set_cooldown')
                .setLabel('Map Cooldown -')
                .setEmoji('♻️')
                .setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('mapvote_back')
                .setLabel('Back to Main')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row1, row2] };
    }
}

module.exports = { MapVotePanelService };
