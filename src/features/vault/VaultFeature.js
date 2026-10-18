const path = require('path');
const { requireFresh } = require('../../util/requireFresh');

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
    this.activateTimeoutMs = Number.isFinite(options.activateTimeoutMs)
      ? Math.max(50, Math.trunc(options.activateTimeoutMs))
      : DEFAULT_ACTIVATE_TIMEOUT_MS;
    this.impl = null;
    this.bot = null;
    this.fallbackSequence = 0;
    this.lastVault = null;
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

  attach(bot) {
    this.stop();
    this.bot = bot;

    if (!this.hasTerrainData(bot)) {
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

    if (!this.hasTerrainData()) {
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

  // ---------- 宝库队列(车头把多个轻量 bot 依次拉到同一个宝库) ----------

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

  parseQueueArgs(args) {
    const options = { settleMs: 1200, delayMs: 8000, backAtEnd: true, targets: [] };

    for (const raw of Array.isArray(args) ? args : []) {
      const value = String(raw || '').trim();
      if (!value) continue;

      const settle = value.match(/^--settle=(\d+)$/i);
      if (settle) { options.settleMs = Number(settle[1]); continue; }

      const delay = value.match(/^--delay=(\d+)$/i);
      if (delay) { options.delayMs = Number(delay[1]); continue; }

      if (/^--no-back$/i.test(value)) { options.backAtEnd = false; continue; }
      if (/^--back$/i.test(value)) { options.backAtEnd = true; continue; }

      if (/^[A-Za-z0-9_]{1,16}$/.test(value)) options.targets.push(value);
    }

    options.targets = Array.from(new Set(options.targets));
    return options;
  }

  async runQueue(context, args) {
    if (!this.impl || typeof this.impl.openNearestVault !== 'function') {
      context.replyError('vaultqueue 只能在完整模式(有地形/实体数据)的车头上使用');
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

    const options = this.parseQueueArgs(args);
    if (options.targets.length === 0) {
      context.replyError('用法: vaultqueue [--settle=ms] [--delay=ms] [--no-back] <玩家名...>');
      return;
    }

    this.queueRunning = true;
    this.queueCancelled = false;

    try {
      context.replyInfo('宝库队列: 车头先开启最近的宝库 ...');
      const opened = await this.impl.openNearestVault();
      const position = opened && opened.position;

      if (!opened || opened.success !== true || !position) {
        context.replyError(`车头开箱失败: ${(opened && opened.message) || '未知原因'}`);
        return;
      }

      const { x, y, z } = position;
      this.lastVault = { x, y, z };
      context.replyInfo(`车头已开启宝库 (${x}, ${y}, ${z})，开始派送 ${options.targets.length} 个 bot`);

      let delivered = 0;
      for (const target of options.targets) {
        if (this.queueCancelled) break;

        this.bot.chat(`/tpahere ${target}`);
        await this.sleepCancellable(options.settleMs);

        this.bot.chat(`/minecraft:w ${target} vault ${x} ${y} ${z}`);
        delivered += 1;
        context.replyInfo(`[${delivered}/${options.targets.length}] 已让 ${target} 打开 (${x}, ${y}, ${z})`);

        await this.sleepCancellable(options.delayMs);
      }

      if (options.backAtEnd) {
        this.bot.chat('/back');
      }

      const suffix = options.backAtEnd ? '，车头已 /back 回基地' : '';
      if (this.queueCancelled) {
        context.replyInfo(`宝库队列已停止: 已派送 ${delivered}/${options.targets.length} 个 bot${suffix}`);
      } else {
        context.replyInfo(`宝库队列完成: 已派送 ${delivered}/${options.targets.length} 个 bot${suffix}`);
      }
    } catch (error) {
      context.replyError(`宝库队列出错: ${error.message}`);
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
