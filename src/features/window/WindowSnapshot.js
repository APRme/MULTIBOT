// 窗口快照序列化：只取基础字段，避免序列化整个 prismarine Item 对象（有循环引用）。

const WINDOW_TYPE_NAMES = {
  'minecraft:inventory': 'inventory',
  'minecraft:generic_9x3': 'chest',
  'minecraft:generic_9x6': 'large-chest',
  'minecraft:crafting': 'crafting-table',
  'minecraft:crafting_table': 'crafting-table',
  'minecraft:furnace': 'furnace'
};

// 通用容器尺寸 -> 面板已有背景图的名称(27=3 行箱子, 54=6 行大箱子)
const GENERIC_SIZE_NAMES = {
  27: 'chest',
  54: 'large-chest'
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

// 服务器自定义菜单(资源包/插件注册的 menu 类型)不在已知表里: 按容器槽位数给出可读名,
// 27/54 槽直接当作箱子/大箱子(面板有对应背景图), 其余给出 generic_9xN 作为标签。
function getDerivedWindowName(containerSlots) {
  if (!Number.isInteger(containerSlots) || containerSlots <= 0) {
    return null;
  }

  if (GENERIC_SIZE_NAMES[containerSlots]) {
    return { name: GENERIC_SIZE_NAMES[containerSlots], supported: true };
  }

  const rows = containerSlots / 9;
  if (Number.isInteger(rows) && rows >= 1 && rows <= 6) {
    return { name: `generic_9x${rows}`, supported: false };
  }

  return null;
}

// 窗口标题(服务器菜单名): 复用聊天的组件渲染, 处理 text/extra/translate 等形态
function renderWindowTitle(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    const { parseChatMessage } = require('../chat/ChatFeature');
    const rendered = parseChatMessage(value);
    if (rendered) {
      return rendered;
    }
  } catch (error) {
    // 标题渲染失败不影响窗口展示
  }

  return typeof value.text === 'string' ? value.text : null;
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
  const inventoryStart = Number.isInteger(window.inventoryStart) ? window.inventoryStart : 0;
  let name = getWindowName(type);
  let supported = name !== null;

  if (!name) {
    const derived = getDerivedWindowName(inventoryStart);
    if (derived) {
      name = derived.name;
      supported = derived.supported;
    }
  }

  const slots = Array.isArray(window.slots)
    ? window.slots
        .map((item) => serializeItem(item))
        .filter((entry) => entry !== null)
    : [];

  return {
    id: Number.isInteger(window.id) ? window.id : null,
    name: name || type || 'unknown',
    supported,
    title: renderWindowTitle(window.title),
    inventoryStart,
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
