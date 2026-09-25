// 巡检器: 周期性检查那些"不会自己报错、但已经出问题"的状态, 并按事件推送。
//   C1 serverAllOffline: 某 host:port 下期望运行的 bot 全部离线(服务器宕机/被限速封禁)
//   D1 botStuck:        期望运行但长期非 online, 且期间没有任何重启动作(卡死)
//   E2 logFileTooLarge: logs/*.log 单个文件超过阈值(如 memory-monitor.log 无轮转)
// 恢复: C1 恢复在线时推一条; D1 的恢复由 BotRuntime 上线时统一处理。
// 说明: 只读状态, 从不修改 bot; 推送失败只写日志。
const fs = require('fs');
const path = require('path');

const DEFAULT_CHECK_INTERVAL_MS = 60000;
const MIN_CHECK_INTERVAL_MS = 10000;
const DEFAULT_LOG_SCAN_LIMIT = 200;

function toMs(value) {
  if (typeof value !== 'string' || !value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toPositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

class NotificationWatcher {
  constructor(options = {}) {
    this.botManager = options.botManager || null;
    this.notifier = options.notifier || null;
    this.logger = options.logger || null;
    this.appRoot = options.appRoot || process.cwd();
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    // 阈值统一来自 notifier 的 notifications.events 配置(单一来源); 事件层关闭时巡检器也不跑
    this.checkIntervalMs = Math.max(
      MIN_CHECK_INTERVAL_MS,
      toPositiveNumber(options.checkIntervalMs || this.getEventsConfig().checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS)
    );
    this.tickTimer = null;
    this.serverOfflineSince = new Map();
    this.stuckSince = new Map();
    this.lastLogScanAt = 0;
  }

  getEventsConfig() {
    if (this.notifier && typeof this.notifier.getEventsConfig === 'function') {
      const events = this.notifier.getEventsConfig();
      if (events && typeof events === 'object') {
        return events;
      }
    }
    return {};
  }

  start() {
    if (this.tickTimer) return;
    this.serverOfflineSince.clear();
    this.stuckSince.clear();
    this.lastLogScanAt = 0;
    this.tickTimer = setInterval(() => this.tick(), this.checkIntervalMs);
    if (this.tickTimer && typeof this.tickTimer.unref === 'function') {
      this.tickTimer.unref();
    }
  }

  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.serverOfflineSince.clear();
    this.stuckSince.clear();
  }

  tick() {
    try {
      if (!this.isEnabled()) return;
      this.checkServersOffline();
      this.checkStuckBots();
      this.checkLogSizes();
    } catch (error) {
      this.log('warn', `[NOTIFY] notification watcher tick failed: ${error && error.message ? error.message : error}`);
    }
  }

  log(level, message) {
    if (!this.logger || typeof this.logger[level] !== 'function') return;
    this.logger[level](message);
  }

  isEnabled() {
    if (!this.notifier || typeof this.notifier.isEnabled !== 'function' || !this.notifier.isEnabled()) {
      return false;
    }
    if (typeof this.notifier.isEventsEnabled === 'function' && !this.notifier.isEventsEnabled()) {
      return false;
    }
    return true;
  }

  getEventConfig(type) {
    if (this.notifier && typeof this.notifier.getEventConfig === 'function') {
      return this.notifier.getEventConfig(type);
    }
    return { enabled: false };
  }

  listRuntimes() {
    if (!this.botManager || !this.botManager.runtimes) return [];
    return Array.from(this.botManager.runtimes.values()).filter(Boolean);
  }

  notifyEvent(payload) {
    try {
      const promise = this.notifier.notifyEvent(payload);
      return promise && typeof promise.catch === 'function' ? promise.catch(() => null) : promise;
    } catch (error) {
      return null;
    }
  }

  notifyRecovery(payload) {
    try {
      const promise = this.notifier.notifyRecovery(payload);
      return promise && typeof promise.catch === 'function' ? promise.catch(() => null) : promise;
    } catch (error) {
      return null;
    }
  }

  // C1: 某 host:port 下"期望运行"的 bot 全部离线, 持续 offlineMs 后推送
  checkServersOffline() {
    const eventConfig = this.getEventConfig('serverAllOffline');
    const grouped = new Map();

    this.listRuntimes().forEach((runtime) => {
      const config = runtime.config || {};
      if (runtime.desiredRunning !== true) return;
      const host = config.host || 'unknown';
      const port = config.port === undefined || config.port === null ? '-' : String(config.port);
      const serverKey = `${host}:${port}`;
      if (!grouped.has(serverKey)) {
        grouped.set(serverKey, { host, port, total: 0, online: 0 });
      }
      const group = grouped.get(serverKey);
      group.total += 1;
      if (runtime.state === 'online') {
        group.online += 1;
      }
    });

    const now = this.now();
    const minBots = toPositiveNumber(eventConfig.minBots, 2);
    const offlineMs = toPositiveNumber(eventConfig.offlineMs, 120000);

    grouped.forEach((group, serverKey) => {
      const offline = group.total >= minBots && group.online === 0;

      if (!offline) {
        if (this.serverOfflineSince.has(serverKey)) {
          this.serverOfflineSince.delete(serverKey);
          this.notifyRecovery({
            type: 'serverAllOffline',
            key: `server:offline:${serverKey}`,
            severity: 'active',
            title: 'MULTIBOT Downdetector',
            body: `${serverKey} 已恢复: ${group.online}/${group.total} 个 bot 在线`,
            label: serverKey
          });
        }
        return;
      }

      if (eventConfig.enabled === false) return;

      const firstSeenAt = this.serverOfflineSince.get(serverKey) || now;
      this.serverOfflineSince.set(serverKey, firstSeenAt);
      if (now - firstSeenAt < offlineMs) return;

      const offlineMinutes = Math.max(1, Math.round((now - firstSeenAt) / 60000));
      this.notifyEvent({
        type: 'serverAllOffline',
        key: `server:offline:${serverKey}`,
        severity: 'critical',
        title: 'MULTIBOT Downdetector',
        body: `${serverKey} 上 ${group.total} 个 bot 全部离线已 ${offlineMinutes} 分钟, 请检查服务器状态`,
        label: serverKey
      });
    });
  }

  // D1: 期望运行但长期非 online, 且期间没有重启动作/没有在等重连 -> 卡死
  checkStuckBots() {
    const eventConfig = this.getEventConfig('botStuck');
    const now = this.now();
    const stuckMs = toPositiveNumber(eventConfig.stuckMs, 1800000);

    this.listRuntimes().forEach((runtime) => {
      const config = runtime.config || {};
      const id = config.id || 'unknown';
      const key = `bot:stuck:${id}`;

      const excluded = runtime.desiredRunning !== true
        || runtime.state === 'online'
        || runtime.openAuthPermanentFailure === true
        || runtime.restartScheduleExhausted === true
        || Boolean(runtime.restartTimer);

      if (excluded) {
        this.stuckSince.delete(id);
        return;
      }

      if (eventConfig.enabled === false) return;

      const lastActivityMs = Math.max(
        toMs(runtime.lastSpawnAt),
        toMs(runtime.lastEndAt),
        toMs(runtime.lastFailureAt),
        toMs(runtime.pendingRestartScheduledAt)
      );

      const firstSeenAt = this.stuckSince.get(id) || now;
      this.stuckSince.set(id, firstSeenAt);

      // 有明确活动时间戳时以它为准; 完全没有(如后端刚重启)则以本进程首次观察到的时间为准
      const referenceMs = lastActivityMs > 0 ? lastActivityMs : firstSeenAt;
      if (now - referenceMs < stuckMs) return;

      // 文案与阈值同口径: 报"距最近一次活动"的真实时长, 否则会低估严重程度
      const stuckMinutes = Math.max(1, Math.round((now - referenceMs) / 60000));
      this.notifyEvent({
        type: 'botStuck',
        key,
        severity: 'critical',
        title: 'MULTIBOT Downdetector',
        body: `${id} 已 ${stuckMinutes} 分钟未上线且无重启动作 state=${runtime.state} last=${runtime.lastError || runtime.lastFailure || 'none'}`,
        label: id
      });
    });
  }

  // E2: logs 目录下单文件超过阈值(默认 1GB), 按 checkIntervalMs 限频扫描
  checkLogSizes() {
    const eventConfig = this.getEventConfig('logFileTooLarge');
    if (eventConfig.enabled === false) return;

    const now = this.now();
    const scanIntervalMs = toPositiveNumber(eventConfig.checkIntervalMs, 3600000);
    if (this.lastLogScanAt && now - this.lastLogScanAt < scanIntervalMs) return;
    this.lastLogScanAt = now;

    const maxBytes = toPositiveNumber(eventConfig.maxBytes, 1024 * 1024 * 1024);
    const logsDir = path.join(this.appRoot, 'logs');

    let entries;
    try {
      entries = fs.readdirSync(logsDir, { withFileTypes: true });
    } catch (error) {
      return;
    }

    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.log'))
      .slice(0, DEFAULT_LOG_SCAN_LIMIT)
      .forEach((entry) => {
        let size = 0;
        try {
          size = fs.statSync(path.join(logsDir, entry.name)).size;
        } catch (error) {
          return;
        }
        if (size <= maxBytes) return;

        const sizeMb = Math.round(size / (1024 * 1024));
        const limitMb = Math.round(maxBytes / (1024 * 1024));
        this.notifyEvent({
          type: 'logFileTooLarge',
          key: `disk:log:${entry.name}`,
          severity: 'active',
          title: 'MULTIBOT Downdetector',
          body: `日志 logs/${entry.name} 已 ${sizeMb}MB(阈值 ${limitMb}MB), 建议轮转或清理`,
          label: 'backend'
        });
      });
  }
}

module.exports = {
  NotificationWatcher,
  DEFAULT_CHECK_INTERVAL_MS
};
