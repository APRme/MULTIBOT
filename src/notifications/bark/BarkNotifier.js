// Bark 推送封装: 调用 src/notifications/bark/bark-push.ps1 发送手机通知。
// 设计约束:
//  - 密钥只存在于 .env, 由 PowerShell 脚本自行读取; Node 侧不解析/不记录任何凭据
//  - 脚本输出可能包含 URL/前缀等秘密(异常原文), 故只提取 [OK/...]/[FAIL] 与脱敏的
//    reason=<分类> / elapsed, 绝不把脚本 stdout/stderr 原文写入日志
//  - 每次尝试(成功/失败)追加一行到 logs/bark.log(同样只含 label/reason/elapsed, 无秘密)
//  - 可选 retryOnce: 首次失败后等待 retryDelayMs 再重发一次(共 2 次), 每次尝试各记一行
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getTimestamp, sleep } = require('../../util/time');

const DEFAULT_SCRIPT_PATH = './src/notifications/bark/bark-push.ps1';
const DEFAULT_ENV_PATH = './.env';
const DEFAULT_GROUP = 'mc';
const DEFAULT_COOLDOWN_MS = 600000;
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_LOG_PATH = './logs/bark.log';
const DEFAULT_RETRY_DELAY_MS = 2000;
const MAX_CAPTURED_OUTPUT = 8192;

class BarkNotifier {
  constructor(options = {}) {
    this.config = options.config || {};
    this.logger = options.logger || null;
    this.appRoot = options.appRoot || process.cwd();
    this.spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
    this.platform = options.platform || process.platform;
    this.retryDelayMs = options.retryDelayMs;
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
  //  reason: null(成功) | 脚本给出的脱敏分类(timeout/http-401/tls-fail/...) |
  //          disabled | non-windows | spawn-error | wrapper-timeout | unknown
  // retryOnce=true 时首次失败会等待 getRetryDelayMs() 后重发一次(最多 2 次), 返回最后一次结果
  notify({ title, body, group, label } = {}) {
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
        result = await this.attemptPush({ title, body, group, label: labelText, attempt, maxAttempts });
        if (result.ok || attempt >= maxAttempts) {
          break;
        }
        this.log('warn', `[NOTIFY] bark push retry scheduled attempt=${attempt + 1}/${maxAttempts} reason=${result.reason}`);
        await sleep(this.getRetryDelayMs());
      }

      return result;
    };

    return run();
  }

  // 单次推送尝试
  attemptPush({ title, body, group, label, attempt, maxAttempts } = {}) {
    const startedAt = Date.now();
    const labelText = label || '-';
    const attemptSuffix = maxAttempts > 1 ? ` attempt=${attempt}/${maxAttempts}` : '';

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

      let child;
      try {
        child = this.spawnFn('powershell.exe', args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        this.log('warn', `[NOTIFY] bark push spawn failed: ${error && error.message ? error.message : error}`);
        this.appendLog(`${getTimestamp()} [FAIL] label=${labelText} reason=spawn-error elapsed=${elapsedMs}ms${attemptSuffix}`);
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
        this.appendLog(`${getTimestamp()} [FAIL] label=${labelText} reason=wrapper-timeout elapsed=${elapsedMs}ms${attemptSuffix}`);
        finish({ ok: false, reason: 'wrapper-timeout', elapsedMs });
      }, timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        const elapsedMs = Date.now() - startedAt;
        this.log('warn', `[NOTIFY] bark push error: ${error && error.message ? error.message : error}`);
        this.appendLog(`${getTimestamp()} [FAIL] label=${labelText} reason=spawn-error elapsed=${elapsedMs}ms${attemptSuffix}`);
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
          `${getTimestamp()} [${ok ? 'OK' : 'FAIL'}] label=${labelText}${ok ? '' : ` reason=${reason}`} elapsed=${elapsedMs}ms${attemptSuffix}`
        );
        finish({ ok, reason, elapsedMs });
      });
    });
  }
}

module.exports = {
  BarkNotifier,
  DEFAULT_SCRIPT_PATH,
  DEFAULT_ENV_PATH,
  DEFAULT_GROUP,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_LOG_PATH,
  DEFAULT_RETRY_DELAY_MS
};
