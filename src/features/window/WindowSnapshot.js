// 窗口快照序列化：只取基础字段，避免序列化整个 prismarine Item 对象（有循环引用）。

const WINDOW_TYPE_NAMES = {
  'minecraft:inventory': 'inventory',
  'minecraft:generic_9x3': 'chest',
  'minecraft:generic_9x6': 'large-chest',
  'minecraft:crafting': 'crafting-table',
  'minecraft:crafting_table': 'crafting-table',
  'minecraft:furnace': 'furnace'
};

function normalizeWindowType(type) {
  if (typeof type !== 'string' || type.length === 0) {
    return '';
  }

  return type.startsWith('minecraft:') ? type : `minecraft:${type}`;
}

function getWindowName(type) {
  const normalized = normalizeWindowType(type);
  return WINDOW_TYPE_NAMES[normalized] || null;
}

function serializeItem(item) {
  if (!item) {
    return null;
  }

  const rawName = typeof item.name === 'string' ? item.name : null;
  const name = rawName
    ? (rawName.includes(':') ? rawName : `minecraft:${rawName}`)
    : null;

  return {
    slot: Number.isInteger(item.slot) ? item.slot : null,
    name,
    displayName: typeof item.displayName === 'string' ? item.displayName : null,
    count: Number.isInteger(item.count) ? item.count : null,
    metadata: typeof item.metadata === 'number' ? item.metadata : 0,
    durabilityUsed: Number.isInteger(item.durabilityUsed) ? item.durabilityUsed : null,
    maxDurability: Number.isInteger(item.maxDurability) ? item.maxDurability : null
  };
}

function buildWindowSnapshot(window) {
  if (!window) {
    return null;
  }

  const type = typeof window.type === 'string' ? window.type : '';
  const name = getWindowName(type);
  const slots = Array.isArray(window.slots)
    ? window.slots
        .map((item) => serializeItem(item))
        .filter((entry) => entry !== null)
    : [];

  return {
    id: Number.isInteger(window.id) ? window.id : null,
    name: name || type || 'unknown',
    supported: name !== null,
    inventoryStart: Number.isInteger(window.inventoryStart) ? window.inventoryStart : 0,
    inventoryEnd: Number.isInteger(window.inventoryEnd) ? window.inventoryEnd : 0,
    slots
  };
}

module.exports = {
  getWindowName,
  normalizeWindowType,
  serializeItem,
  buildWindowSnapshot
};
