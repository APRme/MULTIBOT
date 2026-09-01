const fs = require('fs');
const path = require('path');
const { getTimestamp } = require('../util/time');

const LIFECYCLE_EVENTS = {
  BOT_START: 'bot_start',
  BOT_SPAWN: 'bot_spawn',
  BOT_START_FAILED: 'bot_start_failed',
  BOT_KICKED: 'bot_kicked',
  BOT_DISCONNECT: 'bot_disconnect',
  BOT_RESTART_SCHEDULED: 'bot_restart_scheduled',
  BOT_STOP: 'bot_stop',
  PROCESS_CRASH: 'process_crash',
  PROCESS_UNHANDLED_REJECTION: 'process_unhandled_rejection'
};

function normalizeBoolean(value, fallback) {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

function normalizeFilePath(appRoot, configuredPath, fallbackPath) {
  const value = typeof configuredPath === 'string' ? configuredPath.trim() : '';
  if (!value) {
    return path.join(appRoot, fallbackPath);
  }

  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(appRoot, value);
}

function stringifyDetail(detail) {
  if (detail === null || detail === undefined) return null;
  if (detail instanceof Error) {
    return detail.stack || detail.message || String(detail);
  }
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch (error) {
    return String(detail);
  }
}

class InstanceLifecycleLogService {
  constructor(options = {}) {
    this.appRoot = options.appRoot || process.cwd();
    this.config = options.config || {};
    this.enabled = normalizeBoolean(this.config.enabled, true);
    this.logToConsole = normalizeBoolean(this.config.logToConsole, false);
    this.filePath = normalizeFilePath(this.appRoot, this.config.filePath, path.join('logs', 'lifecycle.log'));
  }

  isEnabled() {
    return this.enabled === true;
  }

  record(event, options = {}) {
    if (!this.isEnabled()) {
      return false;
    }

    const entry = {
      type: 'instance_lifecycle',
      event,
      timestamp: getTimestamp(),
      botId: options.botId || null,
      serverDir: options.serverDir || null,
      reason: options.reason || null,
      detail: stringifyDetail(options.detail)
    };

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');

    if (this.logToConsole) {
      console.log(`[MULTIBOT][LIFECYCLE] ${JSON.stringify(entry)}`);
    }

    return true;
  }
}

module.exports = {
  InstanceLifecycleLogService,
  LIFECYCLE_EVENTS
};
