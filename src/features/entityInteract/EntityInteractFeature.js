class EntityInteractFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.bot = null;
  }

  attach(bot) {
    this.bot = bot;
  }

  stop() {
    this.bot = null;
  }

  isInteractableEntity(entity) {
    if (!this.bot || !this.bot.entity || !entity || !entity.position) return false;
    if (entity === this.bot.entity) return false;
    if (entity.type === 'player') return false;
    if (entity.type === 'item' || entity.type === 'orb') return false;

    const distance = this.bot.entity.position.distanceTo(entity.position);
    if (!Number.isFinite(distance) || distance <= 0) return false;

    return true;
  }

  findNearestInteractable() {
    if (!this.bot || !this.bot.entity || typeof this.bot.nearestEntity !== 'function') {
      return null;
    }

    return this.bot.nearestEntity((entity) => this.isInteractableEntity(entity));
  }

  getEntityLabel(entity) {
    return entity && (entity.username || entity.displayName || entity.name || entity.id)
      ? entity.username || entity.displayName || entity.name || entity.id
      : '未知实体';
  }

  async interactTarget(target) {
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

    await this.bot.activateEntity(target);

    if (this.logger) {
      this.logger.info(`[INTERACT] target=${this.getEntityLabel(target)}`);
    }

    return true;
  }

  async handleInteractNearestCommand(context) {
    if (!this.bot || !this.bot.entity) {
      context.replyError('机器人尚未完全生成，无法与实体交互。');
      return true;
    }

    const target = this.findNearestInteractable();
    if (!target) {
      context.replyError('附近没有找到可右键交互的非玩家实体。');
      return true;
    }

    try {
      await this.interactTarget(target);
      context.replyInfo(`正在右键交互 ${this.getEntityLabel(target)}`);
    } catch (error) {
      context.replyError(`实体交互失败: ${error.message}`);
    }

    return true;
  }
}

module.exports = {
  EntityInteractFeature
};
