class AttackFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.config = options.config || {};
    this.bot = null;
    this.attackIntervalId = null;
  }

  attach(bot) {
    this.stop();
    this.bot = bot;

    if (this.config.autoAttack === true) {
      this.startAutoAttack();
    }
  }

  stop() {
    if (this.attackIntervalId) {
      clearInterval(this.attackIntervalId);
      this.attackIntervalId = null;
    }

    this.bot = null;
  }

  getAttackIntervalMs() {
    const value = Number.parseInt(this.config.attackInterval, 10);
    return Number.isFinite(value) && value > 0 ? value : 2000;
  }

  getAttackRange() {
    const value = Number.parseFloat(this.config.attackRange);
    return Number.isFinite(value) && value > 0 ? value : 3;
  }

  getTargetFilter() {
    const targetFilter = this.config.targetFilter || {};
    return {
      excludePlayers: targetFilter.excludePlayers === true,
      excludeItems: targetFilter.excludeItems !== false,
      targetTypes: Array.isArray(targetFilter.targetTypes)
        ? targetFilter.targetTypes.map((value) => String(value).toLowerCase()).filter(Boolean)
        : []
    };
  }

  matchesTargetTypes(entity, targetTypes) {
    if (!targetTypes.length) return true;

    const entityType = String(entity.type || '').toLowerCase();
    const entityName = String(entity.name || '').toLowerCase();
    const entityDisplayName = String(entity.displayName || '').toLowerCase();

    return targetTypes.some((targetType) => {
      if (targetType === 'mob' || targetType === 'player' || targetType === 'object' || targetType === 'item' || targetType === 'orb') {
        return entityType === targetType;
      }

      return entityType === targetType || entityName === targetType || entityDisplayName === targetType;
    });
  }

  isAttackableEntity(entity) {
    if (!this.bot || !this.bot.entity || !entity || !entity.position) return false;
    if (entity === this.bot.entity) return false;

    const targetFilter = this.getTargetFilter();

    if (targetFilter.excludePlayers && entity.type === 'player') return false;
    if (targetFilter.excludeItems && (entity.type === 'orb' || entity.type === 'item')) return false;
    if (!this.matchesTargetTypes(entity, targetFilter.targetTypes)) return false;

    const distance = this.bot.entity.position.distanceTo(entity.position);
    if (distance > this.getAttackRange()) return false;

    if (entity.health !== undefined && entity.health <= 0) return false;

    return true;
  }

  findAttackableTarget() {
    if (!this.bot || !this.bot.entity || typeof this.bot.nearestEntity !== 'function') {
      return null;
    }

    return this.bot.nearestEntity((entity) => this.isAttackableEntity(entity));
  }

  async attackTarget(target) {
    if (!this.bot || !this.bot.entity) {
      throw new Error('bot not connected');
    }

    if (!target || !target.position) {
      throw new Error('target not found');
    }

    if (typeof this.bot.lookAt === 'function') {
      try {
        await this.bot.lookAt(target.position, true);
      } catch (error) {
      }
    }

    this.bot.attack(target);

    if (this.logger) {
      this.logger.info(`[ATTACK] target=${target.username || target.displayName || target.name || target.id}`);
    }

    return true;
  }

  startAutoAttack() {
    if (this.attackIntervalId) return;

    this.attackIntervalId = setInterval(() => {
      if (!this.bot || !this.bot.entity) return;

      const target = this.findAttackableTarget();
      if (!target) return;

      void this.attackTarget(target).catch((error) => {
        if (this.logger) {
          this.logger.warn('[ATTACK] auto attack failed', error.message);
        }
      });
    }, this.getAttackIntervalMs());
  }

  async handleAttackNearestCommand(context) {
    if (!this.bot || !this.bot.entity) {
      context.replyError('机器人尚未完全生成，无法攻击。');
      return true;
    }

    const target = this.findAttackableTarget();
    if (!target) {
      context.replyError('在攻击范围内没有找到可攻击的实体。');
      return true;
    }

    try {
      await this.attackTarget(target);
      context.replyInfo(`正在攻击 ${target.username || target.displayName || target.name || target.id}`);
    } catch (error) {
      context.replyError(`攻击失败: ${error.message}`);
    }

    return true;
  }
}

module.exports = {
  AttackFeature
};
