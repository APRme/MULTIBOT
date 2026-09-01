const fs = require('fs');
const path = require('path');
const { getCurrentTimestamp } = require('../features/activityLog/ActivityLogFeature');

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sortNames(names) {
  return Array.from(new Set(names.filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'accent' }));
}

class AggregateLogService {
  constructor(options = {}) {
    this.appRoot = options.appRoot || process.cwd();
    this.config = options.config || {};
    this.logger = typeof options.loggerFactory === 'function'
      ? options.loggerFactory('aggregateLogging')
      : null;
    this.chatBatchWindowMs = normalizePositiveInteger(this.config.chatBatchWindowMs, 100);
    this.playerListIntervalMinutes = normalizePositiveNumber(this.config.playerListIntervalMinutes, 1);
    this.chatPendingMap = new Map();
    this.playerSnapshotsByServer = new Map();
    this.playerListTimersByServer = new Map();
    this.serverPathsCache = new Map();
    this.started = false;
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  isChatEnabled() {
    return this.isEnabled() && this.config.chat !== false;
  }

  isPlayerListEnabled() {
    return this.isEnabled() && this.config.playerList !== false;
  }

  logWarn(...parts) {
    if (this.logger && typeof this.logger.warn === 'function') {
      this.logger.warn(...parts);
      return;
    }
  }

  start() {
    if (this.started || !this.isEnabled()) {
      return;
    }

    this.started = true;

    if (this.isPlayerListEnabled()) {
      for (const serverDir of this.playerSnapshotsByServer.keys()) {
        this.ensurePlayerListTimer(serverDir);
      }
    }
  }

  stop(reason = 'stop') {
    for (const [key, pending] of this.chatPendingMap.entries()) {
      try {
        if (pending && pending.timer) {
          clearTimeout(pending.timer);
        }
        this.flushChatMessage(key);
      } catch (error) {
        this.logWarn('[AGGREGATE] failed to flush pending chat log on stop', error);
      }
    }

    for (const timer of this.playerListTimersByServer.values()) {
      clearInterval(timer);
    }

    this.started = false;
    this.playerListTimersByServer.clear();
    this.chatPendingMap.clear();
    this.playerSnapshotsByServer.clear();

    if (reason) {
      this.serverPathsCache.clear();
    }
  }

  resolveServerPaths(serverDir) {
    const normalizedServerDir = typeof serverDir === 'string' ? serverDir.trim() : '';
    if (!normalizedServerDir) {
      return null;
    }

    if (!this.serverPathsCache.has(normalizedServerDir)) {
      const serverRoot = path.join(this.appRoot, 'BOTS', normalizedServerDir);
      this.serverPathsCache.set(normalizedServerDir, {
        serverRoot,
        chatLogPath: path.join(serverRoot, `${normalizedServerDir}_chat.log`),
        playerListLogPath: path.join(serverRoot, `${normalizedServerDir}_playerList.log`)
      });
    }

    return this.serverPathsCache.get(normalizedServerDir);
  }

  appendLine(filePath, line) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, 'utf8');
  }

  normalizeSourceName(sourceName) {
    const normalized = typeof sourceName === 'string' ? sourceName.trim() : '';
    return normalized || null;
  }

  recordChatMessage(options = {}) {
    if (!this.isChatEnabled()) {
      return false;
    }

    const serverDir = typeof options.serverDir === 'string' ? options.serverDir.trim() : '';
    const message = options.message === undefined || options.message === null
      ? ''
      : String(options.message).trim();
    const sourceName = this.normalizeSourceName(options.sourceName);

    if (!serverDir || !message) {
      return false;
    }

    const key = `${serverDir}\u0000${message}`;
    if (this.chatPendingMap.has(key)) {
      const pending = this.chatPendingMap.get(key);
      if (pending && sourceName) {
        pending.sourceNames.add(sourceName);
      }
      return true;
    }

    const timer = setTimeout(() => {
      try {
        this.flushChatMessage(key);
      } catch (error) {
        this.logWarn('[AGGREGATE] failed to flush chat log', error);
      }
    }, this.chatBatchWindowMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.chatPendingMap.set(key, {
      serverDir,
      message,
      sourceNames: sourceName ? new Set([sourceName]) : new Set(),
      timer
    });

    return true;
  }

  formatChatLogMessage(pending) {
    const sourceNames = pending && pending.sourceNames instanceof Set
      ? Array.from(pending.sourceNames).filter(Boolean)
      : [];

    if (sourceNames.length === 1) {
      return `[${sourceNames[0]}] ${pending.message}`;
    }

    return pending.message;
  }

  flushChatMessage(key) {
    const pending = this.chatPendingMap.get(key);
    if (!pending) {
      return false;
    }

    this.chatPendingMap.delete(key);
    const paths = this.resolveServerPaths(pending.serverDir);
    if (!paths) {
      return false;
    }

    try {
      this.appendLine(paths.chatLogPath, `${getCurrentTimestamp()} ${this.formatChatLogMessage(pending)}\n`);
      return true;
    } catch (error) {
      this.logWarn('[AGGREGATE] failed to append chat log line', error);
      return false;
    }
  }

  ensurePlayerRecord(serverDir, botId) {
    if (!this.playerSnapshotsByServer.has(serverDir)) {
      this.playerSnapshotsByServer.set(serverDir, new Map());
    }

    const records = this.playerSnapshotsByServer.get(serverDir);
    if (!records.has(botId)) {
      records.set(botId, {
        botId,
        players: [],
        getPlayers: null
      });
    }

    return records.get(botId);
  }

  registerPlayerSnapshotProvider(options = {}) {
    if (!this.isPlayerListEnabled()) {
      return false;
    }

    const serverDir = typeof options.serverDir === 'string' ? options.serverDir.trim() : '';
    const botId = typeof options.botId === 'string' ? options.botId.trim() : '';
    if (!serverDir || !botId) {
      return false;
    }

    const record = this.ensurePlayerRecord(serverDir, botId);
    record.getPlayers = typeof options.getPlayers === 'function' ? options.getPlayers : null;

    if (Array.isArray(options.players)) {
      record.players = sortNames(options.players.map((entry) => String(entry || '').trim()));
    } else if (record.getPlayers) {
      try {
        record.players = sortNames(record.getPlayers());
      } catch (error) {
        this.logWarn('[AGGREGATE] failed to read initial player snapshot', error);
      }
    }

    if (this.started) {
      this.ensurePlayerListTimer(serverDir);
    }

    return true;
  }

  unregisterPlayerSnapshotProvider(options = {}) {
    const serverDir = typeof options.serverDir === 'string' ? options.serverDir.trim() : '';
    const botId = typeof options.botId === 'string' ? options.botId.trim() : '';
    if (!serverDir || !botId) {
      return false;
    }

    const records = this.playerSnapshotsByServer.get(serverDir);
    if (!records) {
      return false;
    }

    records.delete(botId);
    if (records.size === 0) {
      this.playerSnapshotsByServer.delete(serverDir);
      const timer = this.playerListTimersByServer.get(serverDir);
      if (timer) {
        clearInterval(timer);
        this.playerListTimersByServer.delete(serverDir);
      }
    }

    return true;
  }

  refreshPlayerSnapshot(options = {}) {
    if (!this.isPlayerListEnabled()) {
      return false;
    }

    const serverDir = typeof options.serverDir === 'string' ? options.serverDir.trim() : '';
    const botId = typeof options.botId === 'string' ? options.botId.trim() : '';
    if (!serverDir || !botId) {
      return false;
    }

    const record = this.ensurePlayerRecord(serverDir, botId);
    if (typeof options.getPlayers === 'function') {
      record.getPlayers = options.getPlayers;
    }

    if (Array.isArray(options.players)) {
      record.players = sortNames(options.players.map((entry) => String(entry || '').trim()));
      return true;
    }

    if (record.getPlayers) {
      try {
        record.players = sortNames(record.getPlayers());
        return true;
      } catch (error) {
        this.logWarn('[AGGREGATE] failed to refresh player snapshot', error);
      }
    }

    return false;
  }

  ensurePlayerListTimer(serverDir) {
    if (!this.started || !this.isPlayerListEnabled() || this.playerListTimersByServer.has(serverDir)) {
      return;
    }

    const intervalMs = Math.max(1, Math.round(this.playerListIntervalMinutes * 60 * 1000));
    const timer = setInterval(() => {
      try {
        this.flushPlayerList(serverDir);
      } catch (error) {
        this.logWarn('[AGGREGATE] failed to flush player list', error);
      }
    }, intervalMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.playerListTimersByServer.set(serverDir, timer);
  }

  flushPlayerList(serverDir) {
    if (!this.isPlayerListEnabled()) {
      return null;
    }

    const normalizedServerDir = typeof serverDir === 'string' ? serverDir.trim() : '';
    if (!normalizedServerDir) {
      return null;
    }

    const records = this.playerSnapshotsByServer.get(normalizedServerDir);
    if (!records || records.size === 0) {
      return null;
    }

    const union = [];
    for (const record of records.values()) {
      if (record.getPlayers) {
        try {
          record.players = sortNames(record.getPlayers());
        } catch (error) {
          this.logWarn('[AGGREGATE] failed to read player snapshot provider', error);
        }
      }

      union.push(...(Array.isArray(record.players) ? record.players : []));
    }

    const uniqueNames = sortNames(union);
    if (uniqueNames.length === 0) {
      return null;
    }

    const paths = this.resolveServerPaths(normalizedServerDir);
    if (!paths) {
      return null;
    }

    try {
      this.appendLine(paths.playerListLogPath, `${getCurrentTimestamp()} ${uniqueNames.join(', ')}\n`);
      return {
        serverDir: normalizedServerDir,
        players: uniqueNames
      };
    } catch (error) {
      this.logWarn('[AGGREGATE] failed to append player list line', error);
      return null;
    }
  }
}

module.exports = {
  AggregateLogService,
  normalizePositiveInteger,
  normalizePositiveNumber,
  sortNames
};
