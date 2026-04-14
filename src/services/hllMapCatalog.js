/**
 * Local HLL map catalog used when CRCON's map catalog is unavailable.
 *
 * This is intentionally small and warfare-only to keep the degraded-mode
 * fallback predictable and maintainable.
 */

const WARFARE_MAP_CATALOG = [
    createMap('carentan_warfare', 'Carentan'),
    createMap('elalamein_warfare', 'El Alamein'),
    createMap('foy_warfare', 'Foy'),
    createMap('hill400_warfare', 'Hill 400'),
    createMap('hurtgenforest_warfare', 'Hurtgen Forest'),
    createMap('kharkov_warfare', 'Kharkov'),
    createMap('kursk_warfare', 'Kursk'),
    createMap('omahabeach_warfare', 'Omaha Beach'),
    createMap('purpleheartlane_warfare', 'Purple Heart Lane'),
    createMap('remagen_warfare', 'Remagen'),
    createMap('stalingrad_warfare', 'Stalingrad'),
    createMap('stmariedumont_warfare', 'St. Marie Du Mont'),
    createMap('stmereeglise_warfare', 'St. Mere Eglise'),
    createMap('utahbeach_warfare', 'Utah Beach')
];

function createMap(id, prettyName, environment = 'day') {
    return {
        id,
        pretty_name: `${prettyName} Warfare`,
        game_mode: 'warfare',
        environment,
        map: {
            id,
            name: prettyName,
            pretty_name: `${prettyName} Warfare`
        }
    };
}

module.exports = {
    WARFARE_MAP_CATALOG
};
