const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const registryLib = require('prismarine-registry');
const ItemLib = require('prismarine-item');
const { attachLightInventory } = require('../src/features/inventory/lightInventoryCore');

const VERSION = '1.21.11';

function createHarness() {
  const registry = registryLib(VERSION);
  const Item = ItemLib(registry);
  const itemId = (name) => registry.itemsByName[name].id;
  const bot = new EventEmitter();
  bot.registry = registry;
  bot.version = VERSION;
  const writes = [];
  bot._client = new EventEmitter();
  bot._client.state = 'play';
  bot._client.write = (name, payload) => {
    writes.push({ name, payload });
  };

  const listeners = [];
  attachLightInventory(bot, {
    addListener: (target, event, handler) => {
      target.on(event, handler);
      listeners.push(() => target.removeListener(event, handler));
    }
  });

  return {
    bot,
    writes,
    Item,
    itemId,
    dispose() {
      listeners.forEach((dispose) => dispose());
    }
  };
}

function makeEmptyItems() {
  return Array.from({ length: 46 }, () => ({ present: false }));
}

function makeItems(count) {
  return Array.from({ length: count }, () => ({ present: false }));
}

test('lightInventoryCore mounts window0 and applies window_items for the player inventory', () => {
  const { bot, Item, itemId, dispose } = createHarness();
  try {
    assert.ok(bot.inventory, 'bot.inventory mounted');
    assert.equal(bot.inventory.id, 0);
    assert.equal(bot.currentWindow, null);

    const items = makeEmptyItems();
    const diamond = new Item(itemId('diamond'), 5);
    items[36] = Item.toNotch(diamond);
    bot._client.emit('window_items', { windowId: 0, items, stateId: 7 });

    assert.equal(bot.inventory.slots[36].name, 'diamond');
    assert.equal(bot.inventory.slots[36].count, 5);
    assert.equal(bot.inventory.slots[9], null);

    // 没有打开窗口时, 非 window 0 的包不写入自身背包
    const before = bot.inventory.slots[36];
    bot._client.emit('window_items', {
      windowId: 3,
      items: makeEmptyItems(),
      stateId: 8
    });
    assert.equal(bot.inventory.slots[36], before);
  } finally {
    dispose();
  }
});

test('lightInventoryCore opens server windows and defers windowOpen until items arrive', () => {
  const { bot, Item, itemId, dispose } = createHarness();
  try {
    const opened = [];
    const closed = [];
    bot.on('windowOpen', (window) => opened.push(window));
    bot.on('windowClose', (window) => closed.push(window));

    // 已知 menu 类型: 1.21.11 里 generic_9x3 的注册表 id 是 2
    bot._client.emit('open_window', { windowId: 7, inventoryType: 2, windowTitle: { text: '商店' }, stateId: 1 });

    assert.ok(bot.currentWindow, 'currentWindow 建立');
    assert.equal(bot.currentWindow.id, 7);
    assert.equal(bot.currentWindow.type, 'minecraft:generic_9x3');
    assert.equal(opened.length, 0, '物品数据未到前不发 windowOpen(与 mineflayer 一致)');

    const items = makeItems(63); // 27 容器 + 36 玩家背包
    items[0] = Item.toNotch(new Item(itemId('emerald'), 3));
    bot._client.emit('window_items', { windowId: 7, items, stateId: 2 });

    assert.equal(opened.length, 1, '物品到达后发 windowOpen');
    assert.equal(bot.currentWindow.slots[0].name, 'emerald');
    assert.equal(bot.currentWindow.slots[0].count, 3);
    // 容器窗口与自身背包互不干扰
    assert.equal(bot.inventory.slots[0], null);

    // set_slot 作用于当前窗口
    bot._client.emit('set_slot', { windowId: 7, slot: 1, item: Item.toNotch(new Item(itemId('stone'), 1)), stateId: 3 });
    assert.equal(bot.currentWindow.slots[1].name, 'stone');

    // 关闭: currentWindow 清空 + 通知
    bot._client.emit('close_window', { windowId: 7 });
    assert.equal(bot.currentWindow, null);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].id, 7);
  } finally {
    dispose();
  }
});

test('lightInventoryCore falls back to item count for custom menu types', () => {
  const { bot, Item, itemId, dispose } = createHarness();
  try {
    const opened = [];
    bot.on('windowOpen', (window) => opened.push(window));

    // 99 不在 prismarine-windows 的 menu 表里, 且 1.20.2+ 的 open_window 没有 slotCount
    bot._client.emit('open_window', { windowId: 5, inventoryType: 99, windowTitle: { text: '自定义菜单' }, stateId: 1 });
    assert.equal(bot.currentWindow, null, '未知类型且无槽位数时先不建窗口');
    assert.equal(opened.length, 0);

    const items = makeItems(45); // 9 容器 + 36 玩家背包
    items[3] = Item.toNotch(new Item(itemId('diamond'), 7));
    bot._client.emit('window_items', { windowId: 5, items, stateId: 2 });

    assert.equal(opened.length, 1, '物品到达后用物品总数兜底建窗口并通知');
    assert.ok(bot.currentWindow);
    assert.equal(bot.currentWindow.id, 5);
    assert.equal(bot.currentWindow.slots.length, 45);
    assert.equal(bot.currentWindow.inventoryStart, 9, '容器槽位数 = 物品总数 - 36');
    assert.equal(bot.currentWindow.slots[3].count, 7);
  } finally {
    dispose();
  }
});

test('lightInventoryCore clicks inside the opened window with that window stateId', async () => {
  const { bot, writes, Item, itemId, dispose } = createHarness();
  try {
    bot._client.emit('open_window', { windowId: 4, inventoryType: 2, windowTitle: { text: '菜单' }, stateId: 11 });
    const items = makeItems(63);
    items[0] = Item.toNotch(new Item(itemId('diamond'), 2));
    bot._client.emit('window_items', { windowId: 4, items, stateId: 12 });

    await bot.clickWindow(0, 0, 0);

    const click = writes.filter((w) => w.name === 'window_click').pop();
    assert.ok(click, 'window_click written');
    assert.equal(click.payload.windowId, 4);
    assert.equal(click.payload.stateId, 12, '使用该窗口自己的 stateId');
    assert.equal(click.payload.slot, 0);
    assert.equal(bot.currentWindow.selectedItem.name, 'diamond');
  } finally {
    dispose();
  }
});

test('lightInventoryCore closeWindow clears the current window once', () => {
  const { bot, writes, dispose } = createHarness();
  try {
    const closed = [];
    bot.on('windowClose', (window) => closed.push(window));

    bot._client.emit('open_window', { windowId: 9, inventoryType: 2, windowTitle: { text: '菜单' }, stateId: 1 });
    bot._client.emit('window_items', { windowId: 9, items: makeItems(63), stateId: 2 });

    bot.closeWindow(bot.currentWindow);

    assert.equal(writes.some((w) => w.name === 'close_window' && w.payload.windowId === 9), true);
    assert.equal(bot.currentWindow, null);
    assert.equal(closed.length, 1);

    // 服务器随后回 close_window: currentWindow 已为空 => 不重复发事件
    bot._client.emit('close_window', { windowId: 9 });
    assert.equal(closed.length, 1);
  } finally {
    dispose();
  }
});

test('lightInventoryCore ignores packets of a window that is not current', () => {
  const { bot, dispose } = createHarness();
  try {
    bot._client.emit('open_window', { windowId: 3, inventoryType: 2, windowTitle: { text: '菜单' }, stateId: 1 });
    bot._client.emit('window_items', { windowId: 3, items: makeItems(63), stateId: 2 });
    const before = bot.currentWindow.slots[0];

    bot._client.emit('window_items', { windowId: 8, items: makeItems(63), stateId: 3 });
    bot._client.emit('set_slot', { windowId: 8, slot: 0, item: { present: true, itemId: 1, itemCount: 1 }, stateId: 4 });

    assert.equal(bot.currentWindow.slots[0], before);
  } finally {
    dispose();
  }
});

test('lightInventoryCore applies set_slot and tracks stateId', () => {
  const { bot, Item, itemId, dispose } = createHarness();
  try {
    bot._client.emit('window_items', { windowId: 0, items: makeEmptyItems(), stateId: 1 });
    const stone = Item.toNotch(new Item(itemId('stone'), 3));
    bot._client.emit('set_slot', { windowId: 0, slot: 9, item: stone, stateId: 4 });

    assert.equal(bot.inventory.slots[9].name, 'stone');
    assert.equal(bot.inventory.slots[9].count, 3);

    // 非 window 0 的 set_slot 不更新背包
    bot._client.emit('set_slot', { windowId: 1, slot: 9, item: stone, stateId: 5 });
    assert.equal(bot.inventory.slots[9].name, 'stone');
  } finally {
    dispose();
  }
});

test('lightInventoryCore clickWindow predicts locally and writes window_click with stateId', async () => {
  const { bot, writes, Item, itemId, dispose } = createHarness();
  try {
    const items = makeEmptyItems();
    const diamond = new Item(itemId('diamond'), 5);
    items[36] = Item.toNotch(diamond);
    bot._client.emit('window_items', { windowId: 0, items, stateId: 9 });

    await bot.clickWindow(36, 0, 0);

    const click = writes.find((w) => w.name === 'window_click');
    assert.ok(click, 'window_click written');
    assert.equal(click.payload.windowId, 0);
    assert.equal(click.payload.stateId, 9);
    assert.equal(click.payload.slot, 36);
    assert.equal(click.payload.mouseButton, 0);
    assert.equal(click.payload.mode, 0);
    assert.deepEqual(click.payload.changedSlots, [{ location: 36, item: Item.toNotch(null) }]);
    // 拿起物品后 cursor 携带物品
    assert.ok(click.payload.cursorItem, 'cursorItem carries picked item');

    // 本地预测: 物品被拿起(cursor)
    assert.ok(bot.inventory.selectedItem, 'selectedItem holds picked item');
    assert.equal(bot.inventory.selectedItem.name, 'diamond');
    assert.equal(bot.inventory.slots[36], null);
  } finally {
    dispose();
  }
});

test('lightInventoryCore toss drops a stack via click sequence', async () => {
  const { bot, writes, Item, itemId, dispose } = createHarness();
  try {
    const items = makeEmptyItems();
    const diamond = new Item(itemId('diamond'), 5);
    items[36] = Item.toNotch(diamond);
    bot._client.emit('window_items', { windowId: 0, items, stateId: 2 });

    await bot.toss(itemId('diamond'), null, 5);

    const clicks = writes.filter((w) => w.name === 'window_click');
    // 拿起源槽 + 丢到窗外(-999)
    assert.ok(clicks.length >= 2, `expected >=2 clicks, got ${clicks.length}`);
    assert.equal(clicks[0].payload.slot, 36);
    assert.equal(clicks[0].payload.mode, 0);
    const dropClick = clicks.find((c) => c.payload.slot === -999);
    assert.ok(dropClick, 'drop to outside window');
  } finally {
    dispose();
  }
});

test('lightInventoryCore moveSlotItem swaps two slots with three clicks', async () => {
  const { bot, writes, Item, itemId, dispose } = createHarness();
  try {
    const items = makeEmptyItems();
    items[9] = Item.toNotch(new Item(itemId('stone'), 3));
    items[36] = Item.toNotch(new Item(itemId('diamond'), 1));
    bot._client.emit('window_items', { windowId: 0, items, stateId: 3 });

    await bot.moveSlotItem(9, 36);

    const clicks = writes.filter((w) => w.name === 'window_click');
    assert.ok(clicks.length >= 3, `expected >=3 clicks, got ${clicks.length}`);
    assert.equal(clicks[0].payload.slot, 9);
    assert.equal(clicks[1].payload.slot, 36);
    assert.equal(clicks[2].payload.slot, 9); // 放回
  } finally {
    dispose();
  }
});

test('lightInventoryCore setQuickBarSlot writes held_item_slot', () => {
  const { bot, writes, dispose } = createHarness();
  try {
    bot.setQuickBarSlot(2);
    const write = writes.find((w) => w.name === 'held_item_slot');
    assert.ok(write);
    assert.equal(write.payload.slotId, 2);
    assert.equal(bot.quickBarSlot, 2);

    // 服务器确认同槽位不重复发包
    const countBefore = writes.length;
    bot.setQuickBarSlot(2);
    assert.equal(writes.length, countBefore);
  } finally {
    dispose();
  }
});
