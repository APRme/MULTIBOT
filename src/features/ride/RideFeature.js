const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder');
const { buildDefaultMovements } = require('../../util/pathfinding');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RideFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.bot = null;
    this.isRiding = false;
    this.vehicleMovementInterval = null;
    this.currentMovement = { left: 0, forward: 0 };
    this.listeners = [];
  }

  attach(bot) {
    this.detach();
    this.bot = bot;

    if (!bot.pathfinder) {
      bot.loadPlugin(pathfinder);
    }

    this.addListener(bot, 'mount', () => {
      this.isRiding = true;
      if (this.logger) {
        this.logger.info('[RIDE] mounted');
      }
    });

    this.addListener(bot, 'dismount', () => {
      this.isRiding = false;
      this.stopVehicleMovement();
      if (this.logger) {
        this.logger.info('[RIDE] dismounted');
      }
    });

    if (bot._client) {
      this.addListener(bot._client, 'set_passengers', ({ entityId, passengers }) => {
        if (!bot.entity || !bot.vehicle || bot.vehicle.id !== entityId) {
          return;
        }

        const currentPassengers = Array.isArray(passengers) ? passengers : [];
        if (currentPassengers.includes(bot.entity.id)) {
          return;
        }

        const forcedVehicle = bot.vehicle;
        bot.vehicle = null;
        if (bot.entity.vehicle && bot.entity.vehicle.id === forcedVehicle.id) {
          bot.entity.vehicle = null;
        }
        bot.emit('dismount', forcedVehicle);
      });
    }
  }

  addListener(target, eventName, handler) {
    if (!target || typeof target.on !== 'function') {
      return;
    }

    target.on(eventName, handler);
    this.listeners.push({ target, eventName, handler });
  }

  ensureReady() {
    if (!this.bot) {
      throw new Error('ride feature not attached');
    }

    if (!this.bot.pathfinder) {
      this.bot.loadPlugin(pathfinder);
    }
  }

  isRideableEntity(entity, includePlayers = false) {
    if (!entity || !entity.position || entity === this.bot.entity) return false;
    if (includePlayers) {
      return entity.type === 'player';
    }

    const nameLower = String(entity.name || '').toLowerCase();
    const displayNameLower = String(entity.displayName || '').toLowerCase();

    if (entity.type === 'player') return false;
    if (entity.type === 'object') {
      if (nameLower.includes('boat')) return true;
      if (nameLower.includes('minecart')) {
        return !['hopper', 'chest', 'furnace', 'tnt', 'command_block'].some((type) => nameLower.includes(type));
      }
    }

    const rideableTypes = [
      'horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse',
      'pig', 'strider', 'camel', 'llama', 'trader_llama',
      'boat', 'minecart'
    ];

    return rideableTypes.some((type) => nameLower.includes(type) || displayNameLower.includes(type));
  }

  findNearestRideable(includePlayers = false) {
    const entities = Object.values(this.bot.entities || {}).filter((entity) => this.isRideableEntity(entity, includePlayers));
    if (entities.length === 0) return null;

    return entities.reduce((closest, entity) => {
      if (!closest) return entity;

      const currentDistance = this.bot.entity.position.distanceTo(entity.position);
      const closestDistance = this.bot.entity.position.distanceTo(closest.position);
      return currentDistance < closestDistance ? entity : closest;
    }, null);
  }

  async moveNearEntity(targetEntity) {
    const targetPos = targetEntity.position;
    let moveSuccess = false;

    if (this.bot.pathfinder) {
      try {
        const goal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 2);
        const defaultMove = buildDefaultMovements(this.bot);
        this.bot.pathfinder.setMovements(defaultMove);
        this.bot.pathfinder.setGoal(goal);
        await sleep(3000);
        const distance = this.bot.entity.position.distanceTo(targetPos);
        if (distance <= 3) {
          moveSuccess = true;
        }
      } catch (error) {
        if (this.logger) {
          this.logger.warn('[RIDE] pathfinder approach failed', error.message);
        }
      }
    }

    if (moveSuccess) {
      return;
    }

    await this.bot.lookAt(targetPos);
    this.bot.setControlState('forward', true);

    const approachDistance = String(targetEntity.name || '').toLowerCase().includes('boat') ||
      String(targetEntity.name || '').toLowerCase().includes('minecart')
      ? 2
      : 3;

    await new Promise((resolve) => {
      const startedAt = Date.now();
      const interval = setInterval(() => {
        const distance = this.bot.entity.position.distanceTo(targetPos);
        if (distance <= approachDistance || Date.now() - startedAt > 5000) {
          clearInterval(interval);
          this.bot.setControlState('forward', false);
          resolve();
        }
      }, 100);
    });
  }

  waitForMount(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const onMount = () => {
        clearTimeout(timeoutId);
        this.bot.off('mount', onMount);
        resolve();
      };

      const timeoutId = setTimeout(() => {
        this.bot.off('mount', onMount);
        reject(new Error('骑乘超时'));
      }, timeoutMs);

      this.bot.on('mount', onMount);
    });
  }

  async waitForVehicleExit(expectedVehicle, timeoutMs = 1500) {
    if (!expectedVehicle) {
      return !this.bot.vehicle;
    }

    const expectedVehicleId = expectedVehicle.id;
    const hasExitedVehicle = () => !this.bot.vehicle || this.bot.vehicle.id !== expectedVehicleId;

    if (hasExitedVehicle()) {
      return true;
    }

    return new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        clearInterval(checkInterval);
        clearTimeout(timeoutId);
        this.bot.off('dismount', onDismount);
      };

      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onDismount = () => {
        finish(true);
      };

      const checkInterval = setInterval(() => {
        if (hasExitedVehicle()) {
          finish(true);
        }
      }, 50);

      const timeoutId = setTimeout(() => {
        finish(hasExitedVehicle());
      }, timeoutMs);

      this.bot.on('dismount', onDismount);
    });
  }

  startVehicleMovement(left, forward) {
    this.stopVehicleMovement();
    this.currentMovement = { left, forward };

    this.vehicleMovementInterval = setInterval(() => {
      if (this.isRiding && this.bot.vehicle) {
        try {
          this.bot.moveVehicle(this.currentMovement.left, this.currentMovement.forward);
        } catch (error) {
          this.stopVehicleMovement();
        }
      } else {
        this.stopVehicleMovement();
      }
    }, 100);
  }

  stopVehicleMovement() {
    if (this.vehicleMovementInterval) {
      clearInterval(this.vehicleMovementInterval);
      this.vehicleMovementInterval = null;
    }
    this.currentMovement = { left: 0, forward: 0 };
  }

  async handleRideCommand(context, parts) {
    this.ensureReady();

    if (parts.length === 1) {
      if (this.isRiding && this.bot.vehicle) {
        await this.stopRiding(context);
      } else if (this.isRiding && !this.bot.vehicle) {
        this.isRiding = false;
        this.stopVehicleMovement();
        context.replyError('骑乘状态已重置，请重新骑乘');
      } else {
        await this.startRiding(context, false);
      }
      return true;
    }

    if (parts.length === 2 && String(parts[1]).toLowerCase() === 'player') {
      await this.startRiding(context, true);
      return true;
    }

    if (
      String(parts[1] || '').toLowerCase() === 'w' &&
      (parts.length === 2 || (parts.length === 3 && String(parts[2]).toLowerCase() === 'a'))
    ) {
      this.handleRideMoveCommand(context, parts[2] ? String(parts[2]).toLowerCase() : undefined);
      return true;
    }

    context.replyError('用法: ride | ride player | ride w [a]');
    return true;
  }

  handleRideMoveCommand(context, direction) {
    if (this.isRiding && !this.bot.vehicle) {
      this.isRiding = false;
      this.stopVehicleMovement();
      context.replyError('骑乘状态异常，已重置，请重新骑乘');
      return;
    }

    if (!this.isRiding || !this.bot.vehicle) {
      context.replyError('当前没有骑乘任何实体，无法移动');
      return;
    }

    if (direction === 'a') {
      this.startVehicleMovement(1, 1);
      context.replyInfo('开始向左前方移动...');
    } else {
      this.startVehicleMovement(0, 1);
      context.replyInfo('开始向前移动...');
    }
  }

  async startRiding(context, includePlayers) {
    const targetEntity = this.findNearestRideable(includePlayers);
    if (!targetEntity) {
      context.replyInfo(includePlayers ? '附近没有找到其他玩家' : '附近没有找到可骑乘实体');
      return;
    }

    const entityName = targetEntity.displayName || targetEntity.name || '未知实体';
    context.replyInfo(`正在靠近 ${entityName}...`);

    await this.moveNearEntity(targetEntity);

    const finalDistance = this.bot.entity.position.distanceTo(targetEntity.position);
    if (finalDistance > 3) {
      context.replyError(`无法靠近实体，距离过远 (${finalDistance.toFixed(1)}格)`);
      return;
    }

    this.bot.mount(targetEntity);

    try {
      await this.waitForMount(2000);
      if (this.bot.vehicle && this.bot.vehicle.id === targetEntity.id) {
        this.isRiding = true;
        context.replyInfo(`已骑上 ${entityName}，发送 ride 下来`);
      } else {
        context.replyError('骑乘失败，可能该实体不可骑乘');
      }
    } catch (error) {
      context.replyError(`骑乘失败: ${error.message}`);
    }
  }

  async stopRiding(context) {
    this.stopVehicleMovement();

    if (!this.bot.vehicle) {
      this.isRiding = false;
      context.replyInfo('已下来');
      return;
    }

    const expectedVehicle = this.bot.vehicle;
    const wasSneaking = this.bot.getControlState('sneak');

    this.bot.dismount();
    let dismounted = await this.waitForVehicleExit(expectedVehicle, 500);

    if (!dismounted && this.bot.vehicle && this.bot.vehicle.id === expectedVehicle.id) {
      this.bot.setControlState('sneak', true);
      await sleep(250);
      if (!wasSneaking) {
        this.bot.setControlState('sneak', false);
      }
      dismounted = await this.waitForVehicleExit(expectedVehicle, 750);
    }

    if (dismounted || !this.bot.vehicle || this.bot.vehicle.id !== expectedVehicle.id) {
      this.isRiding = false;
      context.replyInfo('已下来');
      return;
    }

    this.isRiding = true;
    context.replyError('下来失败：当前仍在骑乘状态');
  }

  stop() {
    this.stopVehicleMovement();
    this.isRiding = Boolean(this.bot && this.bot.vehicle);
  }

  detach() {
    this.stopVehicleMovement();

    for (const listener of this.listeners) {
      if (listener.target && typeof listener.target.removeListener === 'function') {
        listener.target.removeListener(listener.eventName, listener.handler);
      }
    }

    this.listeners = [];
    this.isRiding = false;
    this.bot = null;
  }

  getState() {
    return {
      isRiding: this.isRiding || Boolean(this.bot && this.bot.vehicle)
    };
  }
}

module.exports = {
  RideFeature
};
