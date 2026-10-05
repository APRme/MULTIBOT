const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder');
const { buildDefaultMovements } = require('../../util/pathfinding');
const { LightweightEntityIndex, normalizeUuid } = require('./LightweightEntityIndex');

const LIGHTWEIGHT_MOUNT_TIMEOUT_MS = 2000;
// 玩家刚加入后的一段时间内服务端会忽略实体交互(实测 vanilla 1.21.11 约 3 秒),
// 因此上车不是"发一次就完", 而是持续重试到总窗口结束
const LIGHTWEIGHT_MOUNT_ATTEMPT_MS = 1200;
const LIGHTWEIGHT_MOUNT_TOTAL_MS = 12000;
const LIGHTWEIGHT_DISMOUNT_STEP_MS = 600;
const LIGHTWEIGHT_INTERACT_RANGE = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RideFeature {
  constructor(options = {}) {
    this.logger = options.logger;
    this.setPhysicsEnabled = options.setPhysicsEnabled || (() => {});
    this.getSelfPosition = options.getSelfPosition || null;
    this.bot = null;
    this.isRiding = false;
    this.vehicleMovementInterval = null;
    this.currentMovement = { left: 0, forward: 0 };
    this.listeners = [];
    this.lightweightIndex = null;
    this.lightweight = false;
    this.ridingEntityId = null;
    this.pendingMountEntityId = null;
    this.rideInFlight = false;
  }

  attach(bot) {
    this.detach();
    this.bot = bot;

    if (!bot.pathfinder) {
      bot.loadPlugin(pathfinder);
    }

    this.addListener(bot, 'mount', () => {
      this.isRiding = true;
      this.setPhysicsEnabled(true);
      if (this.logger) {
        this.logger.info('[RIDE] mounted');
      }
    });

    this.addListener(bot, 'dismount', () => {
      this.isRiding = false;
      this.setPhysicsEnabled(false);
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
    // 互斥: 一次只处理一个 ride 请求(轻量模式上车最长会重试 12 秒), 避免两个重试循环互抢状态
    if (this.rideInFlight) {
      context.replyError('正在处理上一个 ride 请求, 请稍候');
      return true;
    }

    this.rideInFlight = true;
    try {
      if (this.lightweightIndex) {
        return await this.handleLightweightRideCommand(context, parts);
      }

      return await this.handleFullRideCommand(context, parts);
    } finally {
      this.rideInFlight = false;
    }
  }

  async handleFullRideCommand(context, parts) {
    this.ensureReady();

    // ride <uuid>: 直接指定实体(与轻量模式语义一致)
    if (parts.length === 2 && normalizeUuid(parts[1]).length === 32) {
      await this.startRidingByUuid(context, parts[1]);
      return true;
    }

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

    await this.rideTargetEntity(context, targetEntity);
  }

  async startRidingByUuid(context, uuid) {
    const key = normalizeUuid(uuid);
    const entities = this.bot && this.bot.entities ? Object.values(this.bot.entities) : [];
    const targetEntity = entities.find((entity) => entity && normalizeUuid(entity.uuid) === key) || null;

    if (!targetEntity) {
      context.replyError('附近没有找到该 UUID 的实体');
      return;
    }

    await this.rideTargetEntity(context, targetEntity);
  }

  async rideTargetEntity(context, targetEntity) {
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
    this.isRiding = this.lightweight ? this.isRiding : Boolean(this.bot && this.bot.vehicle);
    this.setPhysicsEnabled(false);
  }

  // ==================== 轻量模式(不加载 entities/inventory 插件) ====================

  attachLightweight(bot) {
    this.detach();
    this.bot = bot;
    this.lightweight = true;
    this.isRiding = false;
    this.ridingEntityId = null;

    const client = bot && bot._client;
    if (!client || typeof client.on !== 'function') {
      return;
    }

    const index = new LightweightEntityIndex({
      logger: this.logger,
      typeIds: this.resolveRideableTypeIds(bot),
      maxEntries: 64
    });

    if (!index.attach(client, { bot })) {
      return;
    }

    this.lightweightIndex = index;
    if (this.logger) {
      this.logger.info('[RIDE] 轻量骑乘已就绪(仅索引矿车/船; 命令: ride | ride <uuid>)');
    }

    this.addListener(client, 'set_passengers', (packet) => {
      // 调试日志(任意实体的 set_passengers 都会触发, 人多时会刷屏): 需要排查时取消注释
      // if (this.logger) {
      //   const ids = packet && Array.isArray(packet.passengers) ? packet.passengers : [];
      //   const selfId = this.lightweightIndex ? this.lightweightIndex.selfEntityId : null;
      //   this.logger.info(`[RIDE] set_passengers vehicle=${packet ? packet.entityId : 'n/a'} passengers=[${ids.join(',')}] self=${selfId === null ? 'n/a' : selfId}`);
      // }
      this.handlePassengers(packet);
    });
    this.addListener(client, 'entity_destroy', (packet) => {
      const ids = packet && Array.isArray(packet.entityIds) ? packet.entityIds : [];
      if (this.ridingEntityId !== null && ids.includes(this.ridingEntityId)) {
        this.ridingEntityId = null;
        this.isRiding = false;
        if (this.logger) {
          this.logger.warn('[RIDE] 载具已消失, 骑乘状态已复位');
        }
      }
    });
    this.addListener(client, 'end', () => {
      this.ridingEntityId = null;
      this.isRiding = false;
    });
  }

  // 只索引矿车/船这类可骑乘实体(名字匹配, 兼容各版本的命名差异)
  resolveRideableTypeIds(bot) {
    try {
      const data = require('minecraft-data')(bot.version);
      const byName = data && data.entitiesByName ? data.entitiesByName : null;
      if (!byName) return null;

      const ids = [];
      for (const [name, entity] of Object.entries(byName)) {
        if (/minecart|boat|raft/i.test(name) && entity && Number.isFinite(entity.id)) {
          ids.push(entity.id);
        }
      }

      return ids.length > 0 ? [...new Set(ids)] : null;
    } catch (error) {
      return null;
    }
  }

  handlePassengers(packet) {
    const index = this.lightweightIndex;
    const vehicleId = packet && Number.isFinite(packet.entityId) ? packet.entityId : null;
    const passengers = packet && Array.isArray(packet.passengers) ? packet.passengers : [];

    if (!index || vehicleId === null) {
      return;
    }

    // 兜底: 若没捕获到 login 里的自身 entityId, 就用"刚交互过的载具 + 非空乘客列表"推断
    if (
      index.selfEntityId === null &&
      this.pendingMountEntityId === vehicleId &&
      passengers.length > 0
    ) {
      index.selfEntityId = passengers[0];
      if (this.logger) {
        this.logger.warn(`[RIDE] 未捕获 login 的自身 entityId, 按交互结果推断为 ${passengers[0]}`);
      }
    }

    const selfId = index.selfEntityId;
    if (selfId === null) {
      return;
    }

    if (passengers.includes(selfId)) {
      if (!this.isRiding || this.ridingEntityId !== vehicleId) {
        this.isRiding = true;
        this.ridingEntityId = vehicleId;
        if (this.logger) {
          this.logger.info(`[RIDE] mounted entity=${vehicleId}`);
        }
      }
      return;
    }

    if (this.ridingEntityId === vehicleId) {
      this.ridingEntityId = null;
      this.isRiding = false;
      if (this.logger) {
        this.logger.info('[RIDE] dismounted');
      }
    }
  }

  async handleLightweightRideCommand(context, parts) {
    const arg = parts.length >= 2 ? String(parts[1] || '') : '';
    const sub = arg.toLowerCase();

    if (parts.length === 1) {
      if (this.isRiding) {
        await this.dismountLightweight(context);
        return true;
      }

      await this.rideLightweightNearest(context);
      return true;
    }

    if (parts.length === 2 && sub === 'player') {
      context.replyError('轻量模式不支持 ride player(需要实体处理)');
      return true;
    }

    if (sub === 'w') {
      context.replyError('轻量模式不支持 ride w(需要实体与地形处理)');
      return true;
    }

    if (parts.length === 2 && normalizeUuid(arg).length === 32) {
      await this.rideLightweightByUuid(context, arg);
      return true;
    }

    context.replyError('用法: ride | ride <uuid>');
    return true;
  }

  async rideLightweightNearest(context) {
    const target = this.lightweightIndex.nearest(this.getSelfPosition ? this.getSelfPosition() : null);
    if (!target) {
      context.replyError(`附近没有已知的可骑乘实体(可改用 ride <uuid>) [${this.lightweightIndex.summary()}]`);
      return;
    }

    await this.mountLightweight(context, target);
  }

  async rideLightweightByUuid(context, uuid) {
    const target = this.lightweightIndex.findByUuid(uuid);
    if (!target) {
      context.replyError(`该 UUID 的实体当前不在视野内(先靠近它, 或等它进入视野后再试) [${this.lightweightIndex.summary()}]`);
      return;
    }

    await this.mountLightweight(context, target);
  }

  async mountLightweight(context, entity) {
    const selfPosition = this.getSelfPosition ? this.getSelfPosition() : null;
    if (selfPosition && Number.isFinite(selfPosition.x)) {
      const dx = entity.x - selfPosition.x;
      const dy = entity.y - selfPosition.y;
      const dz = entity.z - selfPosition.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > LIGHTWEIGHT_INTERACT_RANGE) {
        context.replyError(`距离过远 (${distance.toFixed(1)}格, 需要 ≤${LIGHTWEIGHT_INTERACT_RANGE}格)`);
        return;
      }
    }

    // 与上游 bot.mount() 等价: use_entity + mouse=0(INTERACT);
    // 原版在交互实体前会先挥手, 部分服务端/插件依赖这个包, 这里照做
    this.pendingMountEntityId = entity.id;

    const attemptMs = Number.isFinite(this.mountAttemptMs) && this.mountAttemptMs > 0
      ? this.mountAttemptMs
      : LIGHTWEIGHT_MOUNT_ATTEMPT_MS;
    const totalMs = Number.isFinite(this.mountTotalMs) && this.mountTotalMs > 0
      ? this.mountTotalMs
      : LIGHTWEIGHT_MOUNT_TOTAL_MS;
    const deadline = Date.now() + totalMs;

    let attempts = 0;
    let mounted = false;
    let swung = false;

    while (!mounted && Date.now() < deadline) {
      attempts += 1;

      if (!swung) {
        this.bot._client.write('arm_animation', { hand: 0 });
        swung = true;
      }

      this.writeUseEntity(entity, 0, null);
      mounted = await this.waitForLightweightMount(entity.id, attemptMs);

      // 原版对实体交互常用 INTERACT_AT(mouse=2) 变体, 第 2 次开始交替尝试
      if (!mounted && attempts === 1 && Date.now() < deadline) {
        this.writeUseEntity(entity, 2, { x: 0, y: 0.5, z: 0 });
        mounted = await this.waitForLightweightMount(entity.id, attemptMs);
      }

      if (!mounted && Date.now() < deadline) {
        await sleep(300);
      }
    }

    this.pendingMountEntityId = null;

    if (mounted) {
      context.replyInfo(`已骑上 ${this.lightweightIndex.describe(entity)}, 发送 ride 下来`);
      return;
    }

    const selfId = this.lightweightIndex.selfEntityId;
    context.replyError(`骑乘失败: 交互 ${attempts} 次均未收到上车确认 (自身entityId=${selfId === null ? '未知' : selfId}, 索引 ${this.lightweightIndex.size} 个)`);
  }

  writeUseEntity(entity, mouse, hit) {
    const params = {
      target: entity.id,
      mouse,
      sneaking: false
    };

    if (mouse === 0 || mouse === 2) {
      params.hand = 0;
    }

    if (mouse === 2 && hit) {
      params.x = hit.x;
      params.y = hit.y;
      params.z = hit.z;
    }

    this.bot._client.write('use_entity', params);

    if (this.logger) {
      this.logger.info(`[RIDE] use_entity target=${entity.id} mouse=${mouse}${hit ? ` hit=(${hit.x},${hit.y},${hit.z})` : ''}`);
    }
  }

  async dismountLightweight(context) {
    if (!this.isRiding) {
      context.replyInfo('已下来');
      return;
    }

    // 上游 dismount() 发 player_input.jump; 完整版 RideFeature 另外补了 sneak 脉冲, 这里两条都试
    this.writePlayerInput({ shift: true });
    let dismounted = await this.waitForLightweightDismount(LIGHTWEIGHT_DISMOUNT_STEP_MS);

    if (!dismounted) {
      this.writePlayerInput({ shift: false, jump: true });
      dismounted = await this.waitForLightweightDismount(LIGHTWEIGHT_DISMOUNT_STEP_MS);
    }

    this.writePlayerInput({ shift: false, jump: false });

    if (!dismounted && this.isRiding) {
      context.replyError('下来失败: 当前仍在骑乘状态');
      return;
    }

    context.replyInfo('已下来');
  }

  writePlayerInput(inputs) {
    if (!this.bot || !this.bot._client || typeof this.bot._client.write !== 'function') return;
    this.bot._client.write('player_input', { inputs: { ...inputs } });
  }

  async waitForLightweightMount(entityId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isRiding && this.ridingEntityId === entityId) return true;
      await sleep(50);
    }

    return this.isRiding && this.ridingEntityId === entityId;
  }

  async waitForLightweightDismount(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isRiding) return true;
      await sleep(50);
    }

    return !this.isRiding;
  }

  detach() {
    this.stopVehicleMovement();

    if (this.lightweightIndex) {
      this.lightweightIndex.detach();
      this.lightweightIndex = null;
    }

    for (const listener of this.listeners) {
      if (listener.target && typeof listener.target.removeListener === 'function') {
        listener.target.removeListener(listener.eventName, listener.handler);
      }
    }

    this.listeners = [];
    this.isRiding = false;
    this.ridingEntityId = null;
    this.pendingMountEntityId = null;
    this.rideInFlight = false;
    this.lightweight = false;
    this.bot = null;
  }

  getState() {
    return {
      isRiding: this.isRiding || Boolean(this.bot && this.bot.vehicle),
      ridingEntityId: this.ridingEntityId,
      mode: this.lightweight ? 'lightweight' : 'full'
    };
  }
}

module.exports = {
  RideFeature
};
