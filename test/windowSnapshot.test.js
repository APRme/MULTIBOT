const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getWindowName,
  normalizeWindowType,
  serializeItem,
  buildWindowSnapshot
} = require('../src/features/window/WindowSnapshot');

test('normalizeWindowType adds minecraft namespace for bare types', () => {
  assert.equal(normalizeWindowType('generic_9x3'), 'minecraft:generic_9x3');
  assert.equal(normalizeWindowType('minecraft:chest'), 'minecraft:chest');
  assert.equal(normalizeWindowType(''), '');
  assert.equal(normalizeWindowType(null), '');
});

test('getWindowName maps supported window types', () => {
  assert.equal(getWindowName('minecraft:inventory'), 'inventory');
  assert.equal(getWindowName('minecraft:generic_9x3'), 'chest');
  assert.equal(getWindowName('minecraft:generic_9x6'), 'large-chest');
  assert.equal(getWindowName('minecraft:crafting'), 'crafting-table');
  assert.equal(getWindowName('minecraft:crafting_table'), 'crafting-table');
  assert.equal(getWindowName('minecraft:furnace'), 'furnace');
  assert.equal(getWindowName('generic_9x3'), 'chest');
});

test('getWindowName returns null for unsupported types', () => {
  assert.equal(getWindowName('minecraft:anvil'), null);
  assert.equal(getWindowName('minecraft:hopper'), null);
  assert.equal(getWindowName(''), null);
  assert.equal(getWindowName(null), null);
});

test('serializeItem extracts base fields only', () => {
  const item = {
    slot: 5,
    name: 'oak_planks',
    displayName: '橡木木板',
    count: 64,
    metadata: 0,
    durabilityUsed: undefined,
    maxDurability: undefined,
    parent: {},
    raw: {}
  };

  assert.deepEqual(serializeItem(item), {
    slot: 5,
    name: 'minecraft:oak_planks',
    displayName: '橡木木板',
    count: 64,
    metadata: 0,
    durabilityUsed: null,
    maxDurability: null
  });
});

test('serializeItem keeps durability for tools', () => {
  const item = {
    slot: 0,
    name: 'diamond_pickaxe',
    displayName: '钻石镐',
    count: 1,
    metadata: 0,
    durabilityUsed: 42,
    maxDurability: 1562
  };

  const serialized = serializeItem(item);
  assert.equal(serialized.durabilityUsed, 42);
  assert.equal(serialized.maxDurability, 1562);
});

test('serializeItem prefixes bare names with minecraft namespace', () => {
  const item = {
    slot: 1,
    name: 'dirt',
    displayName: '泥土',
    count: 32
  };

  assert.equal(serializeItem(item).name, 'minecraft:dirt');
});

test('serializeItem returns null for empty slots', () => {
  assert.equal(serializeItem(null), null);
  assert.equal(serializeItem(undefined), null);
});

test('buildWindowSnapshot builds supported window snapshot', () => {
  const window = {
    id: 3,
    type: 'minecraft:generic_9x3',
    title: { text: '商店' },
    inventoryStart: 27,
    inventoryEnd: 54,
    slots: [
      null,
      { slot: 1, name: 'oak_planks', displayName: '橡木木板', count: 64, metadata: 0 }
    ]
  };

  assert.deepEqual(buildWindowSnapshot(window), {
    id: 3,
    name: 'chest',
    supported: true,
    title: '商店',
    inventoryStart: 27,
    inventoryEnd: 54,
    cursor: null,
    slots: [
      {
        slot: 1,
        name: 'minecraft:oak_planks',
        displayName: '橡木木板',
        count: 64,
        metadata: 0,
        durabilityUsed: null,
        maxDurability: null
      }
    ]
  });
});

test('buildWindowSnapshot derives a readable name for custom menu types', () => {
  // 自定义菜单(未知类型/数字 id): 27 槽按箱子展示, 45 槽给出 generic_9x5 标签
  const chestLike = buildWindowSnapshot({ id: 5, type: 99, inventoryStart: 27, inventoryEnd: 63, slots: [] });
  assert.equal(chestLike.name, 'chest');
  assert.equal(chestLike.supported, true);

  const oddSize = buildWindowSnapshot({ id: 6, type: 99, inventoryStart: 45, inventoryEnd: 81, slots: [] });
  assert.equal(oddSize.name, 'generic_9x5');
  assert.equal(oddSize.supported, false);

  const unknown = buildWindowSnapshot({ id: 7, type: 99, slots: [] });
  assert.equal(unknown.name, 'unknown');
  assert.equal(unknown.supported, false);
});

test('buildWindowSnapshot keeps raw type with supported=false for unknown windows', () => {
  const window = {
    id: 9,
    type: 'minecraft:anvil',
    slots: []
  };

  const snapshot = buildWindowSnapshot(window);
  assert.equal(snapshot.name, 'minecraft:anvil');
  assert.equal(snapshot.supported, false);
  assert.deepEqual(snapshot.slots, []);
});

test('buildWindowSnapshot returns null without a window', () => {
  assert.equal(buildWindowSnapshot(null), null);
  assert.equal(buildWindowSnapshot(undefined), null);
});

test('window title: custom name wins, translate key is used verbatim', () => {
  // 自定义名称(text 组件)
  assert.equal(buildWindowSnapshot({ id: 1, type: 'minecraft:generic_9x3', title: { text: '商店' }, slots: [] }).title, '商店');

  // 纯字符串标题
  assert.equal(buildWindowSnapshot({ id: 1, type: 'minecraft:generic_9x3', title: '我的箱子', slots: [] }).title, '我的箱子');

  // 翻译键: 直接用键名(不查译名, 也不带 [key] 噪声)
  assert.equal(buildWindowSnapshot({ id: 1, type: 'minecraft:generic_9x3', title: { translate: 'container.chest' }, slots: [] }).title, 'container.chest');

  // 未简化 NBT(真实服务器下发的形态)
  const nbtTitle = {
    type: 'compound',
    value: { translate: { type: 'string', value: 'container.chest' } }
  };
  assert.equal(buildWindowSnapshot({ id: 1, type: 'minecraft:generic_9x3', title: nbtTitle, slots: [] }).title, 'container.chest');

  // NBT 自定义名称 + extra
  const nbtCustom = {
    type: 'compound',
    value: {
      text: { type: 'string', value: '商店' },
      extra: { type: 'list', value: { type: 'string', value: [' 二层'] } }
    }
  };
  assert.equal(buildWindowSnapshot({ id: 1, type: 'minecraft:generic_9x3', title: nbtCustom, slots: [] }).title, '商店 二层');

  // 无标题 / 空标题
  assert.equal(buildWindowSnapshot({ id: 1, type: 'minecraft:generic_9x3', slots: [] }).title, null);
  assert.equal(buildWindowSnapshot({ id: 1, type: 'minecraft:generic_9x3', title: '   ', slots: [] }).title, null);
});
