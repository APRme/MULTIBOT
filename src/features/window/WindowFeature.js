const { buildWindowSnapshot, serializeItem } = require('./WindowSnapshot');

const PATCH_DEBOUNCE_MS = 100;

function removeEventListener(target, eventName, handler) {
  if (!target) {
    return;
  }

  if (typeof target.off === 'function') {
    target.off(eventName, handler);
    return;
  }

  if (typeof target.removeListener === 'function') {
    target.removeListener(eventName, handler);
  }
}

function parseSlotArg(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是数字`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} 必须是 >= 0 的数字`);
  }

  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function itemMatches(left, right) {
  if (!left || !right) return false;
  return String(left.name).replace(/^minecraft:/, '') === String(right.name).replace(/^minecraft:/, '');
}

class WindowFeature {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.eventStream = options.eventStream || null;
    this.botId = options.botId || 'unknown';
    this.bot = null;
    this.listeners = [];
    this.windowSlotListeners = [];
    this.inventoryListeners = new Set();
    this.pendingPatches = new Map();
    this.patchTimer = null;
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    if (!bot) {
      return;
    }

    this.on(bot, 'windowOpen', (window) => {
      this.handleWindowOpen(window);
    });
    this.on(bot, 'windowClose', () => {
      this.handleWindowClose();
    });
    this.on(bot, 'spawn', () => {
      this.handleSpawn();
    });
    this.ensureInventoryListener();
  }

  detach() {
    this.clearPatchTimer();
    this.pendingPatches.clear();

    for (const entry of this.listeners) {
      removeEventListener(entry.target, entry.eventName, entry.handler);
    }
    this.listeners = [];

    this.clearWindowSlotListeners();
    this.inventoryListeners.clear();
    this.bot = null;
  }

  on(target, eventName, handler) {
    if (!target || typeof target.on !== 'function') {
      return;
    }

    target.on(eventName, handler);
    this.listeners.push({ target, eventName, handler });
  }

  ensureInventoryListener() {
    if (!this.bot || !this.bot.inventory) {
      return;
    }

    const inventory = this.bot.inventory;
    if (this.inventoryListeners.has(inventory)) {
      return;
    }

    this.inventoryListeners.add(inventory);
    this.on(inventory, 'updateSlot', (slot, oldItem, newItem) => {
      this.recordSlotPatch(newItem, oldItem);
    });
  }

  clearWindowSlotListeners() {
    for (const entry of this.windowSlotListeners) {
      removeEventListener(entry.target, 'updateSlot', entry.handler);
    }
    this.windowSlotListeners = [];
  }

  clearPatchTimer() {
    if (this.patchTimer) {
      clearTimeout(this.patchTimer);
      this.patchTimer = null;
    }
  }

  clearPendingPatches() {
    this.clearPatchTimer();
    this.pendingPatches.clear();
  }

  handleSpawn() {
    this.ensureInventoryListener();
    this.publishFull(this.bot ? this.bot.inventory : null);
  }

  handleWindowOpen(window) {
    this.clearPendingPatches();
    this.clearWindowSlotListeners();
    if (window && typeof window.on === 'function') {
      const handler = (slot, oldItem, newItem) => {
        this.recordSlotPatch(newItem, oldItem);
      };
      window.on('updateSlot', handler);
      this.windowSlotListeners.push({ target: window, handler });
    }

    this.publishFull(window || (this.bot ? this.bot.inventory : null));
  }

  handleWindowClose() {
    this.clearPendingPatches();
    this.clearWindowSlotListeners();
    this.publishFull(this.bot ? this.bot.inventory : null);
  }

  recordSlotPatch(newItem, oldItem) {
    const reference = newItem || oldItem;
    if (!reference || !Number.isInteger(reference.slot)) {
      return;
    }

    this.pendingPatches.set(reference.slot, newItem ? serializeItem(newItem) : null);
    this.schedulePatchFlush();
  }

  schedulePatchFlush() {
    if (this.patchTimer) {
      return;
    }

    this.patchTimer = setTimeout(() => {
      this.flushPatches();
    }, PATCH_DEBOUNCE_MS);
  }

  flushPatches() {
    this.patchTimer = null;
    if (this.pendingPatches.size === 0) {
      return;
    }

    const slots = {};
    for (const [key, value] of this.pendingPatches) {
      slots[key] = value;
    }
    this.pendingPatches.clear();

    this.publish('patch', {
      windowId: this.currentWindowId(),
      slots
    });
  }

  currentWindowId() {
    if (this.bot && this.bot.currentWindow) {
      return this.bot.currentWindow.id;
    }

    if (this.bot && this.bot.inventory) {
      return this.bot.inventory.id;
    }

    return null;
  }

  publish(type, extra) {
    if (!this.eventStream || typeof this.eventStream.publish !== 'function') {
      return;
    }

    this.eventStream.publish('inventory', {
      botId: this.botId,
      timestamp: Date.now(),
      type,
      ...extra
    });
  }

  publishFull(window) {
    this.publish('window', {
      window: buildWindowSnapshot(window)
    });
  }

  getCurrentSnapshot() {
    if (!this.bot) {
      return null;
    }

    const window = this.bot.currentWindow || this.bot.inventory;
    return buildWindowSnapshot(window);
  }

  async closeWindow() {
    if (!this.bot) {
      return { ok: true, closed: false };
    }

    if (!this.bot.currentWindow) {
      return { ok: true, closed: false };
    }

    await this.bot.closeWindow(this.bot.currentWindow);
    return { ok: true, closed: true };
  }

  async handleChestCommand(context, trimmed) {
    if (!this.bot) {
      context.replyError('窗口模块未初始化');
      return;
    }

    const args = String(trimmed || '').split(/\s+/).slice(1);
    const subCommand = (args[0] || 'info').toLowerCase();

    try {
      switch (subCommand) {
        case 'info':
        case 'list':
        case 'show':
          this.replyChestInfo(context);
          break;
        case 'move':
          await this.handleChestMove(context, args.slice(1));
          break;
        case 'close': {
          const closed = await this.closeWindow();
          context.replyInfo(closed.closed ? '已关闭当前窗口' : '当前没有打开的窗口');
          break;
        }
        case 'help':
          this.replyChestHelp(context);
          break;
        default:
          context.replyError(`未知子命令: ${subCommand}，使用 chest help 查看帮助`);
          break;
      }
    } catch (error) {
      context.replyError(`chest 命令执行出错: ${error.message}`);
    }
  }

  replyChestHelp(context) {
    context.replyInfo('chest <info|move|close|help>');
    context.replyInfo('  chest info - 查看当前窗口信息');
    context.replyInfo('  chest move <源槽位> <目标槽位> [数量] - 移动/拆分物品（槽位为窗口原始索引）');
    context.replyInfo('  chest close - 关闭当前窗口');
  }

  replyChestInfo(context) {
    const snapshot = this.getCurrentSnapshot();
    if (!snapshot) {
      context.replyInfo('当前无窗口可查看');
      return;
    }

    const occupied = snapshot.slots.filter((entry) => entry !== null);
    context.replyInfo(
      `窗口: ${snapshot.name} (id=${snapshot.id}, 支持=${snapshot.supported}, 槽位 ${snapshot.inventoryStart}-${snapshot.inventoryEnd})`
    );
    context.replyInfo(`物品: ${occupied.length} 格`);

    const lines = [];
    for (const entry of occupied.slice(0, 36)) {
      const durability = entry.durabilityUsed !== null && entry.maxDurability !== null
        ? `(${entry.durabilityUsed}/${entry.maxDurability})`
        : '';
      lines.push(`[${entry.slot}]${entry.displayName || entry.name}×${entry.count}${durability}`);
    }

    if (lines.length > 0) {
      context.replyInfo(lines.join(', '));
    }
    if (occupied.length > 36) {
      context.replyInfo(`... 其余 ${occupied.length - 36} 格`);
    }
  }

  async handleChestMove(context, args) {
    if (args.length < 2) {
      context.replyError('用法: chest move <源槽位> <目标槽位> [数量]');
      return;
    }

    const fromSlot = parseSlotArg(args[0], '源槽位');
    const toSlot = parseSlotArg(args[1], '目标槽位');

    let count = null;
    if (args.length >= 3) {
      const parsedCount = Number.parseInt(args[2], 10);
      if (!Number.isInteger(parsedCount) || parsedCount < 1) {
        context.replyError('数量必须是 >= 1 的数字');
        return;
      }
      count = parsedCount;
    }

    const window = this.bot.currentWindow || this.bot.inventory;
    const fromItem = window.slots[fromSlot];
    if (!fromItem) {
      context.replyError(`源槽位 ${fromSlot} 为空`);
      return;
    }

    if (fromSlot === toSlot) {
      context.replyError('源槽位与目标槽位相同');
      return;
    }

    await this.moveSlotItem(fromSlot, toSlot, count);
    const itemName = fromItem.displayName || fromItem.name;
    const movedCount = count == null || count >= fromItem.count ? fromItem.count : count;
    const after = window.slots[toSlot];
    if (itemMatches(after, fromItem)) {
      context.replyInfo(`已将 ${itemName}×${movedCount} 从槽位 ${fromSlot} 移动到槽位 ${toSlot}`);
      return;
    }
    const afterDesc = after ? `${after.displayName || after.name}×${after.count}` : '空';
    if (itemMatches(window.slots[fromSlot], fromItem)) {
      context.replyError(
        `移动失败:目标槽位 ${toSlot} 为 ${afterDesc}，预期 ${itemName}×${movedCount}；` +
        `已自动放回源槽位 ${fromSlot}（服务器拒绝了该放置）`
      );
      return;
    }
    context.replyError(
      `移动失败:目标槽位 ${toSlot} 为 ${afterDesc}，预期 ${itemName}×${movedCount}；` +
      `物品未能放回源槽位 ${fromSlot}，可能已被服务器丢弃，请检查附近地面`
    );
  }

  async moveSlotItem(fromSlot, toSlot, count) {
    const window = this.bot.currentWindow || this.bot.inventory;
    const fromItem = window.slots[fromSlot];
    if (!fromItem) {
      throw new Error(`源槽位 ${fromSlot} 为空`);
    }

    if (count != null && count < fromItem.count) {
      const targetItem = window.slots[toSlot];
      if (targetItem) {
        const sameType = targetItem.type === fromItem.type && targetItem.metadata === fromItem.metadata;
        if (!sameType) {
          throw new Error(`目标槽位 ${toSlot} 有不同类型的物品`);
        }

        const maxStack = Number.isInteger(fromItem.maxStackSize) ? fromItem.maxStackSize : 64;
        if (targetItem.count + count > maxStack) {
          throw new Error(`目标槽位 ${toSlot} 无法容纳 ${count} 个`);
        }
      }
    }

    if (count == null || count >= fromItem.count) {
      // 整组移动:拿 → 放 → 验证 → 失败则放回源槽。
      // 服务器拒绝放置(如非盔甲物品放入盔甲槽)时,物品留在服务器 cursor 上且不再同步给客户端,
      // 本地窗口会显示物品消失;此时主动点击源槽即可把物品放回,服务器会以 set_slot 确认。
      await this.bot.clickWindow(fromSlot, 0, 0);
      await this.bot.clickWindow(toSlot, 0, 0);
      await delay(300);

      if (itemMatches(window.slots[toSlot], fromItem)) {
        // 放置成功;若目标槽原有物品(发生了交换),把换出的物品放回源槽
        if (window.selectedItem || this.bot.inventory.selectedItem) {
          await this.bot.clickWindow(fromSlot, 0, 0);
          await delay(300);
        }
        return { ok: true };
      }

      await this.bot.clickWindow(fromSlot, 0, 0);
      await delay(300);
      const restored = itemMatches(window.slots[fromSlot], fromItem);
      return { ok: false, restored };
    }

    await this.movePartial(fromSlot, toSlot, count, fromItem.count);
    return { ok: true };
  }

  async movePartial(fromSlot, toSlot, count, total) {
    if (count <= Math.floor(total / 2)) {
      await this.bot.clickWindow(fromSlot, 1, 0);
      const held = Math.ceil(total / 2);
      for (let i = 0; i < held - count; i += 1) {
        await this.bot.clickWindow(fromSlot, 1, 0);
      }
    } else {
      await this.bot.clickWindow(fromSlot, 0, 0);
      const putBack = total - count;
      for (let i = 0; i < putBack; i += 1) {
        await this.bot.clickWindow(fromSlot, 1, 0);
      }
    }

    await this.bot.clickWindow(toSlot, 0, 0);

    if (this.bot.inventory && this.bot.inventory.selectedItem) {
      await this.bot.clickWindow(fromSlot, 0, 0);
    }
  }
}

module.exports = {
  WindowFeature
};
