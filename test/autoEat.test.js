const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { EatFeature } = require('../src/features/eat/EatFeature');
const { AutoEatController } = require('../src/features/eat/AutoEatController');
const { normalizeAutoEatConfig, getDefaultAutoEatConfig } = require('../src/config/normalizeAutoEatConfig');

const HOTBAR_START = 36;

function createContext() {
  const info = [];
  const errors = [];
  return {
    info,
    errors,
    replyInfo: (message) => info.push(message),
    replyError: (message) => errors.push(message)
  };
}

// 轻量模式 bot: 没有 mineflayer 的 inventory 插件(无 consume/activateItem), 但有轻量背包核心提供的方法
function createLightweightHarness(options = {}) {
  const bot = new EventEmitter();
  const writes = [];
  const moves = [];
  const quickBarChanges = [];

  bot.food = options.food === undefined ? 20 : options.food;
  bot.health = 20;
  bot.game = { gameMode: 'survival' };
  bot.quickBarSlot = 0;
  bot.currentWindow = null;
  bot.usingHeldItem = false;
  bot.registry = { foodsByName: { bread: { foodPoints: 5, saturation: 6 } }, items: [] };
  bot.entity = undefined; // 轻量模式无实体

  const slots = { 36: { name: 'bread', type: 1, count: 3, slot: 36 } };
  bot.inventory = { slots, hotbarStart: HOTBAR_START };
  bot.heldItem = slots[HOTBAR_START];

  bot._client = new EventEmitter();
  bot._client.write = (name, params) => {
    writes.push({ name, params });
    if (name === 'use_item') {
      setImmediate(() => bot._client.emit('entity_status', { entityId: 1, entityStatus: 9 }));
    }
  };

  bot.setQuickBarSlot = (slot) => {
    quickBarChanges.push(slot);
    bot.quickBarSlot = slot;
  };

  bot.moveSlotItem = async (sourceSlot, destSlot) => {
    moves.push({ sourceSlot, destSlot });
    const tmp = slots[destSlot];
    slots[destSlot] = slots[sourceSlot];
    slots[sourceSlot] = tmp;
    if (slots[destSlot]) slots[destSlot].slot = destSlot;
    if (slots[sourceSlot]) slots[sourceSlot].slot = sourceSlot;
    bot.heldItem = slots[HOTBAR_START];
  };

  const inventoryFeature = {
    findItem(itemName, exactMatch = false) {
      const found = Object.values(slots).find((item) => item && (exactMatch ? item.name === itemName : String(item.name).includes(itemName)));
      return found ? [{ item: found }] : [];
    }
  };

  const feature = new EatFeature({
    logger: null,
    inventoryFeature,
    fishFeature: null,
    getRotation: () => ({ yaw: 1.5, pitch: -0.2 })
  });

  feature.attach(bot);
  return { bot, writes, moves, quickBarChanges, slots, feature, inventoryFeature };
}

test('autoEat 配置归一化: 支持 true/false/对象 且阈值默认 19', () => {
  assert.deepEqual(normalizeAutoEatConfig(true), {
    enabled: true,
    threshold: 19,
    items: [],
    cooldownMs: 3000,
    failureBackoffMs: 30000,
    maxFailures: 3
  });

  assert.equal(normalizeAutoEatConfig(false).enabled, false);
  assert.equal(normalizeAutoEatConfig(undefined).enabled, false);

  const custom = normalizeAutoEatConfig({
    enabled: true,
    threshold: 30,
    items: ['Minecraft:Cooked_Beef', 'cooked_beef', '', 'bread'],
    cooldownMs: -5,
    maxFailures: 999
  });

  assert.equal(custom.enabled, true);
  assert.equal(custom.threshold, 20, '阈值上限 20');
  assert.deepEqual(custom.items, ['cooked_beef', 'bread'], '去前缀/去重/去空');
  assert.equal(custom.cooldownMs, 0, '负数收敛到 0');
  assert.equal(custom.maxFailures, 100, '上限钳制');

  assert.deepEqual(getDefaultAutoEatConfig().items, []);
});

test('轻量模式 eat: 把食物换到主手 -> use_item -> 收到进食完成 -> 还原槽位', async () => {
  const harness = createLightweightHarness({ food: 10 });
  const context = createContext();
  // 把面包放到背包槽(非快捷栏), 迫使走"换到主手"分支
  harness.slots[36] = undefined;
  harness.slots[9] = { name: 'bread', type: 1, count: 3, slot: 9 };
  harness.bot.heldItem = undefined;

  await harness.feature.handleEatCommand(context, 'bread');

  const useItem = harness.writes.find((entry) => entry.name === 'use_item');
  assert.ok(useItem, '轻量模式必须自己发 use_item');
  assert.equal(useItem.params.hand, 0);
  assert.equal(useItem.params.sequence, 1, 'sequence 从 1 开始自增');
  assert.ok(useItem.params.rotation, '必须带 rotation');
  assert.deepEqual(harness.moves[0], { sourceSlot: 9, destSlot: 36 }, '先把食物换到主手');
  assert.ok(harness.moves.some((move) => move.sourceSlot === 36 && move.destSlot === 9), '吃完把原物换回背包槽');
  assert.deepEqual(context.errors, []);
});

test('轻量模式 eat: 满饱食度吃普通食物会被快速拦截(不发 use_item)', async () => {
  const harness = createLightweightHarness({ food: 20 });
  const context = createContext();
  harness.slots[36] = { name: 'bread', type: 1, count: 3, slot: 36 };
  harness.bot.heldItem = harness.slots[36];

  await harness.feature.handleEatCommand(context, 'bread');

  assert.match(context.errors.join('\n'), /饱食度已满/);
  assert.equal(harness.writes.filter((entry) => entry.name === 'use_item').length, 0, '不应发出 use_item');
});

test('轻量模式 eat 不详之瓶: 满饱食度(food=20)且食物值不变也算成功', async () => {
  const harness = createLightweightHarness({ food: 20 });
  const context = createContext();
  harness.slots[36] = { name: 'ominous_bottle', type: 2, count: 1, slot: 36 };
  harness.bot.heldItem = harness.slots[36];

  await harness.feature.handleEatCommand(context, 'minecraft:ominous_bottle');

  assert.deepEqual(context.errors, [], '满饱食度喝不详之瓶不应报错');
  const useItem = harness.writes.filter((entry) => entry.name === 'use_item');
  assert.equal(useItem.length, 1);
  assert.equal(harness.bot.food, 20, '饱食度不变(靠 entity_status 判定完成)');
});

test('轻量模式 eat: 不可食用 / 背包没有 / sequence 递增', async () => {
  const harness = createLightweightHarness({ food: 10 });
  const context = createContext();

  harness.slots[36] = { name: 'stone', type: 3, count: 1, slot: 36 };
  await harness.feature.handleEatCommand(context, 'stone');
  assert.match(context.errors.join('\n'), /不可食用/);

  context.errors.length = 0;
  await harness.feature.handleEatCommand(context, 'cooked_beef');
  assert.match(context.errors.join('\n'), /未在背包中找到物品/);

  context.errors.length = 0;
  harness.slots[36] = { name: 'bread', type: 1, count: 3, slot: 36 };
  harness.bot.heldItem = harness.slots[36];
  await harness.feature.handleEatCommand(context, 'bread');
  await harness.feature.handleEatCommand(context, 'bread');
  const sequences = harness.writes.filter((entry) => entry.name === 'use_item').map((entry) => entry.params.sequence);
  assert.deepEqual(sequences, [1, 2], 'sequence 必须递增');
});

test('轻量模式 eat: 超时给出失败回复', async () => {
  const harness = createLightweightHarness({ food: 10 });
  const context = createContext();
  harness.bot._client.write = (name, params) => {
    harness.writes.push({ name, params });
    // 故意不回任何确认信号
  };

  const originalTimeout = require('../src/features/eat/EatFeature');
  await harness.feature.handleEatCommand(context, 'bread');
  assert.match(context.errors.join('\n'), /食用失败|Consume timeout/);
  assert.ok(originalTimeout);
});

function createAutoEatHarness(options = {}) {
  const bot = new EventEmitter();
  bot.food = options.food === undefined ? 10 : options.food;
  bot.health = 20;
  bot.currentWindow = null;
  bot.usingHeldItem = false;
  bot.registry = {
    foodsByName: {
      bread: { foodPoints: 5, saturation: 6 },
      cooked_beef: { foodPoints: 8, saturation: 12.8 }
    }
  };

  const inventory = options.inventory || ['bread'];
  const consumed = [];
  const eatFeature = {
    async consumeFromInventory(itemId) {
      consumed.push(itemId);
      if (options.failAll) {
        return { ok: false, stage: 'consume', itemId, itemName: itemId, consumeError: new Error('boom') };
      }
      return { ok: true, itemId, itemName: itemId };
    }
  };

  const inventoryFeature = {
    findItem(itemName) {
      return inventory.includes(itemName) ? [{ item: { name: itemName } }] : [];
    }
  };

  const controller = new AutoEatController({
    logger: options.logger || null,
    config: { enabled: true, threshold: 19, items: [], cooldownMs: 0, failureBackoffMs: 1000, maxFailures: 2, ...(options.config || {}) },
    eatFeature,
    inventoryFeature,
    fishFeature: options.fishFeature || null,
    attackFeature: null,
    digFeature: null
  });

  controller.attach(bot, { initialCheck: false });
  return { bot, controller, consumed, inventoryFeature };
}

test('autoEat: 饱食度低于阈值才吃, 高于阈值不动', async () => {
  const low = createAutoEatHarness({ food: 19, inventory: ['bread'] });
  await low.controller.maybeEat('test');
  assert.deepEqual(low.consumed, ['bread'], 'food=19 <= 阈值 19 应进食');

  const high = createAutoEatHarness({ food: 20, inventory: ['bread'] });
  await high.controller.maybeEat('test');
  assert.deepEqual(high.consumed, [], 'food=20 不应进食');
});

test('autoEat: 按配置顺序挑食物, 找不到才顺延', async () => {
  const harness = createAutoEatHarness({
    food: 10,
    inventory: ['bread', 'cooked_beef'],
    config: { items: ['cooked_beef', 'bread'] }
  });

  await harness.controller.maybeEat('test');
  assert.deepEqual(harness.consumed, ['cooked_beef'], '优先配置里第一个且背包里有的');

  const fallback = createAutoEatHarness({
    food: 10,
    inventory: ['bread'],
    config: { items: ['cooked_beef', 'bread'] }
  });
  await fallback.controller.maybeEat('test');
  assert.deepEqual(fallback.consumed, ['bread'], '第一个没有则顺延');
});

test('autoEat: 配置不详之瓶时也能被选中(它不在 foodsByName 里)', async () => {
  // 注意: autoEat 只在饥饿 <= 阈值时动作; 满饱食度喝不详之瓶属于手动 eat 的场景
  const harness = createAutoEatHarness({
    food: 10,
    inventory: ['ominous_bottle'],
    config: { items: ['ominous_bottle'] }
  });

  await harness.controller.maybeEat('test');
  assert.deepEqual(harness.consumed, ['ominous_bottle']);
});

test('autoEat: 未配置食物时按食物点数自动择优', async () => {
  const harness = createAutoEatHarness({ food: 10, inventory: ['bread', 'cooked_beef'], config: { items: [] } });
  await harness.controller.maybeEat('test');
  assert.deepEqual(harness.consumed, ['cooked_beef'], 'cooked_beef 食物点数更高');
});

test('autoEat: 冲突场景跳过(容器界面/钓鱼/使用物品中)', async () => {
  const windowCase = createAutoEatHarness({ food: 10 });
  windowCase.bot.currentWindow = { id: 1 };
  await windowCase.controller.maybeEat('test');
  assert.deepEqual(windowCase.consumed, [], '开着容器界面应跳过');
  windowCase.controller.detach();

  const fishingCase = createAutoEatHarness({
    food: 10,
    fishFeature: { getState: () => ({ isFishing: true }) }
  });
  await fishingCase.controller.maybeEat('test');
  assert.deepEqual(fishingCase.consumed, [], '钓鱼中应跳过');
  fishingCase.controller.detach();

  const usingCase = createAutoEatHarness({ food: 10 });
  usingCase.bot.usingHeldItem = true;
  await usingCase.controller.maybeEat('test');
  assert.deepEqual(usingCase.consumed, [], '正在使用物品应跳过');
  usingCase.controller.detach();
});

test('autoEat: 成功后进入冷却, 连续失败达上限后进入退避', async () => {
  const ok = createAutoEatHarness({ food: 10, config: { cooldownMs: 5000 } });
  await ok.controller.maybeEat('test');
  assert.equal(ok.consumed.length, 1);
  assert.ok(ok.controller.getState().cooldownUntil > Date.now(), '成功后应进入冷却');
  await ok.controller.maybeEat('test');
  assert.equal(ok.consumed.length, 1, '冷却期间不再进食');
  ok.controller.detach();

  const failing = createAutoEatHarness({ food: 10, failAll: true, config: { cooldownMs: 0, maxFailures: 2, failureBackoffMs: 60000 } });
  await failing.controller.maybeEat('test');
  await failing.controller.maybeEat('test');
  assert.ok(failing.controller.getState().cooldownUntil > Date.now(), '连续失败后进入退避');
  failing.controller.clearRetryTimer();
  failing.controller.detach();
});

test('autoEat: 关闭状态不动作, autoeat on/off/status 命令可用', async () => {
  const harness = createAutoEatHarness({ food: 10, config: { enabled: false } });
  await harness.controller.maybeEat('test');
  assert.deepEqual(harness.consumed, [], '未启用时不进食');

  const context = createContext();
  const eatFeature = new EatFeature({ logger: null, inventoryFeature: harness.inventoryFeature, fishFeature: null });
  eatFeature.attach(harness.bot);
  eatFeature.autoEatController = harness.controller;

  await eatFeature.handleAutoEatCommand(context, 'on');
  assert.match(context.info.join('\n'), /已开启/);
  assert.equal(harness.controller.isEnabled(), true);

  context.info.length = 0;
  await eatFeature.handleAutoEatCommand(context, 'status');
  assert.match(context.info.join('\n'), /自动进食: 开启/);
  assert.match(context.info.join('\n'), /阈值=19/);

  await eatFeature.handleAutoEatCommand(context, 'off');
  assert.equal(harness.controller.isEnabled(), false);

  context.errors.length = 0;
  await eatFeature.handleAutoEatCommand(context, 'bogus');
  assert.match(context.errors.join('\n'), /用法: autoeat on\|off\|status/);
  harness.controller.detach();
});

test('满饱食度下白名单物品仍可食用(附魔金苹果/金苹果/蜂蜜瓶/牛奶/药水/紫颂果)', async () => {
  const whitelist = [
    'enchanted_golden_apple',
    'golden_apple',
    'honey_bottle',
    'milk_bucket',
    'potion',
    'chorus_fruit',
    'ominous_bottle'
  ];

  for (const item of whitelist) {
    const harness = createLightweightHarness({ food: 20 });
    const context = createContext();
    harness.slots[36] = { name: item, type: 9, count: 1, slot: 36 };
    harness.bot.heldItem = harness.slots[36];

    await harness.feature.handleEatCommand(context, item);

    assert.deepEqual(context.errors, [], `${item} 在满饱食度下不应被拒绝`);
    assert.equal(
      harness.writes.filter((entry) => entry.name === 'use_item').length,
      1,
      `${item} 应发出 use_item 实际食用`
    );
  }
});

test('白名单外的非食物物品仍然不可食用(回归)', async () => {
  const harness = createLightweightHarness({ food: 20 });
  const context = createContext();
  harness.slots[36] = { name: 'stone', type: 1, count: 1, slot: 36 };
  harness.bot.heldItem = harness.slots[36];

  await harness.feature.handleEatCommand(context, 'stone');

  assert.match(context.errors.join('\n'), /不可食用/);
  assert.equal(harness.writes.filter((entry) => entry.name === 'use_item').length, 0);
});
