const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { buildDefaultMovements } = require('../../util/pathfinding');

class MovementFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.bot = null;
    this.isSneaking = false;
    this.isCircling = false;
    this.circleInterval = null;
    this.circleCenter = null;
  }

  attach(bot) {
    this.stop();
    this.bot = bot;
  }

  ensureBotReady() {
    if (!this.bot) {
      throw new Error('movement feature not attached');
    }
  }

  ensurePathfinderReady() {
    this.ensureBotReady();

    if (!this.bot.pathfinder) {
      this.bot.loadPlugin(pathfinder);
    }
  }

  goto(x, y, z, movementOptions = []) {
    this.ensurePathfinderReady();
    this.stopCircle();

    const movements = buildDefaultMovements(this.bot, movementOptions);
    this.bot.pathfinder.setMovements(movements);
    this.bot.pathfinder.setGoal(new GoalNear(x, y, z, 1));

    if (this.logger) {
      this.logger.info(
        `[MOVE] goto x=${x} y=${y} z=${z} options=${movementOptions.join(',') || 'walk'}`
      );
    }
  }

  async lookDegrees(context, gameYaw, gamePitch) {
    this.ensureBotReady();

    if (!Number.isFinite(gameYaw) || !Number.isFinite(gamePitch)) {
      throw new Error('invalid yaw or pitch');
    }

    let normalizedYaw = gameYaw;
    if (normalizedYaw > 180) normalizedYaw -= 360;
    if (normalizedYaw < -180) normalizedYaw += 360;

    let yawRad;
    if (normalizedYaw === 180 || normalizedYaw === -180) {
      yawRad = -Math.PI / 2;
    } else if (normalizedYaw === 0) {
      yawRad = Math.PI / 2;
    } else if (normalizedYaw === -90) {
      yawRad = Math.PI;
    } else if (normalizedYaw === 90) {
      yawRad = 0;
    } else {
      yawRad = (normalizedYaw + 90) * Math.PI / 180;
    }

    const pitchRad = -gamePitch * Math.PI / 180;
    await this.bot.look(yawRad, pitchRad, true);

    if (this.logger) {
      this.logger.info(`[MOVE] look yaw=${gameYaw} pitch=${gamePitch} yawRad=${yawRad} pitchRad=${pitchRad}`);
    }

    return true;
  }

  toggleSneak(context) {
    this.ensureBotReady();

    if (this.isSneaking) {
      this.stopSneak();
      context.replyInfo('已停止蹲下');
      return true;
    }

    this.bot.setControlState('sneak', true);
    this.isSneaking = true;
    context.replyInfo('已开始蹲下，再次发送 shift 停止');
    return true;
  }

  toggleCircle(context) {
    this.ensureBotReady();

    if (this.isCircling) {
      this.stopCircle();
      context.replyInfo('已停止转圈');
      return true;
    }

    this.startCircle();
    context.replyInfo('已开始转圈，再次发送 circle 停止');
    return true;
  }

  startCircle() {
    this.ensureBotReady();
    this.stopCircle();

    this.isCircling = true;
    this.circleCenter = this.bot.entity && this.bot.entity.position
      ? this.bot.entity.position.clone()
      : null;

    this.bot.setControlState('jump', false);
    this.bot.setControlState('sneak', false);
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);

    let angle = 0;
    this.circleInterval = setInterval(() => {
      if (!this.bot || !this.bot.entity || !this.circleCenter) return;

      angle += Math.PI / 8;
      const radius = 2;
      const targetX = this.circleCenter.x + Math.cos(angle) * radius;
      const targetZ = this.circleCenter.z + Math.sin(angle) * radius;
      const lookTarget = new Vec3(targetX, this.circleCenter.y, targetZ);

      if (typeof this.bot.lookAt === 'function') {
        void this.bot.lookAt(lookTarget).catch(() => {});
      }

      this.bot.setControlState('forward', true);
    }, 200);
  }

  stopCircle() {
    this.isCircling = false;
    this.circleCenter = null;

    if (this.circleInterval) {
      clearInterval(this.circleInterval);
      this.circleInterval = null;
    }

    if (this.bot) {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
    }
  }

  stopSneak() {
    if (this.bot) {
      this.bot.setControlState('sneak', false);
    }
    this.isSneaking = false;
  }

  getState() {
    return {
      isSneaking: this.isSneaking,
      isCircling: this.isCircling
    };
  }

  stop() {
    this.stopCircle();
    this.stopSneak();

    if (this.bot && this.bot.pathfinder) {
      try {
        if (this.bot.entity && typeof this.bot.pathfinder.stop === 'function') {
          this.bot.pathfinder.stop();
        }
      } catch (error) {
      }

      try {
        if (this.bot.entity && typeof this.bot.pathfinder.setGoal === 'function') {
          this.bot.pathfinder.setGoal(null);
        }
      } catch (error) {
      }
    }
  }

  detach() {
    this.stop();
    this.bot = null;
  }
}

module.exports = {
  MovementFeature
};
