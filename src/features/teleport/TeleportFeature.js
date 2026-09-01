const fs = require('fs');
const path = require('path');

class TeleportFeature {
  constructor(options = {}) {
    this.bot = null;
    this.logger = options.logger;
    this.config = options.config || {};
    this.paths = options.paths || {};
    this.lockFeature = options.lockFeature;
    this.trustedPlayersStore = options.trustedPlayersStore || null;
    this.whitelistEntries = [];
    this.whitelistLoadedAt = null;
    this.whitelistWatcher = null;
    this.whitelistWatchTarget = null;
    this.whitelistRefreshDebounceTimer = null;
  }

  attach(bot) {
    this.bot = bot;
  }

  start() {
    this.stop();
    this.refreshWhitelist();
    this.startWhitelistWatcher();
  }

  stop() {
    if (this.whitelistWatcher) {
      this.whitelistWatcher.close();
      this.whitelistWatcher = null;
    }

    if (this.whitelistRefreshDebounceTimer) {
      clearTimeout(this.whitelistRefreshDebounceTimer);
      this.whitelistRefreshDebounceTimer = null;
    }

    this.whitelistWatchTarget = null;
  }

  detach() {
    this.stop();
    this.bot = null;
  }

  isTrustedPlayer(sender) {
    if (this.trustedPlayersStore && typeof this.trustedPlayersStore.isTrustedPlayer === 'function') {
      return this.trustedPlayersStore.isTrustedPlayer(sender);
    }

    const name = String(sender || '').toLowerCase();
    const trustedPlayers = Array.isArray(this.config.trustedPlayers) ? this.config.trustedPlayers : [];
    return trustedPlayers.some((player) => String(player).toLowerCase() === name);
  }

  getWhitelistPath() {
    const teleportConfig = this.config.teleport || {};
    const whitelistFile = teleportConfig.whitelistFile || 'whitelist.txt';
    return path.resolve(this.paths.accountDir || process.cwd(), whitelistFile);
  }

  readWhitelistFile() {
    const whitelistPath = this.getWhitelistPath();
    if (!fs.existsSync(whitelistPath)) {
      return [];
    }

    return Array.from(new Set(
      fs.readFileSync(whitelistPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    ));
  }

  refreshWhitelist() {
    this.whitelistEntries = this.readWhitelistFile();
    this.whitelistLoadedAt = new Date().toISOString();

    if (this.logger) {
      this.logger.info(`[TPA] whitelist refreshed count=${this.whitelistEntries.length}`);
    }

    return this.getWhitelistInfo();
  }

  scheduleWhitelistRefresh(reason = 'watch') {
    if (this.whitelistRefreshDebounceTimer) {
      clearTimeout(this.whitelistRefreshDebounceTimer);
    }

    this.whitelistRefreshDebounceTimer = setTimeout(() => {
      this.whitelistRefreshDebounceTimer = null;
      try {
        this.refreshWhitelist();
      } catch (error) {
        if (this.logger) {
          this.logger.warn(`[TPA] whitelist ${reason} refresh failed: ${error.message}`);
        }
      }
    }, 100);
  }

  startWhitelistWatcher() {
    const whitelistPath = this.getWhitelistPath();
    const watchTarget = path.dirname(whitelistPath);

    if (!fs.existsSync(watchTarget)) {
      if (this.logger) {
        this.logger.warn(`[TPA] whitelist watch target missing: ${watchTarget}`);
      }
      return;
    }

    const whitelistBaseName = path.basename(whitelistPath).toLowerCase();
    try {
      this.whitelistWatchTarget = watchTarget;
      this.whitelistWatcher = fs.watch(watchTarget, (eventType, filename) => {
        const normalizedFileName = typeof filename === 'string' ? filename.trim().toLowerCase() : '';
        if (normalizedFileName && normalizedFileName !== whitelistBaseName) {
          return;
        }

        if (eventType === 'rename' || eventType === 'change' || !eventType) {
          this.scheduleWhitelistRefresh('watch');
        }
      });

      this.whitelistWatcher.on('error', (error) => {
        if (this.logger) {
          this.logger.warn(`[TPA] whitelist watch failed: ${error.message}`);
        }
      });
    } catch (error) {
      this.whitelistWatchTarget = null;
      this.whitelistWatcher = null;
      if (this.logger) {
        this.logger.warn(`[TPA] unable to watch whitelist: ${error.message}`);
      }
    }
  }

  getWhitelistInfo() {
    return {
      count: this.whitelistEntries.length,
      loadedAt: this.whitelistLoadedAt,
      entries: this.whitelistEntries.slice()
    };
  }

  getWhitelistEntries() {
    if (!this.whitelistLoadedAt) {
      this.refreshWhitelist();
    }

    return this.whitelistEntries.slice();
  }

  acceptTeleport(sender, reason = 'allowed') {
    if (this.logger) {
      this.logger.info(`[TPA] 接受 ${sender} 的传送请求，原因: ${reason}`);
    }
    if (!this.bot) return;
    this.bot.chat('/tpaccept');
    this.bot.chat(`/minecraft:w ${sender} 已接受你的传送请求。`);
  }

  denyTeleport(sender, reason = 'denied') {
    if (this.logger) {
      this.logger.info(`[TPA] 拒绝 ${sender || '未知玩家'} 的传送请求，原因: ${reason}`);
    }
    if (!this.bot) return;
    this.bot.chat('/tpdeny');
  }

  handleTeleportRequest(sender) {
    const teleportConfig = this.config.teleport || {};
    const mode = String(teleportConfig.mode || 'whitelist').toLowerCase();

    if (mode === 'all') {
      this.acceptTeleport(sender, 'teleport.mode=all');
      return;
    }

    if (mode === 'trustedplayers' || mode === 'trusted_players') {
      if (this.isTrustedPlayer(sender)) {
        this.acceptTeleport(sender, '信任玩家');
      } else {
        this.denyTeleport(sender, '不在信任玩家列表');
      }
      return;
    }

    const whitelist = this.getWhitelistEntries();
    const allowed = whitelist.some((player) => String(player).toLowerCase() === String(sender).toLowerCase());
    if (allowed) {
      this.acceptTeleport(sender, '白名单');
    } else {
      this.denyTeleport(sender, '不在白名单');
    }
  }

  handleTeleportHereRequest(sender) {
    if (!this.isTrustedPlayer(sender)) {
      this.denyTeleport(sender, '不在信任玩家列表');
      return;
    }

    const lockStatus = this.lockFeature ? this.lockFeature.getTeleportLockStatus() : { locked: false };
    if (!lockStatus.locked || (this.lockFeature && this.lockFeature.isTeleportLockOwner(sender))) {
      this.acceptTeleport(sender, lockStatus.locked ? '信任玩家且为锁定人' : '信任玩家且未锁定');
      return;
    }

    this.denyTeleport(sender, `传送锁定，锁定人=${lockStatus.owner} 原因=${lockStatus.reason}`);
    if (this.bot) {
      this.bot.chat(
        `/minecraft:w ${sender} 已锁定，锁定人: ${lockStatus.owner} 原因: ${lockStatus.reason} 剩余锁定时间: ${lockStatus.remainingText}`
      );
    }

    if (this.logger) {
      this.logger.info(
        `[TPAHERE] denied by lock sender=${sender} owner=${lockStatus.owner} reason=${lockStatus.reason}`
      );
    }
  }
}

module.exports = {
  TeleportFeature
};
