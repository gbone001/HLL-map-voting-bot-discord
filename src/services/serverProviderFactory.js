const { CRCONService } = require('./crcon');
const { RCONService } = require('./rcon');

function createServerProvider(config, serverNum = 1) {
    const provider = String(config?.provider || 'crcon').toLowerCase();
    const serverName = config?.serverName || `Server ${serverNum}`;

    if (provider === 'rcon') {
        return new RCONService(
            config?.rconHost,
            config?.rconPassword,
            serverName,
            config?.rconPort
        );
    }

    return new CRCONService(config?.crconUrl, config?.crconToken, serverName);
}

module.exports = {
    createServerProvider
};
