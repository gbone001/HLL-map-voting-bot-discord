/**
 * Schedule Panel Service
 * Discord UI for managing time-based map pool schedules
 */

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const scheduleManager = require('./scheduleManager');
const { MapVotePanelService } = require('./mapVotePanel');
const logger = require('../utils/logger');
const automodPanelHelper = new MapVotePanelService();

function isUnsupportedTransportError(error) {
    return error?.code === 'UNSUPPORTED_TRANSPORT';
}

class SchedulePanelService {
    constructor() {
        this.scheduleEditorDrafts = new Map();
    }

    getScheduleEditorDraftKey(serverNum, userId) {
        return `${serverNum}:${userId}`;
    }

    createEmptyScheduleDraft() {
        return {
            scheduleId: null,
            isNew: true,
            name: 'New Schedule',
            startTime: '18:00',
            endTime: '23:00',
            days: [...scheduleManager.getDayPresets().all],
            minimumPlayers: 25,
            mapsPerVote: 6
        };
    }

    createDraftFromSchedule(schedule) {
        return {
            scheduleId: schedule.id,
            isNew: false,
            name: schedule.name,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            days: Array.isArray(schedule.days) && schedule.days.length > 0
                ? [...schedule.days]
                : [...scheduleManager.getDayPresets().all],
            minimumPlayers: schedule.settings?.minimumPlayers ?? 25,
            mapsPerVote: schedule.settings?.mapsPerVote ?? 6
        };
    }

    startScheduleEditor(serverNum, userId, scheduleId = null) {
        const draft = scheduleId
            ? this.createDraftFromSchedule(
                scheduleManager.getSchedules(serverNum).find(schedule => schedule.id === scheduleId) || {}
            )
            : this.createEmptyScheduleDraft();

        if (scheduleId && !draft.scheduleId) {
            return null;
        }

        this.scheduleEditorDrafts.set(this.getScheduleEditorDraftKey(serverNum, userId), draft);
        return draft;
    }

    getScheduleEditorDraft(serverNum, userId) {
        const draft = this.scheduleEditorDrafts.get(this.getScheduleEditorDraftKey(serverNum, userId));
        return draft ? { ...draft, days: [...draft.days] } : null;
    }

    updateScheduleEditorDraft(serverNum, userId, updates) {
        const draftKey = this.getScheduleEditorDraftKey(serverNum, userId);
        const currentDraft = this.scheduleEditorDrafts.get(draftKey);
        if (!currentDraft) {
            return null;
        }

        const nextDraft = {
            ...currentDraft,
            ...updates
        };
        if (updates.days !== undefined) {
            nextDraft.days = [...updates.days];
        }

        this.scheduleEditorDrafts.set(draftKey, nextDraft);
        return { ...nextDraft, days: [...nextDraft.days] };
    }

    clearScheduleEditorDraft(serverNum, userId) {
        this.scheduleEditorDrafts.delete(this.getScheduleEditorDraftKey(serverNum, userId));
    }

    validateScheduleDraft(draft) {
        const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
        if (!draft.name || !draft.name.trim()) {
            return { success: false, error: 'Schedule name is required.' };
        }
        if (!timeRegex.test(draft.startTime) || !timeRegex.test(draft.endTime)) {
            return { success: false, error: 'Invalid time format. Use HH:MM (24-hour format).' };
        }
        if (!Number.isInteger(draft.minimumPlayers) || draft.minimumPlayers < 0 || draft.minimumPlayers > 100) {
            return { success: false, error: 'Minimum players must be between 0 and 100.' };
        }
        if (!Number.isInteger(draft.mapsPerVote) || draft.mapsPerVote < 2 || draft.mapsPerVote > 10) {
            return { success: false, error: 'Maps per vote must be between 2 and 10.' };
        }

        return { success: true };
    }

    saveScheduleEditorDraft(serverNum, userId) {
        const draft = this.getScheduleEditorDraft(serverNum, userId);
        if (!draft) {
            return { success: false, error: 'No schedule editor session found.' };
        }

        const validation = this.validateScheduleDraft(draft);
        if (!validation.success) {
            return validation;
        }

        if (draft.scheduleId) {
            const result = scheduleManager.updateSchedule(serverNum, draft.scheduleId, {
                name: draft.name.trim(),
                startTime: draft.startTime,
                endTime: draft.endTime,
                days: draft.days,
                settings: {
                    minimumPlayers: draft.minimumPlayers,
                    mapsPerVote: draft.mapsPerVote
                }
            });

            if (!result.success) {
                return result;
            }

            this.clearScheduleEditorDraft(serverNum, userId);
            return { success: true, schedule: result.schedule, isNew: false };
        }

        const schedule = scheduleManager.createSchedule(serverNum, {
            name: draft.name.trim(),
            startTime: draft.startTime,
            endTime: draft.endTime,
            days: draft.days,
            minimumPlayers: draft.minimumPlayers,
            mapsPerVote: draft.mapsPerVote
        });

        if (!schedule) {
            return { success: false, error: 'Failed to save new schedule. Please try again.' };
        }

        this.clearScheduleEditorDraft(serverNum, userId);
        return { success: true, schedule, isNew: true };
    }

    getDayOptions() {
        return [
            { label: 'Monday', value: 'mon', emoji: '1️⃣' },
            { label: 'Tuesday', value: 'tue', emoji: '2️⃣' },
            { label: 'Wednesday', value: 'wed', emoji: '3️⃣' },
            { label: 'Thursday', value: 'thu', emoji: '4️⃣' },
            { label: 'Friday', value: 'fri', emoji: '5️⃣' },
            { label: 'Saturday', value: 'sat', emoji: '6️⃣' },
            { label: 'Sunday', value: 'sun', emoji: '7️⃣' }
        ];
    }

    formatSelectedDays(days = []) {
        const sortedDays = this.getDayOptions()
            .map(option => option.value)
            .filter(value => days.includes(value));

        if (sortedDays.length === 7) {
            return 'All Days';
        }

        const presets = scheduleManager.getDayPresets();
        if (JSON.stringify(sortedDays) === JSON.stringify(presets.weekdays)) {
            return 'Weekdays';
        }
        if (JSON.stringify(sortedDays) === JSON.stringify(presets.weekend)) {
            return 'Weekend';
        }

        return this.getDayOptions()
            .filter(option => sortedDays.includes(option.value))
            .map(option => option.label)
            .join(', ') || 'No days selected';
    }

    getDefaultScheduleGeneralSettings() {
        return {
            teamSwitchCooldown: null,
            idleAutokickTime: null,
            maxPingAutokick: null,
            mapVoteCooldownVotes: null
        };
    }

    getScheduleGeneralSettingDefinitions() {
        return [
            { key: 'teamSwitchCooldown', label: 'Team Switch Cooldown', unit: 'min' },
            { key: 'idleAutokickTime', label: 'Idle Autokick Time', unit: 'min' },
            { key: 'maxPingAutokick', label: 'Max Ping Autokick', unit: 'ms' },
            { key: 'mapVoteCooldownVotes', label: 'Map Vote Cooldown', unit: 'votes' }
        ];
    }

    hasScheduleSpecificGeneralSettings(schedule) {
        const generalSettings = {
            ...this.getDefaultScheduleGeneralSettings(),
            ...(schedule?.generalSettings || {})
        };
        return Object.values(generalSettings).some(value => value !== null && value !== undefined);
    }

    buildGeneralSettingsExportLines(schedule) {
        const generalSettings = {
            ...this.getDefaultScheduleGeneralSettings(),
            ...(schedule?.generalSettings || {})
        };
        const defs = this.getScheduleGeneralSettingDefinitions();

        return [
            'General Settings:',
            ...defs.map(def => {
                const value = generalSettings[def.key];
                if (value === null || value === undefined) {
                    return `- ${def.label}: Server (inherit)`;
                }
                return `- ${def.label}: ${value} ${def.unit} (schedule-specific)`;
            })
        ];
    }

    buildAutomodExportLines(schedule) {
        const automodConfigs = schedule?.automodConfigs || {};
        const automodProfiles = schedule?.automodProfiles || {};
        const moduleDefs = [
            { key: 'level', label: 'Level' },
            { key: 'no_leader', label: 'No Leader' },
            { key: 'solo_tank', label: 'No Solo Tank' }
        ];

        return [
            'Automods:',
            ...moduleDefs.map(def => {
                const config = automodConfigs[def.key];
                const profile = automodProfiles[def.key];
                if (config && typeof config === 'object') {
                    const configuredFields = Object.keys(config).length;
                    return `- ${def.label}: Schedule-specific (${configuredFields} fields)`;
                }
                if (profile) {
                    return `- ${def.label}: Preset attachment (${profile})`;
                }
                return `- ${def.label}: Server (inherit)`;
            })
        ];
    }

    /**
     * Build main schedule management panel
     */
    buildSchedulePanel(serverNum, serverName = 'Server') {
        const config = scheduleManager.getServerConfig(serverNum);
        const schedules = scheduleManager.getSchedules(serverNum);
        const activeSchedule = scheduleManager.getActiveSchedule(serverNum);
        const { time, day, timezone } = scheduleManager.getCurrentTime(serverNum);
        const hasAnyScheduleGeneralOverrides = schedules.some(schedule => this.hasScheduleSpecificGeneralSettings(schedule));

        const embed = new EmbedBuilder()
            .setTitle(`⏰ Schedule Manager - ${serverName}`)
            .setColor(0x3498DB)
            .setTimestamp();

        // Current status
        let statusValue = `**Current Time:** ${time} (${day.toUpperCase()})\n`;
        statusValue += `**Timezone:** ${timezone}\n\n`;

        if (activeSchedule.isOverride) {
            statusValue += `**Active:** ${activeSchedule.name} (Override)\n`;
            if (activeSchedule.overrideType === 'match') {
                statusValue += `*Ends after current match*`;
            } else if (activeSchedule.overrideExpiresAt) {
                const expiry = new Date(activeSchedule.overrideExpiresAt);
                statusValue += `*Expires: ${expiry.toLocaleTimeString()}*`;
            }
        } else if (activeSchedule.isDefault) {
            statusValue += `**Active:** Default (All Maps)\n`;
            statusValue += `*No schedule matches current time*`;
        } else {
            statusValue += `**Active:** ${activeSchedule.name}\n`;
            statusValue += `*${activeSchedule.startTime} - ${activeSchedule.endTime}*`;
        }

        embed.addFields({
            name: '📊 Current Status',
            value: statusValue,
            inline: false
        });

        // List schedules
        if (schedules.length > 0) {
            let scheduleList = '';
            for (const schedule of schedules) {
                const display = scheduleManager.formatScheduleDisplay(schedule, serverNum);
                const activeMarker = schedule.id === activeSchedule.id && !activeSchedule.isDefault ? ' 🟢' : '';
                const enabledMarker = display.enabled ? '' : ' (Disabled)';

                scheduleList += `**${schedule.name}**${activeMarker}${enabledMarker}\n`;
                scheduleList += `⏰ ${display.timeRange} | 📅 ${display.days}\n`;
                scheduleList += `👥 Min: ${display.settings?.minimumPlayers || 'Default'} | 🗺️ Maps: ${display.whitelistCount} | 🔢 Priority: ${display.priority}\n\n`;
            }

            embed.addFields({
                name: `📋 Schedules (${schedules.length})`,
                value: scheduleList.substring(0, 1024) || 'None',
                inline: false
            });
        } else {
            embed.addFields({
                name: '📋 Schedules',
                value: 'No schedules configured.\nClick **Add Schedule** to create one.',
                inline: false
            });
        }

        embed.setDescription(
            'Configure time-based map pools with different settings for different times of day.\n\n' +
            '**How it works:**\n' +
            '• Each schedule defines a time range and one or more active days\n' +
            '• Edit schedule name, days, and time in one guided workflow\n' +
            '• Active schedule controls whitelist, settings, and server rules\n' +
            '• Changes apply after current match ends'
        );

        embed.setFooter({ text: 'Seeding Bot • Schedule Manager' });

        // Buttons Row 1 - Primary actions
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_manage_${serverNum}`)
                .setLabel('Edit/Create Schedule')
                .setEmoji('✏️')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`schedule_maps_${serverNum}`)
                .setLabel('Assign Map Pools')
                .setEmoji('🗺️')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(schedules.length === 0),
            new ButtonBuilder()
                .setCustomId(`schedule_rules_${serverNum}`)
                .setLabel('Assign Server Rules')
                .setEmoji('🤖')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(schedules.length === 0),
            new ButtonBuilder()
                .setCustomId(`schedule_delete_${serverNum}`)
                .setLabel('Delete')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(schedules.length === 0)
        );

        // Buttons Row 2 - Schedule behavior
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_general_${serverNum}`)
                .setLabel('General Settings')
                .setEmoji('⚙️')
                .setStyle(hasAnyScheduleGeneralOverrides ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(schedules.length === 0),
            new ButtonBuilder()
                .setCustomId(`schedule_priority_${serverNum}`)
                .setLabel('Priority')
                .setEmoji('🔢')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(schedules.length === 0),
            new ButtonBuilder()
                .setCustomId(`schedule_timezone_${serverNum}`)
                .setLabel('Set Timezone')
                .setEmoji('🌍')
                .setStyle(ButtonStyle.Secondary)
        );

        // Buttons Row 3 - Override navigation
        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_override_${serverNum}`)
                .setLabel('Override')
                .setEmoji('⚡')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(schedules.length === 0),
            new ButtonBuilder()
                .setCustomId(`schedule_clear_override_${serverNum}`)
                .setLabel('Clear Override')
                .setEmoji('❌')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!config.activeOverride),
            new ButtonBuilder()
                .setCustomId('mapvote_back')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row1, row2, row3] };
    }

    /**
     * Build timezone selection panel
     */
    buildTimezonePanel(serverNum) {
        const config = scheduleManager.getServerConfig(serverNum);
        const timezones = scheduleManager.getTimezones();

        const embed = new EmbedBuilder()
            .setTitle('🌍 Select Timezone')
            .setDescription(`Current timezone: **${config.timezone}**\n\nSelect your local timezone for schedule times.`)
            .setColor(0x3498DB);

        const options = timezones.map(tz => ({
            label: tz.label,
            description: tz.value,
            value: tz.value,
            default: tz.value === config.timezone
        }));

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_set_timezone_${serverNum}`)
                .setPlaceholder('Select timezone...')
                .addOptions(options)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, backRow] };
    }

    buildScheduleEditorSelectPanel(serverNum) {
        const schedules = scheduleManager.getSchedules(serverNum);

        const embed = new EmbedBuilder()
            .setTitle('✏️ Edit Or Create Schedule')
            .setDescription(
                'Select an existing schedule to edit it, or choose **Create New Schedule** at the bottom to start a new one.\n\n' +
                'The editor keeps name, days, and time range in one guided workflow before saving.'
            )
            .setColor(0x3498DB);

        const options = schedules.map(schedule => {
            const display = scheduleManager.formatScheduleDisplay(schedule, serverNum);
            return {
                label: schedule.name.substring(0, 100),
                description: `${display.timeRange} | ${display.days}`.substring(0, 100),
                value: schedule.id
            };
        });

        options.push({
            label: 'Create New Schedule',
            description: 'Start a brand new schedule workflow',
            value: '__create_new_schedule__',
            emoji: '➕'
        });

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_select_manage_${serverNum}`)
                .setPlaceholder('Select a schedule or create a new one...')
                .addOptions(options)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, backRow] };
    }

    /**
     * Build schedule selection panel (for delete/priority)
     */
    buildScheduleSelectPanel(serverNum, action) {
        const schedules = scheduleManager.getSchedules(serverNum);

        const actionLabels = {
            delete: 'Delete',
            priority: 'Edit Priority'
        };
        const titleAction = actionLabels[action] || `${action.charAt(0).toUpperCase() + action.slice(1)}`;

        const embed = new EmbedBuilder()
            .setTitle(`Select Schedule to ${titleAction}`)
            .setColor(action === 'delete' ? 0xE74C3C : 0x3498DB);

        if (schedules.length === 0) {
            embed.setDescription('No schedules configured.');
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`schedule_back_${serverNum}`)
                    .setLabel('Back')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
            );
            return { embeds: [embed], components: [backRow] };
        }

        const options = schedules.map(schedule => {
            const display = scheduleManager.formatScheduleDisplay(schedule, serverNum);
            return {
                label: schedule.name.substring(0, 100),
                description: `${display.timeRange} | ${display.days}`,
                value: schedule.id
            };
        });

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_select_${action}_${serverNum}`)
                .setPlaceholder(`Select a schedule to ${titleAction.toLowerCase()}...`)
                .addOptions(options)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, backRow] };
    }

    /**
     * Build schedule selection for map management
     */
    buildScheduleMapSelectPanel(serverNum) {
        const schedules = scheduleManager.getSchedules(serverNum);

        const embed = new EmbedBuilder()
            .setTitle('🗺️ Assign Map Pools')
            .setDescription(
                'Choose which schedule should use a custom map pool.\n\n' +
                'Tip: schedules can either inherit all CRCON whitelist maps or use a custom per-schedule pool.'
            )
            .setColor(0x2ECC71);

        if (schedules.length === 0) {
            embed.setDescription('No schedules configured. Create a schedule first.');
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`schedule_back_${serverNum}`)
                    .setLabel('Back')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
            );
            return { embeds: [embed], components: [backRow] };
        }

        const options = schedules.map(schedule => {
            const display = scheduleManager.formatScheduleDisplay(schedule, serverNum);
            const whitelistInfo = schedule.whitelist === null
                ? 'All Maps'
                : `${schedule.whitelist.length} maps`;
            return {
                label: schedule.name.substring(0, 100),
                description: `${display.days} | ${whitelistInfo}`.substring(0, 100),
                value: schedule.id
            };
        });

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_select_maps_${serverNum}`)
                .setPlaceholder('Select a schedule...')
                .addOptions(options)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, backRow] };
    }

    /**
     * Build schedule selection for server rules editing
     */
    buildScheduleAutomodSelectPanel(serverNum) {
        const schedules = scheduleManager.getSchedules(serverNum);

        const embed = new EmbedBuilder()
            .setTitle('🤖 Assign Server Rules')
            .setDescription(
                'Choose which schedule should override server rules.\n\n' +
                'These rules apply only while that schedule is active and otherwise inherit the server defaults.'
            )
            .setColor(0x5865F2);

        if (schedules.length === 0) {
            embed.setDescription('No schedules configured. Create a schedule first.');
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`schedule_back_${serverNum}`)
                    .setLabel('Back')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
            );
            return { embeds: [embed], components: [backRow] };
        }

        const options = schedules.map(schedule => ({
            label: schedule.name.substring(0, 100),
            description: `${this.formatSelectedDays(schedule.days)} | ${schedule.startTime}-${schedule.endTime}`.substring(0, 100),
            value: schedule.id
        }));

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_select_rules_${serverNum}`)
                .setPlaceholder('Select a schedule...')
                .addOptions(options)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, backRow] };
    }

    buildScheduleGeneralSelectPanel(serverNum) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const configuredCount = schedules.filter(schedule => this.hasScheduleSpecificGeneralSettings(schedule)).length;

        const embed = new EmbedBuilder()
            .setTitle('⚙️ Select Schedule for General Settings')
            .setDescription(
                'Choose which schedule should have general settings edited.\n\n' +
                `**Schedule-specific configured:** ${configuredCount}/${schedules.length}`
            )
            .setColor(0x16A085);

        if (schedules.length === 0) {
            embed.setDescription('No schedules configured. Create a schedule first.');
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`schedule_back_${serverNum}`)
                    .setLabel('Back')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
            );
            return { embeds: [embed], components: [backRow] };
        }

        const options = schedules.map(schedule => ({
            label: schedule.name.substring(0, 100),
            description: `${schedule.startTime}-${schedule.endTime} | ${this.hasScheduleSpecificGeneralSettings(schedule) ? 'Schedule-specific active' : 'Using server settings'}`.substring(0, 100),
            value: schedule.id
        }));

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_select_general_${serverNum}`)
                .setPlaceholder('Select a schedule...')
                .addOptions(options)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, backRow] };
    }

    buildScheduleGeneralPanel(serverNum, scheduleId, serverValues = {}) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = schedules.find(item => item.id === scheduleId);
        if (!schedule) {
            return { content: 'Schedule not found.' };
        }

        const defs = this.getScheduleGeneralSettingDefinitions();
        const scheduleValues = {
            ...this.getDefaultScheduleGeneralSettings(),
            ...(schedule.generalSettings || {})
        };

        const valueText = (key, unit) => {
            const value = scheduleValues[key];
            if (value === null || value === undefined) {
                const serverValue = serverValues[key];
                return `Server (${serverValue === null || serverValue === undefined ? 'Unknown' : `${serverValue} ${unit}`})`;
            }
            return `Schedule (${value} ${unit})`;
        };

        const embed = new EmbedBuilder()
            .setTitle(`⚙️ Edit General Settings - ${schedule.name}`)
            .setColor(0x16A085)
            .setDescription(
                'Configure schedule-specific general server settings.\n' +
                'If set to **Server**, the current server value is kept.\n' +
                'If set to **Schedule**, this schedule will apply its own value when it becomes active.\n\n' +
                defs.map(def => `**${def.label}:** ${valueText(def.key, def.unit)}`).join('\n')
            );

        const toggleRow = new ActionRowBuilder().addComponents(
            ...defs.map(def => {
                const enabled = scheduleValues[def.key] !== null && scheduleValues[def.key] !== undefined;
                return new ButtonBuilder()
                    .setCustomId(`schedule_general_toggle_${def.key}_${serverNum}_${scheduleId}`)
                    .setLabel(`${def.label}: ${enabled ? 'Schedule' : 'Server'}`)
                    .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary);
            })
        );

        const editRow = new ActionRowBuilder().addComponents(
            ...defs.map(def => {
                const enabled = scheduleValues[def.key] !== null && scheduleValues[def.key] !== undefined;
                return new ButtonBuilder()
                    .setCustomId(`schedule_general_edit_${def.key}_${serverNum}_${scheduleId}`)
                    .setLabel(`Edit ${def.label}`)
                    .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary);
            })
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_general_${serverNum}`)
                .setLabel('Back to Schedule Select')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [toggleRow, editRow, backRow] };
    }

    /**
     * Build automod editing panel for a specific schedule
     */
    buildScheduleAutomodAttachPanel(serverNum, scheduleId) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = schedules.find(item => item.id === scheduleId);
        if (!schedule) {
            return { content: 'Schedule not found.' };
        }

        const automodConfigs = schedule.automodConfigs || {
            level: null,
            no_leader: null,
            solo_tank: null
        };

        const status = (cfg) => cfg && typeof cfg === 'object' ? 'Schedule Specific' : 'Use Server Settings';

        const embed = new EmbedBuilder()
            .setTitle(`🤖 Edit Automods - ${schedule.name}`)
            .setColor(0x5865F2)
            .setDescription(
                'Edit schedule-specific automod settings.\n' +
                'These settings are applied automatically when this schedule becomes active.\n\n' +
                `**Level:** ${status(automodConfigs.level)}\n` +
                `**No Leader:** ${status(automodConfigs.no_leader)}\n` +
                `**No Solo Tank:** ${status(automodConfigs.solo_tank)}`
            );

        const toggleRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_automod_toggle_level_${serverNum}_${scheduleId}`)
                .setLabel(`Level: ${automodConfigs.level ? 'Schedule' : 'Server'}`)
                .setStyle(automodConfigs.level ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`schedule_automod_toggle_no_leader_${serverNum}_${scheduleId}`)
                .setLabel(`No Leader: ${automodConfigs.no_leader ? 'Schedule' : 'Server'}`)
                .setStyle(automodConfigs.no_leader ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`schedule_automod_toggle_solo_tank_${serverNum}_${scheduleId}`)
                .setLabel(`No Solo Tank: ${automodConfigs.solo_tank ? 'Schedule' : 'Server'}`)
                .setStyle(automodConfigs.solo_tank ? ButtonStyle.Success : ButtonStyle.Secondary)
        );

        const editRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_automod_edit_level_${serverNum}_${scheduleId}`)
                .setLabel('Edit Level')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`schedule_automod_edit_no_leader_${serverNum}_${scheduleId}`)
                .setLabel('Edit No Leader')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`schedule_automod_edit_solo_tank_${serverNum}_${scheduleId}`)
                .setLabel('Edit No Solo Tank')
                .setStyle(ButtonStyle.Secondary)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_automods_${serverNum}`)
                .setLabel('Back to Schedule Select')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [toggleRow, editRow, backRow] };
    }

    getDefaultLevelThresholds() {
        return {
            officer: { label: 'Officer', min_level: 30, min_players: 75 },
            spotter: { label: 'Reco (spotter)', min_level: 30, min_players: 75 },
            armycommander: { label: 'Commander', min_level: 50, min_players: 75 },
            tankcommander: { label: 'Tank Commander', min_level: 30, min_players: 75 }
        };
    }

    getScheduleAutomodConfig(serverNum, scheduleId, moduleType) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = schedules.find(item => item.id === scheduleId);
        if (!schedule) return null;

        const automodConfigs = schedule.automodConfigs || {};
        const existing = automodConfigs[moduleType];
        if (existing && typeof existing === 'object') {
            if (moduleType === 'level') {
                return {
                    ...existing,
                    level_thresholds: {
                        ...this.getDefaultLevelThresholds(),
                        ...(existing.level_thresholds || {})
                    }
                };
            }
            return { ...existing };
        }

        if (moduleType === 'level') {
            return { level_thresholds: this.getDefaultLevelThresholds() };
        }
        return {};
    }

    buildScheduleAutomodModulePanel(serverNum, scheduleId, moduleType, draftConfig = null) {
        const config = draftConfig || this.getScheduleAutomodConfig(serverNum, scheduleId, moduleType);
        if (!config) {
            return { content: 'Schedule not found.' };
        }

        let fieldDefs;
        let title;
        let color;
        let table;
        let placeholder;

        if (moduleType === 'level') {
            fieldDefs = automodPanelHelper.getLevelGeneralFieldDefinitions();
            title = '📈 Edit Level (General)';
            color = 0x8E44AD;
            table = automodPanelHelper.buildLevelGeneralConfigTable(config);
            placeholder = 'Select a general field to edit...';
        } else if (moduleType === 'no_leader') {
            fieldDefs = automodPanelHelper.getNoLeaderFieldDefinitions();
            title = '🧭 Edit No Leader';
            color = 0x1ABC9C;
            table = automodPanelHelper.buildNoLeaderConfigTable(config);
            placeholder = 'Select a field to edit...';
        } else {
            fieldDefs = automodPanelHelper.getSoloTankFieldDefinitions();
            title = '🚫 Edit No Solo Tank';
            color = 0xE67E22;
            table = automodPanelHelper.buildSoloTankConfigTable(config);
            placeholder = 'Select a field to edit...';
        }

        const options = fieldDefs.map(field => ({
            label: field.label.substring(0, 100),
            value: field.key,
            description: automodPanelHelper.formatAutoModValueForSelect(config[field.key], field.type)
        }));

        const embed = new EmbedBuilder()
            .setTitle(`${title} - Schedule`)
            .setColor(color)
            .setDescription(
                `Schedule ID: **${scheduleId}**\n` +
                'Pick a field from dropdown to edit it.\n' +
                'Use **Save to Schedule** to persist this module for the schedule.\n\n' +
                table
            );

        const selectRows = [];
        const optionChunks = [];
        for (let i = 0; i < options.length; i += 25) {
            optionChunks.push(options.slice(i, i + 25));
        }
        optionChunks.forEach((chunk, index) => {
            const select = new StringSelectMenuBuilder()
                .setCustomId(`schedule_automod_field_${moduleType}_${index}_${serverNum}_${scheduleId}`)
                .setPlaceholder(optionChunks.length > 1 ? `${placeholder} (${index + 1}/${optionChunks.length})` : placeholder)
                .addOptions(chunk);
            selectRows.push(new ActionRowBuilder().addComponents(select));
        });

        const actionButtons = [
            new ButtonBuilder()
                .setCustomId(`schedule_automod_refresh_${moduleType}_${serverNum}_${scheduleId}`)
                .setLabel('Refresh')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`schedule_automod_save_${moduleType}_${serverNum}_${scheduleId}`)
                .setLabel('Save to Schedule')
                .setEmoji('💾')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`schedule_automod_edit_${serverNum}_${scheduleId}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        ];

        if (moduleType === 'level') {
            actionButtons.splice(2, 0,
                new ButtonBuilder()
                    .setCustomId(`schedule_automod_roles_${serverNum}_${scheduleId}`)
                    .setLabel('Edit Role Levels')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        const actionRow = new ActionRowBuilder().addComponents(actionButtons);
        return { embeds: [embed], components: [...selectRows, actionRow] };
    }

    buildScheduleAutomodRolesPanel(serverNum, scheduleId, draftConfig = null) {
        const config = draftConfig || this.getScheduleAutomodConfig(serverNum, scheduleId, 'level');
        if (!config) {
            return { content: 'Schedule not found.' };
        }

        const options = automodPanelHelper.getLevelRoleKeys().map(role => {
            const value = config.level_thresholds?.[role] || {};
            return {
                label: role.substring(0, 100),
                value: role,
                description: `L=${value.min_level ?? 0}, P=${value.min_players ?? 0}, ${String(value.label || role).slice(0, 45)}`
            };
        });

        const embed = new EmbedBuilder()
            .setTitle('📊 Edit Level Role Thresholds - Schedule')
            .setColor(0x2C3E50)
            .setDescription(
                `Schedule ID: **${scheduleId}**\n` +
                'Select a role threshold to edit label/min_level/min_players.\n\n' +
                automodPanelHelper.buildLevelRolesTable(config.level_thresholds || {})
            );

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_automod_role_select_${serverNum}_${scheduleId}`)
                .setPlaceholder('Select a role threshold to edit...')
                .addOptions(options)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_automod_edit_level_${serverNum}_${scheduleId}`)
                .setLabel('Back to Level')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, backRow] };
    }

    /**
     * Build schedule selection for exporting included maps
     */
    buildScheduleExportSelectPanel(serverNum) {
        const schedules = scheduleManager.getSchedules(serverNum);

        const embed = new EmbedBuilder()
            .setTitle('📤 Export Schedule')
            .setDescription('Select a schedule to export its included maps as a `.txt` file.')
            .setColor(0x3498DB);

        if (schedules.length === 0) {
            embed.setDescription('No schedules configured. Create a schedule first.');
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('mapvote_back')
                    .setLabel('Back')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
            );
            return { embeds: [embed], components: [backRow] };
        }

        const options = schedules.map(schedule => {
            const whitelistInfo = schedule.whitelist === null
                ? 'Using CRCON whitelist'
                : `${schedule.whitelist.length} included maps`;
            return {
                label: schedule.name.substring(0, 100),
                description: `${schedule.startTime}-${schedule.endTime} | ${whitelistInfo}`.substring(0, 100),
                value: schedule.id
            };
        });

        options.unshift({
            label: 'Export All Schedules',
            description: `Export included maps for all ${schedules.length} schedules`,
            value: '__all__'
        });

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_select_export_${serverNum}`)
                .setPlaceholder('Select a schedule to export...')
                .addOptions(options.slice(0, 25))
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('mapvote_back')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, backRow] };
    }

    /**
     * Build override selection panel
     */
    buildOverridePanel(serverNum) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const config = scheduleManager.getServerConfig(serverNum);

        const embed = new EmbedBuilder()
            .setTitle('⚡ Override Schedule')
            .setDescription(
                'Temporarily force a specific schedule.\n\n' +
                '**Override Types:**\n' +
                '• **Until Match Ends** - Reverts after current match\n' +
                '• **For X Hours** - Reverts after time expires'
            )
            .setColor(0xF39C12);

        if (config.activeOverride) {
            const currentSchedule = schedules.find(s => s.id === config.activeOverride.scheduleId);
            embed.addFields({
                name: 'Current Override',
                value: `**${currentSchedule?.name || 'Default'}** (${config.activeOverride.type})`,
                inline: false
            });
        }

        // Schedule selection
        const scheduleOptions = [
            { label: 'Default (All Maps)', description: 'Use default settings', value: 'default' },
            ...schedules.map(s => ({
                label: s.name.substring(0, 100),
                description: `${s.startTime} - ${s.endTime}`,
                value: s.id
            }))
        ];

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_override_select_${serverNum}`)
                .setPlaceholder('Select schedule to activate...')
                .addOptions(scheduleOptions.slice(0, 25))
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [selectRow, backRow] };
    }

    /**
     * Build override type selection panel
     */
    buildOverrideTypePanel(serverNum, scheduleId) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = scheduleId === 'default'
            ? { name: 'Default (All Maps)' }
            : schedules.find(s => s.id === scheduleId);

        const embed = new EmbedBuilder()
            .setTitle('⚡ Override Duration')
            .setDescription(`Override to: **${schedule?.name || 'Unknown'}**\n\nHow long should this override last?`)
            .setColor(0xF39C12);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_override_match_${serverNum}_${scheduleId}`)
                .setLabel('Until Match Ends')
                .setEmoji('🎮')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`schedule_override_hours_${serverNum}_${scheduleId}`)
                .setLabel('For X Hours')
                .setEmoji('⏱️')
                .setStyle(ButtonStyle.Primary)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_override_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row, backRow] };
    }

    buildScheduleEditorPanel(serverNum, userId) {
        const draft = this.getScheduleEditorDraft(serverNum, userId);
        if (!draft) {
            return {
                content: 'No schedule editor session found.',
                flags: 64
            };
        }

        const selectedDays = Array.isArray(draft.days) && draft.days.length > 0
            ? draft.days
            : scheduleManager.getDayPresets().all;
        const selectedDaysSet = new Set(selectedDays);
        const dayOptions = this.getDayOptions().map(option => ({
            label: option.label,
            value: option.value,
            emoji: option.emoji,
            default: selectedDaysSet.has(option.value)
        }));
        const daysLabel = this.formatSelectedDays(selectedDays);

        const embed = new EmbedBuilder()
            .setTitle(draft.isNew ? '➕ Create Schedule' : `✏️ Edit Schedule - ${draft.name}`)
            .setDescription(
                'Finish the full schedule setup here, then save once when it looks right.\n\n' +
                `**Name:** ${draft.name}\n` +
                `**Days:** ${daysLabel}\n` +
                `**Time Range:** ${draft.startTime} - ${draft.endTime}\n` +
                `**Minimum Players:** ${draft.minimumPlayers}\n` +
                `**Maps Per Vote:** ${draft.mapsPerVote}`
            )
            .setColor(0x3498DB);

        const editRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_editor_name_${serverNum}`)
                .setLabel('Edit Name')
                .setEmoji('📝')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`schedule_editor_time_${serverNum}`)
                .setLabel('Edit Time')
                .setEmoji('⏰')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`schedule_editor_settings_${serverNum}`)
                .setLabel('Edit Vote Settings')
                .setEmoji('🎛️')
                .setStyle(ButtonStyle.Secondary)
        );

        const presetRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_editor_days_all_${serverNum}`)
                .setLabel('All Days')
                .setStyle(selectedDays.length === 7 ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`schedule_editor_days_weekdays_${serverNum}`)
                .setLabel('Weekdays')
                .setStyle(daysLabel === 'Weekdays' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`schedule_editor_days_weekend_${serverNum}`)
                .setLabel('Weekend')
                .setStyle(daysLabel === 'Weekend' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

        const daySelectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_editor_days_select_${serverNum}`)
                .setPlaceholder('Select one or more days...')
                .setMinValues(1)
                .setMaxValues(dayOptions.length)
                .addOptions(dayOptions)
        );

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_editor_save_${serverNum}`)
                .setLabel(draft.isNew ? 'Create Schedule' : 'Save Changes')
                .setEmoji('💾')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`schedule_editor_cancel_${serverNum}`)
                .setLabel('Cancel')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [editRow, presetRow, daySelectRow, actionRow] };
    }

    buildScheduleEditorNameModal(serverNum, draft) {
        const modal = new ModalBuilder()
            .setCustomId(`schedule_editor_name_modal_${serverNum}`)
            .setTitle(draft.isNew ? 'Create Schedule Name' : 'Edit Schedule Name');

        const nameInput = new TextInputBuilder()
            .setCustomId('schedule_name')
            .setLabel('Schedule Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., Prime Time, Seeding Hours')
            .setValue(draft.name || '')
            .setRequired(true)
            .setMaxLength(50);

        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        return modal;
    }

    buildScheduleEditorTimeModal(serverNum, draft) {
        const modal = new ModalBuilder()
            .setCustomId(`schedule_editor_time_modal_${serverNum}`)
            .setTitle(draft.isNew ? 'Create Schedule Time' : 'Edit Schedule Time');

        const startTimeInput = new TextInputBuilder()
            .setCustomId('schedule_start')
            .setLabel('Start Time (24h format)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 18:00')
            .setValue(draft.startTime || '18:00')
            .setRequired(true)
            .setMaxLength(5);

        const endTimeInput = new TextInputBuilder()
            .setCustomId('schedule_end')
            .setLabel('End Time (24h format)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 23:00')
            .setValue(draft.endTime || '23:00')
            .setRequired(true)
            .setMaxLength(5);

        modal.addComponents(
            new ActionRowBuilder().addComponents(startTimeInput),
            new ActionRowBuilder().addComponents(endTimeInput)
        );
        return modal;
    }

    buildScheduleEditorSettingsModal(serverNum, draft) {
        const modal = new ModalBuilder()
            .setCustomId(`schedule_editor_settings_modal_${serverNum}`)
            .setTitle(draft.isNew ? 'Create Vote Settings' : 'Edit Vote Settings');

        const minPlayersInput = new TextInputBuilder()
            .setCustomId('schedule_min_players')
            .setLabel('Minimum Players to Activate')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 40')
            .setValue(String(draft.minimumPlayers ?? 25))
            .setRequired(true)
            .setMaxLength(3);

        const mapsPerVoteInput = new TextInputBuilder()
            .setCustomId('schedule_maps_per_vote')
            .setLabel('Maps Per Vote')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 6')
            .setValue(String(draft.mapsPerVote ?? 6))
            .setRequired(true)
            .setMaxLength(2);

        modal.addComponents(
            new ActionRowBuilder().addComponents(minPlayersInput),
            new ActionRowBuilder().addComponents(mapsPerVoteInput)
        );
        return modal;
    }

    /**
     * Build add/edit schedule modal
     */
    buildScheduleModal(serverNum, existingSchedule = null) {
        const isEdit = existingSchedule !== null;

        const modal = new ModalBuilder()
            .setCustomId(`schedule_modal_${serverNum}${isEdit ? `_${existingSchedule.id}` : ''}`)
            .setTitle(isEdit ? 'Edit Schedule' : 'Create Schedule');

        const nameInput = new TextInputBuilder()
            .setCustomId('schedule_name')
            .setLabel('Schedule Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., Prime Time, Seeding Hours')
            .setValue(existingSchedule?.name || '')
            .setRequired(true)
            .setMaxLength(50);

        const startTimeInput = new TextInputBuilder()
            .setCustomId('schedule_start')
            .setLabel('Start Time (24h format)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 18:00')
            .setValue(existingSchedule?.startTime || '18:00')
            .setRequired(true)
            .setMaxLength(5);

        const endTimeInput = new TextInputBuilder()
            .setCustomId('schedule_end')
            .setLabel('End Time (24h format)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 23:00')
            .setValue(existingSchedule?.endTime || '23:00')
            .setRequired(true)
            .setMaxLength(5);

        const minPlayersInput = new TextInputBuilder()
            .setCustomId('schedule_min_players')
            .setLabel('Minimum Players to Activate')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 40')
            .setValue(String(existingSchedule?.settings?.minimumPlayers || 25))
            .setRequired(true)
            .setMaxLength(3);

        const mapsPerVoteInput = new TextInputBuilder()
            .setCustomId('schedule_maps_per_vote')
            .setLabel('Maps Per Vote')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 6')
            .setValue(String(existingSchedule?.settings?.mapsPerVote || 6))
            .setRequired(true)
            .setMaxLength(2);

        modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput),
            new ActionRowBuilder().addComponents(startTimeInput),
            new ActionRowBuilder().addComponents(endTimeInput),
            new ActionRowBuilder().addComponents(minPlayersInput),
            new ActionRowBuilder().addComponents(mapsPerVoteInput)
        );

        return modal;
    }

    /**
     * Build hours input modal for override
     */
    buildOverrideHoursModal(serverNum, scheduleId) {
        const modal = new ModalBuilder()
            .setCustomId(`schedule_override_hours_modal_${serverNum}_${scheduleId}`)
            .setTitle('Override Duration');

        const hoursInput = new TextInputBuilder()
            .setCustomId('hours')
            .setLabel('Duration in hours')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 2')
            .setValue('2')
            .setRequired(true)
            .setMaxLength(2);

        modal.addComponents(
            new ActionRowBuilder().addComponents(hoursInput)
        );

        return modal;
    }

    /**
     * Build day selection panel for a schedule
     */
    buildDaySelectPanel(serverNum, scheduleId) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = schedules.find(s => s.id === scheduleId);
        const selectedDays = Array.isArray(schedule?.days) && schedule.days.length > 0
            ? schedule.days
            : scheduleManager.getDayPresets().all;
        const selectedDaysSet = new Set(selectedDays);
        const dayOptions = this.getDayOptions().map(option => ({
            label: option.label,
            value: option.value,
            emoji: option.emoji,
            default: selectedDaysSet.has(option.value)
        }));

        const embed = new EmbedBuilder()
            .setTitle('📅 Select Days')
            .setDescription(
                `Schedule: **${schedule?.name || 'Unknown'}**\n\n` +
                `Selected: **${this.formatSelectedDays(selectedDays)}**\n\n` +
                'Use the quick presets below or pick specific days from the selector.'
            )
            .setColor(0x3498DB);

        const presetRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_days_all_${serverNum}_${scheduleId}`)
                .setLabel('All Days')
                .setStyle(selectedDays.length === 7 ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`schedule_days_weekdays_${serverNum}_${scheduleId}`)
                .setLabel('Weekdays')
                .setStyle(this.formatSelectedDays(selectedDays) === 'Weekdays' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`schedule_days_weekend_${serverNum}_${scheduleId}`)
                .setLabel('Weekend')
                .setStyle(this.formatSelectedDays(selectedDays) === 'Weekend' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`schedule_days_select_${serverNum}_${scheduleId}`)
                .setPlaceholder('Select one or more days...')
                .setMinValues(1)
                .setMaxValues(dayOptions.length)
                .addOptions(dayOptions)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [presetRow, selectRow, backRow] };
    }

    buildSchedulePriorityModal(serverNum, schedule) {
        const modal = new ModalBuilder()
            .setCustomId(`schedule_priority_modal_${serverNum}_${schedule.id}`)
            .setTitle(`Priority - ${schedule.name}`);

        const priorityInput = new TextInputBuilder()
            .setCustomId('schedule_priority')
            .setLabel('Priority (0-100)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Higher priority wins on overlap')
            .setValue(String(schedule.priority ?? 0))
            .setRequired(true)
            .setMaxLength(3);

        modal.addComponents(
            new ActionRowBuilder().addComponents(priorityInput)
        );

        return modal;
    }

    /**
     * Build whitelist selection panel for a schedule
     */
    async buildScheduleWhitelistPanel(serverNum, scheduleId, crconService, page = 0, filter = null) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = schedules.find(s => s.id === scheduleId);

        if (!schedule) {
            return { content: 'Schedule not found.' };
        }

        // Get all maps from CRCON
        let allMaps = [];
        try {
            const mapsResponse = await crconService.getMaps();
            allMaps = mapsResponse?.result || [];
        } catch (e) {
            logger.error('[SchedulePanel] Error fetching maps:', e);
        }

        // Get schedule's whitelist (null = use all maps)
        const scheduleWhitelist = new Set(schedule.whitelist || []);
        const useAllMaps = schedule.whitelist === null;

        // Filter maps
        let filteredMaps = allMaps;
        if (filter === 'warfare') {
            filteredMaps = allMaps.filter(m => m.game_mode === 'warfare');
        } else if (filter === 'offensive') {
            filteredMaps = allMaps.filter(m => m.game_mode === 'offensive');
        } else if (filter === 'skirmish') {
            filteredMaps = allMaps.filter(m => m.game_mode === 'skirmish');
        } else if (filter === 'night') {
            filteredMaps = allMaps.filter(m => m.environment === 'night');
        } else if (filter === 'day') {
            filteredMaps = allMaps.filter(m => m.environment !== 'night');
        }

        // Paginate
        const mapsPerPage = 12;
        const totalPages = Math.ceil(filteredMaps.length / mapsPerPage);
        const startIndex = page * mapsPerPage;
        const pageMaps = filteredMaps.slice(startIndex, startIndex + mapsPerPage);

        // Build map list
        const mapLines = pageMaps.map(map => {
            const isIncluded = useAllMaps || scheduleWhitelist.has(map.id);
            const icon = isIncluded ? '✅' : '❌';
            const mode = map.game_mode === 'warfare' ? '⚔️' : map.game_mode === 'offensive' ? '🎯' : '🔫';
            const time = map.environment === 'night' ? '🌙' : map.environment === 'day' ? '☀️' : '🌤️';
            return `${icon} ${mode}${time} ${map.pretty_name || map.id}`;
        });

        const embed = new EmbedBuilder()
            .setTitle(`🗺️ Schedule Whitelist - ${schedule.name}`)
            .setDescription(
                (useAllMaps
                    ? '**Mode:** Using ALL maps from CRCON whitelist\n\n'
                    : `**Mode:** Custom whitelist (${scheduleWhitelist.size} maps)\n\n`) +
                `**Legend:** ✅ = Included, ❌ = Excluded\n` +
                `**Modes:** ⚔️ Warfare, 🎯 Offensive, 🔫 Skirmish\n` +
                `**Time:** ☀️ Day, 🌤️ Overcast, 🌙 Night\n\n` +
                `Page ${page + 1}/${totalPages}\n\n` +
                (mapLines.join('\n') || 'No maps found')
            )
            .setColor(0x2ECC71)
            .setFooter({ text: 'Select maps to include in this schedule\'s rotation' });

        // Mode toggle row
        const modeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`sched_wl_useall_${serverNum}_${scheduleId}`)
                .setLabel('Use All Maps')
                .setEmoji('🌐')
                .setStyle(useAllMaps ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`sched_wl_custom_${serverNum}_${scheduleId}`)
                .setLabel('Custom Selection')
                .setEmoji('✏️')
                .setStyle(!useAllMaps ? ButtonStyle.Success : ButtonStyle.Secondary)
        );

        // Filter row
        const filterRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`sched_wl_filter_${serverNum}_${scheduleId}_all_${page}`)
                .setLabel('All')
                .setStyle(filter === null ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`sched_wl_filter_${serverNum}_${scheduleId}_warfare_${page}`)
                .setLabel('Warfare')
                .setEmoji('⚔️')
                .setStyle(filter === 'warfare' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`sched_wl_filter_${serverNum}_${scheduleId}_offensive_${page}`)
                .setLabel('Offensive')
                .setEmoji('🎯')
                .setStyle(filter === 'offensive' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`sched_wl_filter_${serverNum}_${scheduleId}_skirmish_${page}`)
                .setLabel('Skirmish')
                .setEmoji('🔫')
                .setStyle(filter === 'skirmish' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`sched_wl_filter_${serverNum}_${scheduleId}_night_${page}`)
                .setLabel('Night')
                .setEmoji('🌙')
                .setStyle(filter === 'night' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

        // Map selection (only if custom mode)
        const components = [modeRow, filterRow];

        if (!useAllMaps && pageMaps.length > 0) {
            const selectOptions = pageMaps.slice(0, 25).map(map => ({
                label: (map.pretty_name || map.id).substring(0, 100),
                value: map.id,
                description: `${scheduleWhitelist.has(map.id) ? '✅ Included' : '❌ Excluded'} - ${map.game_mode}`,
                emoji: scheduleWhitelist.has(map.id) ? '✅' : '❌'
            }));

            const selectRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`sched_wl_toggle_${serverNum}_${scheduleId}`)
                    .setPlaceholder('Toggle maps...')
                    .setMinValues(1)
                    .setMaxValues(Math.min(selectOptions.length, 10))
                    .addOptions(selectOptions)
            );
            components.push(selectRow);
        }

        // Navigation row
        const navRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`sched_wl_prev_${serverNum}_${scheduleId}_${page}_${filter || 'all'}`)
                .setLabel('◀ Prev')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`sched_wl_next_${serverNum}_${scheduleId}_${page}_${filter || 'all'}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages - 1),
            new ButtonBuilder()
                .setCustomId(`schedule_back_${serverNum}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );
        components.push(navRow);

        // Quick actions (only if custom mode)
        if (!useAllMaps) {
            const quickRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`sched_wl_add_all_${serverNum}_${scheduleId}_${filter || 'all'}`)
                    .setLabel('Add All' + (filter ? ` ${filter}` : ''))
                    .setEmoji('✅')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`sched_wl_remove_all_${serverNum}_${scheduleId}_${filter || 'all'}`)
                    .setLabel('Remove All' + (filter ? ` ${filter}` : ''))
                    .setEmoji('❌')
                    .setStyle(ButtonStyle.Danger)
            );
            components.push(quickRow);
        }

        return { embeds: [embed], components: components.slice(0, 5) }; // Discord max 5 rows
    }

    /**
     * Toggle maps in schedule whitelist
     */
    toggleScheduleWhitelistMaps(serverNum, scheduleId, mapIds, allMaps) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = schedules.find(s => s.id === scheduleId);

        if (!schedule) {
            return { success: false, error: 'Schedule not found' };
        }

        // Initialize whitelist if null (was using all maps)
        let whitelist = schedule.whitelist ? [...schedule.whitelist] : allMaps.map(m => m.id);

        for (const mapId of mapIds) {
            const index = whitelist.indexOf(mapId);
            if (index > -1) {
                // Remove
                whitelist.splice(index, 1);
            } else {
                // Add
                whitelist.push(mapId);
            }
        }

        scheduleManager.updateSchedule(serverNum, scheduleId, { whitelist });
        return { success: true, count: whitelist.length };
    }

    /**
     * Set schedule to use all maps (null whitelist)
     */
    setScheduleUseAllMaps(serverNum, scheduleId) {
        return scheduleManager.updateSchedule(serverNum, scheduleId, { whitelist: null });
    }

    /**
     * Set schedule to custom whitelist mode (initialize with all maps)
     */
    async initScheduleCustomWhitelist(serverNum, scheduleId, crconService) {
        let allMaps = [];
        try {
            const mapsResponse = await crconService.getMaps();
            allMaps = (mapsResponse?.result || []).map(m => m.id);
        } catch (e) {
            logger.error('[SchedulePanel] Error fetching maps:', e);
        }

        return scheduleManager.updateSchedule(serverNum, scheduleId, { whitelist: allMaps });
    }

    /**
     * Add all maps matching filter to schedule whitelist
     */
    addAllMapsToSchedule(serverNum, scheduleId, allMaps, filter = null) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = schedules.find(s => s.id === scheduleId);

        if (!schedule) {
            return { success: false, error: 'Schedule not found' };
        }

        let whitelist = schedule.whitelist ? [...schedule.whitelist] : [];

        let mapsToAdd = allMaps;
        if (filter === 'warfare') {
            mapsToAdd = allMaps.filter(m => m.game_mode === 'warfare');
        } else if (filter === 'offensive') {
            mapsToAdd = allMaps.filter(m => m.game_mode === 'offensive');
        } else if (filter === 'skirmish') {
            mapsToAdd = allMaps.filter(m => m.game_mode === 'skirmish');
        } else if (filter === 'night') {
            mapsToAdd = allMaps.filter(m => m.environment === 'night');
        } else if (filter === 'day') {
            mapsToAdd = allMaps.filter(m => m.environment !== 'night');
        }

        for (const map of mapsToAdd) {
            if (!whitelist.includes(map.id)) {
                whitelist.push(map.id);
            }
        }

        scheduleManager.updateSchedule(serverNum, scheduleId, { whitelist });
        return { success: true, count: whitelist.length };
    }

    /**
     * Remove all maps matching filter from schedule whitelist
     */
    removeAllMapsFromSchedule(serverNum, scheduleId, allMaps, filter = null) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = schedules.find(s => s.id === scheduleId);

        if (!schedule) {
            return { success: false, error: 'Schedule not found' };
        }

        let whitelist = schedule.whitelist ? [...schedule.whitelist] : allMaps.map(m => m.id);

        let mapsToRemove = allMaps;
        if (filter === 'warfare') {
            mapsToRemove = allMaps.filter(m => m.game_mode === 'warfare');
        } else if (filter === 'offensive') {
            mapsToRemove = allMaps.filter(m => m.game_mode === 'offensive');
        } else if (filter === 'skirmish') {
            mapsToRemove = allMaps.filter(m => m.game_mode === 'skirmish');
        } else if (filter === 'night') {
            mapsToRemove = allMaps.filter(m => m.environment === 'night');
        } else if (filter === 'day') {
            mapsToRemove = allMaps.filter(m => m.environment !== 'night');
        }

        const removeIds = new Set(mapsToRemove.map(m => m.id));
        whitelist = whitelist.filter(id => !removeIds.has(id));

        scheduleManager.updateSchedule(serverNum, scheduleId, { whitelist });
        return { success: true, count: whitelist.length };
    }

    /**
     * Process schedule modal submission
     */
    processScheduleModal(interaction, serverNum, scheduleId = null) {
        const name = interaction.fields.getTextInputValue('schedule_name');
        const startTime = interaction.fields.getTextInputValue('schedule_start');
        const endTime = interaction.fields.getTextInputValue('schedule_end');
        const minPlayers = parseInt(interaction.fields.getTextInputValue('schedule_min_players'));
        const mapsPerVote = parseInt(interaction.fields.getTextInputValue('schedule_maps_per_vote'));

        // Validate time format
        const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
        if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
            return { success: false, error: 'Invalid time format. Use HH:MM (24-hour format).' };
        }

        // Validate numbers
        if (isNaN(minPlayers) || minPlayers < 0 || minPlayers > 100) {
            return { success: false, error: 'Minimum players must be between 0 and 100.' };
        }
        if (isNaN(mapsPerVote) || mapsPerVote < 2 || mapsPerVote > 10) {
            return { success: false, error: 'Maps per vote must be between 2 and 10.' };
        }

        const scheduleData = {
            name,
            startTime,
            endTime,
            minimumPlayers: minPlayers,
            mapsPerVote
        };

        if (scheduleId) {
            // Update existing
            const result = scheduleManager.updateSchedule(serverNum, scheduleId, {
                name: scheduleData.name,
                startTime: scheduleData.startTime,
                endTime: scheduleData.endTime,
                settings: {
                    minimumPlayers: scheduleData.minimumPlayers,
                    mapsPerVote: scheduleData.mapsPerVote
                }
            });
            return result;
        } else {
            // Create new
            const schedule = scheduleManager.createSchedule(serverNum, scheduleData);
            if (!schedule) {
                return { success: false, error: 'Failed to save new schedule. Please try again.' };
            }
            return { success: true, schedule, isNew: true };
        }
    }

    /**
     * Build schedule map export content
     */
    async buildScheduleExport(serverNum, scheduleId, crconService, serverName = null) {
        const schedules = scheduleManager.getSchedules(serverNum);
        const schedule = schedules.find(s => s.id === scheduleId);

        if (!schedule) {
            return { success: false, error: 'Schedule not found' };
        }

        let allMaps = [];
        try {
            const mapsResponse = await crconService.getMaps();
            allMaps = mapsResponse?.result || [];
        } catch (e) {
            logger.error('[SchedulePanel] Error fetching maps for export:', e);
        }

        const mapById = new Map(allMaps.map(map => [map.id, map]));

        let includedMapIds = [];
        let sourceMode = 'Custom schedule whitelist';

        if (schedule.whitelist === null) {
            sourceMode = 'CRCON whitelist (Use All Maps mode)';
            try {
                const whitelistResponse = await crconService.getVotemapWhitelist();
                includedMapIds = whitelistResponse?.result || [];
            } catch (e) {
                if (isUnsupportedTransportError(e)) {
                    return {
                        success: false,
                        error: 'This export requires the CRCON votemap whitelist API. The active transport mode does not support it.'
                    };
                }
                logger.error('[SchedulePanel] Error fetching CRCON whitelist for export:', e);
                includedMapIds = [];
            }
        } else {
            includedMapIds = Array.isArray(schedule.whitelist) ? schedule.whitelist : [];
        }

        const uniqueMapIds = [...new Set(includedMapIds)];
        const lines = uniqueMapIds.map((mapId, index) => {
            const map = mapById.get(mapId);
            const displayName = map?.pretty_name || map?.name || mapId;
            const mode = map?.game_mode || 'unknown';
            const environment = map?.environment || 'unknown';
            return `${index + 1}. ${displayName} [${mapId}] (${mode}, ${environment})`;
        });

        const exportedAt = new Date().toISOString();
        const safeName = (schedule.name || 'schedule')
            .toLowerCase()
            .replace(/[^a-z0-9-_]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 40) || 'schedule';
        const filename = `schedule-export-s${serverNum}-${safeName}.txt`;

        const contentLines = [
            'Schedule Export',
            '====================',
            `Server: ${serverName || `Server ${serverNum}`}`,
            `Schedule: ${schedule.name}`,
            `Schedule ID: ${schedule.id}`,
            `Time Range: ${schedule.startTime} - ${schedule.endTime}`,
            `Days: ${(schedule.days || []).join(', ') || 'all'}`,
            `Source: ${sourceMode}`,
            `Exported At (UTC): ${exportedAt}`,
            '',
            ...this.buildGeneralSettingsExportLines(schedule),
            '',
            ...this.buildAutomodExportLines(schedule),
            '',
            `Included Maps (${uniqueMapIds.length}):`,
            ...(
                lines.length > 0
                    ? lines
                    : ['(No maps included)']
            ),
            ''
        ];

        return {
            success: true,
            filename,
            content: contentLines.join('\n'),
            mapCount: uniqueMapIds.length,
            scheduleName: schedule.name
        };
    }

    async buildAllSchedulesExport(serverNum, crconService, serverName = null) {
        const schedules = scheduleManager.getSchedules(serverNum);
        if (!schedules.length) {
            return { success: false, error: 'No schedules found.' };
        }

        let allMaps = [];
        try {
            const mapsResponse = await crconService.getMaps();
            allMaps = mapsResponse?.result || [];
        } catch (e) {
            logger.error('[SchedulePanel] Error fetching maps for full export:', e);
        }
        const mapById = new Map(allMaps.map(map => [map.id, map]));

        const requiresCrconWhitelist = schedules.some(schedule => schedule.whitelist === null);
        let crconWhitelist = [];
        if (requiresCrconWhitelist) {
            try {
                const whitelistResponse = await crconService.getVotemapWhitelist();
                crconWhitelist = whitelistResponse?.result || [];
            } catch (e) {
                if (isUnsupportedTransportError(e)) {
                    return {
                        success: false,
                        error: 'At least one schedule uses "Use All Maps", which requires the CRCON votemap whitelist API for export. The active transport mode does not support it.'
                    };
                }
                logger.error('[SchedulePanel] Error fetching CRCON whitelist for full export:', e);
            }
        }

        const sections = [];
        let totalMaps = 0;
        schedules.forEach((schedule, scheduleIndex) => {
            const includedMapIds = schedule.whitelist === null
                ? crconWhitelist
                : (Array.isArray(schedule.whitelist) ? schedule.whitelist : []);
            const uniqueMapIds = [...new Set(includedMapIds)];
            totalMaps += uniqueMapIds.length;

            const sourceMode = schedule.whitelist === null
                ? 'CRCON whitelist (Use All Maps mode)'
                : 'Custom schedule whitelist';

            const lines = uniqueMapIds.map((mapId, index) => {
                const map = mapById.get(mapId);
                const displayName = map?.pretty_name || map?.name || mapId;
                const mode = map?.game_mode || 'unknown';
                const environment = map?.environment || 'unknown';
                return `${index + 1}. ${displayName} [${mapId}] (${mode}, ${environment})`;
            });

            sections.push(
                `Schedule ${scheduleIndex + 1}: ${schedule.name}`,
                '--------------------',
                `Schedule ID: ${schedule.id}`,
                `Time Range: ${schedule.startTime} - ${schedule.endTime}`,
                `Days: ${(schedule.days || []).join(', ') || 'all'}`,
                `Source: ${sourceMode}`,
                ...this.buildGeneralSettingsExportLines(schedule),
                ...this.buildAutomodExportLines(schedule),
                `Included Maps (${uniqueMapIds.length}):`,
                ...(lines.length > 0 ? lines : ['(No maps included)']),
                ''
            );
        });

        const exportedAt = new Date().toISOString();
        const filename = `schedule-export-all-s${serverNum}.txt`;
        const contentLines = [
            'Schedule Export (All Schedules)',
            '====================',
            `Server: ${serverName || `Server ${serverNum}`}`,
            `Schedules: ${schedules.length}`,
            `Total Included Map Entries: ${totalMaps}`,
            `Exported At (UTC): ${exportedAt}`,
            '',
            ...sections
        ];

        return {
            success: true,
            filename,
            content: contentLines.join('\n'),
            mapCount: totalMaps,
            scheduleName: 'All Schedules'
        };
    }
}

module.exports = new SchedulePanelService();

