const path = require('path');
const { requireFresh } = require('../../util/requireFresh');

class CplaceFeature {
  constructor(options = {}) {
    this.paths = options.paths || {};
    this.logger = options.logger;
    this.impl = null;
  }

  attach(bot) {
    this.stop();
    const legacyModulesDir = this.paths.legacyModulesDir || path.resolve(__dirname, '..', '..', 'legacy', 'assn');
    const modulePath = path.join(legacyModulesDir, 'cplace.js');
    this.impl = requireFresh(modulePath);
    this.impl.initCplace(bot);
  }

  async handleCommand(context, trimmed) {
    if (!this.impl) {
      context.replyError('cplace 模块未初始化');
      return true;
    }

    await this.impl.handleCplaceCommand(context, trimmed);
    return true;
  }

  async handleStopCommand(context) {
    if (!this.impl) {
      context.replyError('cplace 模块未初始化');
      return true;
    }

    await this.impl.handleStopCplaceCommand(context);
    return true;
  }

  stop() {
    if (this.impl && typeof this.impl.stopContinuousPlacing === 'function') {
      this.impl.stopContinuousPlacing();
    }
  }

  detach() {
    if (this.impl && typeof this.impl.cleanupCplace === 'function') {
      this.impl.cleanupCplace();
    } else {
      this.stop();
    }

    this.impl = null;
  }
}

module.exports = {
  CplaceFeature
};
