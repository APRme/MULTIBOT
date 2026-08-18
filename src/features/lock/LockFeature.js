const fs = require('fs');
const path = require('path');
const { formatDuration } = require('../../util/time');

class LockFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.lockHistoryPath = options.lockHistoryPath || path.join(process.cwd(), 'lock_history.txt');
    this.activeTeleportLock = null;
    this.activeTeleportLockTimer = null;
  }

  start() {
    this.loadTeleportLockFromHistory();
  }

  stop() {
    if (this.activeTeleportLockTimer) {
      clearTimeout(this.activeTeleportLockTimer);
      this.activeTeleportLockTimer = null;
    }
  }

  parseLockDuration(text) {
    const normalized = typeof text === 'string' ? text.trim().toLowerCase() : '';
    const match = normalized.match(/^([1-9]\d*)([smhd])$/);
    if (!match) return null;

    const count = Number.parseInt(match[1], 10);
    const unit = match[2];
    const multipliers = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000
    };

    return count * multipliers[unit];
  }

  formatLockRemaining(ms) {
    return formatDuration(ms);
  }

  appendLockHistory(event) {
    fs.mkdirSync(path.dirname(this.lockHistoryPath), { recursive: true });
    fs.appendFileSync(this.lockHistoryPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  scheduleTeleportLockExpiry() {
    if (this.activeTeleportLockTimer) {
      clearTimeout(this.activeTeleportLockTimer);
      this.activeTeleportLockTimer = null;
    }

    if (!this.activeTeleportLock) return;

    const delay = Math.max(0, new Date(this.activeTeleportLock.expiresAt).getTime() - Date.now());
    this.activeTeleportLockTimer = setTimeout(() => {
      this.expireActiveTeleportLock('timer_expire');
    }, delay);
  }

  expireActiveTeleportLock(reason = 'timer_expire') {
    if (!this.activeTeleportLock) return false;

    const lock = this.activeTeleportLock;
    this.activeTeleportLock = null;
    if (this.activeTeleportLockTimer) {
      clearTimeout(this.activeTeleportLockTimer);
      this.activeTeleportLockTimer = null;
    }

    this.appendLockHistory({
      type: 'expire',
      lockId: lock.lockId,
      owner: lock.owner,
      actor: lock.owner,
      timestamp: new Date().toISOString(),
      reason,
      version: 1
    });

    if (this.logger) {
      this.logger.info(`[LOCK] expired owner=${lock.owner} reason=${lock.reason} mode=${reason}`);
    }

    return true;
  }

  unlockActiveTeleportLock(actor, reason = 'manual_unlock') {
    if (!this.activeTeleportLock) return false;

    const lock = this.activeTeleportLock;
    this.activeTeleportLock = null;
    if (this.activeTeleportLockTimer) {
      clearTimeout(this.activeTeleportLockTimer);
      this.activeTeleportLockTimer = null;
    }

    this.appendLockHistory({
      type: 'unlock',
      lockId: lock.lockId,
      owner: lock.owner,
      actor,
      timestamp: new Date().toISOString(),
      reason,
      version: 1
    });

    if (this.logger) {
      this.logger.info(`[LOCK] unlocked owner=${lock.owner} actor=${actor} reason=${reason}`);
    }

    return true;
  }

  getTeleportLockStatus(now = Date.now()) {
    if (!this.activeTeleportLock) {
      return {
        locked: false,
        owner: null,
        reason: null,
        expiresAt: null,
        remainingMs: 0,
        remainingText: '0s'
      };
    }

    const remainingMs = new Date(this.activeTeleportLock.expiresAt).getTime() - now;
    if (remainingMs <= 0) {
      this.expireActiveTeleportLock('timer_expire');
      return {
        locked: false,
        owner: null,
        reason: null,
        expiresAt: null,
        remainingMs: 0,
        remainingText: '0s'
      };
    }

    return {
      locked: true,
      owner: this.activeTeleportLock.owner,
      reason: this.activeTeleportLock.reason,
      expiresAt: this.activeTeleportLock.expiresAt,
      remainingMs,
      remainingText: this.formatLockRemaining(remainingMs)
    };
  }

  loadTeleportLockFromHistory() {
    if (!fs.existsSync(this.lockHistoryPath)) return;

    const lines = fs.readFileSync(this.lockHistoryPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    let currentLock = null;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'lock') {
          currentLock = {
            lockId: event.lockId,
            owner: event.owner,
            ownerLower: event.ownerLower,
            reason: event.reason,
            createdAt: event.createdAt,
            expiresAt: event.expiresAt,
            createdBy: event.actor || event.owner,
            source: event.source || 'whisper',
            version: event.version || 1
          };
          continue;
        }

        if (
          currentLock &&
          (event.type === 'unlock' || event.type === 'expire') &&
          event.lockId === currentLock.lockId
        ) {
          currentLock = null;
        }
      } catch (error) {
        if (this.logger) {
          this.logger.warn(`[LOCK] skip broken history line: ${error.message}`);
        }
      }
    }

    if (!currentLock) return;

    const expiresAtMs = new Date(currentLock.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) return;

    this.activeTeleportLock = currentLock;

    if (expiresAtMs <= Date.now()) {
      this.expireActiveTeleportLock('startup_expire');
      return;
    }

    this.scheduleTeleportLockExpiry();
    if (this.logger) {
      this.logger.info(`[LOCK] restored owner=${currentLock.owner} reason=${currentLock.reason}`);
    }
  }

  isTeleportLockOwner(sender) {
    if (!sender || !this.activeTeleportLock) return false;
    return String(sender).toLowerCase() === this.activeTeleportLock.ownerLower;
  }

  isReadOnlyInvCommand(parts) {
    if (!Array.isArray(parts) || String(parts[0] || '').toLowerCase() !== 'inv') return false;
    const subCommand = (parts[1] || '').toLowerCase();
    return ['', 'info', 'quickbar', 'qb', 'help'].includes(subCommand);
  }

  isBlockedSendDuringLock(parts) {
    if (!Array.isArray(parts) || String(parts[0] || '').toLowerCase() !== 'send') return false;
    const content = parts.slice(1).join(' ').trim();
    return content.startsWith('/');
  }

  isAllowedBroadcastCommandDuringLock(trimmed) {
    const normalized = String(trimmed || '').trim();
    if (!normalized) return false;

    const broadcastBody = normalized.replace(/^broadcast\s+/i, '').trim();
    if (!broadcastBody) return false;

    const parts = broadcastBody.split(/\s+/).filter(Boolean);
    const subCommand = String(parts[0] || '').toLowerCase();

    if (subCommand === 'send') {
      return true;
    }

    if (subCommand === 'inv') {
      return this.isReadOnlyInvCommand(parts);
    }

    if (subCommand === 'eat') {
      return false;
    }

    return false;
  }

  isAllowedWhisperCommandDuringLock(trimmed, parts) {
    const normalized = String(trimmed || '').trim().toLowerCase();
    const command = (parts[0] || '').toLowerCase();

    if (['health', 'recordstatus', 'getpos', 'stop', 'stopscript', 'unlock'].includes(command)) {
      return true;
    }

    if (normalized === 'entity list') {
      return true;
    }

    if (command === 'lock' && parts.length === 1) {
      return true;
    }

    if (command === 'inv') {
      return this.isReadOnlyInvCommand(parts);
    }

    if (command === 'send') {
      return !this.isBlockedSendDuringLock(parts);
    }

    if (command === 'broadcast') {
      return this.isAllowedBroadcastCommandDuringLock(trimmed);
    }

    return false;
  }

  shouldEnforceWhisperLock(context) {
    if (!context || context.source !== 'whisper' || !context.sender) return false;

    const status = this.getTeleportLockStatus();
    if (!status.locked) return false;

    return !this.isTeleportLockOwner(context.sender);
  }

  replyTeleportLockBlocked(context) {
    const status = this.getTeleportLockStatus();
    if (!status.locked) {
      context.replyInfo('当前未锁定');
      return;
    }

    context.replyInfo(
      `已锁定，锁定人: ${status.owner} 原因: ${status.reason} 剩余锁定时间: ${status.remainingText}`
    );
  }

  async handleLockCommand(context, parts) {
    if (String(parts[0] || '').toLowerCase() !== 'lock') return false;

    if (context.source !== 'whisper') {
      context.replyError('lock 仅允许管理员私聊使用');
      return true;
    }

    const currentStatus = this.getTeleportLockStatus();
    if (parts.length === 1) {
      context.replyInfo('用法: lock <1s|1m|1h|1d> <原因>');
      if (!currentStatus.locked) {
        context.replyInfo('当前未锁定');
      } else {
        this.replyTeleportLockBlocked(context);
      }
      return true;
    }

    const durationMs = this.parseLockDuration(parts[1]);
    if (!durationMs) {
      context.replyError('锁定时长格式错误，支持 1s / 1m / 1h / 1d');
      return true;
    }

    const reason = parts.slice(2).join(' ').trim();
    if (!reason) {
      context.replyError('用法: lock <1s|1m|1h|1d> <原因>');
      return true;
    }

    if (currentStatus.locked) {
      context.replyError(`当前已被 ${currentStatus.owner} 锁定，请先 unlock`);
      return true;
    }

    const owner = context.sender;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    const lock = {
      lockId: `${Date.now()}-${String(owner).toLowerCase()}`,
      owner,
      ownerLower: String(owner).toLowerCase(),
      reason,
      createdAt,
      expiresAt,
      createdBy: owner,
      source: 'whisper',
      version: 1
    };

    this.activeTeleportLock = lock;
    this.appendLockHistory({
      type: 'lock',
      lockId: lock.lockId,
      owner: lock.owner,
      ownerLower: lock.ownerLower,
      reason: lock.reason,
      createdAt: lock.createdAt,
      expiresAt: lock.expiresAt,
      actor: owner,
      source: 'whisper',
      version: 1
    });
    this.scheduleTeleportLockExpiry();

    const status = this.getTeleportLockStatus();
    if (this.logger) {
      this.logger.info(`[LOCK] created owner=${owner} reason=${reason} remaining=${status.remainingText}`);
    }
    context.replyInfo(`锁定成功，原因: ${reason} 剩余锁定时间: ${status.remainingText}`);
    return true;
  }

  async handleUnlockCommand(context, parts) {
    if (String(parts[0] || '').toLowerCase() !== 'unlock') return false;

    if (context.source !== 'whisper') {
      context.replyError('unlock 仅允许管理员私聊使用');
      return true;
    }

    const status = this.getTeleportLockStatus();
    if (!status.locked) {
      context.replyInfo('当前未锁定');
      return true;
    }

    this.unlockActiveTeleportLock(context.sender || context.label || 'unknown', 'manual_unlock');
    context.replyInfo('已解锁');
    return true;
  }
}

module.exports = {
  LockFeature
};
