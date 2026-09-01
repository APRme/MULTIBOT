const { Vec3 } = require('vec3');

class BlockUseFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.bot = null;
    this.continuousPlacement = {
      enabled: false,
      targetPos: null,
      intervalId: null,
      context: null
    };
  }

  attach(bot) {
    this.stop();
    this.bot = bot;
  }

  stop() {
    if (this.continuousPlacement.intervalId) {
      clearInterval(this.continuousPlacement.intervalId);
    }

    this.continuousPlacement = {
      enabled: false,
      targetPos: null,
      intervalId: null,
      context: null
    };
  }

  detach() {
    this.stop();
    this.bot = null;
  }

  ensureBotReady() {
    if (!this.bot || !this.bot.entity) {
      throw new Error('bot not connected');
    }
  }

  async lookAtBlock(block) {
    const blockCenter = block.position.offset(0.5, 0.5, 0.5);
    const delta = blockCenter.minus(this.bot.entity.position);
    const yaw = Math.atan2(-delta.x, -delta.z);
    const horizontalDistance = Math.sqrt((delta.x * delta.x) + (delta.z * delta.z));
    const pitch = Math.atan2(delta.y, horizontalDistance);
    await this.bot.look(yaw, pitch, false);
  }

  async handleUseBlockCommand(context, x, y, z) {
    this.ensureBotReady();

    try {
      const targetBlock = this.bot.blockAt(new Vec3(x, y, z));
      if (!targetBlock) {
        context.replyError(`错误：在坐标 (${x}, ${y}, ${z}) 找不到方块`);
        return true;
      }

      await this.lookAtBlock(targetBlock);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await this.bot.activateBlock(targetBlock);

      if (this.logger) {
        this.logger.info(`[BLOCK_USE] activated ${targetBlock.name} x=${x} y=${y} z=${z}`);
      }

      context.replyInfo(`已尝试与方块交互: ${targetBlock.name} (${x}, ${y}, ${z})`);
    } catch (error) {
      context.replyError(`方块交互失败: ${error.message}`);
    }

    return true;
  }

  handleContinuousUseBlockCommand(context, x, y, z) {
    this.ensureBotReady();

    if (this.continuousPlacement.enabled) {
      this.stopContinuousPlacement(this.continuousPlacement.context || context);
    }

    const targetPos = new Vec3(x, y, z);
    const distance = this.bot.entity.position.distanceTo(targetPos);
    if (distance > 5) {
      context.replyError(`距离目标太远 (${distance.toFixed(1)} 格)，请先靠近`);
      return true;
    }

    const intervalId = setInterval(() => {
      void this.attemptPlaceBlockAt(targetPos).catch((error) => {
        if (this.logger) {
          this.logger.warn('[BLOCK_USE] continuous placement failed', error.message);
        }
      });
    }, 500);

    this.continuousPlacement = {
      enabled: true,
      targetPos,
      intervalId,
      context
    };

    if (this.logger) {
      this.logger.info(`[BLOCK_USE] start continuous placement x=${x} y=${y} z=${z}`);
    }

    context.replyInfo(`已开始持续在 (${x}, ${y}, ${z}) 放置方块`);
    return true;
  }

  stopContinuousPlacement(context = this.continuousPlacement.context) {
    if (this.continuousPlacement.enabled) {
      if (this.continuousPlacement.intervalId) {
        clearInterval(this.continuousPlacement.intervalId);
      }

      this.continuousPlacement = {
        enabled: false,
        targetPos: null,
        intervalId: null,
        context: null
      };

      if (this.logger) {
        this.logger.info('[BLOCK_USE] stop continuous placement');
      }

      if (context) {
        context.replyInfo('已停止持续放置方块');
      }
    } else if (context) {
      context.replyInfo('当前没有在进行持续放置');
    }

    return true;
  }

  canReplaceBlock(block) {
    if (!block) return true;

    const blockName = String(block.name || '').toLowerCase();
    if (blockName.includes('air')) return true;
    if (blockName.includes('water') || blockName.includes('lava')) return true;
    if (blockName.includes('grass') || blockName.includes('fern') || blockName.includes('bush') || blockName.includes('vine')) return true;
    if (blockName.includes('snow')) return true;

    return block.boundingBox === 'empty' || block.boundingBox === null;
  }

  findAdjacentSolidBlock(x, y, z) {
    const directions = [
      new Vec3(0, 1, 0),
      new Vec3(0, -1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1)
    ];

    let bestBlock = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const dir of directions) {
      const checkPos = new Vec3(x, y, z).plus(dir);
      const block = this.bot.blockAt(checkPos);
      if (!block) continue;
      if (block.boundingBox !== 'block') continue;

      const name = String(block.name || '').toLowerCase();
      if (name.includes('air') || name.includes('water') || name.includes('lava')) continue;

      const distance = this.bot.entity.position.distanceTo(checkPos);
      if (distance < bestDistance) {
        bestBlock = block;
        bestDistance = distance;
      }
    }

    return bestBlock;
  }

  calculateFaceVector(referenceBlock, targetPos) {
    return new Vec3(
      targetPos.x - referenceBlock.position.x,
      targetPos.y - referenceBlock.position.y,
      targetPos.z - referenceBlock.position.z
    );
  }

  async attemptPlaceBlockAt(targetPos) {
    this.ensureBotReady();

    const targetBlock = this.bot.blockAt(targetPos);
    if (targetBlock && !this.canReplaceBlock(targetBlock)) {
      return false;
    }

    if (!this.bot.heldItem) {
      return false;
    }

    const referenceBlock = this.findAdjacentSolidBlock(targetPos.x, targetPos.y, targetPos.z);
    if (!referenceBlock) {
      return false;
    }

    const faceVector = this.calculateFaceVector(referenceBlock, targetPos);
    await this.bot.placeBlock(referenceBlock, faceVector);
    return true;
  }
}

module.exports = {
  BlockUseFeature
};
