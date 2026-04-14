/**
 * Minimal Hell Let Loose RCON V2 client.
 *
 * Protocol flow is based on sledro/hllrcon:
 * 1. TCP connect
 * 2. ServerConnect -> XOR key
 * 3. Login -> auth token
 * 4. framed request/response exchange with XOR-encrypted bodies
 */

const net = require('net');
const { once } = require('events');

const HEADER_MAGIC = 0xDE450508;
const HEADER_SIZE = 12;
const VERSION = 2;

class HLLRconClient {
    constructor(options = {}) {
        this.host = options.host;
        this.port = Number.parseInt(options.port, 10);
        this.password = options.password;
        this.connectTimeoutMs = options.connectTimeoutMs ?? 10000;
        this.socketTimeoutMs = options.socketTimeoutMs ?? 30000;
        this.maxRequestSize = options.maxRequestSize ?? 64 * 1024;
        this.maxResponseSize = options.maxResponseSize ?? 512 * 1024;

        this.socket = null;
        this.authToken = '';
        this.xorKey = null;
        this.readBuffer = Buffer.alloc(0);
        this.requestId = 0;
        this.operationChain = Promise.resolve();
    }

    isConfigured() {
        return Boolean(this.host && this.port && this.password);
    }

    async close() {
        if (!this.socket) {
            return;
        }

        const socket = this.socket;
        this.socket = null;
        this.readBuffer = Buffer.alloc(0);
        this.authToken = '';
        this.xorKey = null;

        try {
            socket.destroy();
        } catch (error) {
            // Ignore socket teardown errors during shutdown/reconnect.
        }
    }

    async execute(command, contentBody = '') {
        return this.runExclusive(async () => {
            await this.ensureConnected();

            try {
                return await this.exchange(command, contentBody);
            } catch (error) {
                await this.close();
                throw error;
            }
        });
    }

    async ensureConnected() {
        if (!this.isConfigured()) {
            throw new Error('Direct RCON is not configured');
        }

        if (this.socket && !this.socket.destroyed) {
            return;
        }

        const socket = net.createConnection({
            host: this.host,
            port: this.port
        });

        socket.setNoDelay(true);
        socket.setTimeout(this.socketTimeoutMs);

        const connectTimeout = setTimeout(() => {
            socket.destroy(new Error(`Timed out connecting to RCON after ${this.connectTimeoutMs}ms`));
        }, this.connectTimeoutMs);

        try {
            await Promise.race([
                once(socket, 'connect'),
                once(socket, 'error').then(([error]) => Promise.reject(error))
            ]);
        } finally {
            clearTimeout(connectTimeout);
        }

        socket.on('data', (chunk) => {
            this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
        });

        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = null;
                this.readBuffer = Buffer.alloc(0);
            }
        });

        socket.on('error', () => {
            if (this.socket === socket) {
                this.socket = null;
            }
        });

        this.socket = socket;
        this.readBuffer = Buffer.alloc(0);
        this.authToken = '';
        this.xorKey = null;

        const connectResponse = await this.exchange('ServerConnect', '');
        if (connectResponse.statusCode !== 200 || typeof connectResponse.contentBody !== 'string') {
            throw new Error(`ServerConnect failed: ${connectResponse.statusMessage || 'unknown error'}`);
        }

        this.xorKey = Buffer.from(connectResponse.contentBody, 'base64');

        const loginResponse = await this.exchange('Login', this.password);
        if (loginResponse.statusCode !== 200 || typeof loginResponse.contentBody !== 'string') {
            throw new Error(`RCON login failed: ${loginResponse.statusMessage || 'unknown error'}`);
        }

        this.authToken = loginResponse.contentBody;
    }

    async exchange(command, contentBody) {
        const payload = this.packRequest(command, contentBody);
        if (payload.buffer.length > this.maxRequestSize) {
            throw new Error(`RCON request exceeds ${this.maxRequestSize} bytes`);
        }

        const encryptedBuffer = this.encryptBody(payload.buffer);
        await this.writeAll(encryptedBuffer);

        const header = await this.readExactly(HEADER_SIZE);
        const magic = header.readUInt32LE(0);
        if (magic !== HEADER_MAGIC) {
            throw new Error(`Invalid RCON response magic: ${magic}`);
        }

        const responseId = header.readUInt32LE(4);
        const contentLength = header.readUInt32LE(8);
        if (contentLength > this.maxResponseSize) {
            throw new Error(`RCON response exceeds ${this.maxResponseSize} bytes`);
        }

        const encryptedBody = await this.readExactly(contentLength);
        const body = this.xorKey?.length ? xorBuffer(encryptedBody, this.xorKey) : encryptedBody;

        let response;
        try {
            response = JSON.parse(body.toString('utf8'));
        } catch (error) {
            throw new Error(`Failed to parse RCON response JSON: ${error.message}`);
        }

        if (responseId !== payload.requestId) {
            throw new Error(`RCON response ID mismatch: expected ${payload.requestId}, got ${responseId}`);
        }

        return response;
    }

    packRequest(command, contentBody) {
        this.requestId += 1;
        const requestId = this.requestId;
        const request = {
            authToken: this.authToken,
            version: VERSION,
            name: command,
            contentBody: serializeContentBody(contentBody)
        };

        const body = Buffer.from(JSON.stringify(request), 'utf8');
        const header = Buffer.alloc(HEADER_SIZE);
        header.writeUInt32LE(HEADER_MAGIC, 0);
        header.writeUInt32LE(requestId, 4);
        header.writeUInt32LE(body.length, 8);

        return {
            requestId,
            buffer: Buffer.concat([header, body])
        };
    }

    encryptBody(buffer) {
        if (!this.xorKey?.length) {
            return buffer;
        }

        const header = buffer.subarray(0, HEADER_SIZE);
        const body = buffer.subarray(HEADER_SIZE);
        return Buffer.concat([header, xorBuffer(body, this.xorKey)]);
    }

    async writeAll(buffer) {
        if (!this.socket) {
            throw new Error('RCON socket is not connected');
        }

        await new Promise((resolve, reject) => {
            this.socket.write(buffer, (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    async readExactly(length) {
        while (this.readBuffer.length < length) {
            if (!this.socket) {
                throw new Error('RCON socket closed while reading response');
            }

            await waitForSocketActivity(this.socket, this.socketTimeoutMs);
        }

        const chunk = this.readBuffer.subarray(0, length);
        this.readBuffer = this.readBuffer.subarray(length);
        return chunk;
    }

    async runExclusive(fn) {
        const previous = this.operationChain;
        let release;
        this.operationChain = new Promise((resolve) => {
            release = resolve;
        });

        await previous;

        try {
            return await fn();
        } finally {
            release();
        }
    }
}

function serializeContentBody(contentBody) {
    if (contentBody === undefined || contentBody === null) {
        return '';
    }
    if (typeof contentBody === 'string') {
        return contentBody;
    }
    return JSON.stringify(contentBody);
}

function xorBuffer(buffer, key) {
    const result = Buffer.allocUnsafe(buffer.length);
    for (let index = 0; index < buffer.length; index += 1) {
        result[index] = buffer[index] ^ key[index % key.length];
    }
    return result;
}

function createSocketTimeoutError(timeoutMs) {
    return new Error(`RCON socket timed out after ${timeoutMs}ms`);
}

function waitForSocketActivity(socket, timeoutMs) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            socket.off('data', handleData);
            socket.off('timeout', handleTimeout);
            socket.off('error', handleError);
            socket.off('close', handleClose);
        };

        const handleData = () => {
            cleanup();
            resolve();
        };

        const handleTimeout = () => {
            cleanup();
            reject(createSocketTimeoutError(timeoutMs));
        };

        const handleError = (error) => {
            cleanup();
            reject(error);
        };

        const handleClose = () => {
            cleanup();
            reject(new Error('RCON socket closed'));
        };

        socket.on('data', handleData);
        socket.on('timeout', handleTimeout);
        socket.on('error', handleError);
        socket.on('close', handleClose);
    });
}

module.exports = {
    HLLRconClient
};
