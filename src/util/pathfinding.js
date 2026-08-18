const { Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

function isThinPassableBlock(block, maxHeight = 0.1) {
  if (!block || !Array.isArray(block.shapes) || block.shapes.length === 0) {
    return false;
  }
  return block.shapes.every((shape) => (
    Array.isArray(shape)
    && shape.length >= 6
    && Number.isFinite(shape[4])
    && shape[4] <= maxHeight
  ));
}

class CarpetAwareMovements extends Movements {
  constructor(bot) {
    super(bot);
    for (const type of this.carpets) {
      // Prevent pathfinder from lifting the start node by one block when the
      // bot is already standing on a thin carpet collision surface.
      this.emptyBlocks.add(type);
    }
  }

  getBlock(pos, dx, dy, dz) {
    const block = super.getBlock(pos, dx, dy, dz);
    if (block && this.carpets.has(block.type)) {
      block.safe = true;
      block.physical = false;
      block.replaceable = false;
    }
    return block;
  }
}

class HeightLockedMovements extends CarpetAwareMovements {
  constructor(bot, lockY) {
    super(bot);
    this.lockY = Math.floor(lockY);
  }

  getNeighbors(node) {
    if (!node || Math.floor(node.y) !== this.lockY) {
      return [];
    }

    return super.getNeighbors(node).filter((neighbor) => Math.floor(neighbor.y) === this.lockY);
  }
}

class HeightRecoveryMovements extends CarpetAwareMovements {
  constructor(bot, lockY) {
    super(bot);
    this.lockY = Math.floor(lockY);
    this.minRecoveryY = this.lockY - 1;
    this.maxDropDown = 1;
    this.infiniteLiquidDropdownDistance = false;
  }

  getNeighbors(node) {
    if (!node) {
      return [];
    }
    const nodeY = Math.floor(node.y);
    if (nodeY < this.minRecoveryY || nodeY > this.lockY) {
      return [];
    }
    return super.getNeighbors(node).filter((neighbor) => {
      const neighborY = neighbor && Math.floor(neighbor.y);
      return neighborY >= this.minRecoveryY && neighborY <= this.lockY;
    });
  }
}

// Pathfinder's post-processing can move an integer node onto a half-height
// collision surface (for example, the lower half of a stair).  Treat that
// surface as belonging to the next full block layer, but never allow a full
// block step to the layer below the configured lock.
function isLockedHeightPosition(bot, position, lockY) {
  if (
    !position
    || !Number.isFinite(position.x)
    || !Number.isFinite(position.y)
    || !Number.isFinite(position.z)
    || !Number.isInteger(lockY)
  ) {
    return false;
  }

  if (Math.floor(position.y) === lockY) {
    return true;
  }

  if (!(position.y > lockY - 1 && position.y < lockY)) {
    return false;
  }

  if (!bot || typeof bot.blockAt !== 'function') {
    return false;
  }

  const blockPosition = new Vec3(
    Math.floor(position.x),
    Math.floor(position.y),
    Math.floor(position.z)
  );
  let block;
  try {
    block = bot.blockAt(blockPosition);
  } catch (error) {
    return false;
  }
  if (!block || !Array.isArray(block.shapes) || !block.position) {
    return false;
  }

  const localX = position.x - blockPosition.x;
  const localZ = position.z - blockPosition.z;
  const epsilon = 1e-6;
  for (const shape of block.shapes) {
    if (!Array.isArray(shape) || shape.length < 6) continue;
    if (
      localX + epsilon < shape[0]
      || localX - epsilon > shape[3]
      || localZ + epsilon < shape[2]
      || localZ - epsilon > shape[5]
    ) {
      continue;
    }
    if (Math.abs((block.position.y + shape[4]) - position.y) <= 0.1) {
      return true;
    }
  }

  return false;
}

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
function buildDefaultMovements(bot, enabledOptions = [], options = {}) {
  const movements = Number.isInteger(options.lockY)
    ? new HeightLockedMovements(bot, options.lockY)
    : new Movements(bot);
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

function buildHeightRecoveryMovements(bot, lockY) {
  const movements = new HeightRecoveryMovements(bot, lockY);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;
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
  CarpetAwareMovements,
  HeightLockedMovements,
  HeightRecoveryMovements,
  isThinPassableBlock,
  isLockedHeightPosition,
  buildDefaultMovements,
  buildHeightRecoveryMovements,
  parseMovementOptions
};
