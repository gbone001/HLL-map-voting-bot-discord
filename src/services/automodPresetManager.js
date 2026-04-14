/**
 * AutoMod Preset Manager
 * Stores named automod configurations in persistent JSON storage.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getDataFilePath } = require('../utils/dataPath');

const PRESET_PATH = getDataFilePath('automod-presets.json');

const TYPE_LABELS = {
    level: 'Level',
    no_leader: 'No Leader',
    solo_tank: 'No Solo Tank'
};

class AutoModPresetManager {
    constructor() {
        this.data = this.loadData();
    }

    loadData() {
        try {
            const dir = path.dirname(PRESET_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            if (fs.existsSync(PRESET_PATH)) {
                return JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8'));
            }
        } catch (error) {
            logger.error('[AutoModPresetManager] Error loading preset data:', error);
        }

        return { servers: {} };
    }

    saveData() {
        try {
            const dir = path.dirname(PRESET_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(PRESET_PATH, JSON.stringify(this.data, null, 2));
            return true;
        } catch (error) {
            logger.error('[AutoModPresetManager] Error saving preset data:', error);
            return false;
        }
    }

    initServer(serverNum) {
        const key = String(serverNum);
        if (!this.data.servers[key]) {
            this.data.servers[key] = {
                level: [],
                no_leader: [],
                solo_tank: []
            };
        }
        return this.data.servers[key];
    }

    normalizeType(type) {
        if (!TYPE_LABELS[type]) {
            throw new Error(`Unsupported automod type: ${type}`);
        }
        return type;
    }

    buildDisplayName(name, type) {
        const base = (name || '').trim();
        const label = TYPE_LABELS[type] || type;
        return `${base} - ${label}`;
    }

    createPreset(serverNum, type, name, config) {
        const safeType = this.normalizeType(type);
        const server = this.initServer(serverNum);
        const trimmedName = (name || '').trim();
        if (!trimmedName) {
            return { success: false, error: 'Preset name is required.' };
        }

        const now = new Date().toISOString();
        const preset = {
            id: `p${Date.now()}_${Math.floor(Math.random() * 100000)}`,
            type: safeType,
            name: trimmedName,
            displayName: this.buildDisplayName(trimmedName, safeType),
            config: JSON.parse(JSON.stringify(config || {})),
            createdAt: now,
            updatedAt: now
        };

        server[safeType].push(preset);
        if (!this.saveData()) {
            server[safeType].pop();
            return { success: false, error: 'Failed to save preset data.' };
        }
        return { success: true, preset };
    }

    getPresets(serverNum, type) {
        const safeType = this.normalizeType(type);
        const server = this.initServer(serverNum);
        return server[safeType] || [];
    }

    getPresetById(serverNum, type, presetId) {
        const presets = this.getPresets(serverNum, type);
        return presets.find(preset => preset.id === presetId) || null;
    }
}

module.exports = new AutoModPresetManager();
