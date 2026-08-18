const fs = require('fs');
const path = require('path');

class BlockBreakFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.config = options.config || {};
    this.paths = options.paths || {};
    this.bot = null;
    this.listeners = [];
    this.lastBlockUpdates = new Map();
    this.cleanupTimers = new Map();
  }

  attach(bot) {
    this.stop();
    this.bot = bot;

    this.addListener('blockBreakProgressObserved', (block, destroyStage, entity) => {
      this.handleBlockBreakProgressObserved(block, destroyStage, entity);
    });
    this.addListener('blockBreakProgressEnd', (block, entity) => {
      this.handleBlockBreakProgressEnd(block, entity);
    });
    this.addListener('blockUpdate', (oldBlock, newBlock) => {
      this.handleBlockUpdate(oldBlock, newBlock);
    });
  }

  addListener(eventName, handler) {
    if (!this.bot) return;
    this.bot.on(eventName, handler);
    this.listeners.push({ eventName, handler });
  }

  stop() {
    if (this.bot) {
      for (const listener of this.listeners) {
        this.bot.removeListener(listener.eventName, listener.handler);
      }
    }

    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }

    this.listeners = [];
    this.lastBlockUpdates.clear();
    this.cleanupTimers.clear();
    this.bot = null;
  }

  getMonitoredBlocks() {
    return Array.isArray(this.config.monitoredBlocks)
      ? this.config.monitoredBlocks.map((value) => String(value)).filter(Boolean)
      : [];
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  matchesMonitoredBlocks(block) {
    if (!block || !block.name) return false;

    const monitoredBlocks = this.getMonitoredBlocks();
    if (!monitoredBlocks.length) return true;

    return monitoredBlocks.includes(block.name);
  }

  isCreativePlayer(entity) {
    if (this.config.excludeCreativeMode !== true) return false;
    if (!this.bot || !entity || !entity.username) return false;

    const player = this.bot.players ? this.bot.players[entity.username] : null;
    const gamemode = player ? (player.gamemode ?? player.gameMode) : null;
    return gamemode === 1 || gamemode === 'creative';
  }

  shouldMonitorObservedBreak(block, entity) {
    if (!this.isEnabled()) return false;
    if (!this.matchesMonitoredBlocks(block)) return false;
    if (this.isCreativePlayer(entity)) return false;
    return true;
  }

  resolveLogFilePath() {
    const configuredPath = this.config.logFilePath || './block-break.log';
    if (path.isAbsolute(configuredPath)) {
      return configuredPath;
    }

    return path.resolve(this.paths.accountDir || process.cwd(), configuredPath);
  }

  writeLog(message, level = 'warn') {
    const timestamp = new Date().toLocaleString('zh-CN');

    if (this.config.logToConsole !== false && this.logger && typeof this.logger[level] === 'function') {
      this.logger[level](`[BLOCK_BREAK] ${message}`);
    }

    if (this.config.logToFile === true) {
      try {
        const filePath = this.resolveLogFilePath();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, `[${timestamp}] ${message}\n`, 'utf8');
      } catch (error) {
      }
    }
  }

  alertTrustedPlayers(message) {
    if (!this.bot) return;

    const players = Array.isArray(this.config.alertTrustedPlayers)
      ? this.config.alertTrustedPlayers.map((value) => String(value)).filter(Boolean)
      : [];

    for (const playerName of players) {
      if (this.bot.players && this.bot.players[playerName]) {
        this.bot.chat(`/tell ${playerName} ${message}`);
      }
    }
  }

  formatLocation(position) {
    if (!position) return 'unknown';
    return `${position.x} ${position.y} ${position.z}`;
  }

  getDistance(left, right) {
    if (!left || !right) return Number.POSITIVE_INFINITY;
    if (typeof left.distanceTo === 'function') {
      return left.distanceTo(right);
    }

    const dx = Number(left.x || 0) - Number(right.x || 0);
    const dy = Number(left.y || 0) - Number(right.y || 0);
    const dz = Number(left.z || 0) - Number(right.z || 0);
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
  }

  getNearbyPlayers(blockPos, radius = 20) {
    if (!this.bot) return [];

    const nearbyPlayers = [];
    for (const player of Object.values(this.bot.players || {})) {
      if (!player || !player.entity || !player.entity.position) continue;

      const username = player.username || player.entity.username;
      if (!username) continue;

      const distance = this.getDistance(player.entity.position, blockPos);
      if (distance > radius) continue;

      nearbyPlayers.push({
        name: username,
        distance: Math.round(distance)
      });
    }

    nearbyPlayers.sort((left, right) => left.distance - right.distance);
    return nearbyPlayers.map((entry) => `${entry.name}(${entry.distance}格)`);
  }

  handleBlockBreakProgressObserved(block, destroyStage, entity) {
    if (!this.shouldMonitorObservedBreak(block, entity)) return;

    const actor = entity && entity.username ? entity.username : '未知玩家';
    const message = `⚠️ ${actor} 正在破坏 ${block.name} 位于 ${this.formatLocation(block.position)} (进度: ${Number(destroyStage) + 1}/10)`;
    this.writeLog(message, 'warn');
    this.alertTrustedPlayers(message);
  }

  handleBlockBreakProgressEnd(block, entity) {
    if (!this.shouldMonitorObservedBreak(block, entity)) return;

    const actor = entity && entity.username ? entity.username : '未知玩家';
    const message = `✅ ${actor} 停止破坏 ${block.name} 位于 ${this.formatLocation(block.position)}`;
    this.writeLog(message, 'info');
  }

  shouldHandleBlockUpdate(oldBlock, newBlock) {
    if (!this.isEnabled()) return false;
    if (!oldBlock || !newBlock || !oldBlock.position) return false;
    if (!this.matchesMonitoredBlocks(oldBlock)) return false;

    if (oldBlock.name === 'air' || String(oldBlock.name).includes('water')) {
      return false;
    }

    return (
      newBlock.name === 'air' ||
      String(newBlock.name).includes('water') ||
      String(newBlock.name).includes('lava')
    );
  }

  scheduleDedupCleanup(positionKey, timestamp) {
    const existingTimer = this.cleanupTimers.get(positionKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      if (this.lastBlockUpdates.get(positionKey) === timestamp) {
        this.lastBlockUpdates.delete(positionKey);
      }
      this.cleanupTimers.delete(positionKey);
    }, 1000);

    this.cleanupTimers.set(positionKey, timer);
  }

  handleBlockUpdate(oldBlock, newBlock) {
    if (!this.shouldHandleBlockUpdate(oldBlock, newBlock)) return;

    const positionKey = `${oldBlock.position.x},${oldBlock.position.y},${oldBlock.position.z}`;
    const now = Date.now();
    const lastSeenAt = this.lastBlockUpdates.get(positionKey);
    if (lastSeenAt && now - lastSeenAt < 1000) {
      return;
    }

    this.lastBlockUpdates.set(positionKey, now);
    this.scheduleDedupCleanup(positionKey, now);

    const nearbyPlayers = this.getNearbyPlayers(oldBlock.position, 20);
    if (!nearbyPlayers.length) return;

    let actionType = '被替换';
    if (newBlock.name === 'air') {
      actionType = '被破坏';
    } else if (String(newBlock.name).includes('water')) {
      actionType = '被水替换';
    } else if (String(newBlock.name).includes('lava')) {
      actionType = '被岩浆替换';
    }

    const message = `⚡ 方块 ${oldBlock.name} ${actionType} 位于 ${this.formatLocation(oldBlock.position)} | 附近玩家: ${nearbyPlayers.join(', ')}`;
    this.writeLog(message, 'warn');
    this.alertTrustedPlayers(message);
  }
}

module.exports = {
  BlockBreakFeature
};
