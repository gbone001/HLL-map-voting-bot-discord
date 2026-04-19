const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getDataFilePath } = require('../utils/dataPath');

const BUNDLED_CATALOG_PATH = path.join(__dirname, '../../data/hll-warfare-map-catalog.json');
const RUNTIME_CATALOG_FILENAME = 'hll-map-catalog.json';

function normalizeStringValue(value) {
    if (value === undefined || value === null) {
        return null;
    }

    return String(value).trim();
}

function normalizeEnvironment(value) {
    const normalized = normalizeStringValue(value)?.toLowerCase();
    if (!normalized) {
        return 'day';
    }

    if (normalized === 'morning') return 'dawn';
    if (normalized === 'evening') return 'dusk';
    return normalized;
}

function normalizeCatalogEntry(rawEntry) {
    const id = normalizeStringValue(rawEntry?.id);
    if (!id) {
        return null;
    }

    const type = normalizeStringValue(rawEntry?.type || rawEntry?.game_mode)?.toLowerCase() || 'warfare';
    const environment = normalizeEnvironment(rawEntry?.environment);
    const name = normalizeStringValue(rawEntry?.name) || id;
    const friendlyName = normalizeStringValue(rawEntry?.friendly_name || rawEntry?.friendlyName) || name;
    const prettyName = normalizeStringValue(rawEntry?.pretty_name || rawEntry?.prettyName) || friendlyName;

    return {
        id,
        type,
        environment,
        name,
        friendly_name: friendlyName,
        pretty_name: prettyName
    };
}

function toLegacyMapShape(entry) {
    return {
        id: entry.id,
        pretty_name: entry.pretty_name,
        game_mode: entry.type,
        environment: entry.environment,
        map: {
            id: entry.id,
            name: entry.friendly_name,
            pretty_name: entry.pretty_name
        }
    };
}

class HllMapCatalogService {
    constructor() {
        this.runtimeCatalogPath = getDataFilePath(RUNTIME_CATALOG_FILENAME);
        this.bundledEntries = this.loadBundledEntries();
    }

    loadBundledEntries() {
        try {
            const parsed = JSON.parse(fs.readFileSync(BUNDLED_CATALOG_PATH, 'utf8'));
            return this.normalizeEntries(parsed);
        } catch (error) {
            logger.error('[HllMapCatalog] Failed to load bundled catalog:', error);
            return [];
        }
    }

    normalizeEntries(entries) {
        if (!Array.isArray(entries)) {
            return [];
        }

        const normalizedEntries = [];
        const seenIds = new Set();

        for (const rawEntry of entries) {
            const normalizedEntry = normalizeCatalogEntry(rawEntry);
            if (!normalizedEntry || seenIds.has(normalizedEntry.id)) {
                continue;
            }

            seenIds.add(normalizedEntry.id);
            normalizedEntries.push(normalizedEntry);
        }

        normalizedEntries.sort((left, right) => left.pretty_name.localeCompare(right.pretty_name));
        return normalizedEntries;
    }

    readRuntimeEntries() {
        if (!fs.existsSync(this.runtimeCatalogPath)) {
            return null;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(this.runtimeCatalogPath, 'utf8'));
            return this.normalizeEntries(parsed);
        } catch (error) {
            logger.error('[HllMapCatalog] Failed to read runtime catalog:', error);
            return null;
        }
    }

    hasRuntimeCatalog() {
        const runtimeEntries = this.readRuntimeEntries();
        return Array.isArray(runtimeEntries) && runtimeEntries.length > 0;
    }

    getEntries() {
        const runtimeEntries = this.readRuntimeEntries();
        if (Array.isArray(runtimeEntries) && runtimeEntries.length > 0) {
            return runtimeEntries;
        }

        return [...this.bundledEntries];
    }

    getMaps() {
        return this.getEntries().map(toLegacyMapShape);
    }

    getCatalogStatus() {
        const runtimeEntries = this.readRuntimeEntries();
        const hasRuntimeCatalog = Array.isArray(runtimeEntries) && runtimeEntries.length > 0;
        let syncedAt = null;

        if (hasRuntimeCatalog) {
            try {
                syncedAt = fs.statSync(this.runtimeCatalogPath).mtime.toISOString();
            } catch (error) {
                logger.warn('[HllMapCatalog] Failed to read runtime catalog timestamp:', error.message);
            }
        }

        return {
            runtimeCatalogPath: this.runtimeCatalogPath,
            hasRuntimeCatalog,
            source: hasRuntimeCatalog ? 'runtime' : 'bundled',
            entryCount: hasRuntimeCatalog ? runtimeEntries.length : this.bundledEntries.length,
            bundledEntryCount: this.bundledEntries.length,
            syncedAt
        };
    }

    syncFromCrconMaps(rawMaps) {
        const normalizedEntries = this.normalizeEntries(
            (Array.isArray(rawMaps) ? rawMaps : []).map((rawMap) => ({
                id: rawMap?.id,
                type: rawMap?.game_mode || rawMap?.type,
                environment: rawMap?.environment,
                name: rawMap?.map?.name || rawMap?.name,
                friendly_name: rawMap?.map?.name || rawMap?.friendly_name || rawMap?.name,
                pretty_name: rawMap?.pretty_name || rawMap?.map?.pretty_name || rawMap?.name
            }))
        );

        if (normalizedEntries.length === 0) {
            throw new Error('CRCON returned no valid maps to sync');
        }

        fs.writeFileSync(this.runtimeCatalogPath, `${JSON.stringify(normalizedEntries, null, 2)}\n`, 'utf8');
        logger.info(
            `[HllMapCatalog] Synced ${normalizedEntries.length} map entries to ${this.runtimeCatalogPath}`
        );

        return this.getCatalogStatus();
    }

    normalizeMapIds(mapIds, options = {}) {
        const { dropUnknown = this.hasRuntimeCatalog() } = options;
        const lookup = this.buildLookup();
        const normalizedMapIds = [];
        const seenMapIds = new Set();

        for (const rawValue of Array.isArray(mapIds) ? mapIds : []) {
            const normalizedMapId = this.resolveMapId(rawValue, lookup);
            if (!normalizedMapId && dropUnknown) {
                continue;
            }

            const valueToStore = normalizedMapId || normalizeStringValue(rawValue);
            if (!valueToStore || seenMapIds.has(valueToStore)) {
                continue;
            }

            seenMapIds.add(valueToStore);
            normalizedMapIds.push(valueToStore);
        }

        return normalizedMapIds;
    }

    buildLookup() {
        const lookup = new Map();

        for (const map of this.getMaps()) {
            for (const alias of [
                map.id,
                map.pretty_name,
                map.map?.name,
                map.map?.pretty_name,
                map.id?.replace(/_(warfare|offensive|skirmish)(_.+)?$/i, ''),
                map.pretty_name?.replace(/\s+(warfare|offensive|skirmish)(\s+\(.+\))?$/i, '')
            ]) {
                const normalizedAlias = this.normalizeLookupKey(alias);
                if (normalizedAlias && !lookup.has(normalizedAlias)) {
                    lookup.set(normalizedAlias, map.id);
                }
            }
        }

        return lookup;
    }

    resolveMapId(value, lookup = this.buildLookup()) {
        const normalizedKey = this.normalizeLookupKey(value);
        if (!normalizedKey) {
            return null;
        }

        return lookup.get(normalizedKey) || null;
    }

    normalizeLookupKey(value) {
        if (value === undefined || value === null) {
            return null;
        }

        return String(value)
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase()
            .replace(/\bsaint(e)?\b/g, 'st')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }
}

const hllMapCatalog = new HllMapCatalogService();

module.exports = {
    HllMapCatalogService,
    hllMapCatalog,
    WARFARE_MAP_CATALOG: hllMapCatalog.getMaps()
};
