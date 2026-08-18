function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FishFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.autoStartEnabled = options.autoStartEnabled === true;
    this.autoStartDelayMs = Number.isFinite(options.autoStartDelayMs) ? options.autoStartDelayMs : 10000;
    this.createAutoContext = options.createAutoContext || (() => null);
    this.bot = null;
    this.isFishing = false;
    this.bobberUuid = null;
    this.bobberInitialY = null;
    this.monitorInterval = null;
    this.timeoutId = null;
    this.recastTimer = null;
    this.autoStartTimer = null;
    this.sinkThreshold = -0.3;
    this.fishingTimeoutMs = 60000;
    this.recastDelayMs = 1000;
  }

  attach(bot) {
    this.stop();
    this.bot = bot;
  }

  handleSpawn() {
    if (!this.autoStartEnabled) return;
    if (!this.bot) return;

    if (this.autoStartTimer) {
      clearTimeout(this.autoStartTimer);
      this.autoStartTimer = null;
    }

    this.autoStartTimer = setTimeout(() => {
      this.autoStartTimer = null;
      if (this.isFishing) return;

      const context = this.createAutoContext();
      if (!context) return;

      void this.handleFishCommand(context).catch((error) => {
        if (this.logger) {
          this.logger.warn('[FISH] auto start failed', error.message);
        }
      });
    }, this.autoStartDelayMs);
  }

  ensureReady() {
    if (!this.bot) {
      throw new Error('fish feature not attached');
    }
  }

  async handleFishCommand(context) {
    this.ensureReady();

    if (this.isFishing) {
      this.stopFishing();
      context.replyInfo('已停止钓鱼');
      return true;
    }

    try {
      const fishingRodId = this.bot.registry.itemsByName.fishing_rod?.id;
      if (!fishingRodId) {
        throw new Error('无法识别钓鱼竿物品ID');
      }
      await this.bot.equip(fishingRodId, 'hand');
    } catch (error) {
      context.replyError(`装备失败: ${error.message}`);
      return true;
    }

    this.isFishing = true;
    context.replyInfo('开始钓鱼');

    try {
      await this.castLine();
      this.scheduleMonitoring(2000);
    } catch (error) {
      this.stopFishing();
      context.replyError(`抛竿失败: ${error.message}`);
    }

    return true;
  }

  async castLine() {
    return new Promise((resolve, reject) => {
      this.bot.activateItem();

      const timeoutId = setTimeout(() => {
        this.bot.removeListener('entitySpawn', onEntitySpawn);
        reject(new Error('浮漂生成超时'));
      }, 5000);

      const onEntitySpawn = (entity) => {
        if (entity.name !== 'fishing_bobber') return;

        let ownerId = null;
        if (Array.isArray(entity.metadata)) {
          for (const meta of entity.metadata) {
            if (typeof meta === 'number' && meta > 0) {
              ownerId = meta;
              break;
            }
          }
        }

        const closeEnough = this.bot.entity && this.bot.entity.position.distanceTo(entity.position) < 3;
        if (ownerId === this.bot.entity.id || closeEnough) {
          clearTimeout(timeoutId);
          this.bot.removeListener('entitySpawn', onEntitySpawn);
          this.bobberUuid = entity.uuid;
          this.bobberInitialY = entity.position.y;
          resolve();
        }
      };

      this.bot.on('entitySpawn', onEntitySpawn);
    });
  }

  scheduleMonitoring(delayMs = 2000) {
    if (this.recastTimer) {
      clearTimeout(this.recastTimer);
      this.recastTimer = null;
    }

    this.recastTimer = setTimeout(() => {
      this.recastTimer = null;
      this.startMonitor();
      this.startTimeout();
    }, delayMs);
  }

  startMonitor() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    if (this.bobberUuid) {
      const bobber = Object.values(this.bot.entities || {}).find((entity) => entity.uuid === this.bobberUuid);
      if (bobber) {
        this.bobberInitialY = bobber.position.y;
      }
    }

    this.monitorInterval = setInterval(() => {
      if (!this.isFishing) return;

      if (!this.bobberUuid) {
        this.stopMonitor();
        void this.attemptRecast();
        return;
      }

      const bobber = Object.values(this.bot.entities || {}).find((entity) => entity.uuid === this.bobberUuid);
      if (!bobber) {
        this.bobberUuid = null;
        return;
      }

      const yDiff = bobber.position.y - this.bobberInitialY;
      if (yDiff < this.sinkThreshold) {
        this.bot.activateItem();
        this.stopMonitor();
        this.clearTimeout();
        this.bobberUuid = null;
        this.scheduleRecast();
      }
    }, 200);
  }

  startTimeout() {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      this.stopMonitor();
      this.bobberUuid = null;
      void this.attemptRecast();
    }, this.fishingTimeoutMs);
  }

  scheduleRecast() {
    if (!this.isFishing) return;

    this.recastTimer = setTimeout(() => {
      this.recastTimer = null;
      void this.attemptRecast();
    }, this.recastDelayMs);
  }

  async attemptRecast() {
    if (!this.isFishing) return;

    try {
      await this.castLine();
      this.scheduleMonitoring(2000);
    } catch (error) {
      if (this.logger) {
        this.logger.warn('[FISH] recast failed', error.message);
      }
      this.scheduleRecast();
    }
  }

  stopMonitor() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  clearTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  stopFishing() {
    this.stopMonitor();
    this.clearTimeout();
    if (this.autoStartTimer) {
      clearTimeout(this.autoStartTimer);
      this.autoStartTimer = null;
    }
    if (this.recastTimer) {
      clearTimeout(this.recastTimer);
      this.recastTimer = null;
    }

    if (this.isFishing && this.bobberUuid) {
      try {
        this.bot.activateItem();
      } catch (error) {
      }
    }

    this.isFishing = false;
    this.bobberUuid = null;
    this.bobberInitialY = null;
  }

  stop() {
    this.stopFishing();
  }

  detach() {
    this.stop();
    this.bot = null;
  }

  getState() {
    return {
      isFishing: this.isFishing
    };
  }
}

module.exports = {
  FishFeature
};
