const { Vec3 } = require('vec3');

// 树场: 对"指定 xyz 的土块"持续右键, 默认每 2 游戏刻(100ms)尝试一次。
//
// 依据本地 vanilla 1.21.11 实测(见 .temp/treefarm-probe*.js):
//   1) 服务端不会把 block_place 从主手回退到副手 —— 用副手树苗种植必须显式 hand=1;
//   2) 树苗没有碰撞形状(shapes=[] / boundingBox=empty), mineflayer 的 blockAtCursor 打不到它,
//      而原版客户端的准星用的是选取框 —— 所以不能用射线判断"该点土块还是点树苗", 只能按坐标 +
//      上方那一格的状态决定;
//   3) 目标格上方是树苗时用主手(骨粉)催熟; 否则用副手(树苗)种下;
//   4) 服务端判定只用包里的 location, direction/cursor 不严格, 这里仍按真实客户端形态填。
const TICK_INTERVAL_MS = 100; // 每 2 游戏刻一次
const SAPLING_NAME_PATTERN = /_sapling$/;
const SOIL_BLOCK_NAMES = new Set([
  'dirt',
  'grass_block',
  'coarse_dirt',
  'rooted_dirt',
  'podzol',
  'mycelium',
  'moss_block',
  'mud',
  'muddy_mangrove_roots'
]);
const BLOCK_CHANGE_PACKETS = ['block_change', 'block_update'];

function positionKey(position) {
  return `${position.x},${position.y},${position.z}`;
}

class TreeFarmFeature {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.getSequence = typeof options.getSequence === 'function' ? options.getSequence : null;
    this.bot = null;
    this.listeners = [];
    this.timer = null;
    this.target = null;
    this.above = null;
    this.targetKey = null;
    this.aboveKey = null;
    this.blockCache = new Map();
    this.plantCount = 0;
    this.fertilizeCount = 0;
    this.unknownWarned = false;
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    if (!bot || !bot._client) return;

    for (const eventName of BLOCK_CHANGE_PACKETS) {
      this.addListener(bot._client, eventName, (packet) => this.onBlockChange(packet));
    }
    this.addListener(bot, 'end', () => this.stop());
  }

  detach() {
    this.stop();

    for (const listener of this.listeners) {
      if (listener.target && typeof listener.target.removeListener === 'function') {
        listener.target.removeListener(listener.eventName, listener.handler);
      }
    }

    this.listeners = [];
    this.blockCache.clear();
    this.bot = null;
  }

  addListener(target, eventName, handler) {
    if (!target || typeof target.on !== 'function') return;
    target.on(eventName, handler);
    this.listeners.push({ target, eventName, handler });
  }

  // ---------- 状态 ----------

  getState() {
    return {
      isRunning: this.isRunning(),
      target: this.target ? { x: this.target.x, y: this.target.y, z: this.target.z } : null,
      aboveName: this.above ? this.resolveBlockName(this.above) : null,
      plantCount: this.plantCount,
      fertilizeCount: this.fertilizeCount
    };
  }

  isRunning() {
    return this.timer !== null;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resolveBlockName(position) {
    const bot = this.bot;
    if (bot && typeof bot.blockAt === 'function') {
      try {
        const block = bot.blockAt(position);
        if (block && block.name) return block.name;
      } catch (error) {
        // 轻量模式没有世界数据, 落到缓存
      }
    }

    const cached = this.blockCache.get(positionKey(position));
    return cached === undefined ? null : cached;
  }

  onBlockChange(packet) {
    if (!packet || !packet.location || !this.target) return;

    const key = positionKey(packet.location);
    if (key !== this.targetKey && key !== this.aboveKey) return;

    const stateId = packet.type !== undefined ? packet.type : packet.blockId;
    const name = this.resolveStateName(stateId);
    if (!name) return;

    this.blockCache.set(key, name);
  }

  resolveStateName(stateId) {
    const registry = this.bot && this.bot.registry;
    const entry = registry && registry.blocksByStateId ? registry.blocksByStateId[stateId] : null;
    return entry && entry.name ? entry.name : null;
  }

  // ---------- 控制 ----------

  start(context, x, y, z) {
    if (!this.bot) {
      if (context) context.replyError('树场不可用: 未连接到服务器');
      return false;
    }

    const soilName = this.resolveBlockName(new Vec3(x, y, z));
    if (soilName && !SOIL_BLOCK_NAMES.has(soilName)) {
      if (context) context.replyError(`目标方块不是可种植的泥土类方块(当前: ${soilName})`);
      return false;
    }

    this.target = new Vec3(x, y, z);
    this.above = new Vec3(x, y + 1, z);
    this.targetKey = positionKey(this.target);
    this.aboveKey = positionKey(this.above);
    this.blockCache.clear();
    this.plantCount = 0;
    this.fertilizeCount = 0;
    this.unknownWarned = false;

    this.stop();
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    if (context) {
      const reachWarning = this.describeReachWarning();
      context.replyInfo(`树场已启动: 目标土块 (${x}, ${y}, ${z}), 上方 (${x}, ${y + 1}, ${z}); 每 2 游戏刻尝试一次${reachWarning}`);
    }
    if (this.logger) {
      this.logger.info(`[TREEFARM] start target=(${x},${y},${z}) interval=${TICK_INTERVAL_MS}ms`);
    }
    return true;
  }

  describeReachWarning() {
    const position = this.bot && this.bot.entity ? this.bot.entity.position : null;
    if (!position || !this.target) return '';

    const center = this.target.offset(0.5, 0.5, 0.5);
    const distance = position.distanceTo(center);
    if (distance <= 4.5) return '';
    return `; 注意: 当前距离约 ${distance.toFixed(2)} 格, 超过 4.5 格时服务端会忽略交互`;
  }

  // ---------- 每 2 游戏刻一次的动作 ----------

  tick() {
    // stop() 之后可能还有已排队的 tick, 这里必须再挡一次
    if (!this.isRunning() || !this.bot || !this.target || !this.above) return;

    const aboveName = this.resolveBlockName(this.above);
    if (aboveName === null) {
      if (!this.unknownWarned && this.logger) {
        this.unknownWarned = true;
        this.logger.warn('[TREEFARM] 尚未拿到目标格上方方块状态(轻量模式依赖 block_change 包), 先只尝试种植');
      }
    }

    // 只有明确识别为树苗时才用主手骨粉催熟
    if (aboveName && SAPLING_NAME_PATTERN.test(aboveName)) {
      this.writeBlockPlace(0, this.above);
      this.fertilizeCount += 1;
      return;
    }

    this.writeBlockPlace(1, this.target);
    this.plantCount += 1;
  }

  writeBlockPlace(hand, position) {
    const client = this.bot && this.bot._client;
    if (!client || typeof client.write !== 'function') return;

    const sequence = this.nextSequence();
    try {
      client.write('block_place', {
        hand,
        location: position,
        direction: 1,
        cursorX: 0.5,
        cursorY: 1,
        cursorZ: 0.5,
        insideBlock: false,
        worldBorderHit: false,
        sequence
      });
    } catch (error) {
      if (this.logger) {
        this.logger.warn(`[TREEFARM] 发送 block_place 失败: ${error.message}`);
      }
      return;
    }

    if (typeof this.bot.swingArm === 'function') {
      this.bot.swingArm();
    }
  }

  nextSequence() {
    if (this.getSequence) return this.getSequence();
    this.fallbackSequence = ((this.fallbackSequence || 0) + 1) % 32767;
    return this.fallbackSequence;
  }

  // ---------- 命令 ----------

  handleTreeFarmCommand(context, args = []) {
    const action = String(args[0] || 'status').trim().toLowerCase();

    if (action === 'start') {
      const x = Number(args[1]);
      const y = Number(args[2]);
      const z = Number(args[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        context.replyError('用法: treefarm start <x> <y> <z>');
        return true;
      }
      this.start(context, Math.floor(x), Math.floor(y), Math.floor(z));
      return true;
    }

    if (action === 'stop') {
      const wasRunning = this.isRunning();
      this.stop();
      if (this.logger && wasRunning) this.logger.info('[TREEFARM] stop');
      context.replyInfo(wasRunning ? '树场已停止' : '当前没有在运行树场');
      return true;
    }

    if (action === 'status' || action === '') {
      const state = this.getState();
      if (!state.isRunning) {
        context.replyInfo('树场: 未运行');
        return true;
      }

      const aboveText = state.aboveName === null ? '未知' : state.aboveName;
      context.replyInfo(
        `树场: 运行中 | 土块 (${state.target.x}, ${state.target.y}, ${state.target.z}) | 上方=${aboveText}`
        + ` | 种下=${state.plantCount} 催熟=${state.fertilizeCount}`
      );
      return true;
    }

    context.replyError('用法: treefarm start <x> <y> <z> | treefarm stop | treefarm status');
    return true;
  }
}

module.exports = {
  TreeFarmFeature,
  TICK_INTERVAL_MS,
  SOIL_BLOCK_NAMES
};
