const util = require('util');
const { RingBuffer } = require('./RingBuffer');
const { getTimestamp } = require('../util/time');

function formatPart(part) {
  if (part instanceof Error) {
    return part.stack || part.message;
  }

  if (typeof part === 'string') {
    return part;
  }

  return util.inspect(part, {
    depth: 4,
    breakLength: 120,
    compact: true
  });
}

class BotLogger {
  constructor(options = {}) {
    this.botId = options.botId || 'unknown';
    this.consoleEnabled = options.consoleEnabled !== false;
    this.eventStream = options.eventStream || null;
    this.buffer = new RingBuffer(options.bufferSize || 500);
  }

  createEntry(level, message) {
    return {
      timestamp: getTimestamp(),
      botId: this.botId,
      level,
      message
    };
  }

  emitEntry(entry, options = {}) {
    const consoleEnabled = options.consoleEnabled === true;

    this.buffer.push(entry);

    if (consoleEnabled) {
      const prefix = `[MULTIBOT][${this.botId}][${entry.level.toUpperCase()}]`;
      const method = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'log';
      console[method](`${prefix} ${entry.message}`);
    }

    if (this.eventStream) {
      this.eventStream.publish('log', entry);
    }

    return entry;
  }

  write(level, ...parts) {
    const message = parts.map(formatPart).join(' ');
    const entry = this.createEntry(level, message);
    return this.emitEntry(entry, { consoleEnabled: this.consoleEnabled });
  }

  capture(level, ...parts) {
    const message = parts.map(formatPart).join(' ');
    return this.emitEntry(this.createEntry(level, message), { consoleEnabled: false });
  }

  info(...parts) {
    return this.write('info', ...parts);
  }

  warn(...parts) {
    return this.write('warn', ...parts);
  }

  error(...parts) {
    return this.write('error', ...parts);
  }

  debug(...parts) {
    return this.write('debug', ...parts);
  }

  getRecent() {
    return this.buffer.toArray();
  }
}

module.exports = {
  BotLogger
};
