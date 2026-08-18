const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { WarehouseFeature } = require('../src/warehouse/WarehouseFeature');
const { getStoreForWarehouse, closeAllStores } = require('../src/warehouse/StoreRegistry');

const TEST_TMP_DIR = path.resolve(__dirname, '.tmp', 'feature');
const PENDING_DELETE_DIR = path.resolve(__dirname, '..', '.pending-delete');

const VALID_RULES = {
  inbox: [{ x: 90, y: 64, z: 190 }],
  containers: [
    { name: '矿石箱', x: 100, y: 64, z: 200, allow: ['minecraft:iron_ingot'] },
    { name: '杂项箱', x: 102, y: 64, z: 200, default: true }
  ]
};

function createContext() {
  const messages = [];
  return {
    messages,
    replyInfo(message) {
      messages.push(['info', message]);
    },
    replyError(message) {
      messages.push(['error', message]);
    }
  };
}

function createFeature(serverDir, configOverrides = {}) {
  return new WarehouseFeature({
    logger: null,
    config: { enabled: true, rulesFile: 'rules.json', ...configOverrides },
    paths: { serverDir }
  });
}

function withWarehouseSettings(settings) {
  return { ...VALID_RULES, ...settings };
}

function createServerDir(prefix, rules) {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_TMP_DIR, prefix));
  if (rules) {
    fs.mkdirSync(path.join(dir, 'warehouse'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'warehouse', 'rules.json'), JSON.stringify(rules), 'utf8');
  }
  return dir;
}

// 测试产生的临时 db/规则文件不删除,统一移交待删除区,由用户决定最终处理。
test.after(() => {
  closeAllStores();
  if (!fs.existsSync(TEST_TMP_DIR)) {
    return;
  }
  const entries = fs.readdirSync(TEST_TMP_DIR);
  for (const entry of entries) {
    const src = path.join(TEST_TMP_DIR, entry);
    const destDir = path.join(PENDING_DELETE_DIR, 'test-warehouse-feature');
    fs.mkdirSync(destDir, { recursive: true });
    let dest = path.join(destDir, entry);
    if (fs.existsSync(dest)) {
      dest = path.join(destDir, `${Date.now()}-${entry}`);
    }
    fs.renameSync(src, dest);
  }
});

test('isAvailable:无 serverDir 时不可用', () => {
  const feature = createFeature(null);
  assert.equal(feature.isAvailable(), false);
});

test('attach 加载规则并初始化 store', () => {
  const serverDir = createServerDir('wh-valid-', VALID_RULES);
  const feature = createFeature(serverDir);
  feature.attach({});

  assert.equal(feature.isAvailable(), true);
  assert.ok(feature.store, 'store 已初始化');
  assert.equal(feature.rules.containers.length, 2);
  assert.equal(feature.rules.inbox.length, 1);
  assert.equal(feature.rulesErrors.length, 0);

  // store 按 serverDir 共享
  const feature2 = createFeature(serverDir);
  feature2.attach({});
  assert.equal(feature2.store, feature.store);

  feature.detach();
  assert.equal(feature.bot, null);
  feature.detach(); // 幂等
});

test('仓库正确映射真实玩家背包索引到容器窗口索引', () => {
  const serverDir = createServerDir('wh-inventory-index-', VALID_RULES);
  const bot = {
    inventory: {
      inventoryStart: 9,
      inventoryEnd: 45,
      slots: new Array(46).fill(null)
    }
  };
  bot.inventory.slots[0] = { name: 'crafting_only' };
  bot.inventory.slots[9] = { name: 'iron_ingot', count: 1 };
  const feature = createFeature(serverDir);
  feature.attach(bot);

  assert.equal(feature.findInventoryFreeSlot(), 10);
  assert.deepEqual(feature.readBackpack().map((entry) => entry.invIndex), [9]);
  assert.equal(feature.getWindowInventorySlot({ inventoryStart: 27 }, 9), 27);
  assert.equal(feature.getWindowInventorySlot({ inventoryStart: 27 }, 44), 62);
  feature.detach();
});

test('打开容器后根据窗口背包区选择下一个空槽', () => {
  const serverDir = createServerDir('wh-window-free-slot-', VALID_RULES);
  const bot = {
    inventory: {
      inventoryStart: 9,
      inventoryEnd: 45,
      slots: new Array(46).fill(null)
    }
  };
  const window = {
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: new Array(63).fill(null)
  };
  window.slots[27] = { name: 'iron_ingot', count: 1 };
  const feature = createFeature(serverDir);
  feature.attach(bot);

  assert.equal(feature.findInventoryFreeSlot(window), 10);
  feature.detach();
});

test('attach 时规则文件缺失:rules 为 null 且记录错误', () => {
  const serverDir = createServerDir('wh-missing-', null);
  const feature = createFeature(serverDir);
  feature.attach({});

  assert.equal(feature.rules, null);
  assert.ok(feature.rulesErrors.length > 0);
});

test('reloadRules:坏 JSON 时失败并保留错误,修复后成功', () => {
  const serverDir = createServerDir('wh-reload-', { containers: [] });
  const feature = createFeature(serverDir);
  feature.attach({});

  // 初始规则无效(containers 空数组)
  assert.equal(feature.rules, null);
  assert.ok(feature.rulesErrors.some((e) => e.includes('containers')));

  // 修复规则文件后重载成功
  const rulesPath = path.join(serverDir, 'warehouse', 'rules.json');
  fs.writeFileSync(rulesPath, JSON.stringify(VALID_RULES), 'utf8');
  const result = feature.reloadRules();
  assert.equal(result.ok, true);
  assert.equal(feature.rules.containers.length, 2);
  assert.equal(feature.rulesErrors.length, 0);
});

test('handleWarehouseCommand:help 输出子命令', async () => {
  const serverDir = createServerDir('wh-cmd-', VALID_RULES);
  const feature = createFeature(serverDir);
  feature.attach({});

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse help');
  const text = context.messages.map((entry) => entry[1]).join('\n');
  assert.ok(text.includes('warehouse rules'));
  assert.ok(text.includes('warehouse reload'));
});

test('handleWarehouseCommand:rules 输出摘要与 default 箱', async () => {
  const serverDir = createServerDir('wh-cmd-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } },
    idle: { enabled: true, position: { x: 1, y: 74, z: 2 } },
    automation: {
      pickupSort: { enabled: true, delaySeconds: 10 },
      scheduled: { enabled: true, intervalSeconds: 1800, action: 'sortThenAudit' }
    }
  }));
  const feature = createFeature(serverDir);
  feature.attach({});

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse rules');
  const text = context.messages.map((entry) => entry[1]).join('\n');
  assert.ok(text.includes('2 个容器'));
  assert.ok(text.includes('1 个暂存箱'));
  assert.ok(text.includes('杂项(default)箱: 杂项箱'));
  assert.ok(text.includes('lockY=74'));
  assert.ok(text.includes('idle=开启'));
  assert.ok(text.includes('pickupSort=开启'));
  assert.ok(text.includes('scheduled=开启'));
});

test('handleWarehouseCommand:规则未加载时 rules 报错', async () => {
  const serverDir = createServerDir('wh-cmd-', null);
  const feature = createFeature(serverDir);
  feature.attach({});

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse rules');
  assert.equal(context.messages[0][0], 'error');
  assert.ok(context.messages[0][1].includes('规则未加载'));
});

test('handleWarehouseCommand:reload 成功与失败', async () => {
  const serverDir = createServerDir('wh-cmd-', withWarehouseSettings({
    movement: { lockY: { enabled: false, value: 74 } }
  }));
  const feature = createFeature(serverDir);
  feature.attach({});

  let context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse reload');
  assert.equal(context.messages[0][0], 'info');
  assert.ok(context.messages[0][1].includes('规则已重载'));
  assert.equal(feature.getLockedY(), null);

  fs.writeFileSync(
    path.join(serverDir, 'warehouse', 'rules.json'),
    JSON.stringify(withWarehouseSettings({ movement: { lockY: { enabled: true, value: 74 } } })),
    'utf8'
  );
  context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse reload');
  assert.equal(context.messages[0][0], 'info');
  assert.equal(feature.getLockedY(), 74);

  fs.writeFileSync(path.join(serverDir, 'warehouse', 'rules.json'), '{ bad', 'utf8');
  context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse reload');
  assert.equal(context.messages[0][0], 'error');
  assert.ok(context.messages[0][1].includes('规则重载失败'));
});

test('handleWarehouseCommand:未知子命令与不可用实例', async () => {
  const serverDir = createServerDir('wh-cmd-', VALID_RULES);
  const feature = createFeature(serverDir);
  feature.attach({});

  let context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse nonsense');
  assert.equal(context.messages[0][0], 'error');
  assert.ok(context.messages[0][1].includes('未知子命令'));

  const unavailable = createFeature(null);
  context = createContext();
  await unavailable.handleWarehouseCommand(context, 'warehouse help');
  assert.equal(context.messages[0][0], 'error');
  assert.ok(context.messages[0][1].includes('不支持仓库功能'));
});

test('getStoreForWarehouse 按仓库目录共享并隔离数据库', () => {
  const serverDir = createServerDir('wh-registry-', VALID_RULES);
  const warehouseDir = path.join(serverDir, 'warehouse');
  const otherWarehouseDir = path.join(serverDir, 'other-warehouse');
  const store1 = getStoreForWarehouse(warehouseDir);
  const store2 = getStoreForWarehouse(warehouseDir);
  const otherStore = getStoreForWarehouse(otherWarehouseDir);
  assert.equal(store1, store2);
  assert.notEqual(store1, otherStore);

  const id = store1.upsertContainer({ x: 1, y: 2, z: 3, name: 'A' });
  assert.equal(store2.getContainer(1, 2, 3).id, id);
  assert.equal(otherStore.getContainer(1, 2, 3), null);

  closeAllStores();
});

test('WarehouseFeature 从 WareHouse/serverDir/wh1 加载规则和数据库', () => {
  const serverDir = createServerDir('wh-external-root-', null);
  const warehouseServerDir = path.join(serverDir, 'WareHouse', 'EDEN');
  const warehouseDir = path.join(warehouseServerDir, 'wh1');
  fs.mkdirSync(warehouseDir, { recursive: true });
  fs.writeFileSync(path.join(warehouseDir, 'rules.json'), JSON.stringify(VALID_RULES), 'utf8');

  const feature = new WarehouseFeature({
    logger: null,
    config: { enabled: true, rulesFile: 'wh1/rules.json' },
    paths: { serverDir, serverDirName: 'EDEN', warehouseServerDir }
  });
  feature.attach({});

  assert.equal(feature.rulesFilePath, path.join(warehouseDir, 'rules.json'));
  assert.equal(feature.warehouseDir, warehouseDir);
  assert.ok(fs.existsSync(path.join(warehouseDir, 'warehouse.db')));
  feature.detach();
});

test('WarehouseFeature 拒绝 rulesFile 路径穿越和反斜杠', () => {
  const serverDir = createServerDir('wh-invalid-path-', null);
  const warehouseServerDir = path.join(serverDir, 'WareHouse', 'EDEN');

  for (const rulesFile of ['../rules.json', 'wh1\\rules.json']) {
    const feature = new WarehouseFeature({
      logger: null,
      config: { enabled: true, rulesFile },
      paths: { serverDir, serverDirName: 'EDEN', warehouseServerDir }
    });
    feature.attach({});
    assert.equal(feature.rules, null);
    assert.equal(feature.store, null);
    assert.ok(feature.rulesErrors.some((error) => error.includes('warehouse.rulesFile')));
    feature.detach();
  }
});

test('仓库移动在调用寻路前等待 physics 插件就绪', async () => {
  const serverDir = createServerDir('wh-physics-wait-', VALID_RULES);
  const calls = [];
  const feature = createFeature(serverDir);
  feature.movementFeature = {
    async waitForPhysicsReady(timeoutMs, retryIntervalMs) {
      calls.push(['waitPhysics', timeoutMs, retryIntervalMs]);
    },
    gotoExact(x, y, z) {
      calls.push(['goto', x, y, z]);
    },
    async awaitGoalReached() {
      calls.push(['arrive']);
    }
  };
  feature.attach({});

  await feature.moveToWarehousePosition({ x: 1, y: 2, z: 3 });
  assert.deepEqual(calls, [
    ['waitPhysics', 5000, 100],
    ['goto', 1, 2, 3],
    ['arrive']
  ]);
  feature.detach();
});

test('锁高仓库移动等待出生高度和区块碰撞数据就绪', async () => {
  const serverDir = createServerDir('wh-height-wait-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const calls = [];
  const feature = createFeature(serverDir);
  feature.movementFeature = {
    async waitForPhysicsReady() {
      calls.push('physics');
    },
    async waitForLockedHeightReady(lockY, timeoutMs, retryIntervalMs) {
      calls.push(['height', lockY, timeoutMs, retryIntervalMs]);
    },
    gotoExact() {
      calls.push('goto');
    },
    async awaitGoalReached() {
      calls.push('arrive');
    }
  };
  feature.attach({});

  await feature.moveToWarehousePosition({ x: 1, y: 74, z: 3 });
  assert.deepEqual(calls, [
    'physics',
    ['height', 74, 5000, 100],
    'goto',
    'arrive'
  ]);
  feature.detach();
});

test('仓库目标槽只合并完整组件身份相同的物品', () => {
  const serverDir = createServerDir('wh-component-identity-', VALID_RULES);
  const feature = createFeature(serverDir);
  const source = {
    type: 1,
    name: 'minecraft:book',
    count: 1,
    metadata: 0,
    components: [{ type: 'minecraft:custom_name', data: 'alpha' }],
    removedComponents: []
  };
  const window = {
    inventoryStart: 3,
    slots: [
      { ...source, slot: 0, count: 32, components: [{ type: 'minecraft:custom_name', data: 'beta' }] },
      { ...source, slot: 1, count: 32, components: [{ type: 'minecraft:custom_name', data: 'beta' }] },
      null
    ]
  };

  assert.equal(feature.findTargetSlot(window, source, 1), 2);
});

test('仓库目标槽不会把 stackSize=1 的同身份物品当作可合并', () => {
  const serverDir = createServerDir('wh-stack-size-', VALID_RULES);
  const feature = createFeature(serverDir);
  const source = {
    type: 2,
    name: 'minecraft:flint_and_steel',
    count: 1,
    stackSize: 1,
    metadata: 0,
    components: [],
    removedComponents: []
  };
  const window = {
    inventoryStart: 3,
    slots: [
      { ...source, slot: 0 },
      null,
      null
    ]
  };

  assert.equal(feature.findTargetSlot(window, source, 1), 1);
});

test('仓库搬运会拒绝窗口层报告的失败结果', async () => {
  const serverDir = createServerDir('wh-move-result-', VALID_RULES);
  const feature = createFeature(serverDir);
  const item = {
    type: 2,
    name: 'minecraft:flint_and_steel',
    count: 1,
    stackSize: 1,
    metadata: 0
  };
  const window = {
    inventoryStart: 1,
    slots: [item, null]
  };
  feature.bot = {
    inventory: { slots: [null], inventoryStart: 0 }
  };
  feature.windowFeature = {
    async moveSlotItem() {
      return { ok: false, restored: true };
    }
  };

  await assert.rejects(
    feature.moveFromContainerToInventoryInWindow(window, 0, 1, 0),
    /服务器拒绝了槽位搬运，物品已恢复到源槽/
  );
});

// ---------- inspect ----------

const { EventEmitter } = require('events');

const SNAPSHOT = {
  id: 7,
  name: 'chest',
  supported: true,
  inventoryStart: 27,
  inventoryEnd: 63,
  slots: [
    { slot: 0, name: 'minecraft:iron_ingot', displayName: '铁锭', count: 64, metadata: 0, durabilityUsed: null, maxDurability: null },
    { slot: 1, name: 'minecraft:gold_ingot', displayName: '金锭', count: 32, metadata: 0, durabilityUsed: null, maxDurability: null }
  ]
};

function createInspectFeature(serverDir, options = {}) {
  const bot = new EventEmitter();
  const calls = [];
  const feature = createFeature(serverDir);
  feature.movementFeature = {
    goto(x, y, z) {
      calls.push(['goto', x, y, z]);
    },
    async awaitGoalReached() {
      calls.push(['arrive']);
    }
  };
  feature.blockUseFeature = {
    async openBlock(x, y, z) {
      calls.push(['open', x, y, z]);
      if (options.openBlockError) {
        throw options.openBlockError;
      }
      if (options.emitWindow !== false) {
        // 模拟真实开箱的异步 windowOpen 事件
        setImmediate(() => bot.emit('windowOpen', { id: 7 }));
      }
    }
  };
  feature.windowFeature = {
    getCurrentSnapshot() {
      calls.push(['snapshot']);
      return options.snapshot || SNAPSHOT;
    },
    async closeWindow() {
      calls.push(['close']);
    }
  };
  feature.attach(bot);
  return { feature, bot, calls };
}

test('inspect:走到→开箱→读快照→写索引→回复清单', async () => {
  const serverDir = createServerDir('wh-inspect-', VALID_RULES);
  const { feature, calls } = createInspectFeature(serverDir);

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse inspect 100 64 200');

  assert.deepEqual(calls, [
    ['goto', 101, 64, 200],
    ['arrive'],
    ['open', 100, 64, 200],
    ['snapshot'],
    ['close']
  ]);
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('容器 chest')));
  assert.ok(context.messages.some(([kind, text]) => kind === 'info' && text.includes('铁锭×64')));

  // 索引已写入:容器 + 物品
  const container = feature.store.getContainer(100, 64, 200);
  assert.ok(container);
  const iron = feature.store.queryItemsByName('minecraft:iron_ingot');
  assert.equal(iron.length, 1);
  assert.equal(iron[0].count, 64);
  assert.equal(feature.store.summarize().length, 2);
});

test('inspect:参数错误与未连接', async () => {
  const serverDir = createServerDir('wh-inspect-', VALID_RULES);
  const { feature } = createInspectFeature(serverDir);

  let context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse inspect 1 2');
  assert.equal(context.messages[0][0], 'error');
  assert.ok(context.messages[0][1].includes('用法'));

  context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse inspect a b c');
  assert.equal(context.messages[0][0], 'error');
  assert.ok(context.messages[0][1].includes('坐标必须是数字'));

  feature.detach();
  context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse inspect 1 2 3');
  assert.equal(context.messages[0][0], 'error');
  assert.ok(context.messages[0][1].includes('bot 未连接'));
});

test('inspect:开箱超时回滚并关闭窗口', async () => {
  const serverDir = createServerDir('wh-inspect-', VALID_RULES);
  const { feature, calls } = createInspectFeature(serverDir, { emitWindow: false });

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse inspect 100 64 200');

  assert.ok(calls.some((entry) => Array.isArray(entry) && entry[0] === 'close'), '超时后应关闭窗口');
  assert.ok(
    context.messages.some(([kind, text]) => kind === 'error' && text.includes('检查容器失败')),
    '应回复检查失败'
  );
  assert.ok(
    context.messages.some(([kind, text]) => kind === 'error' && text.includes('超时')),
    '应包含超时原因'
  );
});

test('inspect:找不到方块时失败且不写索引', async () => {
  const serverDir = createServerDir('wh-inspect-', VALID_RULES);
  const { feature } = createInspectFeature(serverDir, {
    openBlockError: new Error('在坐标 (100, 64, 200) 找不到方块')
  });

  const context = createContext();
  await feature.handleWarehouseCommand(context, 'warehouse inspect 100 64 200');

  assert.ok(
    context.messages.some(([kind, text]) => kind === 'error' && text.includes('找不到方块')),
    '应回复找不到方块'
  );
  assert.equal(feature.store.getContainer(100, 64, 200), null);
});

test('openContainerAt uses a lockY-safe 4-block approach position', async () => {
  const serverDir = createServerDir('wh-approach-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const bot = new EventEmitter();
  bot.entity = { position: { x: 0, y: 74, z: 0 } };
  const calls = [];
  const feature = createFeature(serverDir);
  feature.movementFeature = {
    gotoExact(x, y, z, options, movementOptions) {
      calls.push(['gotoExact', x, y, z, movementOptions]);
    },
    async awaitGoalReached() {
      calls.push(['arrive']);
    },
    stop() {}
  };
  feature.blockUseFeature = {
    async openBlock(x, y, z) {
      calls.push(['open', x, y, z]);
      setImmediate(() => bot.emit('windowOpen', { id: 8 }));
    }
  };
  feature.windowFeature = { async closeWindow() {} };
  feature.attach(bot);

  await feature.openContainerAt(100, 76, 200);

  assert.equal(calls[0][0], 'gotoExact');
  assert.equal(calls[0][2], 74);
  assert.deepEqual(calls[0][4], { lockY: 74 });
  assert.ok(feature.getContainerInteractionDistance(
    { x: calls[0][1], y: calls[0][2], z: calls[0][3] },
    100,
    76,
    200
  ) <= 4);
  assert.deepEqual(calls.slice(1), [
    ['arrive'],
    ['open', 100, 76, 200]
  ]);
  feature.detach();
});

test('locked approach accepts vertical projection within 4 blocks and rejects farther containers', () => {
  const serverDir = createServerDir('wh-approach-range-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const feature = createFeature(serverDir);
  feature.attach({ entity: { position: { x: 0, y: 74, z: 0 } } });

  const approaches = feature.getLockedContainerApproachPositions(100, 79, 200);
  assert.ok(approaches.some((position) => (
    position.x === 100 && position.y === 74 && position.z === 200
  )));
  assert.throws(
    () => feature.getLockedContainerApproachPosition(100, 80, 200),
    /锁定高度 y=74 上超出 4 格交互范围/
  );
  feature.detach();
});

test('locked approach reaches a corridor four blocks from a container wall', () => {
  const serverDir = createServerDir('wh-approach-corridor-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const feature = createFeature(serverDir);
  feature.attach({ entity: { position: { x: 73, y: 74, z: 85 } } });

  assert.deepEqual(
    feature.getLockedContainerApproachPosition(63, 74, 85),
    { x: 67, y: 74, z: 85 }
  );
  assert.ok(feature.getContainerInteractionDistance({ x: 67, y: 74, z: 85 }, 63, 74, 85) < 4);
  feature.detach();
});

test('locked approach includes the reported stair position for a high container', () => {
  const serverDir = createServerDir('wh-approach-stair-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const feature = createFeature(serverDir);
  feature.attach({ entity: { position: { x: 71, y: 74, z: 132 } } });

  assert.ok(feature.getLockedContainerApproachPositions(75, 77, 132).some((position) => (
    position.x === 71 && position.y === 74 && position.z === 132
  )));
  feature.detach();
});

test('locked approach excludes occupied feet and head blocks before pathfinding', () => {
  const serverDir = createServerDir('wh-approach-occupied-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const feature = createFeature(serverDir);
  feature.attach({
    entity: { position: { x: 73, y: 74, z: 85 } },
    blockAt(position) {
      const occupied = position.x === 67 && position.z === 85 && [74, 75].includes(position.y);
      return { boundingBox: occupied ? 'block' : 'empty' };
    }
  });

  assert.notDeepEqual(
    feature.getLockedContainerApproachPosition(63, 74, 85),
    { x: 67, y: 74, z: 85 }
  );
  feature.detach();
});

test('locked approach accepts 0.0625 carpet at feet but not a half slab', () => {
  const serverDir = createServerDir('wh-approach-carpet-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const feature = createFeature(serverDir);
  const blocks = new Map();
  const key = (position) => `${position.x},${position.y},${position.z}`;
  blocks.set('67,74,85', {
    boundingBox: 'block',
    shapes: [[0, 0, 0, 1, 0.0625, 1]]
  });
  feature.attach({
    entity: { position: { x: 67, y: 74, z: 85 } },
    blockAt(position) {
      return blocks.get(key(position)) || { boundingBox: 'empty', shapes: [] };
    }
  });

  assert.equal(feature.isWarehouseStandingSpaceOpen({ x: 67, y: 74, z: 85 }), true);
  blocks.set('67,74,85', {
    boundingBox: 'block',
    shapes: [[0, 0, 0, 1, 0.5, 1]]
  });
  assert.equal(feature.isWarehouseStandingSpaceOpen({ x: 67, y: 74, z: 85 }), false);
  feature.detach();
});

test('warehouse lockY readiness automatically recovers after the initial wait fails', async () => {
  const serverDir = createServerDir('wh-height-recovery-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const calls = [];
  const feature = createFeature(serverDir);
  feature.movementFeature = {
    async waitForLockedHeightReady() {
      calls.push('wait');
      throw new Error('bot 当前高度不是锁定高度 y=74');
    },
    async recoverLockedHeight(lockY) {
      calls.push(['recover', lockY]);
      return {
        recovered: true,
        target: { x: 2, y: lockY, z: 3, source: 'nearest' }
      };
    }
  };
  feature.attach({ entity: { position: { x: 0, y: 73, z: 0 } } });

  await feature.ensureWarehouseLockedHeight(74);

  assert.deepEqual(calls, ['wait', ['recover', 74]]);
  feature.detach();
});

test('locked container movement retries another safe position after noPath', async () => {
  const serverDir = createServerDir('wh-approach-retry-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const bot = new EventEmitter();
  bot.entity = { position: { x: 0, y: 74, z: 0 } };
  const calls = [];
  let attempts = 0;
  const feature = createFeature(serverDir);
  feature.movementFeature = {
    gotoExact(x, y, z) {
      calls.push([x, y, z]);
    },
    async awaitGoalReached() {
      attempts += 1;
      if (attempts === 1) throw new Error('寻路器未找到可达路径');
    }
  };
  feature.attach(bot);

  await feature.moveToWarehouseContainer(100, 74, 200);

  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, y]) => y === 74));
  assert.notDeepEqual(calls[0], calls[1]);
  feature.detach();
});

test('locked container movement retries another position when the container is occluded', async () => {
  const serverDir = createServerDir('wh-approach-visibility-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } }
  }));
  const bot = new EventEmitter();
  bot.entity = { position: { x: 0, y: 74, z: 0 } };
  const calls = [];
  let visibilityChecks = 0;
  const feature = createFeature(serverDir);
  feature.movementFeature = {
    gotoExact(x, y, z) {
      calls.push([x, y, z]);
    },
    async awaitGoalReached() {}
  };
  feature.blockUseFeature = {
    isBlockVisibleAt() {
      visibilityChecks += 1;
      return visibilityChecks >= 2;
    }
  };
  feature.attach(bot);

  await feature.moveToWarehouseContainer(100, 74, 200);

  assert.equal(calls.length, 2);
  assert.notDeepEqual(calls[0], calls[1]);
  feature.detach();
});

test('warehouse automation validates idle height and debounces pickup sorting', async () => {
  const serverDir = createServerDir('wh-automation-invalid-', withWarehouseSettings({
    movement: { lockY: { enabled: true, value: 74 } },
    idle: { enabled: true, position: { x: 1, y: 73, z: 2 } },
    automation: { pickupSort: { enabled: true, delaySeconds: 0 } }
  }));
  const bot = new EventEmitter();
  bot.entity = { position: { y: 74 } };
  const feature = createFeature(serverDir);
  feature.attach(bot);
  assert.equal(feature.rules, null);
  assert.ok(feature.rulesErrors.some((error) => /position\.y/.test(error)));
  feature.detach();

  const validServerDir = createServerDir('wh-automation-valid-', withWarehouseSettings({
    automation: { pickupSort: { enabled: true, delaySeconds: 0 } }
  }));
  const valid = createFeature(validServerDir);
  valid.attach(bot);
  const actions = [];
  valid.enqueueAutomaticAction = (type, reason) => actions.push([type, reason]);
  valid.handlePlayerCollect(bot.entity);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(actions, [['sort', 'pickup']]);
  valid.detach();
});

test('warehouse idle movement waits until spawn and can be delayed', async () => {
  const serverDir = createServerDir('wh-idle-spawn-', withWarehouseSettings({
    idle: { enabled: true, position: { x: 1, y: 74, z: 2 } }
  }));
  const bot = new EventEmitter();
  bot.entity = { position: { x: 0, y: 74, z: 0 } };
  const calls = [];
  const feature = createFeature(serverDir);
  feature.movementFeature = {
    gotoExact(x, y, z) {
      calls.push([x, y, z]);
    },
    async awaitGoalReached() {}
  };
  feature.attach(bot);

  feature.scheduleIdleMove(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, []);

  feature.handleSpawn();
  feature.scheduleIdleMove(5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [[1, 74, 2]]);
  feature.detach();
});

test('warehouse scheduled sortThenAudit enqueues both stages without duplicates', () => {
  const serverDir = createServerDir('wh-schedule-', withWarehouseSettings({
    automation: {
      scheduled: { enabled: true, intervalSeconds: 10, action: 'sortThenAudit' }
    }
  }));
  const feature = createFeature(serverDir);
  feature.attach(new EventEmitter());
  const actions = [];
  feature.enqueueAutomaticAction = (type, reason) => actions.push([type, reason]);
  feature.enqueueScheduledAction();
  assert.deepEqual(actions, [['sort', 'scheduled'], ['audit', 'scheduled']]);
  feature.detach();
});
