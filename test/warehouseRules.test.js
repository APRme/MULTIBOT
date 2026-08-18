const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  normalizeItemName,
  stripNamespace,
  parseRules,
  loadRulesFile,
  matchContainer
} = require('../src/warehouse/rules');

const VALID_RULES = {
  movement: { lockY: { enabled: true, value: 64 } },
  idle: { enabled: true, position: { x: 80, y: 64, z: 181 } },
  automation: {
    pickupSort: { enabled: true, delaySeconds: 12 },
    scheduled: { enabled: true, intervalSeconds: 60, action: 'audit' }
  },
  inbox: [{ x: 90, y: 64, z: 190 }],
  dropZone: {
    min: { x: 85, y: 63, z: 185 },
    max: { x: 95, y: 65, z: 195 }
  },
  containers: [
    { name: '矿石箱', x: 100, y: 64, z: 200, allow: ['minecraft:iron_ingot', 'gold_ingot'] },
    { name: '木材箱', x: 101, y: 64, z: 200, allow: ['minecraft:oak_log'] },
    { name: '杂项箱', x: 102, y: 64, z: 200, default: true }
  ],
  pickup: { x: 80, y: 64, z: 180 }
};

test('normalizeItemName 统一为小写 minecraft 命名空间', () => {
  assert.equal(normalizeItemName('iron_ingot'), 'minecraft:iron_ingot');
  assert.equal(normalizeItemName('minecraft:IRON_INGOT'), 'minecraft:iron_ingot');
  assert.equal(normalizeItemName('  oak_log  '), 'minecraft:oak_log');
  assert.equal(normalizeItemName(''), null);
  assert.equal(normalizeItemName(null), null);
});

test('stripNamespace 去掉 minecraft 前缀', () => {
  assert.equal(stripNamespace('minecraft:iron_ingot'), 'iron_ingot');
  assert.equal(stripNamespace('iron_ingot'), 'iron_ingot');
});

test('parseRules 接受合法规则并规范化 allow', () => {
  const result = parseRules(VALID_RULES);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.rules.inbox, [{ x: 90, y: 64, z: 190 }]);
  assert.deepEqual(result.rules.dropZone.min, { x: 85, y: 63, z: 185 });
  assert.deepEqual(result.rules.pickup, { x: 80, y: 64, z: 180 });
  assert.deepEqual(result.rules.movement, { lockY: { enabled: true, value: 64 } });
  assert.deepEqual(result.rules.idle, {
    enabled: true,
    position: { x: 80, y: 64, z: 181 }
  });
  assert.deepEqual(result.rules.automation, {
    pickupSort: { enabled: true, delaySeconds: 12 },
    scheduled: { enabled: true, intervalSeconds: 60, action: 'audit' }
  });
  assert.equal(result.rules.containers.length, 3);
  // allow 被规范化为 minecraft 前缀
  assert.deepEqual(result.rules.containers[0].allow, ['minecraft:iron_ingot', 'minecraft:gold_ingot']);
  assert.equal(result.rules.containers[2].default, true);
});

test('parseRules 接受 JSON 字符串输入', () => {
  const result = parseRules(JSON.stringify(VALID_RULES));
  assert.equal(result.ok, true);
  assert.equal(result.rules.containers.length, 3);
});

test('parseRules 拒绝非法 JSON', () => {
  const result = parseRules('{ not json');
  assert.equal(result.ok, false);
  assert.equal(result.rules, null);
  assert.ok(result.errors[0].includes('不是合法 JSON'));
});

test('parseRules 拒绝缺少 containers', () => {
  const result = parseRules({ inbox: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('containers 必须是非空数组')));
});

test('parseRules 拒绝容器坐标重复', () => {
  const rules = {
    containers: [
      { name: 'A', x: 1, y: 2, z: 3, allow: [] },
      { name: 'B', x: 1, y: 2, z: 3, allow: [] }
    ]
  };
  const result = parseRules(rules);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('坐标重复 1,2,3')));
});

test('parseRules 拒绝多个 default 箱子', () => {
  const rules = {
    containers: [
      { name: 'A', x: 1, y: 2, z: 3, default: true },
      { name: 'B', x: 4, y: 2, z: 3, default: true }
    ]
  };
  const result = parseRules(rules);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('最多只能有一个 default')));
});

test('parseRules 拒绝非法容器字段', () => {
  const result = parseRules({
    containers: [
      { name: '', x: 'a', y: 2, z: 3, allow: 'not-array', default: 'yes' }
    ]
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('containers[0]')));
});

test('parseRules 为省略的仓库运行设置提供默认值', () => {
  const result = parseRules({
    containers: [{ name: 'A', x: 1, y: 2, z: 3 }]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rules.movement, { lockY: { enabled: false, value: 74 } });
  assert.deepEqual(result.rules.idle, { enabled: false, position: null });
  assert.deepEqual(result.rules.automation, {
    pickupSort: { enabled: false, delaySeconds: 10 },
    scheduled: { enabled: false, intervalSeconds: 1800, action: 'sortThenAudit' }
  });
});

test('parseRules 拒绝非法仓库运行设置', () => {
  const result = parseRules({
    movement: { lockY: { enabled: 'yes', value: 74.5 } },
    idle: { enabled: true, position: { x: 1, y: 73, z: 2 } },
    automation: {
      pickupSort: { enabled: true, delaySeconds: -1 },
      scheduled: { enabled: true, intervalSeconds: '60', action: 'unknown' }
    },
    containers: [{ name: 'A', x: 1, y: 2, z: 3 }]
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('movement.lockY.enabled')));
  assert.ok(result.errors.some((error) => error.includes('movement.lockY.value')));
  assert.ok(result.errors.some((error) => error.includes('pickupSort.delaySeconds')));
  assert.ok(result.errors.some((error) => error.includes('scheduled.intervalSeconds')));
  assert.ok(result.errors.some((error) => error.includes('scheduled.action')));
});

test('parseRules 拒绝挂机位置与锁定高度不一致', () => {
  const result = parseRules({
    movement: { lockY: { enabled: true, value: 74 } },
    idle: { enabled: true, position: { x: 1, y: 73, z: 2 } },
    containers: [{ name: 'A', x: 1, y: 2, z: 3 }]
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('idle.position.y')));
});

test('parseRules 拒绝容器与 inbox/pickup 坐标冲突', () => {
  const rules = {
    inbox: [{ x: 1, y: 2, z: 3 }],
    pickup: { x: 4, y: 5, z: 6 },
    containers: [
      { name: 'A', x: 1, y: 2, z: 3, allow: [] },
      { name: 'B', x: 4, y: 5, z: 6, allow: [] }
    ]
  };
  const result = parseRules(rules);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('inbox 坐标与容器重复')));
  assert.ok(result.errors.some((e) => e.includes('pickup 坐标与容器重复')));
});

test('matchContainer:精确匹配优先于 default', () => {
  const { rules } = parseRules(VALID_RULES);
  const hit = matchContainer(rules, 'minecraft:iron_ingot');
  assert.equal(hit.container.name, '矿石箱');
});

test('matchContainer:匹配时忽略命名空间/大小写', () => {
  const { rules } = parseRules(VALID_RULES);
  const hit = matchContainer(rules, 'IRON_INGOT');
  assert.equal(hit.container.name, '矿石箱');
});

test('matchContainer:未精确命中时落入 default 箱', () => {
  const { rules } = parseRules(VALID_RULES);
  const hit = matchContainer(rules, 'minecraft:dirt');
  assert.equal(hit.container.name, '杂项箱');
});

test('matchContainer:无 default 且无匹配时返回 null', () => {
  const { rules } = parseRules({
    containers: [{ name: 'A', x: 1, y: 2, z: 3, allow: ['minecraft:iron_ingot'] }]
  });
  assert.equal(matchContainer(rules, 'minecraft:dirt'), null);
  assert.equal(matchContainer(rules, null), null);
});

test('loadRulesFile:文件不存在返回错误', () => {
  const result = loadRulesFile(path.join('__nonexistent__', 'rules.json'));
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes('读取规则文件失败'));
});

test('loadRulesFile:读取并解析真实文件', () => {
  const tmpRoot = path.resolve(__dirname, '.tmp', 'rules');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'warehouse-rules-'));
  const filePath = path.join(dir, 'rules.json');
  fs.writeFileSync(filePath, JSON.stringify(VALID_RULES), 'utf8');

  const result = loadRulesFile(filePath);
  assert.equal(result.ok, true);
  assert.equal(result.rules.containers.length, 3);

  // 测试临时文件不删除,移交待删除区,由用户决定
  const pendingDir = path.resolve(__dirname, '..', '.pending-delete', 'test-warehouse-rules');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.renameSync(dir, path.join(pendingDir, path.basename(dir)));
});
