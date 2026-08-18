const path = require('path');
const { Vec3 } = require('vec3');
const { loadRulesFile, matchContainer, normalizeItemName } = require('./rules');
const { getStoreForWarehouse } = require('./StoreRegistry');
const {
  getItemIdentityHash,
  getItemStackSize,
  sameItemIdentity
} = require('../features/window/itemIdentity');
const { isThinPassableBlock } = require('../util/pathfinding');
const { resolveWarehousePaths } = require('./paths');

const CONTAINER_INTERACTION_REACH = 4;

// 仓库分拣假人 feature。
// 能力:规则表加载/重载、开箱读取(inspect)、库存查询(query)、
//   分拣入库(sort,含背包自然拾取物品)、盘点(audit,可断点)、取出(withdraw)、
//   任务队列(task,排队/取消/断点恢复)。
// 数据与规则位置:WareHouse/<serverDir>/<warehouseId>/{warehouse.db, rules.json}
class WarehouseFeature {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.config = options.config || {};
    this.paths = options.paths || {};
    this.movementFeature = options.movementFeature || null;
    this.blockUseFeature = options.blockUseFeature || null;
    this.windowFeature = options.windowFeature || null;
    this.eventStream = options.eventStream || null;
    this.botId = options.botId || 'unknown';
    this.bot = null;
    this.hasSpawned = false;
    this.store = null;
    this.rules = null;
    this.rulesErrors = [];
    this.rulesFilePath = null;
    this.warehouseDir = null;
    this.taskRunning = false;
    this.stopRequested = false;
    this.cancelRequested = new Set();
    this.idleTimer = null;
    this.idleMoveTimer = null;
    this.scheduledTimer = null;
    this.spawnListener = null;
    this.pickupListener = null;
    this.windowPositions = new WeakMap();
    this.moveLogSequence = 0;
  }

  // 仅 multibot_bots 实例模式可用(需要 serverDir 定位共享数据目录)。
  isAvailable() {
    return Boolean(this.paths.serverDir);
  }

  getWarehouseServerDir() {
    if (this.paths.warehouseServerDir) {
      return this.paths.warehouseServerDir;
    }
    // 兼容直接构造 WarehouseFeature 的旧调用与测试；生产路径由 resolveBotPaths 提供。
    return this.paths.serverDir ? path.join(this.paths.serverDir, 'warehouse') : null;
  }

  getWarehousePaths() {
    const warehouseServerDir = this.getWarehouseServerDir();
    const rulesFile = typeof this.config.rulesFile === 'string' ? this.config.rulesFile : 'rules.json';
    return resolveWarehousePaths(warehouseServerDir, rulesFile);
  }

  getWarehouseDir() {
    const result = this.getWarehousePaths();
    return result.ok ? result.dataDir : null;
  }

  getRulesFilePath() {
    const result = this.getWarehousePaths();
    return result.ok ? result.rulesPath : null;
  }

  logInfo(message) {
    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(message);
    }
  }

  logWarn(message) {
    if (this.logger && typeof this.logger.warn === 'function') {
      this.logger.warn(message);
    }
  }

  publishWarehouse(type, data) {
    if (this.eventStream && typeof this.eventStream.publish === 'function') {
      this.eventStream.publish('warehouse', {
        botId: this.botId,
        serverDir: this.paths.serverDirName || null,
        timestamp: Date.now(),
        type,
        data
      });
    }
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    this.hasSpawned = false;

    if (!this.isAvailable()) {
      this.logWarn('[WAREHOUSE] 仓库功能需要 multibot_bots 实例模式(缺少 serverDir),已跳过');
      return;
    }

    this.reloadRules();
    this.stopRequested = false;
    this.recoverInterruptedTasks();
    this.spawnListener = () => this.handleSpawn();
    this.pickupListener = (collector) => this.handlePlayerCollect(collector);
    if (typeof bot.on === 'function') {
      bot.on('spawn', this.spawnListener);
      bot.on('playerCollect', this.pickupListener);
    }
    this.pump();
  }

  // 重新加载规则文件。返回 { ok, rules?, errors? }。
  reloadRules() {
    this.clearAutomationTimers();
    const warehousePaths = this.getWarehousePaths();
    if (!warehousePaths.ok) {
      this.rules = null;
      this.rulesErrors = [warehousePaths.error];
      this.rulesFilePath = null;
      this.warehouseDir = null;
      this.logWarn(`[WAREHOUSE] 规则路径无效: ${warehousePaths.error}`);
      return { ok: false, rules: null, errors: this.rulesErrors };
    }

    this.rulesFilePath = warehousePaths.rulesPath;
    this.warehouseDir = warehousePaths.dataDir;
    this.store = getStoreForWarehouse(this.warehouseDir, { logger: this.logger });
    const result = loadRulesFile(this.rulesFilePath);
    if (result.ok) {
      this.rules = result.rules;
      this.rulesErrors = [];
      this.logInfo(
        `[WAREHOUSE] 规则已加载: ${this.rules.containers.length} 个容器, ` +
        `${this.rules.inbox.length} 个暂存箱`
      );
      if (this.bot && !this.stopRequested) {
        this.startScheduledAutomation();
        const hasPendingTask = this.taskRunning || (
          this.store && this.store.listTasks({ status: ['queued', 'running'] }).length > 0
        );
        if (this.rules.idle.enabled && !hasPendingTask) {
          this.scheduleIdleMove();
        }
      }
      return { ok: true, rules: this.rules };
    }
    this.rules = null;
    this.rulesErrors = result.errors;
    this.logWarn(`[WAREHOUSE] 规则加载失败: ${result.errors.join('; ')}`);
    return result;
  }

  detach() {
    this.stopRequested = true;
    this.clearAutomationTimers();
    if (this.bot && typeof this.bot.removeListener === 'function') {
      if (this.spawnListener) this.bot.removeListener('spawn', this.spawnListener);
      if (this.pickupListener) this.bot.removeListener('playerCollect', this.pickupListener);
    }
    this.spawnListener = null;
    this.pickupListener = null;
    this.cancelRequested.clear();
    if (this.store && this.bot) {
      // 意外中断:进行中的任务标记 interrupted,保留进度供下次恢复
      const running = this.store.listTasks({ status: 'running' });
      for (const task of running) {
        this.store.updateTask(task.id, { status: 'interrupted' });
        this.publishTaskStatus(task.id);
      }
    }
    this.taskRunning = false;
    this.bot = null;
    this.hasSpawned = false;
    // store 为 server 级共享连接,不在此关闭;规则引用保留供 reload 比对
  }

  getLockedY() {
    const lockY = this.rules && this.rules.movement && this.rules.movement.lockY;
    return lockY && lockY.enabled === true && Number.isInteger(lockY.value)
      ? lockY.value
      : null;
  }

  clearAutomationTimers() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleMoveTimer) clearTimeout(this.idleMoveTimer);
    if (this.scheduledTimer) clearInterval(this.scheduledTimer);
    this.idleTimer = null;
    this.idleMoveTimer = null;
    this.scheduledTimer = null;
  }

  handleSpawn() {
    if (this.stopRequested || !this.bot) return;
    this.hasSpawned = true;
    if (!this.rules) return;
    this.startScheduledAutomation();
    if (this.rules.idle && this.rules.idle.enabled === true) {
      this.scheduleIdleMove();
    }
  }

  cancelScheduledIdleMove() {
    if (this.idleMoveTimer) clearTimeout(this.idleMoveTimer);
    this.idleMoveTimer = null;
  }

  scheduleIdleMove(delayMs = 1000) {
    this.cancelScheduledIdleMove();
    if (
      this.stopRequested
      || !this.bot
      || !this.hasSpawned
      || !this.rules
      || !this.rules.idle
      || this.rules.idle.enabled !== true
      || this.taskRunning
      || (this.store && this.store.listTasks({ status: ['queued', 'running'] }).length > 0)
    ) {
      return;
    }

    const bot = this.bot;
    this.idleMoveTimer = setTimeout(() => {
      this.idleMoveTimer = null;
      if (
        this.stopRequested
        || this.bot !== bot
        || this.taskRunning
        || (this.store && this.store.listTasks({ status: ['queued', 'running'] }).length > 0)
      ) {
        return;
      }
      void this.moveToIdlePosition();
    }, Math.max(0, delayMs));
  }

  handlePlayerCollect(collector) {
    const pickupSort = this.rules && this.rules.automation && this.rules.automation.pickupSort;
    if (
      this.stopRequested ||
      !this.bot ||
      !pickupSort ||
      pickupSort.enabled !== true ||
      !this.bot.entity ||
      collector !== this.bot.entity
    ) {
      return;
    }

    if (this.idleTimer) clearTimeout(this.idleTimer);
    const delayMs = Math.max(0, Number(pickupSort.delaySeconds) * 1000);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.enqueueAutomaticAction('sort', 'pickup');
    }, delayMs);
  }

  hasQueuedOrRunningTask(types) {
    if (!this.store) return false;
    const wanted = new Set(Array.isArray(types) ? types : [types]);
    return this.store.listTasks({ status: ['queued', 'running'] })
      .some((task) => wanted.has(task.type));
  }

  enqueueAutomaticAction(type, reason) {
    if (this.stopRequested || !this.store || !this.rules || this.hasQueuedOrRunningTask(type)) {
      return null;
    }
    try {
      const taskId = this.enqueueTask(type, {});
      this.logInfo(`[WAREHOUSE] 自动任务 #${taskId} 已入队 reason=${reason}`);
      return taskId;
    } catch (error) {
      this.logWarn(`[WAREHOUSE] 自动任务入队失败 reason=${reason}: ${error.message}`);
      return null;
    }
  }

  enqueueScheduledAction() {
    const scheduled = this.rules && this.rules.automation && this.rules.automation.scheduled;
    if (!scheduled || scheduled.enabled !== true || this.stopRequested || !this.rules) return;
    const action = scheduled.action || 'sortThenAudit';
    if (action === 'sortThenAudit') {
      if (this.hasQueuedOrRunningTask(['sort', 'audit'])) return;
      this.enqueueAutomaticAction('sort', 'scheduled');
      this.enqueueAutomaticAction('audit', 'scheduled');
      return;
    }
    this.enqueueAutomaticAction(action, 'scheduled');
  }

  startScheduledAutomation() {
    const scheduled = this.rules && this.rules.automation && this.rules.automation.scheduled;
    if (!scheduled || scheduled.enabled !== true || this.scheduledTimer) return;
    const intervalMs = Math.max(1000, Number(scheduled.intervalSeconds) * 1000);
    this.scheduledTimer = setInterval(() => this.enqueueScheduledAction(), intervalMs);
  }

  getContainerApproachPositions(x, y, z) {
    const lockY = this.getLockedY();
    const approachY = lockY === null
      ? (this.bot && this.bot.entity ? Math.floor(this.bot.entity.position.y) : y)
      : lockY;
    const offsets = [];
    if (lockY === null) {
      offsets.push([1, 0], [-1, 0], [0, 1], [0, -1]);
    } else {
      const radius = Math.ceil(CONTAINER_INTERACTION_REACH);
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        for (let offsetZ = -radius; offsetZ <= radius; offsetZ += 1) {
          offsets.push([offsetX, offsetZ]);
        }
      }
    }
    const positions = offsets
      .map(([offsetX, offsetZ]) => ({ x: x + offsetX, y: approachY, z: z + offsetZ }))
      .filter((position) => {
        if (position.x !== x || position.z !== z) return true;
        return y + 1 <= approachY || y >= approachY + 2;
      })
      .filter((position) => this.isWarehouseStandingSpaceOpen(position));
    const current = this.bot && this.bot.entity && this.bot.entity.position;
    if (!current) return positions;
    return positions.sort((left, right) => {
      const leftDistance = ((left.x - current.x) ** 2) + ((left.y - current.y) ** 2) + ((left.z - current.z) ** 2);
      const rightDistance = ((right.x - current.x) ** 2) + ((right.y - current.y) ** 2) + ((right.z - current.z) ** 2);
      return leftDistance - rightDistance;
    });
  }

  isWarehouseStandingSpaceOpen(position) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return true;
    const feet = this.bot.blockAt(new Vec3(position.x, position.y, position.z));
    const head = this.bot.blockAt(new Vec3(position.x, position.y + 1, position.z));
    const feetOpen = !feet || feet.boundingBox === 'empty' || isThinPassableBlock(feet);
    const headOpen = !head || head.boundingBox === 'empty';
    return feetOpen && headOpen;
  }

  getContainerInteractionDistance(position, x, y, z) {
    const eye = new Vec3(position.x + 0.5, position.y + 1.6, position.z + 0.5);
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const nearestPoint = new Vec3(
      clamp(eye.x, x, x + 1),
      clamp(eye.y, y, y + 1),
      clamp(eye.z, z, z + 1)
    );
    return eye.distanceTo(nearestPoint);
  }

  getLockedContainerApproachPositions(x, y, z) {
    const lockY = this.getLockedY();
    if (lockY === null) {
      return [];
    }

    const candidates = this.getContainerApproachPositions(x, y, z).filter((position) => {
      // Never ask pathfinder to stand inside the container block itself.
      if (position.x === x && position.y === y && position.z === z) {
        return false;
      }
      return this.getContainerInteractionDistance(position, x, y, z) <= CONTAINER_INTERACTION_REACH;
    });
    if (candidates.length === 0) {
      throw new Error(
        `容器 (${x}, ${y}, ${z}) 在锁定高度 y=${lockY} 上超出 ` +
        `${CONTAINER_INTERACTION_REACH} 格交互范围`
      );
    }
    return candidates;
  }

  getLockedContainerApproachPosition(x, y, z) {
    return this.getLockedContainerApproachPositions(x, y, z)[0] || null;
  }

  async ensureWarehouseLockedHeight(lockY) {
    if (lockY === null || !this.movementFeature) return;
    if (typeof this.movementFeature.waitForLockedHeightReady !== 'function') return;
    try {
      await this.movementFeature.waitForLockedHeightReady(lockY, 5000, 100);
      return;
    } catch (error) {
      if (typeof this.movementFeature.recoverLockedHeight !== 'function') {
        throw error;
      }
      const currentY = this.bot && this.bot.entity && this.bot.entity.position
        ? this.bot.entity.position.y
        : 'unknown';
      this.logWarn(
        `[WAREHOUSE][RECOVERY] 检测到锁定高度丢失 currentY=${currentY} lockY=${lockY}，开始自动恢复`
      );
      const result = await this.movementFeature.recoverLockedHeight(lockY);
      if (result && result.recovered && result.target) {
        this.logInfo(
          `[WAREHOUSE][RECOVERY] 已恢复锁定高度 x=${result.target.x} ` +
          `y=${result.target.y} z=${result.target.z} source=${result.target.source}`
        );
      }
    }
  }

  async moveToWarehousePosition(position) {
    if (!this.movementFeature) return;
    if (typeof this.movementFeature.waitForPhysicsReady === 'function') {
      await this.movementFeature.waitForPhysicsReady(5000, 100);
    }
    const lockY = this.getLockedY();
    await this.ensureWarehouseLockedHeight(lockY);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (typeof this.movementFeature.gotoExact === 'function') {
        this.movementFeature.gotoExact(position.x, position.y, position.z, [], { lockY });
      } else if (typeof this.movementFeature.goto === 'function') {
        this.movementFeature.goto(position.x, position.y, position.z, [], { lockY });
      }
      if (typeof this.movementFeature.awaitGoalReached !== 'function') {
        return;
      }
      try {
        await this.movementFeature.awaitGoalReached(this.bot, 30000, { lockY });
        return;
      } catch (error) {
        if (!error || error.message !== '寻路器卡住' || attempt > 0) {
          throw error;
        }
        this.logWarn('[WAREHOUSE][RECOVERY] 寻路器卡住，检查高度后重试目标一次');
        await this.ensureWarehouseLockedHeight(lockY);
      }
    }
  }

  isWarehouseContainerVisible(x, y, z) {
    if (
      this.blockUseFeature
      && typeof this.blockUseFeature.isBlockVisibleAt === 'function'
    ) {
      return this.blockUseFeature.isBlockVisibleAt(x, y, z);
    }
    return true;
  }

  async moveToWarehouseContainer(x, y, z) {
    if (!this.movementFeature) return;
    if (typeof this.movementFeature.waitForPhysicsReady === 'function') {
      await this.movementFeature.waitForPhysicsReady(5000, 100);
    }
    const lockY = this.getLockedY();
    await this.ensureWarehouseLockedHeight(lockY);
    if (lockY !== null) {
      const approaches = this.getLockedContainerApproachPositions(x, y, z);
      const deadline = Date.now() + 30000;
      let lastNoPathError = null;
      let lastVisibilityError = null;
      for (const approach of approaches) {
        if (typeof this.movementFeature.gotoExact === 'function') {
          this.movementFeature.gotoExact(approach.x, approach.y, approach.z, [], { lockY });
        } else if (typeof this.movementFeature.goto === 'function') {
          this.movementFeature.goto(approach.x, approach.y, approach.z, [], { lockY });
        }
        if (typeof this.movementFeature.awaitGoalReached !== 'function') {
          return;
        }
        try {
          await this.movementFeature.awaitGoalReached(
            this.bot,
            Math.max(1, deadline - Date.now()),
            { lockY }
          );
          if (this.isWarehouseContainerVisible(x, y, z)) {
            return;
          }
          lastVisibilityError = new Error(`目标容器被方块遮挡 (${x}, ${y}, ${z})`);
        } catch (error) {
          const retryable = error && ['寻路器未找到可达路径', '寻路器卡住'].includes(error.message);
          if (!retryable) {
            throw error;
          }
          if (error.message === '寻路器卡住') {
            this.logWarn('[WAREHOUSE][RECOVERY] 前往容器时卡住，检查高度并尝试下一站位');
            await this.ensureWarehouseLockedHeight(lockY);
          }
          lastNoPathError = error;
        }
      }
      throw lastVisibilityError || lastNoPathError || new Error('寻路器未找到可达路径');
    }
    if (typeof this.movementFeature.gotoLookAtBlock === 'function') {
      this.movementFeature.gotoLookAtBlock(x, y, z, [], {
        lockY,
        reach: CONTAINER_INTERACTION_REACH
      });
      if (typeof this.movementFeature.awaitGoalReached === 'function') {
        await this.movementFeature.awaitGoalReached(this.bot, 30000, { lockY });
      }
      if (this.isWarehouseContainerVisible(x, y, z)) {
        return;
      }
    }

    for (const fallbackPosition of this.getContainerApproachPositions(x, y, z)) {
      await this.moveToWarehousePosition(fallbackPosition);
      if (this.isWarehouseContainerVisible(x, y, z)) {
        return;
      }
    }
    throw new Error(`目标容器被方块遮挡 (${x}, ${y}, ${z})`);
  }

  async moveToIdlePosition() {
    const position = this.rules && this.rules.idle && this.rules.idle.position;
    if (
      !position
      || !this.bot
      || this.stopRequested
      || this.taskRunning
      || (this.store && this.store.listTasks({ status: ['queued', 'running'] }).length > 0)
    ) {
      return;
    }
    try {
      await this.moveToWarehousePosition(position);
      this.logInfo(`[WAREHOUSE] 已到达挂机位置 x=${position.x} y=${position.y} z=${position.z}`);
    } catch (error) {
      this.logWarn(`[WAREHOUSE] 前往挂机位置失败: ${error.message}`);
    }
  }

  stop() {
    this.detach();
  }

  // 恢复遗留任务:running/interrupted → queued(保留 progress 断点),重新排队。
  recoverInterruptedTasks() {
    if (!this.store) {
      return;
    }
    const stuck = this.store.listTasks({ status: ['running', 'interrupted'] });
    for (const task of stuck) {
      this.store.updateTask(task.id, { status: 'queued' });
      this.publishTaskStatus(task.id);
    }
    if (stuck.length > 0) {
      this.logInfo(`[WAREHOUSE] 已恢复 ${stuck.length} 个未完成任务(重新排队)`);
    }
  }

  // ---------- 开箱原语 ----------

  // 等待 bot 打开窗口,超时失败。
  waitForWindow(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const bot = this.bot;
      if (!bot || typeof bot.on !== 'function') {
        reject(new Error('bot 未连接'));
        return;
      }

      let settled = false;
      const finish = (error, window) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (typeof bot.removeListener === 'function') {
          bot.removeListener('windowOpen', onOpen);
        }
        if (error) {
          reject(error);
        } else {
          resolve(window);
        }
      };
      const onOpen = (window) => finish(null, window);
      bot.on('windowOpen', onOpen);
      const timer = setTimeout(() => finish(new Error(`等待开箱超时(${timeoutMs}ms)`)), timeoutMs);
    });
  }

  // 走到可看见且可交互容器的位置 → 交互开箱 → 返回窗口(不关闭)。
  async openContainerAt(x, y, z) {
    if (!this.bot) {
      throw new Error('bot 未连接');
    }

    if (!this.blockUseFeature || typeof this.blockUseFeature.openBlock !== 'function') {
      throw new Error('方块交互模块未初始化');
    }

    try {
      await this.moveToWarehouseContainer(x, y, z);
      await this.blockUseFeature.openBlock(x, y, z);
      const window = await this.waitForWindow(5000);
      if (window && typeof window === 'object') {
        this.windowPositions.set(window, { x, y, z });
      }
      return window;
    } catch (error) {
      await this.closeWindowSafe();
      if (this.movementFeature && typeof this.movementFeature.stop === 'function') {
        this.movementFeature.stop();
      }
      this.logWarn(`[WAREHOUSE] 容器交互失败 (${x}, ${y}, ${z}): ${error.message}`);
      throw new Error(`无法到达或打开容器 (${x}, ${y}, ${z}): ${error.message}`);
    }
  }

  // 走到容器 → 打开 → 读取快照 → 关闭。快照只保留容器区(排除 bot 背包区)。
  async openContainerAndRead(x, y, z) {
    const window = await this.openContainerAt(x, y, z);
    if (!this.windowFeature || typeof this.windowFeature.getCurrentSnapshot !== 'function') {
      await this.closeWindowSafe();
      throw new Error('窗口模块未初始化');
    }
    const snapshot = this.windowFeature.getCurrentSnapshot();
    await this.closeWindowSafe();

    const inventoryStart = Number.isInteger(snapshot.inventoryStart) ? snapshot.inventoryStart : 0;
    snapshot.slots = (snapshot.slots || []).filter((entry) => entry.slot < inventoryStart);
    return snapshot;
  }

  async closeWindowSafe() {
    if (this.windowFeature && typeof this.windowFeature.closeWindow === 'function') {
      try {
        await this.windowFeature.closeWindow();
      } catch (error) {
        // 关闭失败不掩盖主流程错误
      }
    }
  }

  // 将快照写入索引(注册容器 + 事务替换物品)。
  async writeContainerIndex(x, y, z, snapshot) {
    if (!this.store) {
      throw new Error('仓库存储未初始化');
    }

    const items = (snapshot.slots || []).map((entry) => ({
      slot: entry.slot,
      item_name: entry.name,
      display_name: entry.displayName,
      count: entry.count,
      metadata: entry.metadata,
      durability_used: entry.durabilityUsed,
      max_durability: entry.maxDurability,
      stack_identity: entry.stackIdentity
    }));

    const containerId = this.store.upsertContainer({
      x,
      y,
      z,
      type: snapshot.name,
      name: snapshot.name,
      calibratedAt: Date.now()
    });
    this.store.replaceContainerItems(containerId, items);
    return containerId;
  }

  // 重新读取某容器并刷新索引;返回 { ok, error? }。
  async refreshContainerIndex(x, y, z) {
    try {
      const snapshot = await this.openContainerAndRead(x, y, z);
      await this.writeContainerIndex(x, y, z, snapshot);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // ---------- 搬运原语(背包中转) ----------

  // 找玩家背包空槽,返回 bot.inventory 索引;打开容器时直接读取当前窗口的背包区。
  findInventoryFreeSlot(window = null) {
    const inventory = this.bot && this.bot.inventory;
    if (!inventory || !Array.isArray(inventory.slots)) {
      return null;
    }

    if (
      window
      && window !== inventory
      && Array.isArray(window.slots)
      && Number.isInteger(window.inventoryStart)
      && Number.isInteger(window.inventoryEnd)
    ) {
      const inventoryStart = Number.isInteger(inventory.inventoryStart) ? inventory.inventoryStart : 0;
      for (let windowSlot = window.inventoryStart; windowSlot < window.inventoryEnd; windowSlot += 1) {
        if (!window.slots[windowSlot]) {
          return inventoryStart + windowSlot - window.inventoryStart;
        }
      }
      return null;
    }

    const start = Number.isInteger(inventory.inventoryStart) ? inventory.inventoryStart : 0;
    const end = Number.isInteger(inventory.inventoryEnd) ? inventory.inventoryEnd : inventory.slots.length;
    for (let index = start; index < end; index += 1) {
      if (!inventory.slots[index]) {
        return index;
      }
    }
    return null;
  }

  findInventoryMergeSlot(window, sourceItem, count) {
    if (!window || !sourceItem || !Array.isArray(window.slots)) {
      return null;
    }
    const start = Number.isInteger(window.inventoryStart) ? window.inventoryStart : 0;
    const end = Number.isInteger(window.inventoryEnd) ? window.inventoryEnd : window.slots.length;
    const inventoryStart = this.bot && this.bot.inventory && Number.isInteger(this.bot.inventory.inventoryStart)
      ? this.bot.inventory.inventoryStart
      : 0;
    let firstMergeSlot = null;
    let capacity = 0;
    for (let slot = start; slot < end; slot += 1) {
      const target = window.slots[slot];
      if (
        target
        && sameItemIdentity(target, sourceItem)
        && target.count < getItemStackSize(sourceItem)
      ) {
        if (firstMergeSlot === null) {
          firstMergeSlot = slot;
        }
        capacity += getItemStackSize(sourceItem) - target.count;
      }
    }
    return capacity >= count && firstMergeSlot !== null
      ? inventoryStart + firstMergeSlot - start
      : null;
  }

  // 读取背包全部物品(自然拾取/遗留物)。返回 [{ invIndex, name, count, item }]。
  readBackpack() {
    const inventory = this.bot && this.bot.inventory;
    if (!inventory || !Array.isArray(inventory.slots)) {
      return [];
    }
    const out = [];
    const start = Number.isInteger(inventory.inventoryStart) ? inventory.inventoryStart : 0;
    const end = Number.isInteger(inventory.inventoryEnd) ? inventory.inventoryEnd : inventory.slots.length;
    for (let index = start; index < end; index += 1) {
      const item = inventory.slots[index];
      if (item && item.name) {
        out.push({ invIndex: index, name: item.name, count: item.count, item });
      }
    }
    return out;
  }

  formatMoveItem(item) {
    if (!item) {
      return 'empty';
    }
    const identity = getItemIdentityHash(item);
    return [
      `name=${item.name || 'unknown'}`,
      `count=${Number.isInteger(item.count) ? item.count : 'unknown'}`,
      `stackSize=${getItemStackSize(item)}`,
      `identity=${identity ? identity.slice(0, 12) : 'unknown'}`
    ].join(' ');
  }

  getMoveContainerLabel(window) {
    const position = window && typeof window === 'object' ? this.windowPositions.get(window) : null;
    return position ? `(${position.x},${position.y},${position.z})` : '(unknown)';
  }

  logMoveStart(direction, window, fromSlot, toSlot, item, count) {
    const id = ++this.moveLogSequence;
    const target = window && Array.isArray(window.slots) ? window.slots[toSlot] : null;
    const relation = !target
      ? 'empty'
      : (sameItemIdentity(target, item) ? 'same_identity' : 'different_identity');
    this.logInfo(
      `[WAREHOUSE][MOVE] id=${id} direction=${direction} ` +
      `container=${this.getMoveContainerLabel(window)} fromSlot=${fromSlot} toSlot=${toSlot} ` +
      `moveCount=${count} ${this.formatMoveItem(item)} target=${relation}`
    );
    return id;
  }

  logMoveResult(id, direction, window, fromSlot, toSlot, result, error = null) {
    const sourceAfter = window && Array.isArray(window.slots) ? window.slots[fromSlot] : null;
    const actualTargetSlot = result && Number.isInteger(result.destinationSlot)
      ? result.destinationSlot
      : toSlot;
    const targetAfter = window && Array.isArray(window.slots) ? window.slots[actualTargetSlot] : null;
    const restored = result && typeof result.restored === 'boolean' ? result.restored : null;
    const status = error || (result && result.ok === false) ? 'failed' : 'success';
    const message =
      `[WAREHOUSE][MOVE] id=${id} result=${status} direction=${direction} ` +
      `container=${this.getMoveContainerLabel(window)} restored=${restored === null ? 'n/a' : restored} ` +
      `destinationSlot=${result && Number.isInteger(result.destinationSlot) ? result.destinationSlot : 'n/a'} ` +
      `sourceAfter={${this.formatMoveItem(sourceAfter)}} targetAfter={${this.formatMoveItem(targetAfter)}}` +
      (error ? ` error=${error.message}` : '');
    if (status === 'failed') {
      this.logWarn(message);
    } else {
      this.logInfo(message);
    }
  }

  assertMoveSucceeded(result) {
    if (!result || result.ok !== false) {
      return;
    }
    if (result.restored === true) {
      throw new Error('服务器拒绝了槽位搬运，物品已恢复到源槽');
    }
    throw new Error('槽位搬运失败且未能恢复源槽，请立即检查光标物品与附近地面');
  }

  getWindowInventorySlot(window, inventoryIndex) {
    const windowStart = Number.isInteger(window && window.inventoryStart) ? window.inventoryStart : 0;
    const inventoryStart = this.bot && this.bot.inventory && Number.isInteger(this.bot.inventory.inventoryStart)
      ? this.bot.inventory.inventoryStart
      : 0;
    return windowStart + inventoryIndex - inventoryStart;
  }

  // 在当前打开的容器窗口中找目标槽:优先可合并,其次空槽;满则 null。
  findTargetSlot(window, itemOrName, count) {
    if (!window || !Array.isArray(window.slots)) {
      return null;
    }
    const end = Number.isInteger(window.inventoryStart) ? window.inventoryStart : window.slots.length;
    const sourceItem = itemOrName && typeof itemOrName === 'object' ? itemOrName : null;
    const normalized = String(sourceItem ? sourceItem.name : itemOrName || '').replace(/^minecraft:/, '');

    const stackSize = getItemStackSize(sourceItem);
    let firstMergeSlot = null;
    let firstEmptySlot = null;
    let capacity = 0;
    for (let index = 0; index < end; index += 1) {
      const item = window.slots[index];
      if (!item) {
        if (firstEmptySlot === null) {
          firstEmptySlot = index;
        }
        capacity += stackSize;
        continue;
      }
      const sameType = sourceItem
        ? sameItemIdentity(item, sourceItem)
        : String(item.name || '').replace(/^minecraft:/, '') === normalized;
      if (!sameType) {
        continue;
      }
      const maxStack = getItemStackSize(sourceItem || item);
      if (item.count < maxStack) {
        if (firstMergeSlot === null) {
          firstMergeSlot = index;
        }
        capacity += maxStack - item.count;
      }
    }
    if (capacity < count) {
      return null;
    }
    return firstMergeSlot === null ? firstEmptySlot : firstMergeSlot;
  }

  // 打开容器,把 fromSlot 槽位 count 件物品搬入背包空槽。
  // 返回 { invIndex, fromSlot };背包无空位抛错。
  async moveFromContainerToInventory(containerPos, fromSlot, count) {
    if (!this.windowFeature || typeof this.windowFeature.moveSlotItem !== 'function') {
      throw new Error('窗口模块未初始化');
    }

    const invIndex = this.findInventoryFreeSlot();
    if (invIndex === null) {
      throw new Error('背包没有空位');
    }

    const window = await this.openContainerAt(containerPos.x, containerPos.y, containerPos.z);
    try {
      return await this.moveFromContainerToInventoryInWindow(window, fromSlot, count, invIndex);
    } finally {
      await this.closeWindowSafe();
    }
  }

  // 在已打开的容器窗口中搬运一个背包空槽,调用方负责关闭窗口。
  async moveFromContainerToInventoryInWindow(window, fromSlot, count, invIndex = null) {
    const sourceItem = window.slots[fromSlot];
    let targetInventoryIndex = invIndex === null ? this.findInventoryFreeSlot(window) : invIndex;
    if (targetInventoryIndex === null) {
      targetInventoryIndex = this.findInventoryMergeSlot(window, sourceItem, count);
    }
    if (targetInventoryIndex === null) {
      throw new Error('背包没有可用空间');
    }
    const invSlot = this.getWindowInventorySlot(window, targetInventoryIndex);
    const moveId = this.logMoveStart('container->inventory', window, fromSlot, invSlot, sourceItem, count);
    let result;
    try {
      result = await this.windowFeature.moveSlotItem(
        fromSlot,
        invSlot,
        count,
        { preventSwap: true, quickMove: true }
      );
      this.logMoveResult(moveId, 'container->inventory', window, fromSlot, invSlot, result);
      this.assertMoveSucceeded(result);
    } catch (error) {
      if (!result || result.ok !== false) {
        this.logMoveResult(moveId, 'container->inventory', window, fromSlot, invSlot, result, error);
      }
      throw error;
    }
    const inventoryStart = Number.isInteger(this.bot.inventory && this.bot.inventory.inventoryStart)
      ? this.bot.inventory.inventoryStart
      : 0;
    const actualWindowSlot = result && Number.isInteger(result.destinationSlot)
      ? result.destinationSlot
      : invSlot;
    const actualInventoryIndex = actualWindowSlot - (Number.isInteger(window.inventoryStart) ? window.inventoryStart : 0) + inventoryStart;
    return { invIndex: actualInventoryIndex, fromSlot };
  }

  // 打开容器,把背包 invIndex 槽位 count 件物品放入目标槽。
  // preferredSlot 非空时直接放入该槽(用于放回暂存箱原槽);否则查找合并/空槽。
  // 返回目标槽位;容器满返回 null(物品留在背包,由调用方决定)。
  async moveFromInventoryToContainer(containerPos, invIndex, itemName, count, preferredSlot = null) {
    if (!this.windowFeature || typeof this.windowFeature.moveSlotItem !== 'function') {
      throw new Error('窗口模块未初始化');
    }

    const window = await this.openContainerAt(containerPos.x, containerPos.y, containerPos.z);
    try {
      return await this.moveFromInventoryToContainerInWindow(
        window,
        invIndex,
        itemName,
        count,
        preferredSlot
      );
    } finally {
      await this.closeWindowSafe();
    }
  }

  // 在已打开的容器窗口中搬运一个背包槽,调用方负责关闭窗口。
  async moveFromInventoryToContainerInWindow(window, invIndex, itemName, count, preferredSlot = null) {
    const invSlot = this.getWindowInventorySlot(window, invIndex);
    const sourceItem = window.slots[invSlot];
    if (!sourceItem) {
      throw new Error(`背包槽 ${invIndex} 为空`);
    }
    let targetSlot = preferredSlot !== null
      ? preferredSlot
      : this.findTargetSlot(window, sourceItem, count);
    if (preferredSlot !== null) {
      const preferredItem = window.slots[preferredSlot];
      if (preferredItem && !sameItemIdentity(preferredItem, sourceItem)) {
        targetSlot = this.findTargetSlot(window, sourceItem, count);
      }
    }
    if (targetSlot === null) {
      return null;
    }
    const quickMove = preferredSlot === null;
    const moveId = this.logMoveStart('inventory->container', window, invSlot, targetSlot, sourceItem, count);
    let result;
    try {
      result = await this.windowFeature.moveSlotItem(
        invSlot,
        targetSlot,
        count,
        { preventSwap: true, quickMove }
      );
      this.logMoveResult(moveId, 'inventory->container', window, invSlot, targetSlot, result);
      this.assertMoveSucceeded(result);
    } catch (error) {
      if (!result || result.ok !== false) {
        this.logMoveResult(moveId, 'inventory->container', window, invSlot, targetSlot, result, error);
      }
      throw error;
    }
    return result && Number.isInteger(result.destinationSlot) ? result.destinationSlot : targetSlot;
  }

  // 把背包 invIndex 槽位 count 件物品丢给附近玩家(toss)。
  tossItem(invIndex, count) {
    const item = this.bot && this.bot.inventory && this.bot.inventory.slots[invIndex];
    if (!item) {
      return Promise.reject(new Error(`背包槽 ${invIndex} 为空`));
    }
    return new Promise((resolve, reject) => {
      if (typeof this.bot.tossStack !== 'function') {
        reject(new Error('bot 不支持 tossStack'));
        return;
      }
      this.bot.tossStack(item.type, item.metadata, count, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  // ---------- 任务队列 ----------

  publishTaskStatus(taskId) {
    const task = this.store && this.store.getTask(taskId);
    if (!task) {
      return;
    }
    let progress = null;
    if (task.progress) {
      try {
        progress = JSON.parse(task.progress);
      } catch (error) {
        progress = null;
      }
    }
    this.publishWarehouse('task_status', {
      id: task.id,
      type: task.type,
      status: task.status,
      progress,
      error: task.error
    });
  }

  isCancelRequested(taskId) {
    return this.cancelRequested.has(taskId);
  }

  // 入队一个任务并立即尝试执行。返回任务 id。
  enqueueTask(type, payload) {
    if (!this.store) {
      throw new Error('仓库存储未初始化');
    }
    const taskId = this.store.createTask({ botId: this.botId, type, payload });
    this.publishTaskStatus(taskId);
    this.pump();
    return taskId;
  }

  // 串行执行队列:一次一个任务,直到队列清空或 stopRequested。
  async pump() {
    if (this.taskRunning || !this.store || !this.bot) {
      return;
    }
    this.taskRunning = true;
    try {
      while (!this.stopRequested) {
        const task = this.store.listTasks({ status: 'queued' })[0];
        if (!task) {
          break;
        }
        this.store.updateTask(task.id, { status: 'running' });
        this.publishTaskStatus(task.id);

        let result;
        try {
          result = await this.runTask(task);
        } catch (error) {
          result = { ok: false, error: error.message };
        }

        if (this.isCancelRequested(task.id)) {
          this.cancelRequested.delete(task.id);
          this.store.updateTask(task.id, { status: 'cancelled' });
          this.logInfo(`[WAREHOUSE] 任务 #${task.id} 已取消`);
        } else if (result && result.ok === false) {
          this.store.updateTask(task.id, { status: 'failed', error: result.error || '执行失败' });
          this.logWarn(`[WAREHOUSE] 任务 #${task.id} 失败: ${result.error || ''}`);
        } else {
          this.store.updateTask(task.id, { status: 'done' });
          this.logInfo(`[WAREHOUSE] 任务 #${task.id} 完成`);
          if (result) {
            if (Array.isArray(result.diffs) && result.diffs.length > 0) {
              this.publishWarehouse('audit_delta', { diffs: result.diffs });
              this.logWarn(`[WAREHOUSE] 任务 #${task.id} 盘点发现 ${result.diffs.length} 个容器与记录不一致`);
            }
            if (Array.isArray(result.errors) && result.errors.length > 0) {
              this.logWarn(`[WAREHOUSE] 任务 #${task.id} 部分失败: ${result.errors.join('; ')}`);
            }
            if (Array.isArray(result.stranded) && result.stranded.length > 0) {
              this.logWarn(`[WAREHOUSE] 任务 #${task.id} 滞留 ${result.stranded.length} 种物品`);
            }
          }
        }
        this.publishTaskStatus(task.id);
      }
    } finally {
      this.taskRunning = false;
      if (
        !this.stopRequested &&
        this.bot &&
        this.rules &&
        this.rules.idle &&
        this.rules.idle.enabled === true &&
        this.store &&
        this.store.listTasks({ status: 'queued' }).length === 0
      ) {
        this.scheduleIdleMove();
      }
    }
  }

  async runTask(task) {
    let payload = {};
    if (task.payload) {
      try {
        payload = JSON.parse(task.payload);
      } catch (error) {
        payload = {};
      }
    }

    switch (task.type) {
      case 'sort':
        return this.runSort(task);
      case 'audit':
        return this.runAudit(task, payload);
      case 'withdraw':
        return this.runWithdraw(task, payload);
      default:
        return { ok: false, error: `未知任务类型: ${task.type}` };
    }
  }

  // ---------- sort 分拣 ----------

  // 分拣:先清背包(自然拾取/遗留物品按规则入库),再处理暂存箱。
  async runSort(task) {
    if (!this.rules) {
      return { ok: false, error: `规则未加载: ${this.rulesErrors.join('; ')}` };
    }

    const moved = [];
    const stranded = [];
    const errors = [];
    const touched = new Set();

    // 1. 背包物品按目标容器分组,同一目标只开箱一次。
    const backpackGroups = new Map();
    for (const entry of this.readBackpack()) {
      if (this.isCancelRequested(task && task.id)) {
        return { ok: true, interrupted: true, moved, stranded, errors };
      }
      const match = matchContainer(this.rules, entry.name);
      if (!match) {
        stranded.push({ itemName: entry.name, count: entry.count, reason: '背包物品无匹配规则且无 default 箱' });
        continue;
      }
      const target = match.container;
      const key = `${target.x},${target.y},${target.z}`;
      touched.add(key);
      if (!backpackGroups.has(key)) {
        backpackGroups.set(key, { target, entries: [] });
      }
      backpackGroups.get(key).entries.push(entry);
    }

    for (const { target, entries } of backpackGroups.values()) {
      let window = null;
      try {
        window = await this.openContainerAt(target.x, target.y, target.z);
        for (const entry of entries) {
          if (this.isCancelRequested(task && task.id)) {
            return { ok: true, interrupted: true, moved, stranded, errors };
          }
          try {
            const current = this.bot.inventory && this.bot.inventory.slots
              ? this.bot.inventory.slots[entry.invIndex]
              : null;
            if (!current) {
              continue;
            }
            const targetSlot = await this.moveFromInventoryToContainerInWindow(
              window,
              entry.invIndex,
              current.name,
              current.count
            );
            if (targetSlot === null) {
              stranded.push({ itemName: current.name, count: current.count, reason: `目标箱(${target.name})已满` });
              continue;
            }
            moved.push({ itemName: current.name, count: current.count, containerName: target.name });
          } catch (error) {
            errors.push(`搬运背包物品 ${entry.name} 失败: ${error.message}`);
          }
        }
      } catch (error) {
        for (const entry of entries) {
          errors.push(`搬运背包物品 ${entry.name} 失败: ${error.message}`);
        }
      } finally {
        if (window) {
          await this.closeWindowSafe();
        }
      }
    }

    // 2. 暂存箱按目标容器分批搬运:每批从暂存箱装入背包,再一次性送往目标箱。
    for (const inboxPos of this.rules.inbox || []) {
      touched.add(`${inboxPos.x},${inboxPos.y},${inboxPos.z}`);

      const blockedSlots = new Set();
      const unmatchedSlots = new Set();
      while (!this.stopRequested) {
        const transfers = [];
        let sourceOpenFailed = false;
        let inboxWindow = null;
        try {
          inboxWindow = await this.openContainerAt(inboxPos.x, inboxPos.y, inboxPos.z);
          const inventoryEnd = Number.isInteger(inboxWindow.inventoryStart)
            ? inboxWindow.inventoryStart
            : inboxWindow.slots.length;
          for (let slot = 0; slot < inventoryEnd; slot += 1) {
            if (this.isCancelRequested(task && task.id)) {
              return { ok: true, interrupted: true, moved, stranded, errors };
            }
            const current = inboxWindow.slots[slot];
            if (!current || blockedSlots.has(slot)) {
              continue;
            }
            const match = matchContainer(this.rules, current.name);
            if (!match) {
              if (!unmatchedSlots.has(slot)) {
                unmatchedSlots.add(slot);
                stranded.push({
                  itemName: current.name,
                  count: current.count,
                  reason: '无匹配规则且无 default 箱'
                });
              }
              continue;
            }
            const target = match.container;
            const key = `${target.x},${target.y},${target.z}`;
            touched.add(key);
            try {
              const transfer = await this.moveFromContainerToInventoryInWindow(
                inboxWindow,
                slot,
                current.count
              );
              transfers.push({
                ...transfer,
                target,
                item: { name: current.name, count: current.count, slot }
              });
            } catch (error) {
              if (error.message === '背包没有空位') {
                break;
              }
              errors.push(`从暂存箱搬运 ${current.name} 失败: ${error.message}`);
            }
          }
        } catch (error) {
          sourceOpenFailed = true;
          errors.push(`读取暂存箱失败 (${inboxPos.x}, ${inboxPos.y}, ${inboxPos.z}): ${error.message}`);
        } finally {
          if (inboxWindow) {
            await this.closeWindowSafe();
          }
        }

        if (sourceOpenFailed || transfers.length === 0) {
          break;
        }

        const groupedTransfers = new Map();
        for (const transfer of transfers) {
          const key = `${transfer.target.x},${transfer.target.y},${transfer.target.z}`;
          if (!groupedTransfers.has(key)) {
            groupedTransfers.set(key, { target: transfer.target, transfers: [] });
          }
          groupedTransfers.get(key).transfers.push(transfer);
        }

        const restore = [];
        const successfulSlots = new Set();
        const fullSlots = new Set();
        for (const { target, transfers: targetTransfers } of groupedTransfers.values()) {
          let targetWindow = null;
          try {
            targetWindow = await this.openContainerAt(target.x, target.y, target.z);
            for (const transfer of targetTransfers) {
              const { item, invIndex } = transfer;
              try {
                const targetSlot = await this.moveFromInventoryToContainerInWindow(
                  targetWindow,
                  invIndex,
                  item.name,
                  item.count
                );
                if (targetSlot === null) {
                  restore.push(transfer);
                  fullSlots.add(item.slot);
                  stranded.push({
                    itemName: item.name,
                    count: item.count,
                    reason: `目标箱(${target.name})已满`
                  });
                  continue;
                }
                successfulSlots.add(item.slot);
                moved.push({ itemName: item.name, count: item.count, containerName: target.name });
              } catch (error) {
                restore.push(transfer);
                errors.push(`搬运 ${item.name} 失败: ${error.message}`);
              }
            }
          } catch (error) {
            restore.push(...targetTransfers);
            errors.push(`打开目标箱(${target.name})失败: ${error.message}`);
          } finally {
            if (targetWindow) {
              await this.closeWindowSafe();
            }
          }
        }

        if (restore.length > 0) {
          let restoreWindow = null;
          try {
            restoreWindow = await this.openContainerAt(inboxPos.x, inboxPos.y, inboxPos.z);
            for (const { item, invIndex } of restore) {
              await this.moveFromInventoryToContainerInWindow(
                restoreWindow,
                invIndex,
                item.name,
                item.count,
                item.slot
              );
            }
          } catch (error) {
            errors.push(`物品放回暂存箱失败: ${error.message}`);
            break;
          } finally {
            if (restoreWindow) {
              await this.closeWindowSafe();
            }
          }
        }

        for (const slot of fullSlots) {
          blockedSlots.add(slot);
        }
        if (successfulSlots.size === 0) {
          break;
        }
      }
    }

    const residual = this.readBackpack();
    if (residual.length > 0) {
      const summary = residual.map((entry) => (
        `slot=${entry.invIndex} ${this.formatMoveItem(entry.item)}`
      )).join('; ');
      this.logWarn(`[WAREHOUSE][SORT] 任务 #${task && task.id ? task.id : 'unknown'} 背包残留: ${summary}`);
    } else {
      this.logInfo(`[WAREHOUSE][SORT] 任务 #${task && task.id ? task.id : 'unknown'} 背包无残留物品`);
    }

    // 3. 刷新涉及容器索引
    for (const key of touched) {
      const [x, y, z] = key.split(',').map((value) => Number.parseInt(value, 10));
      const result = await this.refreshContainerIndex(x, y, z);
      if (!result.ok) {
        errors.push(`更新索引失败 (${key}): ${result.error}`);
      }
    }

    return { ok: true, moved, stranded, errors, residual };
  }

  // ---------- audit 盘点 ----------

  // 盘点规则容器,与库比对,以实际为准修正。支持断点续盘(progress.nextIndex)。
  async runAudit(task, payload) {
    if (!this.rules) {
      return { ok: false, error: `规则未加载: ${this.rulesErrors.join('; ')}` };
    }

    const containers = this.rules.containers;
    if (containers.length === 0) {
      return { ok: false, error: '规则中没有容器可盘点' };
    }

    const targetName = payload.containerName || null;
    const startIndex = targetName
      ? 0
      : this.getTaskProgressNextIndex(task) || 0;
    const diffs = [];
    let audited = 0;

    for (let index = startIndex; index < containers.length; index += 1) {
      if (this.isCancelRequested(task.id)) {
        // 保存断点,返回中断标记
        this.store.updateTask(task.id, { progress: { nextIndex: index, done: audited, total: containers.length } });
        return { ok: true, interrupted: true, diffs };
      }

      const container = containers[index];
      if (targetName && container.name !== targetName) {
        continue;
      }

      try {
        const snapshot = await this.openContainerAndRead(container.x, container.y, container.z);
        const actual = (snapshot.slots || []).map((entry) => ({
          slot: entry.slot,
          item_name: entry.name,
          display_name: entry.displayName,
          count: entry.count,
          metadata: entry.metadata,
          durability_used: entry.durabilityUsed,
          max_durability: entry.maxDurability,
          stack_identity: entry.stackIdentity
        }));

        const containerId = this.store.upsertContainer({
          x: container.x,
          y: container.y,
          z: container.z,
          type: snapshot.name,
          name: container.name,
          calibratedAt: Date.now()
        });
        const dbItems = this.store.getItemsByContainer(containerId);
        const containerDiffs = this.compareItems(dbItems, actual);
        if (containerDiffs.length > 0) {
          diffs.push({ containerName: container.name, diffs: containerDiffs });
        }
        this.store.replaceContainerItems(containerId, actual);
        this.store.updateContainerMeta(containerId, { last_audited_at: Date.now() });
        audited += 1;

        if (!targetName) {
          this.store.updateTask(task.id, {
            progress: { nextIndex: index + 1, done: audited, total: containers.length }
          });
        }
      } catch (error) {
        if (targetName) {
          return { ok: false, error: `盘点 ${container.name} 失败: ${error.message}` };
        }
        diffs.push({ containerName: container.name, diffs: [{ error: error.message }] });
      }
    }

    return { ok: true, diffs };
  }

  getTaskProgressNextIndex(task) {
    if (!task || !task.progress) {
      return null;
    }
    try {
      const progress = JSON.parse(task.progress);
      return Number.isInteger(progress.nextIndex) ? progress.nextIndex : null;
    } catch (error) {
      return null;
    }
  }

  // 与库中记录比对,返回差异列表 [{ slot, itemName, before, after }]。
  compareItems(dbItems, actual) {
    const diffs = [];
    const dbMap = new Map(dbItems.map((entry) => [entry.slot, entry]));
    const actualMap = new Map(actual.map((entry) => [entry.slot, entry]));

    for (const [slot, entry] of actualMap) {
      const before = dbMap.get(slot);
      const beforeDesc = before ? `${before.item_name}×${before.count}` : '空';
      const afterDesc = `${entry.item_name}×${entry.count}`;
      const basicChanged = !before || before.item_name !== entry.item_name || before.count !== entry.count;
      const identityKnown = before && typeof before.stack_identity === 'string' && before.stack_identity.length > 0;
      const identityChanged = identityKnown && before.stack_identity !== entry.stack_identity;
      if (basicChanged || identityChanged) {
        diffs.push({
          slot,
          itemName: entry.item_name,
          before: beforeDesc,
          after: afterDesc,
          reason: identityChanged && !basicChanged ? 'components_changed' : 'item_changed'
        });
      }
    }
    for (const [slot, entry] of dbMap) {
      if (!actualMap.has(slot)) {
        diffs.push({ slot, itemName: entry.item_name, before: `${entry.item_name}×${entry.count}`, after: '空' });
      }
    }
    return diffs;
  }

  // ---------- withdraw 取出 ----------

  async runWithdraw(task, payload) {
    const itemName = normalizeItemName(payload.itemName);
    if (!itemName) {
      return { ok: false, error: '缺少物品名' };
    }
    const count = payload.count === null || payload.count === undefined ? null : Number(payload.count);
    const sender = payload.sender || null;

    const rows = this.store.queryItemsByName(itemName);
    if (rows.length === 0) {
      return { ok: false, error: `库存中没有 ${itemName}` };
    }

    let remaining = count === null || !Number.isFinite(count) || count <= 0 ? Infinity : count;
    const taken = [];

    for (const row of rows) {
      if (remaining <= 0) {
        break;
      }
      const take = Math.min(remaining, row.count);
      const invIndex = this.findInventoryFreeSlot();
      if (invIndex === null) {
        break;
      }

      try {
        const window = await this.openContainerAt(row.x, row.y, row.z);
        const invSlot = this.getWindowInventorySlot(window, invIndex);
        await this.windowFeature.moveSlotItem(row.slot, invSlot, take);
        await this.closeWindowSafe();
        taken.push({ invIndex, count: take });
        remaining -= take;
        await this.refreshContainerIndex(row.x, row.y, row.z);
      } catch (error) {
        await this.closeWindowSafe();
        return { ok: false, error: `从容器取出失败: ${error.message}` };
      }
    }

    if (taken.length === 0) {
      return { ok: false, error: '背包无空位,无法取出' };
    }
    const totalTaken = taken.reduce((sum, entry) => sum + entry.count, 0);

    // 交付:优先取货箱,其次交给请求者,兜底留在背包
    if (this.rules && this.rules.pickup) {
      for (const entry of taken) {
        await this.moveFromInventoryToContainer(
          this.rules.pickup,
          entry.invIndex,
          itemName,
          entry.count
        );
      }
      return { ok: true, deliveredTo: 'pickup', count: totalTaken };
    }

    if (sender && this.bot.players && this.bot.players[sender] && this.bot.players[sender].entity) {
      const playerPos = this.bot.players[sender].entity.position;
      const lockY = this.getLockedY();
      if (this.movementFeature && typeof this.movementFeature.goto === 'function') {
        this.movementFeature.goto(playerPos.x, playerPos.y, playerPos.z, [], { lockY });
      }
      if (this.movementFeature && typeof this.movementFeature.awaitGoalReached === 'function') {
        await this.movementFeature.awaitGoalReached(this.bot, 30000, { lockY });
      }
      for (const entry of taken) {
        await this.tossItem(entry.invIndex, entry.count);
      }
      return { ok: true, deliveredTo: `player:${sender}`, count: totalTaken };
    }

    return {
      ok: true,
      deliveredTo: 'backpack',
      count: totalTaken,
      note: '物品在 bot 背包,请靠近领取(可配置 pickup 取货箱自动投递)'
    };
  }

  // ---------- 命令入口 ----------

  async handleWarehouseCommand(context, trimmed) {
    if (!this.isAvailable()) {
      context.replyError('当前实例不支持仓库功能(需要 multibot_bots 实例模式)');
      return;
    }
    const args = String(trimmed || '').split(/\s+/).slice(1);
    const subCommand = (args[0] || 'help').toLowerCase();

    if (['inspect', 'sort', 'audit', 'withdraw'].includes(subCommand)) {
      this.cancelScheduledIdleMove();
    }

    try {
      switch (subCommand) {
        case 'help':
          this.replyHelp(context);
          break;
        case 'rules':
          this.replyRules(context);
          break;
        case 'reload':
          this.handleReload(context);
          break;
        case 'inspect':
          await this.handleInspect(context, args.slice(1));
          this.scheduleIdleMove();
          break;
        case 'query':
          this.handleQuery(context, args.slice(1));
          break;
        case 'sort':
          this.handleSortCommand(context);
          break;
        case 'audit':
          this.handleAuditCommand(context, args.slice(1));
          break;
        case 'withdraw':
          this.handleWithdrawCommand(context, args.slice(1));
          break;
        case 'task':
          await this.handleTaskCommand(context, args.slice(1));
          break;
        default:
          context.replyError(`未知子命令: ${subCommand}，使用 warehouse help 查看帮助`);
          break;
      }
    } catch (error) {
      context.replyError(`warehouse 命令执行出错: ${error.message}`);
    }
  }

  replyHelp(context) {
    context.replyInfo('warehouse <help|rules|reload|inspect|query|sort|audit|withdraw|task>');
    context.replyInfo('  warehouse rules - 查看当前规则摘要');
    context.replyInfo('  warehouse reload - 重新加载 rules.json');
    context.replyInfo('  warehouse inspect <x> <y> <z> - 开箱读取并写入索引');
    context.replyInfo('  warehouse query [物品名] - 库存汇总或按物品查询');
    context.replyInfo('  warehouse sort - 入队分拣任务(暂存箱+背包→规则箱)');
    context.replyInfo('  warehouse audit [箱名] - 入队盘点任务(对照游戏实际修正索引)');
    context.replyInfo('  warehouse withdraw <物品> [数量] - 入队取出任务');
    context.replyInfo('  warehouse task list - 查看任务队列');
    context.replyInfo('  warehouse task cancel <id> - 取消任务');
  }

  replyRules(context) {
    if (!this.rules) {
      context.replyError(`规则未加载: ${this.rulesErrors.join('; ')}`);
      return;
    }
    context.replyInfo(
      `规则: ${this.rules.containers.length} 个容器, ` +
      `${(this.rules.inbox || []).length} 个暂存箱, ` +
      `dropZone=${this.rules.dropZone ? '有' : '无'}, pickup=${this.rules.pickup ? '有' : '无'}`
    );
    const defaultBox = this.rules.containers.find((entry) => entry.default);
    if (defaultBox) {
      context.replyInfo(`杂项(default)箱: ${defaultBox.name} (${defaultBox.x}, ${defaultBox.y}, ${defaultBox.z})`);
    }
    const allowCount = this.rules.containers.filter((entry) => entry.allow.length > 0).length;
    context.replyInfo(`带 allow 白名单的容器: ${allowCount} 个`);
    context.replyInfo(
      `运行设置: lockY=${this.rules.movement.lockY.enabled ? this.rules.movement.lockY.value : '关闭'}, ` +
      `idle=${this.rules.idle.enabled ? '开启' : '关闭'}, ` +
      `pickupSort=${this.rules.automation.pickupSort.enabled ? '开启' : '关闭'}, ` +
      `scheduled=${this.rules.automation.scheduled.enabled ? '开启' : '关闭'}`
    );
  }

  handleReload(context) {
    const result = this.reloadRules();
    if (result.ok) {
      context.replyInfo(
        `规则已重载: ${result.rules.containers.length} 个容器, ${(result.rules.inbox || []).length} 个暂存箱`
      );
    } else {
      context.replyError(`规则重载失败: ${result.errors.join('; ')}`);
    }
  }

  async handleInspect(context, args) {
    if (args.length !== 3) {
      context.replyError('用法: warehouse inspect <x> <y> <z>');
      return;
    }

    const [x, y, z] = args.map((value) => Number.parseInt(value, 10));
    if ([x, y, z].some((value) => Number.isNaN(value))) {
      context.replyError('坐标必须是数字');
      return;
    }

    if (!this.bot) {
      context.replyError('bot 未连接');
      return;
    }

    try {
      context.replyInfo(`正在检查容器 (${x}, ${y}, ${z})...`);
      const snapshot = await this.openContainerAndRead(x, y, z);
      const containerId = await this.writeContainerIndex(x, y, z, snapshot);

      const items = snapshot.slots || [];
      const totalCount = items.reduce((sum, entry) => sum + (entry.count || 0), 0);
      context.replyInfo(`容器 ${snapshot.name}: ${items.length} 个物品格, 共 ${totalCount} 件, 已写入索引`);

      for (const entry of items.slice(0, 10)) {
        context.replyInfo(`  [${entry.slot}] ${entry.displayName || entry.name}×${entry.count}`);
      }
      if (items.length > 10) {
        context.replyInfo(`  ... 其余 ${items.length - 10} 格`);
      }
    } catch (error) {
      context.replyError(`检查容器失败: ${error.message}`);
    }
  }

  handleQuery(context, args) {
    if (!this.store) {
      context.replyError('仓库存储未初始化');
      return;
    }

    if (args.length === 0) {
      const summary = this.store.summarize();
      if (summary.length === 0) {
        context.replyInfo('仓库为空');
        return;
      }
      context.replyInfo(`共 ${summary.length} 种物品:`);
      for (const entry of summary.slice(0, 20)) {
        context.replyInfo(`  ${entry.itemName}×${entry.total} (${entry.containerCount} 箱)`);
      }
      if (summary.length > 20) {
        context.replyInfo(`  ... 其余 ${summary.length - 20} 种`);
      }
      return;
    }

    const itemName = normalizeItemName(args[0]);
    const rows = this.store.queryItemsByName(itemName);
    if (rows.length === 0) {
      context.replyInfo(`仓库中没有 ${itemName}`);
      return;
    }
    const total = rows.reduce((sum, entry) => sum + entry.count, 0);
    context.replyInfo(`${itemName}: 共 ${total} 件,分布在 ${rows.length} 个槽位:`);
    for (const row of rows.slice(0, 10)) {
      context.replyInfo(`  (${row.x}, ${row.y}, ${row.z}) [${row.slot}] ×${row.count}`);
    }
    if (rows.length > 10) {
      context.replyInfo(`  ... 其余 ${rows.length - 10} 个槽位`);
    }
  }

  handleSortCommand(context) {
    if (!this.store) {
      context.replyError('仓库存储未初始化');
      return;
    }
    if (!this.rules) {
      context.replyError(`规则未加载: ${this.rulesErrors.join('; ')}`);
      return;
    }
    try {
      const taskId = this.enqueueTask('sort', {});
      context.replyInfo(`分拣任务 #${taskId} 已入队`);
    } catch (error) {
      context.replyError(`入队失败: ${error.message}`);
    }
  }

  handleAuditCommand(context, args) {
    if (!this.store) {
      context.replyError('仓库存储未初始化');
      return;
    }
    if (!this.rules) {
      context.replyError(`规则未加载: ${this.rulesErrors.join('; ')}`);
      return;
    }
    const containerName = args.length > 0 ? args.join(' ') : null;
    try {
      const taskId = this.enqueueTask('audit', { containerName });
      context.replyInfo(`盘点任务 #${taskId} 已入队${containerName ? ` (${containerName})` : ''}`);
    } catch (error) {
      context.replyError(`入队失败: ${error.message}`);
    }
  }

  handleWithdrawCommand(context, args) {
    if (!this.store) {
      context.replyError('仓库存储未初始化');
      return;
    }
    if (args.length === 0) {
      context.replyError('用法: warehouse withdraw <物品名> [数量]');
      return;
    }
    let count = null;
    if (args.length >= 2) {
      const parsed = Number.parseInt(args[1], 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        context.replyError('数量必须是 >= 1 的数字');
        return;
      }
      count = parsed;
    }
    const sender = context && context.sender ? context.sender : null;
    try {
      const taskId = this.enqueueTask('withdraw', { itemName: args[0], count, sender });
      context.replyInfo(`取出任务 #${taskId} 已入队: ${args[0]}${count ? ` ×${count}` : ''}`);
    } catch (error) {
      context.replyError(`入队失败: ${error.message}`);
    }
  }

  async handleTaskCommand(context, args) {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'list') {
      const tasks = this.store.listTasks();
      if (tasks.length === 0) {
        context.replyInfo('任务队列为空');
        return;
      }
      context.replyInfo(`任务队列共 ${tasks.length} 条:`);
      for (const task of tasks.slice(-20)) {
        context.replyInfo(`  #${task.id} [${task.type}] ${task.status}${task.error ? `: ${task.error}` : ''}`);
      }
      return;
    }

    if (sub === 'cancel') {
      const id = Number.parseInt(args[1], 10);
      if (!Number.isInteger(id)) {
        context.replyError('用法: warehouse task cancel <任务id>');
        return;
      }
      const task = this.store.getTask(id);
      if (!task) {
        context.replyError(`任务 #${id} 不存在`);
        return;
      }
      if (task.status === 'queued') {
        this.store.updateTask(id, { status: 'cancelled' });
        this.publishTaskStatus(id);
        context.replyInfo(`任务 #${id} 已取消`);
        return;
      }
      if (task.status === 'running') {
        this.cancelRequested.add(id);
        context.replyInfo(`正在请求取消任务 #${id}(将在当前步骤完成后生效)`);
        return;
      }
      context.replyInfo(`任务 #${id} 当前状态为 ${task.status},无需取消`);
      return;
    }

    context.replyError('用法: warehouse task <list|cancel>');
  }
}

module.exports = {
  WarehouseFeature
};
