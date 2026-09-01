const fs = require('fs');
const path = require('path');
const { getTimestamp } = require('../util/time');

function toMb(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }

  return Math.round((numeric / (1024 * 1024)) * 100) / 100;
}

function normalizeIntervalMs(value, fallback = 10000) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback;
}

class MemoryLogService {
  constructor(options = {}) {
    this.appRoot = options.appRoot || process.cwd();
    this.botManager = options.botManager || null;
    this.config = options.config || {};
    this.intervalMs = normalizeIntervalMs(this.config.intervalMs, 10000);
    this.filePath = this.resolveFilePath(this.config.filePath);
    this.timer = null;
    this.memoryUsageProvider = options.memoryUsageProvider || (() => process.memoryUsage());
    this.timestampProvider = options.timestampProvider || (() => getTimestamp());
    this.pidProvider = options.pidProvider || (() => process.pid);
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  isMemoryDetailsEnabled() {
    return this.botManager && typeof this.botManager.isMemoryDetailsEnabled === 'function'
      ? this.botManager.isMemoryDetailsEnabled() === true
      : false;
  }

  resolveFilePath(configuredPath) {
    const value = typeof configuredPath === 'string' ? configuredPath.trim() : '';
    if (!value) {
      return path.join(this.appRoot, 'logs', 'memory-monitor.log');
    }

    if (path.isAbsolute(value)) {
      return value;
    }

    return path.resolve(this.appRoot, value);
  }

  getBotSnapshot() {
    const bots = this.botManager && typeof this.botManager.listBots === 'function'
      ? this.botManager.listBots()
      : [];
    const botDiagnostics = this.isMemoryDetailsEnabled()
      && this.botManager
      && typeof this.botManager.getBotDiagnostics === 'function'
      ? this.botManager.getBotDiagnostics()
      : [];
    const stateCounts = {};
    const desiredRunningIds = [];
    const botStates = [];
    const botMemory = [];
    const endedBotRefs = [];
    const diagnosticById = new Map();

    for (const diagnostic of botDiagnostics) {
      if (diagnostic && diagnostic.id) {
        diagnosticById.set(diagnostic.id, diagnostic);
      }
    }

    for (const bot of bots) {
      const state = bot && typeof bot.state === 'string' && bot.state
        ? bot.state
        : 'unknown';
      stateCounts[state] = (stateCounts[state] || 0) + 1;

      if (bot && bot.desiredRunning === true && bot.id) {
        desiredRunningIds.push(bot.id);
      }

      if (bot && bot.id) {
        botStates.push(`${bot.id}:${state}`);
        const diagnostic = diagnosticById.get(bot.id);
        if (diagnostic) {
          botMemory.push({
            id: diagnostic.id,
            state: diagnostic.state,
            desiredRunning: diagnostic.desiredRunning,
            hasBot: diagnostic.hasBot,
            worldColumns: diagnostic.worldColumns,
            entities: diagnostic.entities,
            players: diagnostic.players,
            pathfinderLoaded: diagnostic.pathfinderLoaded,
            physicsEnabled: diagnostic.physicsEnabled,
            clientEnded: diagnostic.client ? diagnostic.client.ended : null,
            clientState: diagnostic.client ? diagnostic.client.state : null,
            socketDestroyed: diagnostic.client ? diagnostic.client.socketDestroyed : null,
            chunkPackets: diagnostic.chunkPackets
          });
          if (Array.isArray(diagnostic.endedBotRefs)) {
            endedBotRefs.push(...diagnostic.endedBotRefs);
          }
        }
      }
    }

    const diagnosticTotals = botMemory.reduce((accumulator, bot) => {
      accumulator.worldColumns += Number.isFinite(bot.worldColumns) ? bot.worldColumns : 0;
      accumulator.entities += Number.isFinite(bot.entities) ? bot.entities : 0;
      accumulator.players += Number.isFinite(bot.players) ? bot.players : 0;
      if (bot.hasBot) accumulator.liveBotObjects += 1;
      if (bot.pathfinderLoaded) accumulator.pathfinderLoaded += 1;
      return accumulator;
    }, {
      worldColumns: 0,
      entities: 0,
      players: 0,
      liveBotObjects: 0,
      pathfinderLoaded: 0
    });

    return {
      totalBots: bots.length,
      desiredRunningCount: desiredRunningIds.length,
      desiredRunningIds,
      stateCounts,
      botStates,
      diagnosticTotals,
      endedBotRefs,
      botMemory
    };
  }

  buildSample(trigger = 'tick') {
    const memoryUsage = this.memoryUsageProvider() || {};
    const botSnapshot = this.getBotSnapshot();

    return {
      timestamp: this.timestampProvider(),
      trigger,
      pid: this.pidProvider(),
      rssMB: toMb(memoryUsage.rss),
      heapTotalMB: toMb(memoryUsage.heapTotal),
      heapUsedMB: toMb(memoryUsage.heapUsed),
      externalMB: toMb(memoryUsage.external),
      arrayBuffersMB: toMb(memoryUsage.arrayBuffers),
      totalBots: botSnapshot.totalBots,
      desiredRunningCount: botSnapshot.desiredRunningCount,
      desiredRunningIds: botSnapshot.desiredRunningIds,
      stateCounts: botSnapshot.stateCounts,
      botStates: botSnapshot.botStates,
      diagnosticTotals: botSnapshot.diagnosticTotals,
      endedBotRefs: botSnapshot.endedBotRefs,
      botMemory: botSnapshot.botMemory
    };
  }

  appendSample(trigger = 'tick') {
    const sample = this.buildSample(trigger);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(sample)}\n`, 'utf8');
    return sample;
  }

  start() {
    if (!this.isEnabled() || this.timer) {
      return;
    }

    this.appendSample('start');
    this.timer = setInterval(() => {
      try {
        this.appendSample('tick');
      } catch (error) {
      }
    }, this.intervalMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(reason = 'stop') {
    if (!this.isEnabled()) {
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    try {
      this.appendSample(`stop:${reason}`);
    } catch (error) {
    }
  }
}

module.exports = {
  MemoryLogService,
  toMb,
  normalizeIntervalMs
};
