const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { WindowFeature } = require('../src/features/window/WindowFeature');

function createMockWindow(options = {}) {
  const window = new EventEmitter();
  window.id = options.id !== undefined ? options.id : 3;
  window.type = options.type || 'minecraft:generic_9x3';
  window.inventoryStart = options.inventoryStart !== undefined ? options.inventoryStart : 27;
  window.inventoryEnd = options.inventoryEnd !== undefined ? options.inventoryEnd : 54;
  window.slots = options.slots || [];
  return window;
}

function createItem(slot, name, count, extra = {}) {
  return {
    slot,
    type: extra.type || name,
    name,
    displayName: extra.displayName || name,
    count,
    metadata: 0,
    maxStackSize: 64,
    ...extra
  };
}

function createFeature() {
  const events = [];
  const eventStream = {
    publish(event, data) {
      events.push({ event, data });
    }
  };

  const inventory = createMockWindow({
    id: 0,
    type: 'minecraft:inventory',
    inventoryStart: 9,
    inventoryEnd: 45
  });

  const bot = new EventEmitter();
  bot.inventory = inventory;
  bot.currentWindow = null;
  bot.moveSlotItem = async () => {};
  bot.clickWindow = async () => {};
  bot.closeWindow = async () => {
    bot.currentWindow = null;
  };

  const feature = new WindowFeature({
    eventStream,
    botId: 'server__bot'
  });

  return { feature, bot, inventory, events };
}

// 模拟 Minecraft 点击语义（对应 prismarine-windows acceptClick）：
// 左键: 光标空=拿整组/光标有物=放下或合并或交换；右键: 光标空=拿半组(ceil)/光标有物=放1个。
function installClickSimulator(bot) {
  bot.inventory.selectedItem = null;

  bot.clickWindow = async (slot, button, mode) => {
    const window = bot.currentWindow || bot.inventory;
    const item = window.slots[slot];

    if (mode !== 0) {
      throw new Error(`unexpected mode ${mode}`);
    }

    if (button === 0) {
      if (!bot.inventory.selectedItem) {
        if (!item) return;
        bot.inventory.selectedItem = { ...item };
        window.slots[slot] = null;
        return;
      }

      const held = bot.inventory.selectedItem;
      if (!item) {
        window.slots[slot] = held;
        bot.inventory.selectedItem = null;
        return;
      }

      if (item.type === held.type && item.metadata === held.metadata) {
        const maxStack = held.maxStackSize || 64;
        const total = item.count + held.count;
        if (total <= maxStack) {
          window.slots[slot] = { ...item, count: total };
          bot.inventory.selectedItem = null;
        } else {
          window.slots[slot] = { ...item, count: maxStack };
          bot.inventory.selectedItem = { ...held, count: total - maxStack };
        }
        return;
      }

      window.slots[slot] = held;
      bot.inventory.selectedItem = item;
      return;
    }

    if (button === 1) {
      if (!bot.inventory.selectedItem) {
        if (!item) return;
        const heldCount = Math.ceil(item.count / 2);
        bot.inventory.selectedItem = { ...item, count: heldCount };
        window.slots[slot] = { ...item, count: item.count - heldCount };
        return;
      }

      const held = bot.inventory.selectedItem;
      if (!item || (item.type === held.type && item.metadata === held.metadata)) {
        const target = item ? { ...item, count: item.count + 1 } : { ...held, count: 1 };
        window.slots[slot] = target;
        bot.inventory.selectedItem = { ...held, count: held.count - 1 };
        if (bot.inventory.selectedItem.count === 0) {
          bot.inventory.selectedItem = null;
        }
        return;
      }

      window.slots[slot] = held;
      bot.inventory.selectedItem = item;
      return;
    }

    throw new Error(`unexpected button ${button}`);
  };
}

test('WindowFeature attaches listeners and detaches cleanly', () => {
  const { feature, bot, inventory } = createFeature();
  feature.attach(bot);

  assert.equal(bot.listenerCount('windowOpen'), 1);
  assert.equal(bot.listenerCount('windowClose'), 1);
  assert.equal(bot.listenerCount('spawn'), 1);
  assert.equal(inventory.listenerCount('updateSlot'), 1);

  feature.detach();
  assert.equal(bot.listenerCount('windowOpen'), 0);
  assert.equal(bot.listenerCount('windowClose'), 0);
  assert.equal(bot.listenerCount('spawn'), 0);
  assert.equal(inventory.listenerCount('updateSlot'), 0);
  assert.equal(feature.bot, null);
});

test('spawn publishes full inventory window snapshot', () => {
  const { feature, bot, inventory, events } = createFeature();
  inventory.slots = [createItem(0, 'oak_planks', 64)];
  feature.attach(bot);

  bot.emit('spawn');

  assert.equal(events.length, 1);
  const published = events[0];
  assert.equal(published.event, 'inventory');
  assert.equal(published.data.botId, 'server__bot');
  assert.equal(published.data.type, 'window');
  assert.equal(published.data.window.name, 'inventory');
  assert.equal(published.data.window.slots.length, 1);
  assert.equal(published.data.window.slots[0].name, 'minecraft:oak_planks');
});

test('windowOpen publishes window snapshot and attaches currentWindow slot listener', () => {
  const { feature, bot, inventory, events } = createFeature();
  feature.attach(bot);

  const chest = createMockWindow({ id: 3, type: 'minecraft:generic_9x3' });
  chest.slots = [createItem(0, 'dirt', 32)];
  bot.currentWindow = chest;

  bot.emit('windowOpen', chest);
  assert.equal(chest.listenerCount('updateSlot'), 1);

  assert.equal(events.length, 1);
  assert.equal(events[0].data.type, 'window');
  assert.equal(events[0].data.window.name, 'chest');
  assert.equal(events[0].data.window.slots[0].count, 32);
  assert.equal(inventory.listenerCount('updateSlot'), 1);
});

test('windowClose clears currentWindow listeners and publishes inventory snapshot', () => {
  const { feature, bot, events } = createFeature();
  feature.attach(bot);

  const chest = createMockWindow({ id: 3 });
  bot.currentWindow = chest;
  bot.emit('windowOpen', chest);
  assert.equal(chest.listenerCount('updateSlot'), 1);

  bot.currentWindow = null;
  bot.emit('windowClose', chest);

  assert.equal(chest.listenerCount('updateSlot'), 0);
  assert.equal(events.length, 2);
  assert.equal(events[1].data.type, 'window');
  assert.equal(events[1].data.window.name, 'inventory');
});

test('updateSlot publishes debounced patch and null clears slot', async () => {
  const { feature, bot, inventory } = createFeature();
  feature.attach(bot);

  const oldItem = createItem(5, 'oak_planks', 64);
  const newItem = createItem(5, 'oak_planks', 63);
  inventory.emit('updateSlot', 5, oldItem, newItem);

  const clearedOld = createItem(9, 'dirt', 32);
  inventory.emit('updateSlot', 9, clearedOld, null);

  assert.equal(feature.pendingPatches.size, 2);

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(feature.pendingPatches.size, 0);
  assert.equal(feature.patchTimer, null);
});

test('flushed patch payload carries windowId and merged slots', async () => {
  const { feature, bot, inventory, events } = createFeature();
  feature.attach(bot);

  const oldItem = createItem(5, 'oak_planks', 64);
  const newItem = createItem(5, 'oak_planks', 63);
  inventory.emit('updateSlot', 5, oldItem, newItem);
  const clearedOld = createItem(9, 'dirt', 32);
  inventory.emit('updateSlot', 9, clearedOld, null);

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(events.length, 1);
  const data = events[0].data;
  assert.equal(data.type, 'patch');
  assert.equal(data.windowId, 0);
  assert.equal(data.slots['5'].count, 63);
  assert.equal(data.slots['9'], null);
});

test('currentWindow slot updates merge into patch', async () => {
  const { feature, bot, events } = createFeature();
  feature.attach(bot);

  const chest = createMockWindow({ id: 3 });
  bot.currentWindow = chest;
  bot.emit('windowOpen', chest);

  const oldItem = createItem(2, 'iron_ingot', 10);
  const newItem = createItem(2, 'iron_ingot', 9);
  chest.emit('updateSlot', 2, oldItem, newItem);

  await new Promise((resolve) => setTimeout(resolve, 150));

  const patch = events.find((entry) => entry.data.type === 'patch');
  assert.ok(patch);
  assert.equal(patch.data.windowId, 3);
  assert.equal(patch.data.slots['2'].count, 9);
});

test('getCurrentSnapshot prefers currentWindow over inventory', () => {
  const { feature, bot } = createFeature();
  feature.attach(bot);

  assert.equal(feature.getCurrentSnapshot().name, 'inventory');

  const chest = createMockWindow({ id: 3, type: 'minecraft:generic_9x3' });
  bot.currentWindow = chest;
  assert.equal(feature.getCurrentSnapshot().name, 'chest');
});

test('closeWindow is idempotent without a window', async () => {
  const { feature, bot } = createFeature();
  feature.attach(bot);

  const closedWindows = [];
  bot.closeWindow = async (window) => {
    closedWindows.push(window);
  };

  assert.deepEqual(await feature.closeWindow(), { ok: true, closed: false });
  assert.equal(closedWindows.length, 0);

  const chest = createMockWindow({ id: 3 });
  bot.currentWindow = chest;
  assert.deepEqual(await feature.closeWindow(), { ok: true, closed: true });
  assert.equal(closedWindows.length, 1);
  assert.equal(closedWindows[0], chest);
});

test('chest move moves whole stack and swaps target contents back', async () => {
  const { feature, bot } = createFeature();
  const chest = createMockWindow({ id: 3 });
  chest.slots = new Array(46).fill(null);
  chest.slots[0] = createItem(0, 'diamond', 64);
  chest.slots[27] = createItem(27, 'oak_planks', 64);
  bot.currentWindow = chest;
  installClickSimulator(bot);
  feature.attach(bot);

  const replies = [];
  const context = {
    replyError(message) {
      replies.push({ level: 'error', message });
    },
    replyInfo(message) {
      replies.push({ level: 'info', message });
    }
  };

  await feature.handleChestCommand(context, 'chest move 0 27');

  assert.equal(chest.slots[27].name, 'diamond');
  assert.equal(chest.slots[0].name, 'oak_planks');
  assert.ok(replies.some((entry) => entry.level === 'info' && entry.message.includes('移动到')));
});

test('chest move rolls back to source slot when server rejects placement', async () => {
  const { feature, bot } = createFeature();
  const chest = createMockWindow({ id: 3 });
  chest.slots = [createItem(0, 'diamond', 64), null, null];
  bot.currentWindow = chest;
  feature.attach(bot);

  // 模拟服务器拒绝:点击目标槽 2 时放置不生效(物品留在服务器 cursor,本地消失),
  // 其余槽位按正常拿/放处理。
  bot.clickWindow = async (slot, button, mode) => {
    if (slot === 2) return;
    const window = bot.currentWindow || bot.inventory;
    if (!bot.inventory.selectedItem) {
      if (!window.slots[slot]) return;
      bot.inventory.selectedItem = window.slots[slot];
      window.slots[slot] = null;
    } else {
      window.slots[slot] = bot.inventory.selectedItem;
      bot.inventory.selectedItem = null;
    }
  };

  const replies = [];
  const context = {
    replyError: (message) => replies.push(message),
    replyInfo: (message) => replies.push(message)
  };

  await feature.handleChestCommand(context, 'chest move 0 2');

  assert.equal(chest.slots[0].name, 'diamond');
  assert.ok(replies.some((message) => String(message).includes('已自动放回源槽位 0')));
});

test('chest move splits partial count via protocol-accurate clicks', async () => {
  const { feature, bot } = createFeature();
  const chest = createMockWindow({ id: 3 });
  chest.slots = [
    createItem(0, 'diamond', 64),
    null
  ];
  bot.currentWindow = chest;
  installClickSimulator(bot);
  feature.attach(bot);

  const context = {
    replyError() {},
    replyInfo() {}
  };

  await feature.handleChestCommand(context, 'chest move 0 27 10');

  assert.equal(chest.slots[0].count, 54);
  assert.equal(chest.slots[27].count, 10);
  assert.equal(chest.slots[27].name, 'diamond');
  assert.equal(bot.inventory.selectedItem, null);
});

test('chest move grabs whole stack and puts back excess for large counts', async () => {
  const { feature, bot } = createFeature();
  const chest = createMockWindow({ id: 3 });
  chest.slots = [
    createItem(0, 'diamond', 64),
    null
  ];
  bot.currentWindow = chest;
  installClickSimulator(bot);
  feature.attach(bot);

  const context = {
    replyError() {},
    replyInfo() {}
  };

  await feature.handleChestCommand(context, 'chest move 0 27 50');

  assert.equal(chest.slots[0].count, 14);
  assert.equal(chest.slots[27].count, 50);
  assert.equal(bot.inventory.selectedItem, null);
});

test('chest move rejects mismatched or overflowing target slots', async () => {
  const { feature, bot } = createFeature();
  const chest = createMockWindow({ id: 3 });
  chest.slots = new Array(29).fill(null);
  chest.slots[0] = createItem(0, 'diamond', 64);
  chest.slots[27] = createItem(27, 'oak_planks', 5);
  chest.slots[28] = createItem(28, 'diamond', 60);
  bot.currentWindow = chest;
  installClickSimulator(bot);
  feature.attach(bot);

  const errors = [];
  const context = {
    replyError(message) {
      errors.push(message);
    },
    replyInfo() {}
  };

  await feature.handleChestCommand(context, 'chest move 0 27 10');
  await feature.handleChestCommand(context, 'chest move 0 28 10');

  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('不同类型的物品'));
  assert.ok(errors[1].includes('无法容纳'));
  assert.equal(chest.slots[0].count, 64);
  assert.equal(chest.slots[27].count, 5);
  assert.equal(chest.slots[28].count, 60);
});

test('chest move rejects invalid args and empty source', async () => {
  const { feature, bot } = createFeature();
  const chest = createMockWindow({ id: 3 });
  chest.slots = [null];
  bot.currentWindow = chest;
  feature.attach(bot);

  const errors = [];
  const context = {
    replyError(message) {
      errors.push(message);
    },
    replyInfo() {}
  };

  await feature.handleChestCommand(context, 'chest move 0');
  await feature.handleChestCommand(context, 'chest move 5 27');
  await feature.handleChestCommand(context, 'chest move 0 0');
  await feature.handleChestCommand(context, 'chest move 0 27 abc');

  assert.equal(errors.length, 4);
});

test('chest info lists occupied slots', () => {
  const { feature, bot } = createFeature();
  const chest = createMockWindow({ id: 3 });
  chest.slots = [
    createItem(0, 'diamond', 64, { displayName: '钻石' }),
    null,
    createItem(2, 'iron_ingot', 10, { displayName: '铁锭' })
  ];
  bot.currentWindow = chest;
  feature.attach(bot);

  const infos = [];
  const context = {
    replyError() {},
    replyInfo(message) {
      infos.push(message);
    }
  };

  feature.handleChestCommand(context, 'chest info');

  assert.ok(infos.some((line) => line.includes('chest')));
  assert.ok(infos.some((line) => line.includes('[0]钻石×64')));
  assert.ok(infos.some((line) => line.includes('[2]铁锭×10')));
});

test('chest close closes current window', async () => {
  const { feature, bot } = createFeature();
  const chest = createMockWindow({ id: 3 });
  bot.currentWindow = chest;
  feature.attach(bot);

  let closed = false;
  bot.closeWindow = async () => {
    closed = true;
  };

  const infos = [];
  const context = {
    replyError() {},
    replyInfo(message) {
      infos.push(message);
    }
  };

  await feature.handleChestCommand(context, 'chest close');
  assert.equal(closed, true);
  assert.ok(infos.some((line) => line.includes('已关闭')));
});
