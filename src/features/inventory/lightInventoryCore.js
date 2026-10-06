// 轻量背包核心: mineflayer inventory/simple_inventory 插件"窗口部分"的裁剪移植,
// 去掉全部 bot.entity/physics/blocks 依赖。
// 覆盖: 自身背包(window 0) + 服务器主动打开的窗口(箱子/菜单, 即 open_window)。
//   - 维护 bot.currentWindow, 并像 mineflayer 一样发出 windowOpen/windowClose/setWindowItems:<id>/setSlot:<id>
//     事件, 因此 WindowFeature(面板展示、chest 命令、关闭窗口) 在轻量模式下可原样复用;
//   - 未识别的菜单类型(插件/资源包自定义)也支持: prismarine-windows 需要"容器槽位数",
//     1.20.2+ 的 open_window 不再携带 slotCount, 这时用随后到达的 window_items 物品总数反推(总数 - 36 玩家背包)。
// 不支持: 走位/实体/方块交互类操作(与轻量模式能力一致)。
// 数据流: 登录/重生后服务器主动推送 window_items(0) 全量背包, 日常经 set_slot 增量更新
// (MCC 同款机制, 无需客户端请求包); 点击/丢弃只发 window_click/held_item_slot 协议包。
const ItemLib = require('prismarine-item');
const windowsLib = require('prismarine-windows');

const QUICK_BAR_START = 36;
const PLAYER_INVENTORY_SLOTS = 36;

// hooks: { addListener(target, event, handler), logger? }
function attachLightInventory(bot, hooks = {}) {
  if (!bot || !bot._client || typeof bot._client.write !== 'function') {
    return null;
  }

  const addListener = typeof hooks.addListener === 'function'
    ? hooks.addListener
    : (target, event, handler) => target.on(event, handler);
  const log = hooks.logger && typeof hooks.logger.info === 'function'
    ? (message) => hooks.logger.info(message)
    : () => {};

  const Item = ItemLib(bot.registry);
  const windows = windowsLib(bot.version);

  bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  bot.currentWindow = null;
  bot.quickBarSlot = null;
  bot.QUICK_BAR_START = QUICK_BAR_START;

  Object.defineProperty(bot, 'heldItem', {
    configurable: true,
    enumerable: true,
    get() {
      if (bot.quickBarSlot == null) return null;
      return bot.inventory.slots[QUICK_BAR_START + bot.quickBarSlot] || null;
    }
  });

  // 1.17.1+ 窗口点击依赖 stateId; 服务器对 window_items/set_slot 均携带最新 stateId。
  // 同时开多个窗口时 stateId 是"每个窗口各自一个", 因此按 windowId 分别记录。
  const stateIdByWindow = new Map();
  // 未知菜单类型: 先记下 open_window, 等 window_items 反推槽位数后再建窗口
  let pendingOpenWindow = null;
  // 窗口已建立但物品数据还没到: 与 mineflayer 一致, 等物品到了再对外发 windowOpen
  let pendingOpenEmitWindowId = null;

  const trackStateId = (packet) => {
    if (packet && Number.isInteger(packet.stateId) && Number.isInteger(packet.windowId)) {
      stateIdByWindow.set(packet.windowId, packet.stateId);
    }
  };

  const getStateId = (windowId) => (stateIdByWindow.has(windowId) ? stateIdByWindow.get(windowId) : -1);

  const resolveWindow = (windowId) => {
    if (windowId === 0) return bot.inventory;
    if (bot.currentWindow && bot.currentWindow.id === windowId) return bot.currentWindow;
    return null;
  };

  const applyItems = (window, items) => {
    if (!Array.isArray(items)) return;
    const limit = Math.min(items.length, window.slots.length);
    for (let i = 0; i < limit; ++i) {
      window.updateSlot(i, Item.fromNotch(items[i]));
    }
    updateHeldItem();
  };

  // 建立窗口。已知的 menu 类型交给 prismarine-windows 按其布局建;
  // 未知类型(自定义菜单)时它只在给了 slotCount 的情况下才肯建, 所以用物品总数兜底。
  const createWindow = (packet, totalSlots) => {
    try {
      const created = windows.createWindow(
        packet.windowId,
        packet.inventoryType,
        packet.windowTitle,
        packet.slotCount
      );
      if (created) {
        return created;
      }
    } catch (error) {
      log(`[BOT] window create failed type=${packet.inventoryType}: ${error.message}`);
    }

    if (!Number.isInteger(totalSlots) || totalSlots <= PLAYER_INVENTORY_SLOTS) {
      return null;
    }

    try {
      return windows.createWindow(
        packet.windowId,
        `custom:${packet.inventoryType}`,
        packet.windowTitle,
        totalSlots - PLAYER_INVENTORY_SLOTS
      );
    } catch (error) {
      log(`[BOT] custom window fallback failed type=${packet.inventoryType}: ${error.message}`);
      return null;
    }
  };

  const clearCurrentWindow = () => {
    const previous = bot.currentWindow;
    bot.currentWindow = null;
    pendingOpenWindow = null;
    pendingOpenEmitWindowId = null;
    if (previous) {
      bot.emit('windowClose', previous);
    }
    return previous;
  };

  const onOpenWindow = (packet) => {
    if (!packet || !Number.isInteger(packet.windowId)) return;

    pendingOpenWindow = null;
    pendingOpenEmitWindowId = null;
    // 服务器可能没关旧窗口就开了新的(换界面): 先按关闭处理, 保证 currentWindow 只有一个
    if (bot.currentWindow) {
      clearCurrentWindow();
    }

    const window = createWindow(packet, undefined);
    if (!window) {
      // 1.20.2+ 的 open_window 没有 slotCount: 未知类型只能等物品包反推
      pendingOpenWindow = {
        windowId: packet.windowId,
        inventoryType: packet.inventoryType,
        windowTitle: packet.windowTitle
      };
      return;
    }

    bot.currentWindow = window;
    pendingOpenEmitWindowId = window.id;
  };

  const onWindowItems = (packet) => {
    if (!packet || !Number.isInteger(packet.windowId)) return;

    let window = resolveWindow(packet.windowId);

    if (!window && pendingOpenWindow && pendingOpenWindow.windowId === packet.windowId) {
      const created = createWindow(pendingOpenWindow, Array.isArray(packet.items) ? packet.items.length : undefined);
      if (created) {
        pendingOpenWindow = null;
        applyItems(created, packet.items);
        bot.currentWindow = created;
        pendingOpenEmitWindowId = null;
        bot.emit(`setWindowItems:${created.id}`);
        bot.emit('windowOpen', created);
        return;
      }
    }

    if (!window) return;

    applyItems(window, packet.items);
    bot.emit(`setWindowItems:${window.id}`);

    if (pendingOpenEmitWindowId === window.id) {
      pendingOpenEmitWindowId = null;
      bot.emit('windowOpen', window);
    }
  };

  const onSetSlot = (packet) => {
    if (!packet || !Number.isInteger(packet.windowId)) return;
    const window = resolveWindow(packet.windowId);
    if (!window) return;
    const newItem = Item.fromNotch(packet.item);
    setSlot(packet.slot, newItem, window);
  };

  const onCloseWindow = () => {
    clearCurrentWindow();
  };

  // 跨子服(re-login)时服务器不会补发 close_window, 与 mineflayer 一样本地关闭
  const onLogin = () => {
    clearCurrentWindow();
  };

  const onHeldItemSlot = (packet) => {
    if (packet && Number.isInteger(packet.slot)) {
      setQuickBarSlot(packet.slot);
    }
  };

  addListener(bot._client, 'window_items', trackStateId);
  addListener(bot._client, 'set_slot', trackStateId);
  addListener(bot._client, 'open_window', onOpenWindow);
  addListener(bot._client, 'open_screen', onOpenWindow); // 后续协议若改名, 同一处理
  addListener(bot._client, 'window_items', onWindowItems);
  addListener(bot._client, 'set_slot', onSetSlot);
  addListener(bot._client, 'close_window', onCloseWindow);
  addListener(bot._client, 'login', onLogin);
  addListener(bot._client, 'held_item_slot', onHeldItemSlot);

  function setSlot(slotId, newItem, window = bot.inventory) {
    const oldItem = window.slots[slotId];
    window.updateSlot(slotId, newItem);
    updateHeldItem();
    bot.emit(`setSlot:${window.id}`, oldItem, newItem);
  }

  function updateHeldItem() {
    bot.emit('heldItemChanged', bot.heldItem);
  }

  function getChangedSlots(oldSlots, newSlots) {
    const changedSlots = [];
    for (let i = 0; i < newSlots.length; i++) {
      if (!Item.equal(oldSlots[i], newSlots[i])) {
        changedSlots.push(i);
      }
    }
    return changedSlots;
  }

  // 与 mineflayer inventory.js clickWindow 一致: 本地 acceptClick 预测 + window_click 上报
  async function clickWindow(slot, mouseButton, mode) {
    const window = bot.currentWindow || bot.inventory;

    const click = {
      slot,
      mouseButton,
      mode,
      windowId: window.id,
      item: slot === -999 ? null : window.slots[slot]
    };

    let changedSlots;
    if ([0, 3, 4].includes(click.mode)) {
      changedSlots = window.acceptClick(click);
    } else {
      const oldSlots = JSON.parse(JSON.stringify(window.slots));
      window.acceptClick(click);
      changedSlots = getChangedSlots(oldSlots, window.slots);
    }

    changedSlots = (changedSlots || []).map((slotIndex) => ({
      location: slotIndex,
      item: Item.toNotch(window.slots[slotIndex])
    }));

    bot._client.write('window_click', {
      windowId: window.id,
      stateId: getStateId(window.id),
      slot,
      mouseButton,
      mode,
      changedSlots,
      cursorItem: Item.toNotch(window.selectedItem)
    });
  }

  function closeWindow(window) {
    if (!window) return;

    bot._client.write('close_window', {
      windowId: window.id
    });

    // 本地立即清空(服务器随后回 close_window 时 currentWindow 已为 null, 不会重复发事件)
    if (bot.currentWindow && bot.currentWindow.id === window.id) {
      clearCurrentWindow();
    } else {
      bot.emit('windowClose', window);
    }
  }

  // 把选中的物品放回 window 的 [start,end) 范围(来自 mineflayer putSelectedItemRange)
  async function putSelectedItemRange(start, end, window, slot) {
    async function tossLeftover() {
      if (window.selectedItem) {
        await clickWindow(-999, 0, 0);
      }
    }

    while (window.selectedItem) {
      const item = window.findItemRange(
        start,
        end,
        window.selectedItem.type,
        window.selectedItem.metadata,
        true,
        window.selectedItem.nbt
      );

      if (item && item.stackSize !== item.count) {
        await clickWindow(item.slot, 0, 0);
      } else {
        const emptySlot = window.firstEmptySlotRange(start, end);
        if (emptySlot === null) {
          if (slot === null) {
            await tossLeftover();
          } else {
            await clickWindow(slot, 0, 0);
            await tossLeftover();
          }
        } else {
          await clickWindow(emptySlot, 0, 0);
        }
      }
    }
  }

  // 物品搬运(来自 mineflayer transfer): 支持目标 -999(丢弃)
  async function transfer(options) {
    const window = options.window || bot.inventory;
    const itemType = options.itemType;
    const metadata = options.metadata;
    const nbt = options.nbt;
    let count = (options.count === undefined || options.count === null) ? 1 : options.count;
    let firstSourceSlot = null;

    const sourceStart = options.sourceStart;
    const destStart = options.destStart;
    const sourceEnd = options.sourceEnd === null ? sourceStart + 1 : options.sourceEnd;
    const destEnd = options.destEnd === null ? destStart + 1 : options.destEnd;

    await transferOne();

    async function transferOne() {
      if (count === 0) {
        await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot);
        return;
      }
      if (!window.selectedItem
        || window.selectedItem.type !== itemType
        || (metadata != null && window.selectedItem.metadata !== metadata)
        || (nbt != null && window.selectedItem.nbt !== nbt)) {
        const sourceItem = window.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt);
        if (!sourceItem) throw new Error(`Can't find item (id: ${itemType}) in slots [${sourceStart} - ${sourceEnd}]`);
        if (firstSourceSlot === null) firstSourceSlot = sourceItem.slot;
        await clickWindow(sourceItem.slot, 0, 0);
      }
      await clickDest();

      async function clickDest() {
        let destItem;
        let destSlot;
        if (destStart === -999) {
          destSlot = -999;
        } else {
          destItem = window.findItemRange(
            destStart,
            destEnd,
            window.selectedItem.type,
            window.selectedItem.metadata,
            true,
            nbt
          );
          destSlot = destItem ? destItem.slot : window.firstEmptySlotRange(destStart, destEnd);
          if (destSlot === null) {
            throw new Error('destination full');
          }
        }
        const destSlotCount = destItem && destItem.count ? destItem.count : 0;
        const movedItems = Math.min(
          window.selectedItem.stackSize - destSlotCount,
          window.selectedItem.count
        );
        if (movedItems <= count) {
          await clickWindow(destSlot, 0, 0);
          count -= movedItems;
          await transferOne();
        } else {
          await clickWindow(destSlot, 1, 0);
          count -= 1;
          await transferOne();
        }
      }
    }
  }

  function setQuickBarSlot(slot) {
    if (bot.quickBarSlot === slot) return;
    bot.quickBarSlot = slot;
    bot._client.write('held_item_slot', {
      slotId: slot
    });
    updateHeldItem();
  }

  async function tossStack(item) {
    await clickWindow(item.slot, 0, 0);
    await clickWindow(-999, 0, 0);
    closeWindow(bot.inventory);
  }

  async function toss(itemType, metadata, count) {
    const window = bot.inventory;
    const options = {
      window,
      itemType,
      metadata,
      count,
      sourceStart: window.inventoryStart,
      sourceEnd: window.inventoryEnd,
      destStart: -999
    };
    await transfer(options);
  }

  async function moveSlotItem(sourceSlot, destSlot) {
    await clickWindow(sourceSlot, 0, 0);
    await clickWindow(destSlot, 0, 0);
    updateHeldItem();
    if (bot.inventory.selectedItem) {
      await clickWindow(sourceSlot, 0, 0);
    }
  }

  bot.clickWindow = clickWindow;
  bot.closeWindow = closeWindow;
  bot.transfer = transfer;
  bot.moveSlotItem = moveSlotItem;
  bot.toss = toss;
  bot.tossStack = tossStack;
  bot.setQuickBarSlot = setQuickBarSlot;
  bot.updateHeldItem = updateHeldItem;

//   log('[BOT] lightweight inventory core attached (zero entity dependency)');

  return {
    getStateId: (windowId) => getStateId(Number.isInteger(windowId) ? windowId : 0)
  };
}

module.exports = {
  attachLightInventory
};
