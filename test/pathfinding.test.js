const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDefaultMovements,
  buildHeightRecoveryMovements,
  isThinPassableBlock,
  isLockedHeightPosition,
  parseMovementOptions,
  MOVEMENT_OPTION_KEYS
} = require('../src/util/pathfinding');

function createBot() {
  return {
    registry: require('minecraft-data')('1.21.1')
  };
}

test('buildDefaultMovements disables all extra abilities by default', () => {
  const movements = buildDefaultMovements(createBot());

  assert.equal(movements.canDig, false);
  assert.equal(movements.allow1by1towers, false);
  assert.equal(movements.allowParkour, false);
  assert.equal(movements.allowSprinting, false);
});

test('buildDefaultMovements enables only requested options', () => {
  const movements = buildDefaultMovements(createBot(), ['dig', 'sprint']);

  assert.equal(movements.canDig, true);
  assert.equal(movements.allowSprinting, true);
  assert.equal(movements.allow1by1towers, false);
  assert.equal(movements.allowParkour, false);
});

test('HeightLockedMovements rejects nodes outside the locked floor', () => {
  const movements = buildDefaultMovements(createBot(), [], { lockY: 74 });

  assert.equal(movements.lockY, 74);
  assert.deepEqual(movements.getNeighbors({ y: 73 }), []);
  assert.deepEqual(movements.getNeighbors({ y: 75 }), []);
});

test('height-locked movements treat 0.0625 carpet as passable but not half slabs', () => {
  const bot = createBot();
  const carpet = bot.registry.blocksByName.white_carpet;
  const movements = buildDefaultMovements(bot, [], { lockY: 74 });
  const carpetBlock = {
    type: carpet.id,
    boundingBox: 'block',
    shapes: [[0, 0, 0, 1, 0.0625, 1]],
    position: { x: 0, y: 74, z: 0 }
  };

  assert.equal(carpetBlock.shapes[0][4], 0.0625);
  assert.equal(isThinPassableBlock(carpetBlock), true);
  assert.equal(isThinPassableBlock({ shapes: [[0, 0, 0, 1, 0.5, 1]] }), false);
  assert.equal(movements.emptyBlocks.has(carpet.id), true);

  bot.blockAt = () => carpetBlock;
  const pathBlock = movements.getBlock({ x: 0, y: 74, z: 0 }, 0, 0, 0);
  assert.equal(pathBlock.safe, true);
  assert.equal(pathBlock.physical, false);
  assert.equal(pathBlock.replaceable, false);
});

test('height recovery movements stay within one block below lockY', () => {
  const movements = buildHeightRecoveryMovements(createBot(), 74);

  assert.equal(movements.lockY, 74);
  assert.equal(movements.minRecoveryY, 73);
  assert.equal(movements.maxDropDown, 1);
  assert.equal(movements.infiniteLiquidDropdownDistance, false);
  assert.deepEqual(movements.getNeighbors({ y: 72 }), []);
  assert.deepEqual(movements.getNeighbors({ y: 75 }), []);
});

test('isLockedHeightPosition accepts a half-height surface below the locked floor', () => {
  const bot = {
    blockAt(position) {
      assert.equal(typeof position.floored, 'function');
      if (position.y !== 73) return null;
      return {
        position: { x: 71, y: 73, z: 132 },
        shapes: [
          [0, 0, 0, 0.5, 0.5, 1],
          [0.5, 0, 0, 1, 1, 1]
        ]
      };
    }
  };

  assert.equal(isLockedHeightPosition(bot, { x: 71.25, y: 73.5, z: 132.5 }, 74), true);
  assert.equal(isLockedHeightPosition(bot, { x: 71.5, y: 73.5, z: 132.5 }, 74), true);
  assert.equal(isLockedHeightPosition(bot, { x: 71.75, y: 73.5, z: 132.5 }, 74), false);
  assert.equal(isLockedHeightPosition(bot, { x: 71.25, y: 73, z: 132.5 }, 74), false);
  assert.equal(isLockedHeightPosition(bot, { x: 71.25, y: 72.5, z: 132.5 }, 74), false);
});

test('parseMovementOptions maps old true to sprint and ignores false', () => {
  assert.deepEqual(parseMovementOptions([]), []);
  assert.deepEqual(parseMovementOptions(['true']), ['sprint']);
  assert.deepEqual(parseMovementOptions(['false']), []);
});

test('parseMovementOptions combines and deduplicates option words case-insensitively', () => {
  assert.deepEqual(parseMovementOptions(['dig', 'sprint']), ['dig', 'sprint']);
  assert.deepEqual(parseMovementOptions(['sprint', 'sprint', 'DIG']), ['sprint', 'dig']);
});

test('parseMovementOptions returns null for invalid words', () => {
  assert.equal(parseMovementOptions(['fly']), null);
  assert.equal(parseMovementOptions(['dig', 'nonsense']), null);
});

test('MOVEMENT_OPTION_KEYS covers the documented option words', () => {
  assert.deepEqual(MOVEMENT_OPTION_KEYS, ['sprint', 'dig', 'tower', 'parkour']);
});
