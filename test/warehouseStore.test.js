const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { WarehouseStore } = require('../src/warehouse/WarehouseStore');

const TEST_TMP_DIR = path.resolve(__dirname, '.tmp', 'store');
const PENDING_DELETE_DIR = path.resolve(__dirname, '..', '.pending-delete');

function createMemoryStore() {
  return new WarehouseStore({ dbPath: ':memory:' });
}

function sampleItems() {
  return [
    { slot: 0, item_name: 'minecraft:iron_ingot', display_name: '铁锭', count: 64, metadata: 0 },
    { slot: 1, item_name: 'minecraft:gold_ingot', display_name: '金锭', count: 32, metadata: 0 }
  ];
}

// 测试产生的临时 db 文件不删除,统一移交待删除区,由用户决定最终处理。
test.after(() => {
  if (!fs.existsSync(TEST_TMP_DIR)) {
    return;
  }
  const entries = fs.readdirSync(TEST_TMP_DIR);
  for (const entry of entries) {
    if (!entry.startsWith('warehouse-persist-')) {
      continue;
    }
    const src = path.join(TEST_TMP_DIR, entry);
    const destDir = path.join(PENDING_DELETE_DIR, 'test-warehouse-store');
    fs.mkdirSync(destDir, { recursive: true });
    let dest = path.join(destDir, entry);
    if (fs.existsSync(dest)) {
      dest = path.join(destDir, `${Date.now()}-${entry}`);
    }
    fs.renameSync(src, dest);
  }
});

test('upsertContainer:新增返回 id,同坐标更新保持 id 不变', () => {
  const store = createMemoryStore();
  const id1 = store.upsertContainer({ x: 1, y: 2, z: 3, name: 'A', slotCount: 27 });
  const id2 = store.upsertContainer({ x: 1, y: 2, z: 3, name: 'A2', slotCount: 54, isInbox: true });
  assert.equal(id1, id2);

  const container = store.getContainer(1, 2, 3);
  assert.equal(container.name, 'A2');
  assert.equal(container.slot_count, 54);
  assert.equal(container.is_inbox, 1);
});

test('getContainer / listContainers / removeContainer', () => {
  const store = createMemoryStore();
  const idA = store.upsertContainer({ x: 1, y: 2, z: 3, name: 'A' });
  store.upsertContainer({ x: 4, y: 2, z: 3, name: 'B' });

  assert.equal(store.getContainer(1, 2, 3).id, idA);
  assert.equal(store.getContainerById(idA).name, 'A');
  assert.equal(store.listContainers().length, 2);

  store.removeContainer(idA);
  assert.equal(store.getContainerById(idA), null);
  assert.equal(store.listContainers().length, 1);
});

test('updateContainerMeta 只更新给定字段', () => {
  const store = createMemoryStore();
  const id = store.upsertContainer({ x: 1, y: 2, z: 3, name: 'A' });
  store.updateContainerMeta(id, { calibrated_at: 12345, is_inbox: true });
  const container = store.getContainerById(id);
  assert.equal(container.calibrated_at, 12345);
  assert.equal(container.is_inbox, 1);
  assert.equal(container.name, 'A');
});

test('replaceContainerItems 替换并返回条目数', () => {
  const store = createMemoryStore();
  const id = store.upsertContainer({ x: 1, y: 2, z: 3 });
  assert.equal(store.replaceContainerItems(id, sampleItems()), 2);

  const items = store.getItemsByContainer(id);
  assert.equal(items.length, 2);
  assert.equal(items[0].item_name, 'minecraft:iron_ingot');
  assert.equal(items[0].count, 64);

  // 再次替换为 1 条,旧记录被清掉
  store.replaceContainerItems(id, [{ slot: 5, item_name: 'minecraft:dirt', count: 1 }]);
  assert.equal(store.getItemsByContainer(id).length, 1);
  assert.equal(store.getItemsByContainer(id)[0].slot, 5);
});

test('replaceContainerItems 保存组件堆叠身份', () => {
  const store = createMemoryStore();
  const id = store.upsertContainer({ x: 1, y: 2, z: 3 });
  const stackIdentity = '{"components":[{"type":"custom_name"}]}';
  store.replaceContainerItems(id, [
    { slot: 0, item_name: 'minecraft:book', count: 1, stack_identity: stackIdentity }
  ]);

  assert.equal(store.getItemsByContainer(id)[0].stack_identity, stackIdentity);
});

test('migrate 为旧数据库补充 stack_identity 列', () => {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  const dbPath = path.join(TEST_TMP_DIR, `warehouse-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      container_id INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      display_name TEXT,
      count INTEGER NOT NULL,
      metadata INTEGER DEFAULT 0,
      durability_used INTEGER,
      max_durability INTEGER,
      UNIQUE (container_id, slot)
    );
  `);
  legacy.close();

  const store = new WarehouseStore({ dbPath });
  const columns = store.db.prepare('PRAGMA table_info(items)').all();
  assert.ok(columns.some((column) => column.name === 'stack_identity'));
  store.close();
});

test('replaceContainerItems 违反唯一约束时整体回滚', () => {
  const store = createMemoryStore();
  const id = store.upsertContainer({ x: 1, y: 2, z: 3 });
  store.replaceContainerItems(id, sampleItems());

  // 两条记录 slot 冲突,应抛错且旧数据保留
  assert.throws(() => {
    store.replaceContainerItems(id, [
      { slot: 0, item_name: 'minecraft:dirt', count: 1 },
      { slot: 0, item_name: 'minecraft:stone', count: 2 }
    ]);
  });

  const items = store.getItemsByContainer(id);
  assert.equal(items.length, 2);
  assert.equal(items[0].item_name, 'minecraft:iron_ingot');
});

test('removeContainer 级联删除物品记录', () => {
  const store = createMemoryStore();
  const id = store.upsertContainer({ x: 1, y: 2, z: 3 });
  store.replaceContainerItems(id, sampleItems());
  store.removeContainer(id);
  assert.equal(store.getItemsByContainer(id).length, 0);
});

test('queryItemsByName 跨容器查询并附带容器信息', () => {
  const store = createMemoryStore();
  const idA = store.upsertContainer({ x: 1, y: 2, z: 3, name: 'A' });
  const idB = store.upsertContainer({ x: 4, y: 2, z: 3, name: 'B' });
  store.replaceContainerItems(idA, [{ slot: 0, item_name: 'minecraft:iron_ingot', count: 10 }]);
  store.replaceContainerItems(idB, [
    { slot: 0, item_name: 'minecraft:iron_ingot', count: 5 },
    { slot: 1, item_name: 'minecraft:dirt', count: 3 }
  ]);

  const rows = store.queryItemsByName('minecraft:iron_ingot');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.item_name === 'minecraft:iron_ingot'));
  assert.equal(rows[0].container_name, 'A');
  assert.equal(rows[1].container_name, 'B');
});

test('summarize 跨容器汇总', () => {
  const store = createMemoryStore();
  const idA = store.upsertContainer({ x: 1, y: 2, z: 3 });
  const idB = store.upsertContainer({ x: 4, y: 2, z: 3 });
  store.replaceContainerItems(idA, [{ slot: 0, item_name: 'minecraft:iron_ingot', count: 10 }]);
  store.replaceContainerItems(idB, [
    { slot: 0, item_name: 'minecraft:iron_ingot', count: 5 },
    { slot: 1, item_name: 'minecraft:dirt', count: 3 }
  ]);

  const summary = store.summarize();
  const iron = summary.find((entry) => entry.itemName === 'minecraft:iron_ingot');
  assert.equal(iron.total, 15);
  assert.equal(iron.containerCount, 2);
  const dirt = summary.find((entry) => entry.itemName === 'minecraft:dirt');
  assert.equal(dirt.total, 3);
  assert.equal(dirt.containerCount, 1);

  assert.equal(store.countItem('minecraft:iron_ingot'), 15);
  assert.equal(store.countItem('minecraft:air'), 0);
});

test('任务 CRUD 与状态过滤', () => {
  const store = createMemoryStore();
  const id1 = store.createTask({ botId: 'bot-a', type: 'sort', payload: { region: 'r1' } });
  const id2 = store.createTask({ botId: 'bot-a', type: 'audit' });
  const id3 = store.createTask({ botId: 'bot-b', type: 'withdraw' });

  assert.ok(Number.isInteger(id1));
  assert.equal(store.getTask(id1).status, 'queued');
  assert.equal(store.getTask(id1).bot_id, 'bot-a');

  store.updateTask(id1, { status: 'running', progress: { done: 1, total: 5 } });
  assert.equal(store.getTask(id1).status, 'running');
  assert.equal(store.getTask(id1).progress, '{"done":1,"total":5}');

  store.updateTask(id1, { status: 'done' });
  store.updateTask(id2, { status: 'failed', error: 'boom' });
  store.updateTask(id3, { status: 'running' });

  assert.equal(store.listTasks().length, 3);
  assert.deepEqual(store.listTasks({ status: 'done' }).map((t) => t.id), [id1]);
  assert.deepEqual(store.listTasks({ status: ['running', 'failed'] }).map((t) => t.id).sort(), [id2, id3]);
  assert.deepEqual(store.listTasks({ botId: 'bot-a' }).map((t) => t.id).sort(), [id1, id2]);

  const counts = store.countTasksByStatus();
  assert.equal(counts.done, 1);
  assert.equal(counts.running, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.queued, undefined);
});

test('持久化:关闭后重开数据仍在', () => {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  const dbPath = path.join(TEST_TMP_DIR, `warehouse-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

  const store1 = new WarehouseStore({ dbPath });
  const id = store1.upsertContainer({ x: 10, y: 64, z: 20, name: '矿石箱', slotCount: 27 });
  store1.replaceContainerItems(id, sampleItems());
  const taskId = store1.createTask({ botId: 'bot-a', type: 'sort' });
  store1.updateTask(taskId, { status: 'running' });
  store1.close();

  const store2 = new WarehouseStore({ dbPath });
  assert.equal(store2.getContainer(10, 64, 20).name, '矿石箱');
  assert.equal(store2.getItemsByContainer(id).length, 2);
  assert.equal(store2.getTask(taskId).status, 'running');
  assert.equal(store2.countItem('minecraft:iron_ingot'), 64);
  store2.close();
});
