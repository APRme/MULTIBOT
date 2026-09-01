const path = require('path');
const { requireFresh } = require('../../util/requireFresh');

class InventoryFeature {
  constructor(options = {}) {
    this.paths = options.paths || {};
    this.logger = options.logger;
    this.impl = null;
    this.bot = null;
  }

  attach(bot) {
    this.stop();
    this.bot = bot;
    const legacyModulesDir = this.paths.legacyModulesDir || path.resolve(__dirname, '..', '..', 'legacy', 'assn');
    const modulePath = path.join(legacyModulesDir, 'inv.js');
    this.impl = requireFresh(modulePath);
    this.impl.initInv(bot);
  }

  stop() {
    if (this.impl && typeof this.impl.cleanupInv === 'function') {
      this.impl.cleanupInv();
    }

    this.impl = null;
    this.bot = null;
  }

  async handleCommand(context, trimmed) {
    if (!this.impl) {
      context.replyError('inv 模块未初始化');
      return;
    }

    await this.impl.handleInvCommand(context, trimmed);
  }

  findItem(itemName, exactMatch = false) {
    if (!this.impl || typeof this.impl.findItem !== 'function') {
      return [];
    }

    return this.impl.findItem(itemName, exactMatch);
  }

  getQuickbarText() {
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) {
      return '快捷栏信息: 全部为空';
    }

    const hotbarStart = this.bot.inventory.hotbarStart ?? 36;
    const slotItems = [];

    for (let slot = 0; slot < 9; slot += 1) {
      const item = this.bot.inventory.slots[hotbarStart + slot];
      if (!item) continue;
      slotItems.push(`${slot + 1}:${item.name}`);
    }

    if (slotItems.length === 0) {
      return '快捷栏信息: 全部为空';
    }

    return `快捷栏信息: ${slotItems.join(' ')}`;
  }
}

module.exports = {
  InventoryFeature
};
