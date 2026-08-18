const path = require('path');
const { requireFresh } = require('../../util/requireFresh');

class VaultFeature {
  constructor(options = {}) {
    this.paths = options.paths || {};
    this.logger = options.logger;
    this.impl = null;
  }

  attach(bot) {
    this.stop();
    const legacyModulesDir = this.paths.legacyModulesDir || path.resolve(__dirname, '..', '..', 'legacy', 'assn');
    const modulePath = path.join(legacyModulesDir, 'trial.js');
    this.impl = requireFresh(modulePath);
    this.impl.initTrial(bot);
  }

  handleCommand(context) {
    if (!this.impl) {
      context.replyError('vault 模块未初始化');
      return;
    }

    this.impl.handleVaultCommand(context);
  }

  stop() {
    if (this.impl && typeof this.impl.cleanupTrial === 'function') {
      this.impl.cleanupTrial();
    }
    this.impl = null;
  }

  detach() {
    this.stop();
  }
}

module.exports = {
  VaultFeature
};
