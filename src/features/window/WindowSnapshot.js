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

// 窗口标题(服务器菜单名)。
// minecraft-protocol 的 anonymousNbt 给的是未简化的 NBT({type:'compound',value:{...}}), 先简化;
// 然后按需求: 有自定义名称({text})就用自定义名称, 只有翻译键({translate})时直接用键名(如 container.chest),
// 不做译名查表; translate 携带的参数(with)与 extra 追加在后面。
function simplifyWindowTitle(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  // 未简化 NBT 结构: { type: 'compound', value: {...} }
  if (typeof value.type === 'string' && value.value !== undefined) {
    try {
      const nbt = require('prismarine-nbt');
      return nbt.simplify(value);
    } catch (error) {
      return null;
    }
  }

  return value;
}

function renderTitleComponent(component) {
  if (component == null) {
    return '';
  }

  if (typeof component === 'string') {
    return component;
  }

  if (Array.isArray(component)) {
    return component.map((part) => renderTitleComponent(part)).join('');
  }

  if (typeof component !== 'object') {
    return String(component);
  }

  const parts = [];
  const isTranslate = typeof component.translate === 'string';

  if (typeof component.text === 'string') {
    parts.push(component.text);
  }

  if (isTranslate) {
    parts.push(component.translate);
    if (Array.isArray(component.with)) {
      const args = component.with.map((part) => renderTitleComponent(part)).filter((text) => text.length > 0);
      if (args.length > 0) {
        parts.push(args.join(' '));
      }
    }
  }

  if (Array.isArray(component.extra)) {
    const extras = component.extra.map((part) => renderTitleComponent(part)).filter((text) => text.length > 0);
    if (extras.length > 0) {
      parts.push(isTranslate ? extras.join(' ') : extras.join(''));
    }
  }

  return parts.join(isTranslate ? ' ' : '');
}

function renderWindowTitle(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  const component = simplifyWindowTitle(value);
  if (!component) {
    return null;
  }

  const rendered = renderTitleComponent(component).replace(/\s+/g, ' ').trim();
  return rendered.length > 0 ? rendered : null;
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
    cursor: serializeItem(window.selectedItem || null),
    slots
  };
}

module.exports = {
  getWindowName,
  normalizeWindowType,
  serializeItem,
  buildWindowSnapshot
};
