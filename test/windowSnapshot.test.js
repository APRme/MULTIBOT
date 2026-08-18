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
    inventoryStart: 27,
    inventoryEnd: 54,
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
