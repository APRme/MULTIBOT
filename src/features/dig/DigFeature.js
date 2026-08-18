const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder');
const { buildDefaultMovements } = require('../../util/pathfinding');
const { Vec3 } = require('vec3');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DigFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.areaDigDelayMs = Number.isFinite(options.areaDigDelayMs) ? options.areaDigDelayMs : 100;
    this.progressReportInterval = Number.isInteger(options.progressReportInterval) && options.progressReportInterval > 0
      ? options.progressReportInterval
      : 10;
    this.moveTimeoutMs = Number.isFinite(options.moveTimeoutMs) ? options.moveTimeoutMs : 10000;
    this.nextLayerMoveTimeoutMs = Number.isFinite(options.nextLayerMoveTimeoutMs) ? options.nextLayerMoveTimeoutMs : 15000;
    this.bot = null;
    this.isDigging = false;
    this.isAreaDigging = false;
    this.stopAreaDigging = false;
  }

  attach(bot) {
    this.bot = bot;

    if (!bot.pathfinder && typeof bot.loadPlugin === 'function') {
      bot.loadPlugin(pathfinder);
    }
  }

  stop() {
    this.isDigging = false;
    this.stopAreaDigging = true;

    if (!this.bot) return;

    try {
      if (this.bot.pathfinder && typeof this.bot.pathfinder.stop === 'function') {
        this.bot.pathfinder.stop();
      }

      if (this.bot.pathfinder && typeof this.bot.pathfinder.setGoal === 'function') {
        this.bot.pathfinder.setGoal(null);
      }
    } catch (error) {
    }

    if (typeof this.bot.stopDigging !== 'function') return;

    try {
      this.bot.stopDigging();
    } catch (error) {
    }
  }

  detach() {
    this.stop();
    this.bot = null;
  }

  ensureReady() {
    if (!this.bot || !this.bot.entity) {
      throw new Error('bot not connected');
    }
  }

  async handleDigCommand(context, x, y, z) {
    this.ensureReady();

    if (this.isAreaDigging) {
      context.replyInfo('正在执行范围挖掘，请先等待完成或使用 stopdig 停止');
      return true;
    }

    try {
      this.isDigging = true;
      const targetBlock = this.bot.blockAt(new Vec3(x, y, z));
      if (!targetBlock) {
        context.replyError(`坐标 (${x}, ${y}, ${z}) 处没有方块`);
        return true;
      }

      if (!targetBlock.diggable) {
        context.replyError(`这个方块无法挖掘 (${targetBlock.name})`);
        return true;
      }

      const blockName = targetBlock.displayName || targetBlock.name;
      context.replyInfo(`开始挖掘 ${blockName} (${x}, ${y}, ${z})`);
      await this.bot.dig(targetBlock, true, 'auto');

      if (this.logger) {
        this.logger.info(`[DIG] completed ${blockName} x=${x} y=${y} z=${z}`);
      }

      context.replyInfo(`成功挖掘 ${blockName}`);
    } catch (error) {
      this.stop();
      context.replyError(`挖掘失败: ${error.message}`);
    }

    this.isDigging = false;
    return true;
  }

  async handleAreaDigCommand(context, x1, y1, z1, x2, y2, z2) {
    this.ensureReady();

    if (this.isAreaDigging) {
      context.replyInfo('正在执行范围挖掘，请先等待完成或使用 stopdig 停止');
      return true;
    }

    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2);
    const maxZ = Math.max(z1, z2);
    const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);

    if (volume > 1000) {
      context.replyInfo(`警告：将挖掘 ${volume} 个方块，这可能需要很长时间！`);
    } else {
      context.replyInfo(`开始范围挖掘 ${volume} 个方块`);
    }

    this.isAreaDigging = true;
    this.stopAreaDigging = false;

    let totalDigCount = 0;
    let totalSkipCount = 0;

    try {
      for (let y = maxY; y >= minY && !this.stopAreaDigging; y -= 1) {
        const currentLayer = maxY - y + 1;
        const layerCount = maxY - minY + 1;
        let layerDigCount = 0;
        let layerSkipCount = 0;

        context.replyInfo(`开始挖掘第 ${currentLayer}/${layerCount} 层 (Y=${y})`);

        for (let x = minX; x <= maxX && !this.stopAreaDigging; x += 1) {
          for (let z = minZ; z <= maxZ && !this.stopAreaDigging; z += 1) {
            try {
              let block = this.bot.blockAt(new Vec3(x, y, z));
              if (!block) {
                layerSkipCount += 1;
                continue;
              }

              if (block.name === 'air' || !block.diggable) {
                layerSkipCount += 1;
                continue;
              }

              if (this.getDistanceTo(x, y, z) > 3) {
                const moveSuccess = await this.moveToPositionForMining(x, y, z);
                if (!moveSuccess || this.stopAreaDigging) {
                  layerSkipCount += 1;
                  continue;
                }

                block = this.bot.blockAt(new Vec3(x, y, z));
                if (!block || block.name === 'air' || !block.diggable) {
                  layerSkipCount += 1;
                  continue;
                }
              }

              await this.bot.dig(block, true, 'auto');
              layerDigCount += 1;
              totalDigCount += 1;

              if (
                this.progressReportInterval > 0 &&
                totalDigCount % this.progressReportInterval === 0
              ) {
                const progress = Math.round((totalDigCount / volume) * 100);
                context.replyInfo(`总进度: ${totalDigCount}/${volume} (${progress}%)`);
              }

              if (!this.stopAreaDigging) {
                await sleep(this.areaDigDelayMs);
              }
            } catch (error) {
              layerSkipCount += 1;

              if (this.logger) {
                this.logger.warn(`[DIG] failed area block x=${x} y=${y} z=${z}: ${error.message}`);
              }
            }
          }
        }

        totalSkipCount += layerSkipCount;
        context.replyInfo(`第 ${currentLayer} 层完成: 挖掘 ${layerDigCount} 个，跳过 ${layerSkipCount} 个`);

        if (y > minY && !this.stopAreaDigging) {
          context.replyInfo('准备挖掘下一层...');
          await this.moveToNextLayer(minX, maxX, minZ, maxZ, y - 1);
        }
      }

      if (this.stopAreaDigging) {
        context.replyInfo(`范围挖掘已停止，已挖掘 ${totalDigCount} 个方块`);
      } else {
        context.replyInfo(`范围挖掘完成！总共挖掘了 ${totalDigCount} 个方块，跳过了 ${totalSkipCount} 个方块`);
      }

      if (this.logger) {
        this.logger.info(`[DIG] area completed dug=${totalDigCount} skipped=${totalSkipCount} stopped=${this.stopAreaDigging}`);
      }
    } catch (error) {
      this.stop();
      context.replyError(`范围挖掘失败: ${error.message}`);
    } finally {
      this.isAreaDigging = false;
      this.stopAreaDigging = false;
    }

    return true;
  }

  stopDigging(context) {
    try {
      const isStoppingAreaDig = this.isAreaDigging;
      this.stop();

      if (context) {
        if (isStoppingAreaDig) {
          context.replyInfo('正在停止范围挖掘...');
        } else {
          context.replyInfo('已停止挖掘');
        }
      }
    } catch (error) {
      if (context) {
        context.replyError(`停止挖掘失败: ${error.message}`);
      }
    }

    return true;
  }

  getDistanceTo(x, y, z) {
    const position = this.bot && this.bot.entity && this.bot.entity.position;
    if (!position) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.hypot(position.x - x, position.y - y, position.z - z);
  }

  ensurePathfinder() {
    if (!this.bot) {
      return false;
    }

    if (!this.bot.pathfinder && typeof this.bot.loadPlugin === 'function') {
      this.bot.loadPlugin(pathfinder);
    }

    return Boolean(
      this.bot.pathfinder &&
      typeof this.bot.pathfinder.setGoal === 'function'
    );
  }

  async moveToPositionForMining(x, y, z) {
    return this.moveNearTarget(x, y + 1, z, this.moveTimeoutMs);
  }

  async moveToNextLayer(minX, maxX, minZ, maxZ, nextY) {
    const centerX = Math.floor((minX + maxX) / 2);
    const centerZ = Math.floor((minZ + maxZ) / 2);
    return this.moveNearTarget(centerX, nextY + 1, centerZ, this.nextLayerMoveTimeoutMs);
  }

  async moveNearTarget(x, y, z, timeoutMs) {
    if (!this.ensurePathfinder()) {
      return false;
    }

    try {
      if (typeof this.bot.pathfinder.setMovements === 'function') {
        const defaultMove = buildDefaultMovements(this.bot);
        this.bot.pathfinder.setMovements(defaultMove);
      }
    } catch (error) {
      if (this.logger) {
        this.logger.warn(`[DIG] setMovements failed: ${error.message}`);
      }
    }

    this.bot.pathfinder.setGoal(new GoalNear(x, y, z, 1));
    return this.waitForGoalReached(new Vec3(x, y, z), 2, timeoutMs);
  }

  async waitForGoalReached(target, radius, timeoutMs) {
    const startTime = Date.now();
    let hasSeenMovement = false;

    while (Date.now() - startTime < timeoutMs) {
      if (this.stopAreaDigging) {
        return false;
      }

      const position = this.bot && this.bot.entity && this.bot.entity.position;
      if (position && position.distanceTo(target) <= radius) {
        return true;
      }

      if (
        this.bot &&
        this.bot.pathfinder &&
        typeof this.bot.pathfinder.isMoving === 'function'
      ) {
        const isMoving = this.bot.pathfinder.isMoving();
        hasSeenMovement = hasSeenMovement || isMoving === true;

        if (isMoving === false && hasSeenMovement) {
          return Boolean(position && position.distanceTo(target) <= radius + 1);
        }
      }

      await sleep(100);
    }

    return false;
  }

  getState() {
    return {
      isDigging: this.isDigging,
      isAreaDigging: this.isAreaDigging
    };
  }
}

module.exports = {
  DigFeature
};
