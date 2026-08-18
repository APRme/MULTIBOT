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

    for (const [botId, runtime] of this.runtimes.entries()) {
      if (!runtime || runtime.state !== 'online' || !runtime.bot) {
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
        `[BROADCAST] source=${sourceBotId || 'unknown'} delivered=${deliveredBotIds.length} message=${message}`
      );
    }

    return deliveredBotIds;
  }

  async broadcastCommand(command, options = {}) {
    const normalizedCommand = String(command || '').trim();
    if (!/^(inv|eat)(\s+|$)/i.test(normalizedCommand)) {
      throw new Error('broadcast command only supports inv ... or eat ...');
    }

    const result = {
      command: normalizedCommand,
      successBotIds: [],
      failed: [],
      skippedBotIds: []
    };

    for (const [botId, runtime] of this.runtimes.entries()) {
      if (!runtime || runtime.state !== 'online' || !runtime.bot) {
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
        `[BROADCAST] command source=${options.sourceBotId || 'unknown'} success=${result.successBotIds.length} failed=${result.failed.length} skipped=${result.skippedBotIds.length} command=${normalizedCommand}`
      );
    }

    return result;
  }
}

module.exports = {
  BroadcastService
};
