// Bark 推送封装: 调用 src/notifications/bark/bark-push.ps1 发送手机通知。
// 设计约束:
//  - 密钥只存在于 .env, 由 PowerShell 脚本自行读取; Node 侧不解析/不记录任何凭据
//  - 脚本输出可能包含 URL/前缀等秘密(异常原文), 故只提取 [OK/...]/[FAIL] 与脱敏的
//    reason=<分类> / elapsed, 绝不把脚本 stdout/stderr 原文写入日志
//  - 每次尝试(成功/失败)追加一行到 logs/bark.log(同样只含 label/reason/elapsed, 无秘密)
//  - 可选 retryOnce: 首次失败后等待 retryDelayMs 再重发一次(共 2 次), 每次尝试各记一行
//  - notifyEvent 事件层: 按 key 冷却 + 抑制折叠 + 每小时速率上限 + 恢复配对 + 级别映射,
//    冷却/折叠导致的"没发出去"也记 [SKIP] 行, 便于事后排查"为什么没收到"
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getTimestamp, sleep, formatDuration } = require('../../util/time');

const DEFAULT_SCRIPT_PATH = './src/notifications/bark/bark-push.ps1';
const DEFAULT_ENV_PATH = './.env';
const DEFAULT_GROUP = 'mc';
const DEFAULT_COOLDOWN_MS = 600000;
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_LOG_PATH = './logs/bark.log';
const DEFAULT_RETRY_DELAY_MS = 2000;
const DEFAULT_EVENT_COOLDOWN_MS = 600000;
const DEFAULT_MAX_PER_HOUR = 6;
const HOUR_MS = 3600000;
const MAX_CAPTURED_OUTPUT = 8192;

// 严重度 -> Bark level(决定是否突破专注模式/是否有声)
const SEVERITY_LEVELS = {
  critical: 'timeSensitive',
  active: 'active',
  passive: 'passive'
};

// 各类事件的默认冷却(可被 notifications.events.<type>.cooldownMs 覆盖)
const EVENT_COOLDOWN_DEFAULTS = {
  uncaughtException: 1800000,
  deviceCode: 600000,
  openAuthPermanentFailure: 600000,
  refreshTokenInvalid: 600000,
  invalidSession: 1800000,
  authRejected: 600000,
  serverAllOffline: 1800000,
  restartExhausted: 600000,
  botStuck: 1800000,
  logFileTooLarge: 21600000,
  apiAuthFailure: 1800000,
  pushFailing: 1800000
};

class BarkNotifier {
  constructor(options = {}) {
    this.config = options.config || {};
    this.logger = options.logger || null;
    this.appRoot = options.appRoot || process.cwd();
    this.spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
    this.platform = options.platform || process.platform;
    this.retryDelayMs = options.retryDelayMs;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    // 事件层状态(key -> { lastSentAt, sentCount, suppressed, firstSeenAt, lastSuppressedAt })
    this.eventStates = new Map();
    // 最近一小时内"发送成功"的时间戳(用于全局速率上限)
    this.sendTimestamps = [];
    // 推送自身连续失败计数(用于 pushFailing 事件)
    this.consecutiveFailures = 0;
    this.pushFailingAlerted = false;
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  // 仅当 notifications.bark.retryOnce=true 时, 失败后允许再重发一次(最多 2 次尝试)
  isRetryOnceEnabled() {
    return this.config.retryOnce === true;
  }

  getMaxAttempts() {
    return this.isRetryOnceEnabled() ? 2 : 1;
  }

  getRetryDelayMs() {
    const value = Number(this.retryDelayMs);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETRY_DELAY_MS;
  }

  getCooldownMs() {
    const value = Number(this.config.cooldownMs);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_COOLDOWN_MS;
  }

  getEventsConfig() {
    const events = this.config.events;
    return events && typeof events === 'object' ? events : {};
  }

  // notifications.events.enabled 是总开关(缺省为开), 每个事件还有自己的 enabled
  isEventsEnabled() {
    return this.getEventsConfig().enabled !== false;
  }

  getMaxPerHour() {
    const value = Number(this.getEventsConfig().maxPerHour);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_PER_HOUR;
  }

  // 返回 { enabled, cooldownMs, ...其它该事件自己的阈值字段 }
  getEventConfig(type) {
    const raw = this.getEventsConfig()[type];
    const base = raw && typeof raw === 'object' ? raw : {};
    const fallbackCooldown = EVENT_COOLDOWN_DEFAULTS[type] !== undefined
      ? EVENT_COOLDOWN_DEFAULTS[type]
      : DEFAULT_EVENT_COOLDOWN_MS;
    const cooldown = Number(base.cooldownMs);

    return Object.assign({}, base, {
      enabled: base.enabled !== false,
      cooldownMs: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : fallbackCooldown
    });
  }

  getEventState(key) {
    let state = this.eventStates.get(key);
    if (!state) {
      state = {
        firstSeenAt: 0,
        lastAttemptAt: 0,
        lastSentAt: 0,
        lastSuppressedAt: 0,
        sentCount: 0,
        suppressed: 0
      };
      this.eventStates.set(key, state);
    }
    return state;
  }

  clearEventState(key) {
    this.eventStates.delete(key);
  }

  pruneSendTimestamps(now) {
    this.sendTimestamps = this.sendTimestamps.filter((ts) => now - ts < HOUR_MS);
  }

  isRateLimited(now) {
    this.pruneSendTimestamps(now);
    return this.sendTimestamps.length >= this.getMaxPerHour();
  }

  // 事件级推送: 按 key 冷却 + 抑制折叠 + 每小时速率上限 + 严重度映射
  //   type:     事件类型, 对应 notifications.events.<type>(开关/冷却)
  //   key:      去重键(默认=type), 如 'bot:stuck:APR_m'
  //   severity: critical | active | passive
  // 返回 { sent, ok, reason, folded, suppressed }
  async notifyEvent({ type, key, severity = 'active', title, body, group, label } = {}) {
    const eventKey = key || type || 'event';

    if (!this.isEnabled()) {
      return { sent: false, ok: false, reason: 'disabled', folded: 0, suppressed: 0 };
    }
    if (this.platform !== 'win32') {
      return { sent: false, ok: false, reason: 'non-windows', folded: 0, suppressed: 0 };
    }
    if (!this.isEventsEnabled()) {
      return { sent: false, ok: false, reason: 'events-disabled', folded: 0, suppressed: 0 };
    }

    const eventConfig = this.getEventConfig(type);
    if (eventConfig.enabled !== true) {
      this.log('info', `[NOTIFY] bark event skipped (disabled) key=${eventKey}`);
      return { sent: false, ok: false, reason: 'event-disabled', folded: 0, suppressed: 0 };
    }

    const now = this.now();
    const state = this.getEventState(eventKey);
    if (!state.firstSeenAt) {
      state.firstSeenAt = now;
    }

    // 冷却以"上次尝试"计时(而不是上次成功), 避免推送持续失败时被反复重试刷屏
    if (state.lastAttemptAt && now - state.lastAttemptAt < eventConfig.cooldownMs) {
      state.suppressed += 1;
      state.lastSuppressedAt = now;
      this.appendLog(`${getTimestamp()} [SKIP] key=${eventKey} type=${type || '-'} reason=cooldown suppressed=${state.suppressed}`);
      return { sent: false, ok: false, reason: 'cooldown', folded: 0, suppressed: state.suppressed };
    }

    if (this.isRateLimited(now)) {
      state.suppressed += 1;
      state.lastSuppressedAt = now;
      this.appendLog(`${getTimestamp()} [SKIP] key=${eventKey} type=${type || '-'} reason=rate-limit suppressed=${state.suppressed}`);
      return { sent: false, ok: false, reason: 'rate-limit', folded: 0, suppressed: state.suppressed };
    }

    const folded = state.suppressed;
    const foldedText = folded > 0
      ? `（此前 ${Math.max(1, Math.round(eventConfig.cooldownMs / 60000))} 分钟内折叠 ${folded} 次）`
      : '';

    state.lastAttemptAt = now;
    const result = await this.notify({
      title,
      body: `${body || ''}${foldedText}`,
      group,
      label,
      level: SEVERITY_LEVELS[severity] || SEVERITY_LEVELS.active,
      logKey: eventKey
    });

    if (result.ok) {
      state.lastSentAt = now;
      state.sentCount += 1;
      state.suppressed = 0;
      this.recordSend(now);
      return { sent: true, ok: true, reason: null, folded, suppressed: 0 };
    }

    return { sent: false, ok: false, reason: result.reason, folded, suppressed: state.suppressed };
  }

  // 恢复通知: 只有同一个 key 之前真发出去过故障通知(或 force=true)才推, 推完清空该 key 的状态
  async notifyRecovery({ type, key, title, body, label, severity = 'active', force = false } = {}) {
    const eventKey = key || type || 'event';

    if (!this.isEnabled() || this.platform !== 'win32' || !this.isEventsEnabled()) {
      this.clearEventState(eventKey);
      return { sent: false, reason: 'disabled' };
    }

    const state = this.eventStates.get(eventKey);
    const hadFailure = Boolean(state && state.lastSentAt);
    if (!hadFailure && !force) {
      this.clearEventState(eventKey);
      return { sent: false, reason: 'no-pending-failure' };
    }

    const now = this.now();
    const durationMs = state && state.firstSeenAt ? Math.max(0, now - state.firstSeenAt) : 0;
    const suffix = durationMs > 0 ? `（持续 ${formatDuration(durationMs)}）` : '';
    const result = await this.notify({
      title,
      body: `${body || ''}${suffix}`,
      label,
      level: SEVERITY_LEVELS[severity] || SEVERITY_LEVELS.active,
      logKey: `${eventKey} recovery`
    });

    this.clearEventState(eventKey);
    return { sent: result.ok, reason: result.reason, durationMs };
  }

  recordSend(now) {
    this.sendTimestamps.push(now);
  }

  getPushFailingThreshold() {
    const value = Number(this.getEventConfig('pushFailing').threshold);
    return Number.isFinite(value) && value > 0 ? value : 3;
  }

  // 推送自身连续失败计数(I1): 失败到阈值写 [ALERT] 行并 warn(推不出去时只能用日志),
  // 链路恢复后补推一条"已恢复", 让你知道前面漏了几条
  recordPushOutcome(ok, reason) {
    if (ok) {
      const failures = this.consecutiveFailures;
      this.consecutiveFailures = 0;
      if (this.pushFailingAlerted) {
        this.pushFailingAlerted = false;
        this.appendLog(`${getTimestamp()} [RECOVER] key=push-failing consecutive=${failures} restored`);
        void this.notify({
          title: 'MULTIBOT Downdetector',
          body: `通知链路已恢复（此前连续失败 ${failures} 次）`,
          label: 'push-failing',
          level: SEVERITY_LEVELS.active
        });
      }
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.getPushFailingThreshold() && !this.pushFailingAlerted) {
      this.pushFailingAlerted = true;
      this.appendLog(`${getTimestamp()} [ALERT] key=push-failing consecutive=${this.consecutiveFailures} reason=${reason || 'unknown'}`);
      this.log('warn', `[NOTIFY] bark push failing consecutively count=${this.consecutiveFailures} reason=${reason || 'unknown'}`);
    }
  }

  resolvePath(value, fallback) {
    const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    return path.isAbsolute(raw) ? raw : path.resolve(this.appRoot, raw);
  }

  resolveLogPath() {
    return this.resolvePath(this.config.logPath, DEFAULT_LOG_PATH);
  }

  log(level, message) {
    if (!this.logger || typeof this.logger[level] !== 'function') {
      return;
    }
    this.logger[level](message);
  }

  // 追加一行到 logs/bark.log: 仅含时间戳/结果/label/reason(分类)/耗时, 绝不含凭据
  appendLog(line) {
    try {
      const filePath = this.resolveLogPath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    } catch (error) {
      // 落盘失败不影响推送主流程
    }
  }

  // 返回 Promise<{ ok, reason, elapsedMs }>
  //  reason: null(成功) | 脚本给出的脱敏分类(timeout/http-401/tls-fail/dns-fail/connect-fail/
  //          env-missing/env-incomplete/crypto-key-invalid/crypto-mode-unsupported/...) |
  //          disabled | non-windows | spawn-error | wrapper-timeout | unknown
  // retryOnce=true 时首次失败会等待 getRetryDelayMs() 后重发一次(最多 2 次), 返回最后一次结果
  // level: Bark 通知级别(active/timeSensitive/passive/critical), 省略则由脚本默认 timeSensitive
  // logKey: 事件去重键, 只用于 bark.log 行尾标注(便于追溯是哪个事件)
  notify({ title, body, group, label, level, logKey } = {}) {
    const labelText = label || '-';

    if (!this.isEnabled()) {
      return Promise.resolve({ ok: false, reason: 'disabled', elapsedMs: 0 });
    }

    if (this.platform !== 'win32') {
      this.log('info', '[NOTIFY] bark push skipped (non-windows platform)');
      return Promise.resolve({ ok: false, reason: 'non-windows', elapsedMs: 0 });
    }

    const maxAttempts = this.getMaxAttempts();

    const run = async () => {
      let result = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        result = await this.attemptPush({ title, body, group, label: labelText, level, logKey, attempt, maxAttempts });
        if (result.ok || attempt >= maxAttempts) {
          break;
        }
        this.log('warn', `[NOTIFY] bark push retry scheduled attempt=${attempt + 1}/${maxAttempts} reason=${result.reason}`);
        await sleep(this.getRetryDelayMs());
      }

      this.recordPushOutcome(result.ok === true, result.reason);
      return result;
    };

    return run();
  }

  // 单次推送尝试
  attemptPush({ title, body, group, label, level, logKey, attempt, maxAttempts } = {}) {
    const startedAt = Date.now();
    const labelText = label || '-';
    const attemptSuffix = maxAttempts > 1 ? ` attempt=${attempt}/${maxAttempts}` : '';
    const keySuffix = logKey ? ` key=${logKey}` : '';

    return new Promise((resolve) => {
      const scriptPath = this.resolvePath(this.config.scriptPath, DEFAULT_SCRIPT_PATH);
      const envPath = this.resolvePath(this.config.envPath, DEFAULT_ENV_PATH);
      const args = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-EnvPath', envPath,
        '-Title', String(title || 'MULTIBOT Downdetector'),
        '-Body', String(body || ''),
        '-Group', String(group || this.config.group || DEFAULT_GROUP)
      ];
      if (level) {
        args.push('-Level', String(level));
      }

      let child;
      try {
        child = this.spawnFn('powershell.exe', args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        this.log('warn', `[NOTIFY] bark push spawn failed: ${error && error.message ? error.message : error}`);
        this.appendLog(`${getTimestamp()} [FAIL] label=${labelText} reason=spawn-error elapsed=${elapsedMs}ms${attemptSuffix}${keySuffix}`);
        resolve({ ok: false, reason: 'spawn-error', elapsedMs });
        return;
      }

      if (!child || typeof child.on !== 'function') {
        resolve({ ok: false, reason: 'spawn-error', elapsedMs: Date.now() - startedAt });
        return;
      }

      const timeoutMs = Number.isFinite(Number(this.config.timeoutMs)) && Number(this.config.timeoutMs) > 0
        ? Number(this.config.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

      let output = '';
      const capture = (chunk) => {
        if (output.length >= MAX_CAPTURED_OUTPUT) return;
        output += String(chunk);
      };
      if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', capture);
      if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', capture);

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timer = setTimeout(() => {
        try { child.kill(); } catch (error) { /* ignore */ }
        const elapsedMs = Date.now() - startedAt;
        this.log('warn', '[NOTIFY] bark push timed out');
        this.appendLog(`${getTimestamp()} [FAIL] label=${labelText} reason=wrapper-timeout elapsed=${elapsedMs}ms${attemptSuffix}${keySuffix}`);
        finish({ ok: false, reason: 'wrapper-timeout', elapsedMs });
      }, timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        const elapsedMs = Date.now() - startedAt;
        this.log('warn', `[NOTIFY] bark push error: ${error && error.message ? error.message : error}`);
        this.appendLog(`${getTimestamp()} [FAIL] label=${labelText} reason=spawn-error elapsed=${elapsedMs}ms${attemptSuffix}${keySuffix}`);
        finish({ ok: false, reason: 'spawn-error', elapsedMs });
      });

      child.on('close', () => {
        clearTimeout(timer);
        const elapsedMs = Date.now() - startedAt;
        const ok = /\[OK\//.test(output);
        // 只取脚本给出的脱敏分类, 不记录脚本输出原文(可能含 URL 前缀等秘密)
        const reasonMatch = output.match(/reason=([a-z0-9-]+)/i);
        const reason = ok ? null : (reasonMatch ? reasonMatch[1].toLowerCase() : 'unknown');
        this.appendLog(
          `${getTimestamp()} [${ok ? 'OK' : 'FAIL'}] label=${labelText}${ok ? '' : ` reason=${reason}`} elapsed=${elapsedMs}ms${attemptSuffix}${keySuffix}`
        );
        finish({ ok, reason, elapsedMs });
      });
    });
  }
}

module.exports = {
  BarkNotifier,
  SEVERITY_LEVELS,
  EVENT_COOLDOWN_DEFAULTS,
  DEFAULT_SCRIPT_PATH,
  DEFAULT_ENV_PATH,
  DEFAULT_GROUP,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_LOG_PATH,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_EVENT_COOLDOWN_MS,
  DEFAULT_MAX_PER_HOUR
};
