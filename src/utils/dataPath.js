const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let cachedDataDir = null;

function canUseDir(dirPath) {
    if (!dirPath) return false;
    try {
        fs.mkdirSync(dirPath, { recursive: true });
        fs.accessSync(dirPath, fs.constants.W_OK);
        const testPath = path.join(dirPath, `.write-test-${process.pid}-${Date.now()}`);
        fs.writeFileSync(testPath, '');
        fs.unlinkSync(testPath);
        return true;
    } catch {
        return false;
    }
}

function resolveDataDir() {
    if (cachedDataDir) {
        return cachedDataDir;
    }

    const envDataDir = (process.env.DATA_DIR || '').trim();
    const localDataDir = path.join(__dirname, '../../data');

    const candidates = [];
    if (envDataDir) {
        candidates.push(envDataDir);
    }
    candidates.push('/data');
    candidates.push(localDataDir);

    for (const candidate of candidates) {
        if (canUseDir(candidate)) {
            cachedDataDir = candidate;
            logger.info(`[DataPath] Using data directory: ${cachedDataDir}`);
            return cachedDataDir;
        }
    }

    cachedDataDir = localDataDir;
    logger.warn(`[DataPath] Falling back to local data directory: ${cachedDataDir}`);
    return cachedDataDir;
}

function getDataFilePath(filename) {
    return path.join(resolveDataDir(), filename);
}

module.exports = {
    getDataFilePath,
    resolveDataDir
};
