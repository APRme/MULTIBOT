const { Movements } = require('mineflayer-pathfinder');

// 能力词 → Movements 属性映射。
// 寻路默认只做普通走路，其余能力（破块/搭柱/疾跑/跑酷）需显式开启。
const MOVEMENT_OPTION_PROPERTIES = {
  sprint: 'allowSprinting',
  dig: 'canDig',
  tower: 'allow1by1towers',
  parkour: 'allowParkour'
};

const MOVEMENT_OPTION_KEYS = Object.keys(MOVEMENT_OPTION_PROPERTIES);

// 构建寻路 Movements：默认关闭全部额外能力，仅按 enabledOptions 开启指定项。
function buildDefaultMovements(bot, enabledOptions = []) {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;

  for (const key of enabledOptions) {
    const property = MOVEMENT_OPTION_PROPERTIES[key];
    if (property) {
      movements[property] = true;
    }
  }

  return movements;
}

// 从命令参数解析能力词。true 兼容旧的 sprint 参数，false 忽略；
// 无效词返回 null（由调用方报错），成功返回去重后的能力词数组。
function parseMovementOptions(values) {
  const enabled = [];
  for (const raw of values) {
    const value = String(raw || '').toLowerCase();
    if (value === 'true') {
      enabled.push('sprint');
      continue;
    }
    if (value === 'false') {
      continue;
    }
    if (!MOVEMENT_OPTION_KEYS.includes(value)) {
      return null;
    }
    enabled.push(value);
  }
  return Array.from(new Set(enabled));
}

module.exports = {
  MOVEMENT_OPTION_PROPERTIES,
  MOVEMENT_OPTION_KEYS,
  buildDefaultMovements,
  parseMovementOptions
};
