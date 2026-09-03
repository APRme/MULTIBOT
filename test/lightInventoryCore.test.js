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

test('lightInventoryCore mounts window0 and applies window_items for window 0 only', () => {
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

    // 非 window 0 的包不写入自身背包
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
