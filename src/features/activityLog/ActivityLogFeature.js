const fs = require('fs');
const path = require('path');

function getCurrentTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `[${year}-${month}-${day} ${hours}:${minutes}:${seconds}]`;
}

class ActivityLogFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.config = options.config || {};
    this.paths = options.paths || {};
    this.aggregateLogService = options.aggregateLogService || null;
    this.runtimeInfo = options.runtimeInfo || {};
    this.bot = null;
    this.playerListInterval = null;
  }

  attach(bot) {
    this.stop();
    this.bot = bot;

    if (this.shouldAggregatePlayerListToServerFile()) {
      try {
        this.aggregateLogService.registerPlayerSnapshotProvider({
          serverDir: this.runtimeInfo.serverDir,
          botId: this.runtimeInfo.botId,
          getPlayers: () => this.getCurrentPlayerNames()
        });
        this.publishAggregatePlayerSnapshot();
      } catch (error) {
      }
    }

    if (this.shouldLogPlayerList()) {
      this.updatePlayerListFile();
      this.playerListInterval = setInterval(() => {
        this.updatePlayerListFile();
      }, this.getPlayerListIntervalMs());
    }
  }

  stop() {
    if (this.shouldAggregatePlayerListToServerFile()) {
      try {
        this.aggregateLogService.unregisterPlayerSnapshotProvider({
          serverDir: this.runtimeInfo.serverDir,
          botId: this.runtimeInfo.botId
        });
      } catch (error) {
      }
    }

    if (this.playerListInterval) {
      clearInterval(this.playerListInterval);
      this.playerListInterval = null;
    }

    this.bot = null;
  }

  shouldLogChatToFile() {
    return this.config.logToFile === true;
  }

  shouldLogPlayerList() {
    return this.config.logPlayerList === true;
  }

  shouldAggregateChatToServerFile() {
    return Boolean(
      this.aggregateLogService &&
      typeof this.aggregateLogService.isChatEnabled === 'function' &&
      this.aggregateLogService.isChatEnabled() &&
      this.runtimeInfo &&
      this.runtimeInfo.sourceType === 'multibot_bots' &&
      typeof this.runtimeInfo.serverDir === 'string' &&
      this.runtimeInfo.serverDir.trim()
    );
  }

  shouldAggregatePlayerListToServerFile() {
    return Boolean(
      this.aggregateLogService &&
      typeof this.aggregateLogService.isPlayerListEnabled === 'function' &&
      this.aggregateLogService.isPlayerListEnabled() &&
      this.runtimeInfo &&
      this.runtimeInfo.sourceType === 'multibot_bots' &&
      typeof this.runtimeInfo.serverDir === 'string' &&
      this.runtimeInfo.serverDir.trim() &&
      typeof this.runtimeInfo.botId === 'string' &&
      this.runtimeInfo.botId.trim()
    );
  }

  getPlayerListIntervalMs() {
    const minutes = Number.parseFloat(this.config.playerListIntervalMinutes);
    const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 1;
    return safeMinutes * 60 * 1000;
  }

  resolveLogPath(configuredPath, fallbackPath) {
    const filePath = configuredPath || fallbackPath;
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    return path.resolve(this.paths.accountDir || process.cwd(), filePath);
  }

  appendLine(filePath, line) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, 'utf8');
  }

  getCurrentPlayerNames() {
    if (!this.bot) {
      return [];
    }

    const rawNames = Object.keys(this.bot.players || {}).filter(Boolean);
    if (this.bot.player && this.bot.player.username) rawNames.push(this.bot.player.username);
    if (this.bot.username) rawNames.push(this.bot.username);

    return Array.from(new Set(rawNames)).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: 'accent' })
    );
  }

  publishAggregatePlayerSnapshot() {
    if (!this.shouldAggregatePlayerListToServerFile()) {
      return;
    }

    try {
      this.aggregateLogService.refreshPlayerSnapshot({
        serverDir: this.runtimeInfo.serverDir,
        botId: this.runtimeInfo.botId,
        players: this.getCurrentPlayerNames(),
        getPlayers: () => this.getCurrentPlayerNames()
      });
    } catch (error) {
    }
  }

  logChatMessage(message) {
    if (message === undefined || message === null) return;

    if (this.shouldLogChatToFile()) {
      const filePath = this.resolveLogPath(this.config.logFilePath, './assn_chat.log');
      this.appendLine(filePath, `${getCurrentTimestamp()} ${String(message)}\n`);
    }

    if (this.shouldAggregateChatToServerFile()) {
      try {
        this.aggregateLogService.recordChatMessage({
          serverDir: this.runtimeInfo.serverDir,
          message,
          sourceName: this.runtimeInfo.username || this.bot?.username || this.runtimeInfo.botId
        });
      } catch (error) {
      }
    }
  }

  updatePlayerListFile() {
    if (!this.bot) return;

    const uniqueNames = this.getCurrentPlayerNames();

    this.publishAggregatePlayerSnapshot();

    if (!this.shouldLogPlayerList()) return;

    const filePath = this.resolveLogPath(this.config.playerListPath, './assn_playerList.log');
    this.appendLine(filePath, `${getCurrentTimestamp()} ${uniqueNames.join(', ')}\n`);
  }
}

module.exports = {
  ActivityLogFeature,
  getCurrentTimestamp
};
