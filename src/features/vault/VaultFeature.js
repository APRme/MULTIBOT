const path = require('path');
const { requireFresh } = require('../../util/requireFresh');
const { replyLinesSpaced } = require('../../util/replySpacing');

// 宝库方块状态的解码依据(1.21.x/26.2 实测): vault 共 32 个状态,
// vault_state 是变化最快的属性, 因此 (stateId - minStateId) % 4 即为状态序号。
// 优先从 bot.registry 读取 minStateId, 拿不到时退回实测值。
const VAULT_STATE_ORDER = ['inactive', 'active', 'unlocking', 'ejecting'];
const VAULT_MIN_STATE_ID_FALLBACK = 29467;
const DEFAULT_ACTIVATE_TIMEOUT_MS = 2000;
const KEY_ITEM_CANDIDATES = ['trial_key', 'ominous_trial_key'];
const BLOCK_CHANGE_PACKETS = ['block_change', 'block_update'];

function parseCoordinates(args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  if (args.length !== 3) return 'invalid';

  const values = args.map((value) => Number(String(value).trim()));
  if (values.some((value) => !Number.isFinite(value))) return 'invalid';

  return {
    x: Math.floor(values[0]),
    y: Math.floor(values[1]),
    z: Math.floor(values[2])
  };
}

function decodeVaultState(stateId, minStateId) {
  if (!Number.isFinite(stateId) || !Number.isFinite(minStateId)) return null;
  const index = (((stateId - minStateId) % 4) + 4) % 4;
  return VAULT_STATE_ORDER[index] || null;
}

class VaultFeature {
  constructor(options = {}) {
    this.paths = options.paths || {};
    this.logger = options.logger;
    this.getSequence = typeof options.getSequence === 'function' ? options.getSequence : null;
    this.getCapabilities = typeof options.getCapabilities === 'function' ? options.getCapabilities : null;
    this.activateTimeoutMs = Number.isFinite(options.activateTimeoutMs)
      ? Math.max(50, Math.trunc(options.activateTimeoutMs))
      : DEFAULT_ACTIVATE_TIMEOUT_MS;
    this.impl = null;
    this.bot = null;
    this.fallbackSequence = 0;
    this.lastVault = null;
    this.queueConfig = { targets: [], settleMs: 1200, delayMs: 8000, backAtEnd: true, at: null };
    this.queueRunning = false;
    this.queueCancelled = false;
    this.queueWake = null;
  }

  // 完整模式(有区块/实体数据)才加载遗留模块: 它会 loadPlugin(pathfinder), 轻量模式不可用。
  hasTerrainData(bot = this.bot) {
    return Boolean(
      bot &&
      typeof bot.blockAt === 'function' &&
      typeof bot.findBlock === 'function'
    );
  }

  // 按运行时能力开关判定是否完整模式; 没有注入能力时退回探测 bot 方法。
  // 注意: 探测 bot.blockAt/findBlock 不可靠(插件可能延迟装配), 能力开关才是权威。
  isFullMode() {
    if (this.getCapabilities) {
      const caps = this.getCapabilities() || {};
      return Boolean(caps.entityHandling) && Boolean(caps.terrainHandling);
    }

    return this.hasTerrainData(this.bot);
  }

  attach(bot) {
    this.stop();
    this.bot = bot;

    if (!this.isFullMode()) {
      return;
    }

    const legacyModulesDir = this.paths.legacyModulesDir || path.resolve(__dirname, '..', '..', 'legacy', 'assn');
    const modulePath = path.join(legacyModulesDir, 'trial.js');
    this.impl = requireFresh(modulePath);
    this.impl.initTrial(bot);
  }

  handleCommand(context, args = []) {
    const coordinates = parseCoordinates(args);

    if (coordinates === 'invalid') {
      context.replyError('用法: vault [x y z]');
      return;
    }

    if (coordinates) {
      this.activateByCoordinates(context, coordinates).catch((error) => {
        context.replyError(`宝库命令执行出错: ${error.message}`);
      });
      return;
    }

    if (!this.isFullMode()) {
      context.replyError('轻量模式需要提供宝库坐标: vault <x> <y> <z>');
      return;
    }

    if (!this.impl) {
      context.replyError('vault 模块未初始化');
      return;
    }

    this.impl.handleVaultCommand(context);
  }

  // ---------- 坐标路径(轻量模式可用; 完整模式也可用) ----------

  async activateByCoordinates(context, coordinates) {
    const { x, y, z } = coordinates;

    if (!this.bot) {
      context.replyError('机器人尚未连接');
      return;
    }

    const candidates = [];
    for (const itemName of KEY_ITEM_CANDIDATES) {
      const found = this.findItemSlot(itemName);
      if (found) candidates.push({ itemName, ...found });
    }

    if (candidates.length === 0) {
      context.replyError(`背包里没有宝库钥匙(${KEY_ITEM_CANDIDATES.join(' / ')})`);
      return;
    }

    for (const candidate of candidates) {
      const equipped = await this.equipItemToHand(candidate);
      if (!equipped) {
        context.replyError(`装备钥匙失败: ${candidate.itemName}`);
        return;
      }

      // 错钥匙点击无副作用(不消耗), 因此可以依次尝试
      const outcome = await this.sendActivateAndWait(coordinates);
      if (outcome === 'opened') {
        context.replyInfo(`已激活宝库 (${x}, ${y}, ${z}) [${candidate.itemName}]，战利品请手动拾取`);
        return;
      }

      if (outcome === 'error') {
        context.replyError('发送宝库激活包失败');
        return;
      }
    }

    context.replyError(
      '未确认宝库已激活：请确认 bot 站在宝库 3 格内、背包里有对应钥匙、且该宝库本号尚未领取过'
    );
  }

  findItemSlot(itemName) {
    const slots = this.bot && this.bot.inventory && Array.isArray(this.bot.inventory.slots)
      ? this.bot.inventory.slots
      : [];

    for (let slot = 0; slot < slots.length; slot += 1) {
      const item = slots[slot];
      if (item && item.name === itemName) {
        return { slot, item };
      }
    }

    return null;
  }

  async equipItemToHand(candidate) {
    const bot = this.bot;
    const inventory = bot && bot.inventory;
    if (!inventory) return false;

    const hotbarStart = Number.isFinite(inventory.hotbarStart) ? inventory.hotbarStart : 36;
    const quickBarSlot = Number.isFinite(bot.quickBarSlot) ? bot.quickBarSlot : 0;
    const handSlot = hotbarStart + quickBarSlot;

    if (candidate.slot === handSlot) return true;

    if (candidate.slot >= hotbarStart && candidate.slot < hotbarStart + 9) {
      if (typeof bot.setQuickBarSlot !== 'function') return false;
      await bot.setQuickBarSlot(candidate.slot - hotbarStart);
      return true;
    }

    if (typeof bot.moveSlotItem === 'function') {
      await bot.moveSlotItem(candidate.slot, handSlot);
      return true;
    }

    if (typeof bot.equip === 'function') {
      await bot.equip(candidate.item, 'hand');
      return true;
    }

    return false;
  }

  resolveVaultMinStateId() {
    const minStateId = this.bot && this.bot.registry && this.bot.registry.blocksByName
      ? this.bot.registry.blocksByName.vault && this.bot.registry.blocksByName.vault.minStateId
      : null;
    return Number.isFinite(minStateId) ? minStateId : VAULT_MIN_STATE_ID_FALLBACK;
  }

  nextSequence() {
    if (this.getSequence) return this.getSequence();
    this.fallbackSequence = (this.fallbackSequence + 1) % 32767;
    return this.fallbackSequence;
  }

  sendActivateAndWait(coordinates) {
    const bot = this.bot;
    const client = bot && bot._client;

    return new Promise((resolve) => {
      if (!client || typeof client.write !== 'function' || typeof client.on !== 'function') {
        resolve('error');
        return;
      }

      const minStateId = this.resolveVaultMinStateId();
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        for (const eventName of BLOCK_CHANGE_PACKETS) {
          client.removeListener(eventName, onBlockChange);
        }
        if (typeof bot.removeListener === 'function') {
          bot.removeListener('end', onEnd);
        }
      };

      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };

      const onBlockChange = (packet) => {
        const location = packet && packet.location;
        if (!location) return;
        if (location.x !== coordinates.x || location.y !== coordinates.y || location.z !== coordinates.z) {
          return;
        }

        const stateId = packet.type !== undefined ? packet.type : packet.blockId;
        const phase = decodeVaultState(stateId, minStateId);
        if (phase === 'unlocking' || phase === 'ejecting') {
          finish('opened');
        }
      };

      const onEnd = () => finish('error');

      for (const eventName of BLOCK_CHANGE_PACKETS) {
        client.on(eventName, onBlockChange);
      }
      if (typeof bot.on === 'function') {
        bot.on('end', onEnd);
      }

      timer = setTimeout(() => finish('timeout'), this.activateTimeoutMs);

      try {
        client.write('block_place', {
          hand: 0,
          location: { x: coordinates.x, y: coordinates.y, z: coordinates.z },
          direction: 1,
          cursorX: 0.5,
          cursorY: 0.5,
          cursorZ: 0.5,
          insideBlock: false,
          worldBorderHit: false,
          sequence: this.nextSequence()
        });
      } catch (error) {
        finish('error');
        return;
      }

      if (typeof bot.swingArm === 'function') {
        bot.swingArm();
      }
    });
  }

  // ---------- 宝库队列: 两段式(先配置到内存, 再 --start 执行; 不落盘) ----------

  describeQueueConfig() {
    const cfg = this.queueConfig;
    const targets = cfg.targets.length > 0 ? cfg.targets.join(' ') : '(未设置)';
    const at = cfg.at ? `${cfg.at.x},${cfg.at.y},${cfg.at.z}` : '(自动找最近宝库)';
    return `目标: ${targets} | 间隔: ${cfg.delayMs}ms | 落地等待: ${cfg.settleMs}ms | 结束回基地: ${cfg.backAtEnd ? '是' : '否'} | 宝库坐标: ${at}`;
  }

  getQueueHelpLines() {
    return [
      '用法: vaultqueue <玩家名...> [--delay=ms] [--settle=ms] [--at=x,y,z] [--no-back]  (保存配置) | vaultqueue --start (执行) | vaultqueue stop (停止) | vaultqueue --reset (清空)',
      '说明: --delay 每bot间隔(默认8000ms) · --settle tpahere后落地等待(默认1200ms) · --at=x,y,z 直接指定宝库坐标 · --no-back 结束不回基地',
      '提示: 配置仅保存在内存, 重启后需要重新配置; 一个队列内所有 bot 开同一个宝库'
    ];
  }

  cancelQueue(context = null) {
    if (!this.queueRunning) {
      if (context) context.replyInfo('当前没有在运行的宝库队列');
      return false;
    }

    this.queueCancelled = true;
    if (typeof this.queueWake === 'function') {
      const wake = this.queueWake;
      this.queueWake = null;
      wake();
    }

    if (context) context.replyInfo('已请求停止宝库队列');
    return true;
  }

  sleepCancellable(ms) {
    if (this.queueCancelled) return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.queueWake = null;
        resolve();
      }, Math.max(0, Number(ms) || 0));
      this.queueWake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // 返回 { start, invalid, targets?, settleMs?, delayMs?, backAtEnd?, at? }
  parseQueueArgs(args) {
    const parsed = { start: false, reset: false, invalid: false, targets: [] };

    for (const raw of Array.isArray(args) ? args : []) {
      const value = String(raw || '').trim();
      if (!value) continue;

      if (/^--reset$/i.test(value)) { parsed.reset = true; continue; }
      if (/^--start$/i.test(value)) { parsed.start = true; continue; }

      const settle = value.match(/^--settle=(\d+)$/i);
      if (settle) { parsed.settleMs = Number(settle[1]); continue; }

      const delay = value.match(/^--delay=(\d+)$/i);
      if (delay) { parsed.delayMs = Number(delay[1]); continue; }

      if (/^--no-back$/i.test(value)) { parsed.backAtEnd = false; continue; }
      if (/^--back$/i.test(value)) { parsed.backAtEnd = true; continue; }

      const at = value.match(/^--at=(-?\d+),(-?\d+),(-?\d+)$/i);
      if (at) { parsed.at = { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) }; continue; }

      if (/^[A-Za-z0-9_]{1,16}$/.test(value)) { parsed.targets.push(value); continue; }

      parsed.invalid = true;
    }

    parsed.targets = Array.from(new Set(parsed.targets));
    return parsed;
  }

  handleQueueCommand(context, args) {
    const parsed = this.parseQueueArgs(args);

    if (parsed.invalid) {
      context.replyError('用法: vaultqueue <玩家名...> [--settle=ms] [--delay=ms] [--at=x,y,z] [--no-back] | vaultqueue --start | vaultqueue stop');
      return;
    }

    if (parsed.reset) {
      if (this.queueRunning) {
        context.replyError('队列正在运行, 请先发送: vaultqueue stop');
        return;
      }

      this.queueConfig = { targets: [], settleMs: 1200, delayMs: 8000, backAtEnd: true, at: null };
      context.replyInfo('宝库队列配置已重置为默认值');
      context.replyInfo(this.describeQueueConfig());
      return;
    }

    if (parsed.start) {
      this.runQueue(context).catch((error) => {
        context.replyError(`宝库队列出错: ${error.message}`);
      });
      return;
    }

    // 配置模式: 只写入内存, 不执行
    const changed = parsed.targets.length > 0
      || parsed.settleMs !== undefined
      || parsed.delayMs !== undefined
      || parsed.backAtEnd !== undefined
      || parsed.at !== undefined;

    if (!changed) {
      replyLinesSpaced(context, [
        '=== 当前宝库队列配置(未做改动) ===',
        `配置: ${this.describeQueueConfig()}`
      ].concat(this.getQueueHelpLines()), { gapMs: 700 }).catch(() => {});
      return;
    }

    if (parsed.targets.length > 0) this.queueConfig.targets = parsed.targets;
    if (parsed.settleMs !== undefined) this.queueConfig.settleMs = parsed.settleMs;
    if (parsed.delayMs !== undefined) this.queueConfig.delayMs = parsed.delayMs;
    if (parsed.backAtEnd !== undefined) this.queueConfig.backAtEnd = parsed.backAtEnd;
    if (parsed.at !== undefined) this.queueConfig.at = parsed.at;

    replyLinesSpaced(context, [
      '宝库队列配置已保存(仅内存, 重启后需重新配置)',
      `配置: ${this.describeQueueConfig()}`,
      '准备好后发送: vaultqueue --start'
    ], { gapMs: 700 }).catch(() => {});
  }

  // 眼睛 -> 方块 1x1x1 AABB 最近点距离(与服务端 isWithinBlockInteractionRange 同度量)
  distanceToBlockCube(position) {
    const entity = this.bot && this.bot.entity && this.bot.entity.position;
    if (!entity || !position) return null;

    const eyeX = Number(entity.x);
    const eyeY = Number(entity.y) + 1.62;
    const eyeZ = Number(entity.z);
    if (![eyeX, eyeY, eyeZ].every((value) => Number.isFinite(value))) return null;

    const dx = Math.max(position.x - eyeX, 0, eyeX - (position.x + 1));
    const dy = Math.max(position.y - eyeY, 0, eyeY - (position.y + 1));
    const dz = Math.max(position.z - eyeZ, 0, eyeZ - (position.z + 1));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  getInteractionLimit() {
    const mode = this.bot && this.bot.game ? this.bot.game.gameMode : 'survival';
    return mode === 'creative' ? 6.0 : 5.5;
  }

  // 车头自己就地开箱(不移动): 装钥匙 -> 发 block_place -> 等 vault_state 变化
  async activateOwnVault(coordinates) {
    const candidates = [];
    for (const itemName of KEY_ITEM_CANDIDATES) {
      const found = this.findItemSlot(itemName);
      if (found) candidates.push({ itemName, ...found });
    }

    if (candidates.length === 0) {
      return { ok: false, message: `背包里没有宝库钥匙(${KEY_ITEM_CANDIDATES.join(' / ')})` };
    }

    for (const candidate of candidates) {
      const equipped = await this.equipItemToHand(candidate);
      if (!equipped) return { ok: false, message: `装备钥匙失败: ${candidate.itemName}` };

      const outcome = await this.sendActivateAndWait(coordinates);
      if (outcome === 'opened') return { ok: true, key: candidate.itemName };
      if (outcome === 'error') return { ok: false, message: '发送宝库激活包失败' };
    }

    return { ok: false, message: '未确认宝库已激活(可能已领取过 / 钥匙不对 / 距离不足)' };
  }

  async runQueue(context) {
    const cfg = this.queueConfig;

    if (!this.isFullMode()) {
      const caps = this.getCapabilities ? this.getCapabilities() || {} : {};
      context.replyError(`vaultqueue 需要完整模式(地形处理 + 实体处理)的车头, 当前 entity=${caps.entityHandling ? 'on' : 'off'} terrain=${caps.terrainHandling ? 'on' : 'off'}`);
      return;
    }

    if (cfg.targets.length === 0) {
      context.replyError('还没有配置目标 bot, 请先发送: vaultqueue <玩家名...>');
      return;
    }

    if (!cfg.at && (!this.impl || typeof this.impl.findNearestVault !== 'function')) {
      context.replyError('车头没有加载宝库模块(impl 缺失)，请重启该 bot 实例后再试, 或先用 --at=x,y,z 指定坐标');
      return;
    }

    if (!this.bot || typeof this.bot.chat !== 'function') {
      context.replyError('机器人尚未连接');
      return;
    }

    if (this.queueRunning) {
      context.replyError('已有宝库队列在运行(可用 vaultqueue stop 停止)');
      return;
    }

    this.queueRunning = true;
    this.queueCancelled = false;

    try {
      let position;

      if (cfg.at) {
        position = { ...cfg.at };
        context.replyInfo(`使用已配置的宝库坐标 (${position.x}, ${position.y}, ${position.z})`);
      } else {
        const vault = this.impl.findNearestVault(30);
        const vaultPosition = vault && vault.position;

        if (!vaultPosition) {
          context.replyError('车头开箱失败: 30 格内没有找到宝库');
          return;
        }

        position = { x: vaultPosition.x, y: vaultPosition.y, z: vaultPosition.z };
        const distance = this.distanceToBlockCube(position);
        const limit = this.getInteractionLimit();

        if (distance === null) {
          context.replyError('车头开箱失败: 无法计算与宝库的距离(缺少位置信息)');
          return;
        }

        if (distance > limit) {
          context.replyError(`车头开箱失败: 宝库在 ${distance.toFixed(2)} 格外(交互上限 ${limit} 格), 请把车头移到宝库 3 格内再试`);
          return;
        }

        context.replyInfo(`车头就地激活宝库 (${position.x}, ${position.y}, ${position.z}), 距离 ${distance.toFixed(2)} 格`);

        const own = await this.activateOwnVault(position);
        if (!own.ok) {
          context.replyError(`车头开箱失败: ${own.message}`);
          return;
        }
      }

      const { x, y, z } = position;
      this.lastVault = { x, y, z };
      context.replyInfo(`宝库坐标 (${x}, ${y}, ${z})，开始派送 ${cfg.targets.length} 个 bot`);

      let delivered = 0;
      for (const target of cfg.targets) {
        if (this.queueCancelled) break;

        this.bot.chat(`/tpahere ${target}`);
        await this.sleepCancellable(cfg.settleMs);

        this.bot.chat(`/minecraft:w ${target} vault ${x} ${y} ${z}`);
        delivered += 1;
        context.replyInfo(`[${delivered}/${cfg.targets.length}] 已让 ${target} 打开 (${x}, ${y}, ${z})`);

        await this.sleepCancellable(cfg.delayMs);
      }

      if (cfg.backAtEnd) {
        this.bot.chat('/back');
      }

      const suffix = cfg.backAtEnd ? '，车头已 /back 回基地' : '';
      if (this.queueCancelled) {
        context.replyInfo(`宝库队列已停止: 已派送 ${delivered}/${cfg.targets.length} 个 bot${suffix}`);
      } else {
        context.replyInfo(`宝库队列完成: 已派送 ${delivered}/${cfg.targets.length} 个 bot${suffix}`);
      }
    } finally {
      this.queueRunning = false;
      this.queueCancelled = false;
      this.queueWake = null;
    }
  }

  stop() {
    this.cancelQueue();

    if (this.impl && typeof this.impl.cleanupTrial === 'function') {
      this.impl.cleanupTrial();
    }
    this.impl = null;
    this.bot = null;
  }

  detach() {
    this.stop();
  }
}

module.exports = {
  VaultFeature,
  decodeVaultState,
  parseCoordinates,
  VAULT_STATE_ORDER
};
