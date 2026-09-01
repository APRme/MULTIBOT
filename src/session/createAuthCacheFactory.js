const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const minecraftFolderPath = require('minecraft-folder-path');

function createUsernameHash(username) {
  return crypto.createHash('sha1').update(username ?? '', 'binary').digest('hex').slice(0, 6);
}

function createAuthCacheFileName(cacheName, username) {
  return `${createUsernameHash(username)}_${cacheName}-cache.json`;
}

function ensureDirectory(directoryPath) {
  if (!directoryPath) {
    return;
  }

  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload));
}

function getFileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (error) {
    return null;
  }
}

function normalizeLookupUsernames(usernames = []) {
  const normalized = [];
  const seen = new Set();

  for (const value of usernames) {
    const username = typeof value === 'string' ? value.trim() : '';
    if (!username || seen.has(username)) {
      continue;
    }

    seen.add(username);
    normalized.push(username);
  }

  return normalized;
}

function buildCacheCandidates(directoryPath, cacheName, usernames, priorityBase) {
  if (!directoryPath) {
    return [];
  }

  return usernames.map((username, index) => ({
    filePath: path.join(directoryPath, createAuthCacheFileName(cacheName, username)),
    priority: priorityBase + index
  }));
}

function pickReadableCacheFile(candidates = []) {
  const readableCandidates = [];

  for (const candidate of candidates) {
    if (!candidate || !candidate.filePath) {
      continue;
    }

    const mtimeMs = getFileMtimeMs(candidate.filePath);
    if (mtimeMs === null) {
      continue;
    }

    readableCandidates.push({
      filePath: candidate.filePath,
      mtimeMs,
      priority: Number.isFinite(candidate.priority) ? candidate.priority : 0
    });
  }

  readableCandidates.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }

    return left.priority - right.priority;
  });

  for (const candidate of readableCandidates) {
    const value = readJsonFile(candidate.filePath);
    if (value && typeof value === 'object') {
      return {
        filePath: candidate.filePath,
        value
      };
    }
  }

  return null;
}

class DualFileCache {
  constructor(options = {}) {
    this.primaryPath = options.primaryPath || null;
    this.readCandidates = Array.isArray(options.readCandidates)
      ? options.readCandidates.filter((candidate) => candidate && candidate.filePath)
      : [];
    this.cache = undefined;
  }

  async reset() {
    const cached = {};
    await this.setCached(cached);
    return cached;
  }

  async loadInitialValue() {
    const selected = pickReadableCacheFile(this.readCandidates);
    if (!selected) {
      return this.reset();
    }

    const { filePath, value } = selected;
    if (this.primaryPath && filePath !== this.primaryPath) {
      writeJsonFile(this.primaryPath, value);
    }

    return value;
  }

  async getCached() {
    if (this.cache === undefined) {
      this.cache = await this.loadInitialValue();
    }

    return this.cache;
  }

  async setCached(cached) {
    this.cache = cached || {};

    if (this.primaryPath) {
      writeJsonFile(this.primaryPath, this.cache);
    }

    return this.cache;
  }

  async setCachedPartial(cached) {
    const base = await this.getCached();
    return this.setCached({
      ...base,
      ...(cached || {})
    });
  }
}

function getDefaultFallbackAuthCacheDir() {
  return path.join(minecraftFolderPath, 'nmp-cache');
}

function createAuthCacheFactory(options = {}) {
  const primaryDir = options.primaryDir || null;
  const fallbackDir = options.fallbackDir || getDefaultFallbackAuthCacheDir();
  const primaryUsername = typeof options.primaryUsername === 'string'
    ? options.primaryUsername.trim()
    : '';
  const additionalUsernames = normalizeLookupUsernames(options.additionalUsernames || []);

  if (primaryDir) {
    ensureDirectory(primaryDir);
  }

  return ({ cacheName, username }) => {
    const lookupUsernames = normalizeLookupUsernames([
      primaryUsername,
      username,
      ...additionalUsernames
    ]);
    const primaryPath = primaryDir && lookupUsernames[0]
      ? path.join(primaryDir, createAuthCacheFileName(cacheName, lookupUsernames[0]))
      : null;

    const readCandidates = [
      ...buildCacheCandidates(primaryDir, cacheName, lookupUsernames, 0),
      ...buildCacheCandidates(fallbackDir, cacheName, lookupUsernames, 100)
    ];

    return new DualFileCache({
      primaryPath,
      readCandidates
    });
  };
}

module.exports = {
  DualFileCache,
  createAuthCacheFactory,
  createAuthCacheFileName,
  createUsernameHash,
  getDefaultFallbackAuthCacheDir
};
