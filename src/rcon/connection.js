/**
 * HLL RCON V2 connection over TCP with XOR payload encryption.
 */

const dns = require('dns').promises;
const net = require('net');
const logger = require('../utils/logger');

const HEADER_SIZE = 12;
const HEADER_MAGIC = 0xDE450508;

class RconConnection {
    constructor(options = {}) {
        this.host = options.host;
        this.port = options.port || 27015;
        this.password = options.password;
        this.timeout = options.timeout || 15000;

        this.socket = null;
        this.closed = false;
        this.xorKey = null;
        this.authToken = null;
        this.nextId = 1;
        this.activeDataHandler = null;
    }

    async connect() {
        const target = await this.resolveTarget();
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(this.formatConnectError(new Error('Connection timeout'), target));
            }, this.timeout);

            this.socket = new net.Socket();
            this.socket.on('error', (error) => {
                clearTimeout(timeoutId);
                reject(this.formatConnectError(error, target));
            });
            this.socket.on('close', () => {
                this.closed = true;
            });

            this.socket.connect(this.port, target.connectHost, async () => {
                clearTimeout(timeoutId);
                try {
                    await this.serverConnect();
                    await this.login();
                    resolve();
                } catch (error) {
                    this.socket.destroy();
                    reject(error);
                }
            });
        });
    }

    async resolveTarget() {
        if (net.isIP(this.host)) {
            return { connectHost: this.host, displayHost: this.host };
        }

        try {
            const resolved = await dns.lookup(this.host, { family: 4 });
            return {
                connectHost: resolved.address,
                displayHost: `${this.host} (${resolved.address})`
            };
        } catch (error) {
            const code = error?.code ? ` [${error.code}]` : '';
            throw new Error(`IPv4 lookup failed for ${this.host}:${this.port}${code}`);
        }
    }

    formatConnectError(error, target) {
        const code = error?.code ? ` [${error.code}]` : '';
        const host = target?.displayHost || this.host;
        return new Error(`RCON connection failed to ${host}:${this.port}${code}: ${error.message}`);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    xorCipher(data) {
        if (!this.xorKey || this.xorKey.length === 0) {
            return data;
        }

        const out = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) {
            out[i] = data[i] ^ this.xorKey[i % this.xorKey.length];
        }
        return out;
    }

    async sendRequest(request, encrypted = true) {
        if (this.closed) {
            throw new Error('Connection closed');
        }

        return new Promise((resolve, reject) => {
            if (this.activeDataHandler && this.socket) {
                this.socket.removeListener('data', this.activeDataHandler);
                this.activeDataHandler = null;
            }

            const cleanup = () => {
                if (this.activeDataHandler && this.socket) {
                    this.socket.removeListener('data', this.activeDataHandler);
                    this.activeDataHandler = null;
                }
                clearTimeout(timeoutId);
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error(`Request timeout during ${request?.Name || 'Unknown'}`));
            }, this.timeout);

            const reqJson = Buffer.from(JSON.stringify(request), 'utf8');
            const reqPayload = encrypted && this.xorKey ? this.xorCipher(reqJson) : reqJson;

            const requestId = this.nextId++;
            const header = Buffer.alloc(HEADER_SIZE);
            header.writeUInt32LE(HEADER_MAGIC, 0);
            header.writeUInt32LE(requestId, 4);
            header.writeUInt32LE(reqPayload.length, 8);

            const packet = Buffer.concat([header, reqPayload]);

            let responseData = Buffer.alloc(0);
            let expectedLength = null;
            let headerRead = false;

            const dataHandler = (data) => {
                responseData = Buffer.concat([responseData, data]);

                if (!headerRead && responseData.length >= HEADER_SIZE) {
                    const magic = responseData.readUInt32LE(0);
                    if (magic !== HEADER_MAGIC) {
                        cleanup();
                        reject(new Error(`Invalid response header magic: 0x${magic.toString(16)}`));
                        return;
                    }
                    expectedLength = responseData.readUInt32LE(8);
                    headerRead = true;
                }

                if (headerRead && responseData.length >= HEADER_SIZE + expectedLength) {
                    cleanup();

                    const responseId = responseData.readUInt32LE(4);
                    if (responseId !== requestId) {
                        reject(new Error(`Response ID mismatch: expected ${requestId}, got ${responseId}`));
                        return;
                    }

                    let responsePayload = responseData.slice(HEADER_SIZE, HEADER_SIZE + expectedLength);
                    if (encrypted && this.xorKey) {
                        responsePayload = this.xorCipher(responsePayload);
                    }

                    try {
                        const response = JSON.parse(responsePayload.toString('utf8'));
                        const statusCode = response.StatusCode ?? response.statusCode;
                        const statusMessage = response.StatusMessage ?? response.statusMessage;
                        const contentBody = response.ContentBody ?? response.contentBody;

                        if (statusCode !== 200) {
                            reject(new Error(`RCON error ${statusCode}: ${statusMessage}`));
                            return;
                        }

                        resolve({
                            StatusCode: statusCode,
                            StatusMessage: statusMessage,
                            ContentBody: contentBody
                        });
                    } catch (error) {
                        reject(new Error(`Failed to parse RCON response: ${error.message}`));
                    }
                }
            };

            this.activeDataHandler = dataHandler;
            this.socket.on('data', dataHandler);
            logger.debug(`[RCON ${this.host}:${this.port}] Sending ${request?.Name || 'Unknown'}`);
            this.socket.write(packet, (error) => {
                if (error) {
                    cleanup();
                    reject(error);
                }
            });
        });
    }

    async serverConnect() {
        const response = await this.sendRequest({
            AuthToken: '',
            Version: 2,
            Name: 'ServerConnect',
            ContentBody: ''
        }, false);
        this.xorKey = Buffer.from(response.ContentBody, 'base64');
    }

    async login() {
        const response = await this.sendRequest({
            AuthToken: '',
            Version: 2,
            Name: 'Login',
            ContentBody: this.password
        });
        this.authToken = response.ContentBody;
    }

    async getServerInformation(name, value = '') {
        const response = await this.sendRequest({
            AuthToken: this.authToken,
            Version: 2,
            Name: 'GetServerInformation',
            ContentBody: JSON.stringify({ Name: name, Value: value })
        });
        return JSON.parse(response.ContentBody);
    }

    async getSessionInfo() {
        return this.getServerInformation('session', '');
    }

    async getPlayers() {
        return this.getServerInformation('players', '');
    }

    async getMapSequence() {
        return this.getServerInformation('mapsequence', '');
    }

    async getMapRotation() {
        return this.getServerInformation('maprotation', '');
    }

    async serverBroadcast(message) {
        await this.sendRequest({
            AuthToken: this.authToken,
            Version: 2,
            Name: 'ServerBroadcast',
            ContentBody: JSON.stringify({ Message: message })
        });
    }

    async messagePlayer(playerId, message) {
        await this.sendRequest({
            AuthToken: this.authToken,
            Version: 2,
            Name: 'MessagePlayer',
            ContentBody: JSON.stringify({ Message: message, PlayerId: playerId })
        });
    }

    async setIdleKickDuration(minutes) {
        await this.sendRequest({
            AuthToken: this.authToken,
            Version: 2,
            Name: 'SetIdleKickDuration',
            ContentBody: JSON.stringify({ IdleTimeoutMinutes: minutes })
        });
    }

    async getIdleKickDuration() {
        const response = await this.sendRequest({
            AuthToken: this.authToken,
            Version: 2,
            Name: 'GetKickIdleDuration',
            ContentBody: ''
        });
        return JSON.parse(response.ContentBody);
    }

    async setTeamSwitchCooldown(minutes) {
        await this.sendRequest({
            AuthToken: this.authToken,
            Version: 2,
            Name: 'SetTeamSwitchCooldown',
            ContentBody: JSON.stringify({ TeamSwitchTimer: minutes })
        });
    }

    async setHighPingThreshold(ms) {
        await this.sendRequest({
            AuthToken: this.authToken,
            Version: 2,
            Name: 'SetHighPingThreshold',
            ContentBody: JSON.stringify({ HighPingThresholdMs: ms })
        });
    }

    async changeMap(mapName) {
        await this.sendRequest({
            AuthToken: this.authToken,
            Version: 2,
            Name: 'ChangeMap',
            ContentBody: JSON.stringify({ MapName: mapName })
        });
    }

    async execute(commandName, contentBody = '') {
        const body = typeof contentBody === 'string'
            ? contentBody
            : JSON.stringify(contentBody);

        const response = await this.sendRequest({
            AuthToken: this.authToken,
            Version: 2,
            Name: commandName,
            ContentBody: body
        });

        const raw = response?.ContentBody;
        if (typeof raw !== 'string') {
            return raw;
        }

        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    }
}

module.exports = { RconConnection };
