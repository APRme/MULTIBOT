// Bark 推送封装: 调用 src/notifications/bark/bark-push.ps1 发送手机通知。
// 设计约束:
//  - 密钥只存在于 .env, 由 PowerShell 脚本自行读取; Node 侧不解析/不记录任何凭据
//  - 脚本输出可能包含 URL/前缀等秘密(失败信息), 故只提取 [OK/...]/[FAIL] 状态关键字,
//    绝不把脚本 stdout/stderr 原文写入日志
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SCRIPT_PATH = './src/notifications/bark/bark-push.ps1';
const DEFAULT_ENV_PATH = './.env';
const DEFAULT_GROUP = 'mc';
const DEFAULT_COOLDOWN_MS = 600000;
const DEFAULT_TIMEOUT_MS = 25000;
const MAX_CAPTURED_OUTPUT = 8192;

class BarkNotifier {
  constructor(options = {}) {
    this.config = options.config || {};
    this.logger = options.logger || null;
    this.appRoot = options.appRoot || process.cwd();
    this.spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
    this.platform = options.platform || process.platform;
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  getCooldownMs() {
    const value = Number(this.config.cooldownMs);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_COOLDOWN_MS;
  }

  resolvePath(value, fallback) {
    const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    return path.isAbsolute(raw) ? raw : path.resolve(this.appRoot, raw);
  }

  log(level, message) {
    if (!this.logger || typeof this.logger[level] !== 'function') {
      return;
    }
    this.logger[level](message);
  }

  // 返回 Promise<boolean>: true = 脚本报告 [OK/https]; false = 未启用/平台不支持/失败
  notify({ title, body, group } = {}) {
    return new Promise((resolve) => {
      if (!this.isEnabled()) {
        resolve(false);
        return;
      }

      if (this.platform !== 'win32') {
        this.log('info', '[NOTIFY] bark push skipped (non-windows platform)');
        resolve(false);
        return;
      }

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
        this.log('warn', `[NOTIFY] bark push spawn failed: ${error && error.message ? error.message : error}`);
        resolve(false);
        return;
      }

      if (!child || typeof child.on !== 'function') {
        resolve(false);
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
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const timer = setTimeout(() => {
        try { child.kill(); } catch (error) { /* ignore */ }
        this.log('warn', '[NOTIFY] bark push timed out');
        finish(false);
      }, timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        this.log('warn', `[NOTIFY] bark push error: ${error && error.message ? error.message : error}`);
        finish(false);
      });

      child.on('close', () => {
        clearTimeout(timer);
        // 只取状态关键字, 不记录脚本输出原文(可能含 URL 前缀等秘密)
        finish(/\[OK\//.test(output));
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
  DEFAULT_TIMEOUT_MS
};
