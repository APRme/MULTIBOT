const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const registryLib = require('prismarine-registry');
const ItemLib = require('prismarine-item');
const {
  CLICK_MODES,
  OUTSIDE_SLOT,
  OFFHAND_SWAP_BUTTON,
  isValidModeButton,
  canPredictLocally,
  resolveClickAction,
  resolveDragClick,
  createWindowClicker
} = require('../src/features/window/WindowClick');

const VERSION = '1.21.11';

function createHarness(options = {}) {
  const registry = registryLib(VERSION);
  const windowsLib = require('prismarine-windows')(VERSION);
  const bot = new EventEmitter();
  bot.registry = registry;
  bot.game = { gameMode: options.gameMode || 'survival' };
  const writes = [];
  bot._client = new EventEmitter();
  bot._client.write = (name, payload) => {
    writes.push({ name, payload });
  };

  // 用真实的 prismarine-windows 窗口对象, 这样本地预测就是原版菜单逻辑
  bot.inventory = windowsLib.createWindow(0, 'minecraft:inventory', 'Inventory');
  bot.currentWindow = null;

  const listeners = [];
  const clicker = createWindowClicker(bot, {
    addListener: (target, event, handler) => {
      target.on(event, handler);
      listeners.push(() => target.removeListener(event, handler));
    }
  });

  return {
    bot,
    writes,
    clicker,
    windowsLib,
    dispose() {
      listeners.forEach((dispose) => dispose());
    }
  };
}

function stone(name = 'minecraft:stone', count = 1) {
  return { present: true, itemId: 1, itemCount: count, name, nbt: undefined };
}

test('resolveClickAction maps in-game actions to vanilla (button, mode) pairs', () => {
  const left = resolveClickAction('left', { slot: 13 });
  assert.deepEqual([left.slot, left.mouseButton, left.mode], [13, 0, CLICK_MODES.PICKUP]);

  const right = resolveClickAction('right', { slot: 13 });
  assert.deepEqual([right.mouseButton, right.mode], [1, CLICK_MODES.PICKUP]);

  const shift = resolveClickAction('shift', { slot: 13 });
  assert.deepEqual([shift.mouseButton, shift.mode], [0, CLICK_MODES.QUICK_MOVE]);

  const shiftRight = resolveClickAction('shift-right', { slot: 13 });
  assert.deepEqual([shiftRight.mouseButton, shiftRight.mode], [1, CLICK_MODES.QUICK_MOVE]);

  const drop = resolveClickAction('drop', { slot: 13 });
  assert.deepEqual([drop.mouseButton, drop.mode], [0, CLICK_MODES.THROW]);

  const dropStack = resolveClickAction('dropstack', { slot: 13 });
  assert.deepEqual([dropStack.mouseButton, dropStack.mode], [1, CLICK_MODES.THROW]);

  const collect = resolveClickAction('collect', { slot: 13 });
  assert.deepEqual([collect.mouseButton, collect.mode], [0, CLICK_MODES.PICKUP_ALL]);

  const clone = resolveClickAction('clone', { slot: 13 });
  assert.deepEqual([clone.mouseButton, clone.mode], [2, CLICK_MODES.CLONE]);

  // swap: 数字键 1-9 -> button 0-8; offhand -> 40
  const swap3 = resolveClickAction('swap', { slot: 5, swapSlot: '3' });
  assert.deepEqual([swap3.mouseButton, swap3.mode], [2, CLICK_MODES.SWAP]);
  const swapOff = resolveClickAction('swap', { slot: 5, swapSlot: 'offhand' });
  assert.deepEqual([swapOff.mouseButton, swapOff.mode], [OFFHAND_SWAP_BUTTON, CLICK_MODES.SWAP]);

  // 窗口外点击
  const outside = resolveClickAction('left', { slot: OUTSIDE_SLOT });
  assert.equal(outside.slot, OUTSIDE_SLOT);
});

test('resolveClickAction rejects invalid actions and slots', () => {
  assert.throws(() => resolveClickAction('nope', { slot: 0 }), /未知点击动作/);
  assert.throws(() => resolveClickAction('left', { slot: 1.5 }), /槽位必须是整数/);
  assert.throws(() => resolveClickAction('swap', { slot: 0, swapSlot: '10' }), /1-9 或 offhand/);
  assert.throws(() => resolveClickAction('swap', { slot: 0, swapSlot: '' }), /1-9 或 offhand/);
});

test('drag resolution follows vanilla button table and uses -999 for start/end', () => {
  const start = resolveDragClick('start', 'left', 7);
  assert.deepEqual([start.slot, start.mouseButton, start.mode], [OUTSIDE_SLOT, 0, CLICK_MODES.QUICK_CRAFT]);

  const add = resolveDragClick('add', 'left', 7);
  assert.deepEqual([add.slot, add.mouseButton, add.mode], [7, 1, CLICK_MODES.QUICK_CRAFT]);

  const end = resolveDragClick('end', 'left', 7);
  assert.deepEqual([end.slot, end.mouseButton, end.mode], [OUTSIDE_SLOT, 2, CLICK_MODES.QUICK_CRAFT]);

  assert.equal(resolveDragClick('start', 'right', 0).mouseButton, 4);
  assert.equal(resolveDragClick('add', 'right', 3).mouseButton, 5);
  assert.equal(resolveDragClick('end', 'right', 0).mouseButton, 6);
  assert.equal(resolveDragClick('start', 'middle', 0).mouseButton, 8);
  assert.equal(resolveDragClick('add', 'middle', 3).mouseButton, 9);
  assert.equal(resolveDragClick('end', 'middle', 0).mouseButton, 10);

  assert.throws(() => resolveDragClick('add', 'left', undefined), /必须给出槽位/);
  assert.throws(() => resolveDragClick('middle', 'left', 1), /拖拽阶段/);
});

test('mode/button legality matches vanilla and prediction limits', () => {
  assert.equal(isValidModeButton(CLICK_MODES.PICKUP, 0), true);
  assert.equal(isValidModeButton(CLICK_MODES.PICKUP, 2), false);
  assert.equal(isValidModeButton(CLICK_MODES.SWAP, OFFHAND_SWAP_BUTTON), true);
  assert.equal(isValidModeButton(CLICK_MODES.CLONE, 1), false);
  assert.equal(isValidModeButton(CLICK_MODES.QUICK_CRAFT, 0), true);
  assert.equal(isValidModeButton(CLICK_MODES.QUICK_CRAFT, 3), false);
  assert.equal(isValidModeButton(7, 0), false);

  // prismarine-windows 不接受副手交换与拖拽起始 => 这两种只发包不预测
  assert.equal(canPredictLocally(CLICK_MODES.SWAP, OFFHAND_SWAP_BUTTON), false);
  assert.equal(canPredictLocally(CLICK_MODES.QUICK_CRAFT, 0), false);
  assert.equal(canPredictLocally(CLICK_MODES.QUICK_CRAFT, 1), true);
  assert.equal(canPredictLocally(CLICK_MODES.PICKUP, 0), true);
});

test('click writes a vanilla-shaped window_click packet with the window stateId', () => {
  const { bot, writes, clicker, windowsLib, dispose } = createHarness();
  try {
    const Item = ItemLib(bot.registry);
    const registry = bot.registry;
    const window = windowsLib.createWindow(7, 'minecraft:generic_9x3', 'Menu');
    window.updateSlot(0, new Item(registry.itemsByName.stone.id, 1));
    bot.currentWindow = window;

    // 服务器下发 stateId
    bot._client.emit('window_items', { windowId: 7, items: [], stateId: 55 });

    const result = clicker.clickAction('left', { slot: 0 });

    const packet = writes.filter((w) => w.name === 'window_click').pop();
    assert.ok(packet, 'window_click written');
    assert.equal(packet.payload.windowId, 7);
    assert.equal(packet.payload.stateId, 55, '使用该窗口最新 stateId');
    assert.equal(packet.payload.slot, 0);
    assert.equal(packet.payload.mouseButton, 0);
    assert.equal(packet.payload.mode, 0);
    assert.equal(Array.isArray(packet.payload.changedSlots), true);
    assert.equal(result.predicted, true, '左键可本地预测');
    assert.deepEqual(result.changedSlots, [0], '原版语义: 拾起后该槽位变化');
    assert.equal(result.cursorChanged, true);
  } finally {
    dispose();
  }
});

test('click without local prediction still sends the packet (offhand swap, drag start)', () => {
  const { bot, writes, clicker, windowsLib, dispose } = createHarness();
  try {
    const Item = ItemLib(bot.registry);
    const registry = bot.registry;
    const window = windowsLib.createWindow(9, 'minecraft:generic_9x3', 'Menu');
    window.updateSlot(3, new Item(registry.itemsByName.stone.id, 1));
    bot.currentWindow = window;
    bot._client.emit('window_items', { windowId: 9, items: [], stateId: 12 });

    const offhand = clicker.clickAction('swap', { slot: 3, swapSlot: 'offhand' });
    assert.equal(offhand.predicted, false, '副手交换不做本地预测');
    assert.equal(offhand.mouseButton, OFFHAND_SWAP_BUTTON);
    const offhandPacket = writes.filter((w) => w.name === 'window_click').pop();
    assert.equal(offhandPacket.payload.mouseButton, OFFHAND_SWAP_BUTTON);
    assert.equal(offhandPacket.payload.mode, CLICK_MODES.SWAP);
    assert.deepEqual(offhandPacket.payload.changedSlots, []);

    const dragStart = clicker.clickAction('drag-start', { button: 'left' });
    assert.equal(dragStart.predicted, false, '拖拽起始不做本地预测');
    const dragPacket = writes.filter((w) => w.name === 'window_click').pop();
    assert.equal(dragPacket.payload.slot, OUTSIDE_SLOT);
    assert.equal(dragPacket.payload.mouseButton, 0);
    assert.equal(dragPacket.payload.mode, CLICK_MODES.QUICK_CRAFT);
  } finally {
    dispose();
  }
});

test('drag add and end carry vanilla buttons and slots', () => {
  const { bot, writes, clicker, windowsLib, dispose } = createHarness();
  try {
    const window = windowsLib.createWindow(2, 'minecraft:generic_9x3', 'Menu');
    bot.currentWindow = window;
    bot._client.emit('window_items', { windowId: 2, items: [], stateId: 3 });

    clicker.clickAction('drag-start', { button: 'right' });
    clicker.clickAction('drag-add', { slot: 5, button: 'right' });
    clicker.clickAction('drag-add', { slot: 6, button: 'right' });
    clicker.clickAction('drag-end', { button: 'right' });

    const buttons = writes.filter((w) => w.name === 'window_click').map((w) => w.payload.mouseButton);
    assert.deepEqual(buttons, [4, 5, 5, 6]);
    const slots = writes.filter((w) => w.name === 'window_click').map((w) => w.payload.slot);
    assert.deepEqual(slots, [OUTSIDE_SLOT, 5, 6, OUTSIDE_SLOT]);
  } finally {
    dispose();
  }
});

test('click validates slot range and mode/button combinations', () => {
  const { bot, clicker, windowsLib, dispose } = createHarness();
  try {
    const window = windowsLib.createWindow(1, 'minecraft:generic_9x3', 'Menu');
    bot.currentWindow = window;

    assert.throws(() => clicker.click({ slot: 999, mouseButton: 0, mode: 0 }), /槽位越界/);
    assert.throws(() => clicker.click({ slot: 0, mouseButton: 5, mode: 0 }), /原版不存在的点击组合/);
    assert.throws(() => clicker.click({ slot: 0, mouseButton: 1, mode: 3 }), /原版不存在的点击组合/);
    // -999(窗口外)合法
    const outside = clicker.click({ slot: OUTSIDE_SLOT, mouseButton: 0, mode: 0 });
    assert.equal(outside.slot, OUTSIDE_SLOT);
  } finally {
    dispose();
  }
});

test('clicker returns null without a writable client', () => {
  assert.equal(createWindowClicker({ _client: {} }), null);
  assert.equal(createWindowClicker(null), null);
});
