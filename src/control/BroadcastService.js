const { CommandContext } = require('../command/CommandContext');

class BroadcastService {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.runtimes = new Map();
  }

  captureRuntimeBroadcast(runtime, level, message) {
    if (!runtime || !runtime.logger || typeof runtime.logger.capture !== 'function') {
      return;
    }

    runtime.logger.capture(level, message);
  }

  registerRuntime(runtime) {
    if (!runtime || !runtime.config || !runtime.config.id) {
      throw new Error('runtime with config.id is required');
    }

    this.runtimes.set(runtime.config.id, runtime);
  }

  unregisterRuntime(botId) {
    this.runtimes.delete(botId);
  }

  // 广播按服务器隔离: 只投递给与发起 bot 同一 serverDir 的 bot。
  // 发起者(源 bot)必须在 runtimes 中注册; 找不到源 bot 时广播应 fail-closed,
  // 绝不回退成"发给所有服务器"(避免跨服务器误发)。
  getServerDirOfBot(botId) {
    const runtime = botId ? this.runtimes.get(botId) : null;
    return runtime && runtime.config ? (runtime.config.serverDir || null) : null;
  }

  hasSourceBot(botId) {
    return Boolean(botId) && this.runtimes.has(botId);
  }

  isSameServer(runtime, serverDir) {
    if (serverDir == null) {
      return true;
    }
    return (runtime && runtime.config && (runtime.config.serverDir || null)) === serverDir;
  }

  // 收集所有在线 bot 的锁状态摘要(供 whisper lockstatus 聚合回复, 找空闲 bot)。
  // serverDir 非空时只收集同一服务器的 bot。
  collectLockStatuses(serverDir = null) {
    const statuses = [];

    for (const [botId, runtime] of this.runtimes.entries()) {
      if (!runtime || runtime.state !== 'online' || !runtime.bot) {
        continue;
      }

      if (!this.isSameServer(runtime, serverDir)) {
        continue;
      }

      let lock = { locked: false, owner: null, reason: null };
      if (runtime.lockFeature && typeof runtime.lockFeature.getTeleportLockStatus === 'function') {
        lock = runtime.lockFeature.getTeleportLockStatus();
      }

      statuses.push({
        botId,
        username: (runtime.config && runtime.config.username) || botId,
        state: runtime.state,
        serverDir: runtime.config ? runtime.config.serverDir || null : null,
        lock
      });
    }

    return statuses;
  }

  createInternalCommandContext(options = {}) {
    const sourceBotId = options.sourceBotId || 'unknown';
    const sender = options.sender || sourceBotId;

    return new CommandContext({
      source: 'broadcast',
      sender,
      label: `broadcast:${sourceBotId}`
    });
  }

  getFailureMessageFromContext(context) {
    if (!context || typeof context.getMessages !== 'function') {
      return null;
    }

    const messages = context.getMessages();
    for (const entry of messages) {
      const message = String(entry && entry.message ? entry.message : '').trim();
      const mode = String(entry && entry.mode ? entry.mode : '').toLowerCase();
      if (!message) {
        continue;
      }

      if (mode === 'tell' || this.isLikelyCommandFailure(message)) {
        return message;
      }
    }

    return null;
  }

  isLikelyCommandFailure(message) {
    const text = String(message || '').trim();
    if (!text) return false;

    return (
      /^用法[:：]/.test(text) ||
      /^未知命令[:：]/.test(text) ||
      /^命令执行出错[:：]/.test(text) ||
      /失败/.test(text) ||
      /未找到/.test(text) ||
      /无法解析/.test(text) ||
      /请先关闭/.test(text) ||
      /必须/.test(text) ||
      /不存在/.test(text) ||
      /未迁移/.test(text) ||
      /未识别/.test(text)
    );
  }

  broadcastSend(message, sourceBotId = null) {
    const deliveredBotIds = [];

    // 无有效源 bot(未注册/缺 id)时 fail-closed, 不广播
    if (!this.hasSourceBot(sourceBotId)) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(`[BROADCAST] send ignored: unknown source bot id=${sourceBotId || 'null'}`);
      }
      return deliveredBotIds;
    }

    const serverDir = this.getServerDirOfBot(sourceBotId);

    for (const [botId, runtime] of this.runtimes.entries()) {
      if (!runtime || runtime.state !== 'online' || !runtime.bot) {
        continue;
      }

      // 只投递给与发起 bot 同一服务器的 bot, 不跨服务器广播
      if (!this.isSameServer(runtime, serverDir)) {
        continue;
      }

      try {
        runtime.sendChat(message);
        this.captureRuntimeBroadcast(
          runtime,
          'info',
          `[BROADCAST] received send source=${sourceBotId || 'unknown'} message=${message}`
        );
        deliveredBotIds.push(botId);
      } catch (error) {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn(`[BROADCAST] send failed bot=${botId} source=${sourceBotId || 'unknown'}: ${error.message}`);
        }
      }
    }

    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(
        `[BROADCAST] source=${sourceBotId || 'unknown'} server=${serverDir || 'any'} delivered=${deliveredBotIds.length} message=${message}`
      );
    }

    return deliveredBotIds;
  }

  async broadcastCommand(command, options = {}) {
    const normalizedCommand = String(command || '').trim();
    if (!/^(inv|eat)(\s+|$)/i.test(normalizedCommand)) {
      throw new Error('broadcast command only supports inv ... or eat ...');
    }

    const sourceBotId = options.sourceBotId || null;
    const serverDir = this.getServerDirOfBot(sourceBotId);

    const result = {
      command: normalizedCommand,
      successBotIds: [],
      failed: [],
      skippedBotIds: []
    };

    // 无有效源 bot(未注册/缺 id)时 fail-closed, 不向任何 bot 执行
    if (!this.hasSourceBot(sourceBotId)) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(`[BROADCAST] command ignored: unknown source bot id=${sourceBotId || 'null'} command=${normalizedCommand}`);
      }
      return result;
    }

    for (const [botId, runtime] of this.runtimes.entries()) {
      if (!runtime || runtime.state !== 'online' || !runtime.bot) {
        result.skippedBotIds.push(botId);
        continue;
      }

      // 只投递给与发起 bot 同一服务器的 bot, 不跨服务器广播
      if (!this.isSameServer(runtime, serverDir)) {
        result.skippedBotIds.push(botId);
        continue;
      }

      const context = this.createInternalCommandContext({
        sourceBotId: options.sourceBotId || 'unknown',
        sender: options.sender || options.sourceBotId || null
      });

      try {
        this.captureRuntimeBroadcast(
          runtime,
          'info',
          `[BROADCAST] received command source=${options.sourceBotId || 'unknown'} command=${normalizedCommand}`
        );
        await runtime.executeCommand(normalizedCommand, context);

        const failureMessage = this.getFailureMessageFromContext(context);
        if (failureMessage) {
          result.failed.push({ botId, error: failureMessage });
          continue;
        }

        result.successBotIds.push(botId);
      } catch (error) {
        result.failed.push({ botId, error: error.message });
      }
    }

    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(
        `[BROADCAST] command source=${options.sourceBotId || 'unknown'} server=${serverDir || 'any'} success=${result.successBotIds.length} failed=${result.failed.length} skipped=${result.skippedBotIds.length} command=${normalizedCommand}`
      );
    }

    return result;
  }
}

module.exports = {
  BroadcastService
};
