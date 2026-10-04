// 自动进食: 监听 health 事件(轻量模式同样加载 health 插件), 饱食度低于阈值时按配置挑食物,
// 复用 EatFeature 的进食核心(两种模式通用)。冲突时一律跳过, 不打断钓鱼/攻击/挖掘/开箱。
const DEFAULT_CONFIG = {
  enabled: false,
  threshold: 19,
  items: [],
  cooldownMs: 3000,
  failureBackoffMs: 30000,
  maxFailures: 3
};

const AUTO_PICK_LIMIT = 4;
const MIN_RETRY_DELAY_MS = 1000;

class AutoEatController {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    this.eatFeature = options.eatFeature || null;
    this.inventoryFeature = options.inventoryFeature || null;
    this.fishFeature = options.fishFeature || null;
    this.attackFeature = options.attackFeature || null;
    this.digFeature = options.digFeature || null;
    this.bot = null;
    this.enabled = this.config.enabled === true;
    this.eating = false;
    this.failures = 0;
    this.cooldownUntil = 0;
    this.lastItem = null;
    this.lastResult = null;
    this.retryTimer = null;
    this.listeners = [];
  }

  attach(bot, options = {}) {
    this.detach();
    this.bot = bot;
    if (!bot) return;

    this.addListener(bot, 'health', () => this.onHealth());
    this.addListener(bot, 'spawn', () => {
      this.resetConnectionState();
      void this.maybeEat('spawn');
    });
    this.addListener(bot, 'end', () => this.resetConnectionState());

    if (options.initialCheck !== false) {
      void this.maybeEat('attach');
    }
  }

  detach() {
    this.clearRetryTimer();

    for (const listener of this.listeners) {
      if (listener.target && typeof listener.target.removeListener === 'function') {
        listener.target.removeListener(listener.eventName, listener.handler);
      }
    }

    this.listeners = [];
    this.bot = null;
    this.eating = false;
    this.failures = 0;
    this.cooldownUntil = 0;
  }

  stop() {
    this.detach();
  }

  addListener(target, eventName, handler) {
    target.on(eventName, handler);
    this.listeners.push({ target, eventName, handler });
  }

  resetConnectionState() {
    this.clearRetryTimer();
    this.eating = false;
    this.failures = 0;
    this.cooldownUntil = 0;
  }

  clearRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  scheduleRetry(delayMs) {
    this.clearRetryTimer();
    const wait = Math.max(MIN_RETRY_DELAY_MS, Number(delayMs) || 0);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.maybeEat('retry');
    }, wait);
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref();
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled === true;
    if (this.enabled) {
      this.cooldownUntil = 0;
      this.failures = 0;
      void this.maybeEat('enabled');
    } else {
      this.clearRetryTimer();
    }
  }

  isEnabled() {
    return this.enabled;
  }

  getState() {
    return {
      enabled: this.enabled,
      threshold: this.config.threshold,
      items: Array.isArray(this.config.items) ? this.config.items : [],
      eating: this.eating,
      failures: this.failures,
      cooldownUntil: this.cooldownUntil,
      lastItem: this.lastItem,
      lastResult: this.lastResult
    };
  }

  onHealth() {
    if (!this.enabled) return;
    void this.maybeEat('health');
  }

  // 与其它操作冲突时跳过本次(不打断用户操作)
  isBusyWithOtherActivity() {
    if (!this.bot) return true;
    if (this.bot.currentWindow !== null && this.bot.currentWindow !== undefined) return true;
    if (this.bot.usingHeldItem === true) return true;

    if (this.fishFeature && typeof this.fishFeature.getState === 'function') {
      const state = this.fishFeature.getState();
      if (state && state.isFishing === true) return true;
    }

    for (const feature of [this.attackFeature, this.digFeature]) {
      if (!feature || typeof feature.getState !== 'function') continue;
      const state = feature.getState();
      if (!state) continue;
      if (state.isAttacking === true || state.attacking === true) return true;
      if (state.isDigging === true || state.digging === true) return true;
    }

    return false;
  }

  // 先按配置顺序; 配置为空或都找不到时, 从背包里的食物按"食物点数 > 饱和度"择优
  resolveFoodCandidates() {
    const configured = Array.isArray(this.config.items) ? this.config.items : [];
    const configuredHits = [];

    for (const itemId of configured) {
      const matches = this.findItem(itemId);
      if (matches.length > 0) {
        configuredHits.push({ itemId, source: 'config' });
      }
    }

    if (configuredHits.length > 0) {
      return configuredHits;
    }

    const foods = this.bot && this.bot.registry ? this.bot.registry.foodsByName : null;
    if (!foods) return [];

    const scored = [];
    for (const [name, food] of Object.entries(foods)) {
      if (this.findItem(name).length === 0) continue;
      scored.push({
        itemId: name,
        foodPoints: Number(food && food.foodPoints) || 0,
        saturation: Number(food && food.saturation) || 0
      });
    }

    scored.sort((a, b) => (b.foodPoints - a.foodPoints) || (b.saturation - a.saturation));
    return scored.slice(0, AUTO_PICK_LIMIT).map((entry) => ({ itemId: entry.itemId, source: 'auto' }));
  }

  findItem(itemId) {
    if (!this.inventoryFeature || typeof this.inventoryFeature.findItem !== 'function') return [];
    try {
      return this.inventoryFeature.findItem(itemId, true) || [];
    } catch (error) {
      return [];
    }
  }

  async maybeEat(trigger) {
    if (!this.enabled || !this.bot || !this.eatFeature) return;
    if (this.eating) return;
    if (Date.now() < this.cooldownUntil) return;

    const food = this.bot.food;
    if (!Number.isFinite(food) || food > this.config.threshold) return;
    if (Number.isFinite(this.bot.health) && this.bot.health <= 0) return;
    if (this.isBusyWithOtherActivity()) {
      this.scheduleRetry(this.config.cooldownMs);
      return;
    }

    const candidates = this.resolveFoodCandidates();
    if (candidates.length === 0) {
      this.lastResult = `no-food(food=${food})`;
      return;
    }

    this.eating = true;
    const before = food;

    try {
      for (const candidate of candidates) {
        const result = await this.eatFeature.consumeFromInventory(candidate.itemId);

        if (result.ok) {
          this.failures = 0;
          this.lastItem = candidate.itemId;
          this.lastResult = `ok item=${result.itemName} food ${before}->${this.bot ? this.bot.food : '?'} trigger=${trigger}`;
          this.cooldownUntil = Date.now() + Math.max(0, Number(this.config.cooldownMs) || 0);
          if (this.logger) {
            this.logger.info(`[EAT] auto done item=${candidate.itemId} food=${before}->${this.bot ? this.bot.food : '?'} source=${candidate.source}`);
          }
          return;
        }

        if (result.stage === 'full') {
          this.lastResult = `full item=${candidate.itemId}`;
          return;
        }

        this.lastResult = `fail item=${candidate.itemId} stage=${result.stage}`;
        if (this.logger) {
          this.logger.warn(`[EAT] auto failed item=${candidate.itemId} stage=${result.stage}`);
        }
      }

      this.failures += 1;
      if (this.failures >= this.config.maxFailures) {
        this.failures = 0;
        this.cooldownUntil = Date.now() + Math.max(0, Number(this.config.failureBackoffMs) || 0);
        if (this.logger) {
          this.logger.warn(`[EAT] auto 连续失败, 暂停 ${this.config.failureBackoffMs}ms`);
        }
        return;
      }

      this.scheduleRetry(this.config.cooldownMs);
    } catch (error) {
      this.failures += 1;
      this.lastResult = `error ${error && error.message ? error.message : error}`;
      if (this.logger) {
        this.logger.warn(`[EAT] auto error: ${error && error.message ? error.message : error}`);
      }
      this.scheduleRetry(this.config.cooldownMs);
    } finally {
      this.eating = false;
    }
  }
}

module.exports = {
  AutoEatController,
  DEFAULT_AUTO_EAT_CONFIG: DEFAULT_CONFIG
};
