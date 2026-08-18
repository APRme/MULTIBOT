const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  item,
  createContext,
  createWorld,
  chestContents,
  backpackContents,
  getTaskIdFromReplies,
  waitForTaskDone,
  cleanupTestTmp
} = require('./helpers/warehouseWorld');

const TEST_TMP_DIR = path.resolve(__dirname, '.tmp', 'sort');

test.after(() => {
  cleanupTestTmp(TEST_TMP_DIR, 'test-warehouse-sort');
});

// 执行 sort 命令:入队 → 等待任务完成 → 返回终态任务。
async function runSortCommand(world) {
  const context = createContext();
  await world.feature.handleWarehouseCommand(context, 'warehouse sort');
  const taskId = getTaskIdFromReplies(context.messages);
  assert.ok(taskId, '应返回任务 id');
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('已入队')));
  const task = await waitForTaskDone(world.feature, taskId);
  return { context, task };
}

test('sort:暂存箱物品按规则搬运到目标箱并更新索引', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    inboxContents: [item('iron_ingot', 10, 0), item('gold_ingot', 5, 1)]
  });
  const { feature, containers } = world;
  const inbox = containers.get('0,64,0');
  const oreBox = containers.get('10,64,0');
  const junkBox = containers.get('20,64,0');

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');

  assert.deepEqual(chestContents(oreBox), [{ slot: 0, name: 'minecraft:iron_ingot', count: 10 }]);
  assert.deepEqual(chestContents(junkBox), [{ slot: 0, name: 'minecraft:gold_ingot', count: 5 }]);
  assert.deepEqual(chestContents(inbox), []);

  assert.equal(feature.store.countItem('minecraft:iron_ingot'), 10);
  assert.equal(feature.store.countItem('minecraft:gold_ingot'), 5);
});

test('sort:目标箱已有同种物品时合并', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    containers: { 矿石箱: [item('iron_ingot', 54, 0)] },
    inboxContents: [item('iron_ingot', 10, 0)]
  });
  const { feature, containers } = world;
  const oreBox = containers.get('10,64,0');

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');

  assert.deepEqual(chestContents(oreBox), [{ slot: 0, name: 'minecraft:iron_ingot', count: 64 }]);
  assert.equal(feature.store.countItem('minecraft:iron_ingot'), 64);
});

test('sort:同 ID 不可堆叠物品分别进入空槽且不残留背包', async () => {
  const nonStackable = { stackSize: 1, maxStackSize: undefined };
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    inboxContents: [
      item('netherite_sword', 1, 0, nonStackable),
      item('flint_and_steel', 1, 1, nonStackable),
      item('flint_and_steel', 1, 2, nonStackable)
    ]
  });
  const { bot, containers } = world;
  const junkBox = containers.get('20,64,0');

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');
  assert.deepEqual(chestContents(junkBox), [
    { slot: 0, name: 'minecraft:netherite_sword', count: 1 },
    { slot: 1, name: 'minecraft:flint_and_steel', count: 1 },
    { slot: 2, name: 'minecraft:flint_and_steel', count: 1 }
  ]);
  assert.deepEqual(backpackContents(bot), []);
});

test('sort:无匹配规则且无 default 箱时物品滞留', async () => {
  const rules = {
    inbox: [{ x: 0, y: 64, z: 0 }],
    containers: [{ name: '矿石箱', x: 10, y: 64, z: 0, allow: ['minecraft:iron_ingot'] }]
  };
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    rules,
    inboxContents: [item('dirt', 3, 0)]
  });
  const { containers } = world;
  const inbox = containers.get('0,64,0');

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');
  assert.deepEqual(chestContents(inbox), [{ slot: 0, name: 'minecraft:dirt', count: 3 }]);
});

test('sort:目标箱满时物品放回暂存箱并报告滞留', async () => {
  const fullOre = [];
  for (let slot = 0; slot < 27; slot += 1) {
    fullOre.push(item('iron_ingot', 64, slot));
  }
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    containers: { 矿石箱: fullOre },
    inboxContents: [item('iron_ingot', 10, 0)]
  });
  const { containers } = world;
  const inbox = containers.get('0,64,0');
  const oreBox = containers.get('10,64,0');

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');
  assert.equal(chestContents(oreBox).length, 27);
  assert.deepEqual(chestContents(inbox), [{ slot: 0, name: 'minecraft:iron_ingot', count: 10 }]);
});

test('sort:暂存箱为空时任务正常完成', async () => {
  const world = createWorld({ tmpRoot: TEST_TMP_DIR, inboxContents: [] });
  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');
});

test('sort:规则未加载时同步报错不入队', async () => {
  const world = createWorld({ tmpRoot: TEST_TMP_DIR, inboxContents: [item('dirt', 1, 0)] });
  world.feature.rules = null;
  world.feature.rulesErrors = ['containers 必须是非空数组'];

  const context = createContext();
  await world.feature.handleWarehouseCommand(context, 'warehouse sort');
  assert.ok(context.messages.some(([kind, text]) => kind === 'error' && text.includes('规则未加载')));
  assert.equal(getTaskIdFromReplies(context.messages), null);
});

test('sort:背包无空位时报错,物品留在暂存箱', async () => {
  // 无 default 箱:背包塞满无匹配的 dirt,背包始终无空位 → 暂存箱物品无法搬运
  const rules = {
    inbox: [{ x: 0, y: 64, z: 0 }],
    containers: [{ name: '矿石箱', x: 10, y: 64, z: 0, allow: ['minecraft:iron_ingot'] }]
  };
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    rules,
    inboxContents: [item('iron_ingot', 10, 0)]
  });
  const { bot, containers } = world;
  for (let index = 0; index < 36; index += 1) {
    bot.inventory.slots[index] = item('dirt', 1, index);
  }
  const inbox = containers.get('0,64,0');

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');
  assert.deepEqual(chestContents(inbox), [{ slot: 0, name: 'minecraft:iron_ingot', count: 10 }]);
});

test('sort:背包自然拾取的物品也按规则入库', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    inboxContents: [],
    backpackContents: [
      { invIndex: 0, item: item('iron_ingot', 7, 0) },
      { invIndex: 1, item: item('dirt', 2, 1) }
    ]
  });
  const { feature, bot, containers } = world;
  const oreBox = containers.get('10,64,0');
  const junkBox = containers.get('20,64,0');

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');

  assert.deepEqual(chestContents(oreBox), [{ slot: 0, name: 'minecraft:iron_ingot', count: 7 }]);
  assert.deepEqual(chestContents(junkBox), [{ slot: 0, name: 'minecraft:dirt', count: 2 }]);
  assert.deepEqual(backpackContents(bot), []);
  assert.equal(feature.store.countItem('minecraft:iron_ingot'), 7);
});

test('sort:同一目标箱的多个背包物品复用一次开箱会话', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    inboxContents: [],
    backpackContents: [
      { invIndex: 0, item: item('iron_ingot', 7, 0) },
      { invIndex: 1, item: item('iron_ingot', 5, 1) }
    ]
  });

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');
  const oreOpenCalls = world.calls.filter((entry) => entry[0] === 'open' && entry[1] === 10);
  assert.equal(oreOpenCalls.length, 2, '一次分拣开箱 + 一次索引刷新');
});

test('sort:背包仅一空槽时先合并同身份暂存物品再一次送入', async () => {
  const rules = {
    inbox: [{ x: 0, y: 64, z: 0 }],
    containers: [{ name: '矿石箱', x: 10, y: 64, z: 0, allow: ['minecraft:iron_ingot'] }]
  };
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    rules,
    inboxContents: [item('iron_ingot', 7, 0), item('iron_ingot', 5, 1)]
  });
  for (let index = 1; index < 36; index += 1) {
    world.bot.inventory.slots[index] = item('dirt', 1, index);
  }

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');
  const oreOpenCalls = world.calls.filter((entry) => entry[0] === 'open' && entry[1] === 10);
  assert.equal(oreOpenCalls.length, 2, '一次批量送入 + 一次索引刷新');
});

test('sort:背包无空槽但同身份堆叠有容量时继续快速搬运', async () => {
  const rules = {
    inbox: [{ x: 0, y: 64, z: 0 }],
    containers: [{ name: '矿石箱', x: 10, y: 64, z: 0, allow: ['minecraft:iron_ingot'] }]
  };
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    rules,
    inboxContents: [item('iron_ingot', 1, 0)]
  });
  for (let index = 0; index < 35; index += 1) {
    world.bot.inventory.slots[index] = item('dirt', 1, index);
  }
  world.bot.inventory.slots[35] = item('iron_ingot', 63, 35);

  const { task } = await runSortCommand(world);
  assert.equal(task.status, 'done');
  assert.deepEqual(chestContents(world.containers.get('10,64,0')), [
    { slot: 0, name: 'minecraft:iron_ingot', count: 64 }
  ]);
  assert.deepEqual(chestContents(world.containers.get('0,64,0')), []);
});
