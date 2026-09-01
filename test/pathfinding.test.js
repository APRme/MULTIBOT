const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDefaultMovements,
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
