class ChatConsoleCoordinator {
  constructor(options = {}) {
    this.batchWindowMs = Number.isFinite(Number(options.batchWindowMs)) && Number(options.batchWindowMs) > 0
      ? Math.floor(Number(options.batchWindowMs))
      : 100;
    this.writer = typeof options.writer === 'function'
      ? options.writer
      : (entry) => {
        const method = entry.level === 'error'
          ? 'error'
          : entry.level === 'warn'
            ? 'warn'
            : 'log';
        console[method](`[MULTIBOT][${entry.label}][${entry.level.toUpperCase()}] ${entry.message}`);
      };
    this.pendingEntries = new Map();
  }

  getServerLabel(runtime) {
    const serverDir = runtime && runtime.config && typeof runtime.config.serverDir === 'string'
      ? runtime.config.serverDir.trim()
      : '';
    return serverDir || null;
  }

  getBotLabel(runtime) {
    const botId = runtime && runtime.config && typeof runtime.config.id === 'string'
      ? runtime.config.id.trim()
      : '';
    return botId || 'unknown';
  }

  buildKey(runtime, level, message) {
    const serverLabel = this.getServerLabel(runtime);
    if (!serverLabel) {
      return null;
    }

    return `${serverLabel}\u0000${level}\u0000${message}`;
  }

  flushEntry(key) {
    const entry = this.pendingEntries.get(key);
    if (!entry) {
      return;
    }

    this.pendingEntries.delete(key);

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    if (entry.botIds.size > 1) {
      const uniqueLoggers = Array.from(new Set(entry.loggers.filter(Boolean)));
      this.writer({
        label: entry.serverLabel,
        level: entry.level,
        message: entry.message,
        botIds: Array.from(entry.botIds)
      });

      for (const logger of uniqueLoggers) {
        if (typeof logger.capture === 'function') {
          logger.capture(entry.level, entry.message);
          continue;
        }

        if (typeof logger[entry.level] === 'function') {
          logger[entry.level](entry.message);
        }
      }
      return;
    }

    const singleLogger = entry.loggers[0];
    if (singleLogger && typeof singleLogger.info === 'function' && entry.level === 'info') {
      singleLogger.info(entry.message);
      return;
    }

    if (singleLogger && typeof singleLogger[entry.level] === 'function') {
      singleLogger[entry.level](entry.message);
      return;
    }

    this.writer({
      label: entry.singleBotLabel || entry.serverLabel,
      level: entry.level,
      message: entry.message,
      botIds: Array.from(entry.botIds)
    });
  }

  submit(options = {}) {
    const runtime = options.runtime || null;
    const logger = options.logger || null;
    const level = typeof options.level === 'string' && options.level.trim()
      ? options.level.trim().toLowerCase()
      : 'info';
    const message = String(options.message || '').trim();
    if (!message) {
      return;
    }

    const key = this.buildKey(runtime, level, message);
    if (!key) {
      if (logger && typeof logger[level] === 'function') {
        logger[level](message);
        return;
      }

      this.writer({
        label: this.getBotLabel(runtime),
        level,
        message,
        botIds: []
      });
      return;
    }

    let entry = this.pendingEntries.get(key);
    if (!entry) {
      entry = {
        key,
        serverLabel: this.getServerLabel(runtime),
        singleBotLabel: this.getBotLabel(runtime),
        level,
        message,
        botIds: new Set(),
        loggers: [],
        timer: null
      };
      this.pendingEntries.set(key, entry);
      entry.timer = setTimeout(() => {
        this.flushEntry(key);
      }, this.batchWindowMs);
      if (typeof entry.timer.unref === 'function') {
        entry.timer.unref();
      }
    }

    const botId = this.getBotLabel(runtime);
    if (!entry.botIds.has(botId)) {
      entry.botIds.add(botId);
      if (logger) {
        entry.loggers.push(logger);
      }
    }
  }

  stop() {
    const keys = Array.from(this.pendingEntries.keys());
    for (const key of keys) {
      this.flushEntry(key);
    }
  }
}

module.exports = {
  ChatConsoleCoordinator
};
