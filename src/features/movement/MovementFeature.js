const { pathfinder, goals: { GoalNear, GoalBlock, GoalLookAtBlock } } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const {
  buildDefaultMovements,
  buildHeightRecoveryMovements,
  isLockedHeightPosition,
  isThinPassableBlock
} = require('../../util/pathfinding');
const physics = require('mineflayer/lib/plugins/physics');

const LOCKED_RECOVERY_RADIUS = 6;
const LOCKED_RECOVERY_ANCHOR_DISTANCE = 12;
const LOCKED_RECOVERY_TIMEOUT_MS = 8000;

class LockedGoalBlock extends GoalBlock {
  constructor(x, y, z, bot, lockY) {
    super(x, y, z);
    this.bot = bot;
    this.lockY = lockY;
  }

  isEnd(node) {
    if (super.isEnd(node)) {
      return true;
    }

    // A post-processed path may finish on a half-height surface below the
    // integer node (e.g. a stair at y=73 with feet at y=73.5).  The logical
    // path remains locked at y=74; accept that physical endpoint only when
    // the bot is actually standing on the corresponding collision surface.
    return Boolean(
      node
      && node.x === this.x
      && node.z === this.z
      && this.y === this.lockY
      && node.y === this.lockY - 1
      && isLockedHeightPosition(this.bot, this.bot && this.bot.entity && this.bot.entity.position, this.lockY)
    );
  }
}

class MovementFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.bot = null;
    this.isSneaking = false;
    this.isCircling = false;
    this.circleInterval = null;
    this.circleCenter = null;
    this.lastLockedPosition = null;
  }

  attach(bot) {
    this.stop();
    this.bot = bot;
    this.lastLockedPosition = null;
  }

  ensureBotReady() {
    if (!this.bot) {
      throw new Error('movement feature not attached');
    }
  }

  ensurePhysicsReady() {
    this.ensureBotReady();

    if (typeof this.bot.setControlState === 'function') {
      return;
    }

    if (typeof this.bot.loadPlugin === 'function') {
      this.bot.loadPlugin(physics);
    }

    if (typeof this.bot.setControlState !== 'function') {
      throw new Error('mineflayer 物理插件未加载，无法执行寻路');
    }
  }

  async waitForPhysicsReady(timeoutMs = 5000, retryIntervalMs = 100) {
    this.ensureBotReady();
    const bot = this.bot;
    const deadline = Date.now() + Math.max(0, timeoutMs);

    while (typeof bot.setControlState !== 'function') {
      if (this.bot !== bot) {
        throw new Error('movement feature bot changed while waiting for physics plugin');
      }
      if (typeof bot.loadPlugin === 'function') {
        bot.loadPlugin(physics);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('mineflayer 物理插件未加载，无法执行寻路');
      }
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(Math.max(1, retryIntervalMs), remaining));
      });
    }
  }

  async waitForLockedHeightReady(lockY, timeoutMs = 5000, retryIntervalMs = 100) {
    this.ensureBotReady();
    if (!Number.isInteger(lockY)) return;

    const bot = this.bot;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let lastY = null;

    while (true) {
      if (this.bot !== bot) {
        throw new Error('movement feature bot changed while waiting for locked height');
      }

      const position = bot.entity && bot.entity.position;
      lastY = position && Number.isFinite(position.y) ? position.y : null;
      if (position && isLockedHeightPosition(bot, position, lockY)) {
        this.rememberLockedPosition(lockY);
        return;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const actual = lastY === null ? '未知' : lastY;
        throw new Error(`bot 当前高度 y=${actual} 不是锁定高度 y=${lockY}`);
      }

      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(Math.max(1, retryIntervalMs), remaining));
      });
    }
  }

  ensurePathfinderReady() {
    this.ensurePhysicsReady();

    if (!this.bot.pathfinder) {
      this.bot.loadPlugin(pathfinder);
    }
  }

  rememberLockedPosition(lockY, preferredPosition = null) {
    const actual = this.bot && this.bot.entity && this.bot.entity.position;
    if (!actual || !isLockedHeightPosition(this.bot, actual, lockY)) {
      return null;
    }
    const source = preferredPosition || actual;
    if (!Number.isFinite(source.x) || !Number.isFinite(source.z)) {
      return null;
    }
    this.lastLockedPosition = {
      x: Math.floor(source.x),
      y: lockY,
      z: Math.floor(source.z),
      lockY
    };
    return this.lastLockedPosition;
  }

  isAirBlock(block) {
    return Boolean(block && ['air', 'cave_air', 'void_air'].includes(block.name));
  }

  isRecoveryStandingPosition(x, lockY, z) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') {
      return false;
    }
    const feet = this.bot.blockAt(new Vec3(x, lockY, z));
    const head = this.bot.blockAt(new Vec3(x, lockY + 1, z));
    const support = this.bot.blockAt(new Vec3(x, lockY - 1, z));
    if (!(this.isAirBlock(feet) || isThinPassableBlock(feet)) || !this.isAirBlock(head)) {
      return false;
    }
    if (!support || !Array.isArray(support.shapes) || support.shapes.length === 0) {
      return false;
    }
    const centerX = 0.5;
    const centerZ = 0.5;
    const epsilon = 1e-6;
    return support.shapes.some((shape) => (
      Array.isArray(shape)
      && shape.length >= 6
      && centerX + epsilon >= shape[0]
      && centerX - epsilon <= shape[3]
      && centerZ + epsilon >= shape[2]
      && centerZ - epsilon <= shape[5]
      && Math.abs(shape[4] - 1) <= 0.01
    ));
  }

  findNearestLockedRecoveryPosition(lockY, radius = LOCKED_RECOVERY_RADIUS) {
    const current = this.bot && this.bot.entity && this.bot.entity.position;
    if (!current) return null;
    const centerX = Math.floor(current.x);
    const centerZ = Math.floor(current.z);
    const candidates = [];
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      for (let offsetZ = -radius; offsetZ <= radius; offsetZ += 1) {
        if ((offsetX ** 2) + (offsetZ ** 2) > radius ** 2) continue;
        const x = centerX + offsetX;
        const z = centerZ + offsetZ;
        if (this.isRecoveryStandingPosition(x, lockY, z)) {
          candidates.push({ x, y: lockY, z, distanceSq: (offsetX ** 2) + (offsetZ ** 2) });
        }
      }
    }
    candidates.sort((left, right) => left.distanceSq - right.distanceSq);
    return candidates.length > 0
      ? { x: candidates[0].x, y: lockY, z: candidates[0].z }
      : null;
  }

  getLockedRecoveryTargets(lockY) {
    const targets = [];
    const nearest = this.findNearestLockedRecoveryPosition(lockY);
    if (nearest) {
      targets.push({ ...nearest, source: 'nearest' });
    }
    const anchor = this.lastLockedPosition;
    const current = this.bot && this.bot.entity && this.bot.entity.position;
    if (
      anchor
      && anchor.lockY === lockY
      && current
      && Math.hypot(anchor.x - current.x, anchor.z - current.z) <= LOCKED_RECOVERY_ANCHOR_DISTANCE
      && this.isRecoveryStandingPosition(anchor.x, lockY, anchor.z)
      && !targets.some((target) => target.x === anchor.x && target.z === anchor.z)
    ) {
      targets.push({ x: anchor.x, y: lockY, z: anchor.z, source: 'last_success' });
    }
    return targets;
  }

  async waitForRecoveryGround(timeoutMs = 2000) {
    const bot = this.bot;
    const deadline = Date.now() + timeoutMs;
    while (bot && bot.entity && bot.entity.onGround !== true && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return Boolean(bot && bot.entity && bot.entity.onGround === true);
  }

  async recoverLockedHeight(lockY) {
    this.ensurePathfinderReady();
    if (isLockedHeightPosition(this.bot, this.bot.entity && this.bot.entity.position, lockY)) {
      this.rememberLockedPosition(lockY);
      return { recovered: false, target: null };
    }
    if (!await this.waitForRecoveryGround()) {
      throw new Error(`锁高恢复失败: bot 未稳定落地，当前 y=${this.bot.entity && this.bot.entity.position.y}`);
    }
    if (isLockedHeightPosition(this.bot, this.bot.entity.position, lockY)) {
      this.rememberLockedPosition(lockY);
      return { recovered: false, target: null };
    }

    const targets = this.getLockedRecoveryTargets(lockY);
    if (targets.length === 0) {
      throw new Error(`锁高恢复失败: 附近没有安全的 y=${lockY} 站位`);
    }

    let lastError = null;
    for (const target of targets) {
      const movements = buildHeightRecoveryMovements(this.bot, lockY);
      this.bot.pathfinder.setMovements(movements);
      this.bot.pathfinder.setGoal(new GoalBlock(target.x, target.y, target.z));
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(
          `[MOVE][RECOVERY] 尝试恢复锁定高度 currentY=${this.bot.entity.position.y} ` +
          `target=${target.x},${target.y},${target.z} source=${target.source}`
        );
      }
      try {
        await this.awaitGoalReached(this.bot, LOCKED_RECOVERY_TIMEOUT_MS, { recoveryLockY: lockY });
        this.rememberLockedPosition(lockY, target);
        return { recovered: true, target };
      } catch (error) {
        lastError = error;
        if (this.bot.pathfinder && typeof this.bot.pathfinder.setGoal === 'function') {
          this.bot.pathfinder.setGoal(null);
        }
      }
    }
    throw new Error(`锁高恢复失败: ${lastError ? lastError.message : '无法到达安全站位'}`);
  }

  goto(x, y, z, movementOptions = [], options = {}) {
    this.gotoGoal(new GoalNear(x, y, z, 1), movementOptions, options);
  }

  gotoExact(x, y, z, movementOptions = [], options = {}) {
    const lockY = Number.isInteger(options.lockY) ? options.lockY : null;
    const goal = lockY === null
      ? new GoalBlock(x, y, z)
      : new LockedGoalBlock(x, y, z, this.bot, lockY);
    this.gotoGoal(goal, movementOptions, options);
  }

  gotoLookAtBlock(x, y, z, movementOptions = [], options = {}) {
    this.ensureBotReady();
    const reach = Number.isFinite(options.reach) ? options.reach : 3.5;
    const goal = new GoalLookAtBlock(new Vec3(x, y, z), this.bot.world, { reach });
    this.gotoGoal(goal, movementOptions, options);
  }

  gotoGoal(goal, movementOptions = [], options = {}) {
    this.ensurePathfinderReady();
    this.stopCircle();

    const lockY = Number.isInteger(options.lockY) ? options.lockY : null;
    if (
      lockY !== null
      && (!this.bot.entity || !isLockedHeightPosition(this.bot, this.bot.entity.position, lockY))
    ) {
      throw new Error(`bot 当前高度不是锁定高度 y=${lockY}`);
    }

    const movements = buildDefaultMovements(this.bot, movementOptions, { lockY });
    this.bot.pathfinder.setMovements(movements);
    this.bot.pathfinder.setGoal(goal);

    if (this.logger) {
      const lockDescription = lockY === null ? '' : ` lockY=${lockY}`;
      this.logger.info(
        goal instanceof GoalNear
          ? `[MOVE] goto x=${goal.x} y=${goal.y} z=${goal.z} options=${movementOptions.join(',') || 'walk'}${lockDescription}`
          : `[MOVE] goto goal=${goal.constructor.name} options=${movementOptions.join(',') || 'walk'}${lockDescription}`
      );
    }
  }

  // 等待当前寻路目标到达,超时或死亡则失败。用于需要"到达"信号的编排流程。
  awaitGoalReached(bot, timeoutMs = 30000, options = {}) {
    if (!bot || !bot.pathfinder) {
      return Promise.reject(new Error('pathfinder 未初始化'));
    }

    const lockY = Number.isInteger(options.lockY) ? options.lockY : null;
    const recoveryLockY = Number.isInteger(options.recoveryLockY) ? options.recoveryLockY : null;
    const finalLockY = lockY === null ? recoveryLockY : lockY;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (typeof bot.removeListener === 'function') {
          bot.removeListener('goal_reached', onGoal);
          bot.removeListener('path_update', onPathUpdate);
          bot.removeListener('path_reset', onPathReset);
          bot.removeListener('death', onDeath);
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const stopPathfinder = () => {
        if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') {
          bot.pathfinder.stop();
        }
      };
      const onGoal = (goal) => {
        const actualY = bot.entity && bot.entity.position ? bot.entity.position.y : null;
        if (
          finalLockY !== null
          && (!Number.isFinite(actualY) || !isLockedHeightPosition(bot, bot.entity.position, finalLockY))
        ) {
          stopPathfinder();
          finish(new Error(`已到达错误高度 y=${actualY};要求锁定高度 y=${finalLockY}`));
          return;
        }
        if (finalLockY !== null) {
          const target = goal && goal.pos ? goal.pos : goal;
          this.rememberLockedPosition(finalLockY, target);
        }
        if (this.logger && typeof this.logger.info === 'function') {
          const target = goal && goal.pos ? goal.pos : goal;
          const coordinates = target
            && Number.isFinite(target.x)
            && Number.isFinite(target.y)
            && Number.isFinite(target.z)
            ? ` x=${target.x} y=${target.y} z=${target.z}`
            : '';
          this.logger.info(`[MOVE] 已到达目标位置${coordinates}`);
        }
        finish();
      };
      const onDeath = () => finish(new Error('bot 死亡，移动中断'));
      const onPathReset = (reason) => {
        if (finalLockY !== null && reason === 'stuck') {
          finish(new Error('寻路器卡住'));
        }
      };
      const onPathUpdate = (result) => {
        if (result && result.status === 'noPath') {
          finish(new Error('寻路器未找到可达路径'));
          return;
        }
        if (
          lockY !== null
          && result
          && Array.isArray(result.path)
          && result.path.some((node) => !node || !isLockedHeightPosition(bot, node, lockY))
        ) {
          stopPathfinder();
          finish(new Error(`寻路路径违反锁定高度 y=${lockY}`));
          return;
        }
        if (
          recoveryLockY !== null
          && result
          && Array.isArray(result.path)
          && result.path.some((node) => {
            const y = node && Math.floor(node.y);
            return !Number.isFinite(y) || y < recoveryLockY - 1 || y > recoveryLockY;
          })
        ) {
          stopPathfinder();
          finish(new Error(`恢复路径超出允许高度 y=${recoveryLockY - 1}..${recoveryLockY}`));
        }
      };

      if (typeof bot.on === 'function') {
        bot.on('goal_reached', onGoal);
        bot.on('path_update', onPathUpdate);
        bot.on('path_reset', onPathReset);
        bot.on('death', onDeath);
      }

      const timer = setTimeout(() => finish(new Error(`等待到达超时(${timeoutMs}ms)`)), timeoutMs);
    });
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
    this.lastLockedPosition = null;
  }
}

module.exports = {
  MovementFeature
};
