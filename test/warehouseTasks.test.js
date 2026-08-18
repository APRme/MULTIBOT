const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  item,
  createContext,
  createWorld,
  chestContents,
  getTaskIdFromReplies,
  waitForTaskDone,
  cleanupTestTmp
} = require('./helpers/warehouseWorld');
const { getItemIdentityHash } = require('../src/features/window/itemIdentity');

const TEST_TMP_DIR = path.resolve(__dirname, '.tmp', 'tasks');

test.after(() => {
  cleanupTestTmp(TEST_TMP_DIR, 'test-warehouse-tasks');
});

// ---------- query ----------

test('query:汇总输出与按物品查询', async () => {
  const world = createWorld({ tmpRoot: TEST_TMP_DIR });
  const { feature, containers } = world;
  const oreBox = containers.get('10,64,0');
  const junkBox = containers.get('20,64,0');

  // 直接造索引:矿石箱 iron×10,杂项箱 dirt×3
  const cid1 = feature.store.upsertContainer({ x: 10, y: 64, z: 0, name: '矿石箱', type: 'chest' });
  feature.store.replaceContainerItems(cid1, [{ slot: 0, item_name: 'minecraft:iron_ingot', count: 10 }]);
  const cid2 = feature.store.upsertContainer({ x: 20, y: 64, z: 0, name: '杂项箱', type: 'chest' });
  feature.store.replaceContainerItems(cid2, [{ slot: 0, item_name: 'minecraft:dirt', count: 3 }]);

  let context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse query');
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('共 2 种物品')));
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('minecraft:iron_ingot×10')));

  context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse query iron_ingot');
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('共 10 件')));
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('(10, 64, 0)')));

  context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse query minecraft:air');
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('仓库中没有')));
  assert.equal(oreBox, oreBox);
  assert.ok(junkBox);
});

// ---------- audit ----------

test('audit:检测差异并修正索引,发布 audit_delta 事件', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    containers: { 矿石箱: [item('iron_ingot', 10, 0)] },
    inboxContents: []
  });
  const { feature, events } = world;

  // 造一条与游戏实际(10)不一致的库记录(5),并设置旧盘点时间
  const cid = feature.store.upsertContainer({ x: 10, y: 64, z: 0, name: '矿石箱', type: 'chest' });
  feature.store.replaceContainerItems(cid, [{ slot: 0, item_name: 'minecraft:iron_ingot', count: 5 }]);

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse audit');
  const taskId = getTaskIdFromReplies(context.messages);
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('已入队')));
  const task = await waitForTaskDone(feature, taskId);
  assert.equal(task.status, 'done');

  // 索引已按游戏实际修正
  assert.equal(feature.store.countItem('minecraft:iron_ingot'), 10);
  const container = feature.store.getContainer(10, 64, 0);
  assert.ok(container.last_audited_at > 0, '应更新 last_audited_at');

  // 发布 audit_delta
  assert.ok(
    events.some((entry) => entry.event === 'warehouse'
      && entry.data.type === 'audit_delta'
      && entry.data.data.diffs.some((d) => d.containerName === '矿石箱'))
  );
});

test('audit:同 ID 同数量但组件变化时报告差异并更新身份', async () => {
  const actualItem = item('book', 1, 0, {
    components: [{ type: 'custom_name', data: { value: 'Alpha' } }],
    removedComponents: []
  });
  const previousItem = item('book', 1, 0, {
    components: [{ type: 'custom_name', data: { value: 'Beta' } }],
    removedComponents: []
  });
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    containers: { 矿石箱: [actualItem] },
    inboxContents: []
  });
  const { feature, events } = world;
  const cid = feature.store.upsertContainer({ x: 10, y: 64, z: 0, name: '矿石箱', type: 'chest' });
  feature.store.replaceContainerItems(cid, [{
    slot: 0,
    item_name: 'minecraft:book',
    count: 1,
    stack_identity: getItemIdentityHash(previousItem)
  }]);

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse audit');
  const taskId = getTaskIdFromReplies(context.messages);
  const task = await waitForTaskDone(feature, taskId);
  assert.equal(task.status, 'done');

  const auditEvent = events.find((entry) => entry.event === 'warehouse' && entry.data.type === 'audit_delta');
  assert.ok(auditEvent);
  assert.ok(auditEvent.data.data.diffs.some((container) =>
    container.diffs.some((diff) => diff.reason === 'components_changed')));
  assert.equal(feature.store.getItemsByContainer(cid)[0].stack_identity, getItemIdentityHash(actualItem));
});

test('audit:旧索引缺少组件身份时静默回填', () => {
  const world = createWorld({ tmpRoot: TEST_TMP_DIR });
  const actualItem = item('book', 1, 0, {
    components: [{ type: 'custom_name', data: { value: 'Alpha' } }]
  });
  const actual = [{
    slot: 0,
    item_name: 'minecraft:book',
    count: 1,
    stack_identity: getItemIdentityHash(actualItem)
  }];
  const legacy = [{ slot: 0, item_name: 'minecraft:book', count: 1, stack_identity: null }];

  assert.deepEqual(world.feature.compareItems(legacy, actual), []);
});

test('audit:单箱盘点只处理指定容器', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    containers: { 矿石箱: [item('iron_ingot', 10, 0)] },
    inboxContents: []
  });
  const { feature, calls } = world;
  const cid = feature.store.upsertContainer({ x: 10, y: 64, z: 0, name: '矿石箱', type: 'chest' });
  feature.store.replaceContainerItems(cid, [{ slot: 0, item_name: 'minecraft:iron_ingot', count: 5 }]);

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse audit 矿石箱');
  const taskId = getTaskIdFromReplies(context.messages);
  const task = await waitForTaskDone(feature, taskId);
  assert.equal(task.status, 'done');
  assert.equal(feature.store.countItem('minecraft:iron_ingot'), 10);
  // 只打开过矿石箱(10,64,0),杂项箱(20,64,0)不应被打开
  assert.ok(calls.some((c) => c[0] === 'open' && c[1] === 10));
  assert.ok(!calls.some((c) => c[0] === 'open' && c[1] === 20));
});

// ---------- withdraw ----------

test('withdraw:取出到 pickup 取货箱并刷新源容器索引', async () => {
  const rules = {
    containers: [{ name: '矿石箱', x: 10, y: 64, z: 0, allow: ['minecraft:iron_ingot'] }],
    pickup: { x: 30, y: 64, z: 0 }
  };
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    rules,
    containers: { 矿石箱: [item('iron_ingot', 10, 0)] }
  });
  const { feature, containers } = world;
  const oreBox = containers.get('10,64,0');
  const pickupBox = containers.get('30,64,0');

  const cid = feature.store.upsertContainer({ x: 10, y: 64, z: 0, name: '矿石箱', type: 'chest' });
  feature.store.replaceContainerItems(cid, [{ slot: 0, item_name: 'minecraft:iron_ingot', count: 10 }]);

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse withdraw iron_ingot 6');
  const taskId = getTaskIdFromReplies(context.messages);
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('已入队')));
  const task = await waitForTaskDone(feature, taskId);
  assert.equal(task.status, 'done');

  assert.deepEqual(chestContents(pickupBox), [{ slot: 0, name: 'minecraft:iron_ingot', count: 6 }]);
  assert.deepEqual(chestContents(oreBox), [{ slot: 0, name: 'minecraft:iron_ingot', count: 4 }]);
  // 源容器索引已刷新
  assert.equal(feature.store.countItem('minecraft:iron_ingot'), 4);
});

test('withdraw:交付给请求者(toss)', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    containers: { 矿石箱: [item('iron_ingot', 10, 0)] }
  });
  const { feature, bot, calls } = world;
  const cid = feature.store.upsertContainer({ x: 10, y: 64, z: 0, name: '矿石箱', type: 'chest' });
  feature.store.replaceContainerItems(cid, [{ slot: 0, item_name: 'minecraft:iron_ingot', count: 10 }]);

  bot.players['player-a'] = {
    entity: { position: { x: 50, y: 64, z: 50 } }
  };
  bot.tossStack = (type, metadata, count, callback) => {
    calls.push(['toss', type, metadata, count]);
    callback(null);
  };

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse withdraw iron_ingot 3');
  const taskId = getTaskIdFromReplies(context.messages);
  const task = await waitForTaskDone(feature, taskId);
  assert.equal(task.status, 'done');

  assert.ok(calls.some((c) => c[0] === 'goto'), '应走向玩家');
  assert.ok(calls.some((c) => c[0] === 'toss' && c[3] === 3), '应 toss 3 个');
});

test('withdraw:库存不足时任务失败', async () => {
  const world = createWorld({ tmpRoot: TEST_TMP_DIR });
  const { feature } = world;

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse withdraw emerald 1');
  const taskId = getTaskIdFromReplies(context.messages);
  const task = await waitForTaskDone(feature, taskId);
  assert.equal(task.status, 'failed');
  assert.ok(task.error.includes('库存中没有'));
});

// ---------- 任务队列 ----------

test('task list 与 cancel', async () => {
  const world = createWorld({ tmpRoot: TEST_TMP_DIR });
  const { feature } = world;

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse task list');
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('任务队列为空')));
});

test('task:入队后立即取消,任务终态为 cancelled', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    containers: {
      矿石箱: [item('iron_ingot', 10, 0), item('iron_ingot', 10, 1), item('iron_ingot', 10, 2)]
    },
    inboxContents: [item('dirt', 1, 0)]
  });
  const { feature } = world;

  // 入队 audit(3 容器,循环有取消检查点)
  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse audit');
  const taskId = getTaskIdFromReplies(context.messages);

  // 立即取消
  const cancelContext = createContext();
  await feature.handleWarehouseCommand(cancelContext, `warehouse task cancel ${taskId}`);

  const task = await waitForTaskDone(feature, taskId);
  assert.equal(task.status, 'cancelled');
});

test('task:断点恢复——running 任务 detach 后转 interrupted,attach 后转 queued 并保留进度', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    containers: { 矿石箱: [item('iron_ingot', 10, 0)] },
    inboxContents: []
  });
  const { feature, bot, calls } = world;

  // 造一个 running 的 audit 任务,进度指向第 2 个容器(nextIndex=1)
  const taskId = feature.store.createTask({ botId: 'test-bot', type: 'audit' });
  feature.store.updateTask(taskId, {
    status: 'running',
    progress: { nextIndex: 1, done: 1, total: 2 }
  });

  // detach:running → interrupted
  feature.detach();
  assert.equal(feature.store.getTask(taskId).status, 'interrupted');
  assert.ok(feature.store.getTask(taskId).progress.includes('"nextIndex":1'), '应保留断点进度');

  // attach:interrupted → queued 并自动从断点续跑
  feature.attach(bot);
  const task = await waitForTaskDone(feature, taskId);
  assert.equal(task.status, 'done');

  // 续跑从第 2 个容器开始:第 1 个容器(10,64,0)不应再被打开
  assert.ok(!calls.some((c) => c[0] === 'open' && c[1] === 10));
});

test('task:多个任务依次执行,全部完成', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    inboxContents: [item('iron_ingot', 5, 0)]
  });
  const { feature, containers } = world;
  const oreBox = containers.get('10,64,0');

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse sort');
  const id1 = getTaskIdFromReplies(context.messages);
  await feature.handleWarehouseCommand(context, 'warehouse audit');
  const id2 = getTaskIdFromReplies(context.messages);

  const t1 = await waitForTaskDone(feature, id1);
  const t2 = await waitForTaskDone(feature, id2);
  assert.equal(t1.status, 'done');
  assert.equal(t2.status, 'done');
  assert.deepEqual(chestContents(oreBox), [{ slot: 0, name: 'minecraft:iron_ingot', count: 5 }]);
});

test('task:任务状态事件发布(task_status)', async () => {
  const world = createWorld({
    tmpRoot: TEST_TMP_DIR,
    inboxContents: [item('iron_ingot', 5, 0)]
  });
  const { feature, events } = world;

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse sort');
  const taskId = getTaskIdFromReplies(context.messages);
  await waitForTaskDone(feature, taskId);

  const statusEvents = events.filter((entry) => entry.event === 'warehouse' && entry.data.type === 'task_status');
  assert.ok(statusEvents.length >= 2, '至少发布 queued 与终态事件');
  const last = statusEvents[statusEvents.length - 1].data.data;
  assert.equal(last.id, taskId);
  assert.equal(last.status, 'done');
});
