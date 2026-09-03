// 轻量背包核心: mineflayer inventory/simple_inventory 插件"窗口部分"的裁剪移植,
// 去掉全部 bot.entity/physics/blocks 依赖。仅支持自身背包(window 0)的查看/整理/丢弃,
// 不支持容器/合成/使用物品(与轻量模式能力一致)。
// 数据流: 服务器登录/重生后主动推送 window_items(0) 全量背包, 日常经 set_slot 增量更新
// (MCC 同款机制, 无需客户端请求包); 点击/丢弃只发 window_click/held_item_slot 协议包。
const ItemLib = require('prismarine-item');
const windowsLib = require('prismarine-windows');

const QUICK_BAR_START = 36;

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

  let stateId = -1;

  // 1.17.1+ 窗口点击依赖 stateId; 服务器对 window_items/set_slot 均携带最新 stateId
  const trackStateId = (packet) => {
    if (packet && Number.isInteger(packet.stateId)) {
      stateId = packet.stateId;
    }
  };

  const onWindowItems = (packet) => {
    if (!packet || packet.windowId !== 0) return;
    const window = bot.inventory;
    for (let i = 0; i < packet.items.length; ++i) {
      window.updateSlot(i, Item.fromNotch(packet.items[i]));
    }
    updateHeldItem();
    bot.emit(`setWindowItems:${window.id}`);
  };

  const onSetSlot = (packet) => {
    if (!packet || packet.windowId !== 0) return;
    const window = bot.inventory;
    const newItem = Item.fromNotch(packet.item);
    setSlot(packet.slot, newItem, window);
  };

  const onHeldItemSlot = (packet) => {
    if (packet && Number.isInteger(packet.slot)) {
      setQuickBarSlot(packet.slot);
    }
  };

  addListener(bot._client, 'window_items', trackStateId);
  addListener(bot._client, 'set_slot', trackStateId);
  addListener(bot._client, 'window_items', onWindowItems);
  addListener(bot._client, 'set_slot', onSetSlot);
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
      stateId,
      slot,
      mouseButton,
      mode,
      changedSlots,
      cursorItem: Item.toNotch(window.selectedItem)
    });
  }

  function closeWindow(window) {
    bot._client.write('close_window', {
      windowId: window.id
    });
    bot.emit('windowClose', window);
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

  log('[BOT] lightweight inventory core attached (zero entity dependency)');

  return {
    getStateId: () => stateId
  };
}

module.exports = {
  attachLightInventory
};
