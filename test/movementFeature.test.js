const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { MovementFeature } = require('../src/features/movement/MovementFeature');

function createContext() {
  return {
    replyInfo() {},
    replyError() {}
  };
}

function createBot() {
  const controlStates = new Map();
  const calls = [];
  const bot = {
    calls,
    registry: {
      blocksByName: {
        chest: { id: 1 },
        fire: { id: 2 },
        lava: { id: 3 },
        water: { id: 4 },
        sand: { id: 5 },
        gravel: { id: 6 },
        ladder: { id: 7 },
        air: { id: 8 }
      },
      itemsByName: {
        dirt: { id: 9 },
        cobblestone: { id: 10 }
      },
      blocksArray: []
    },
    version: '1.21.1',
    entity: {
      position: new Vec3(0, 64, 0)
    },
    pathfinder: {
      setMovements(movements) {
        calls.push(['setMovements', movements.allowSprinting]);
      },
      setGoal(goal) {
        calls.push(['setGoal', goal === null ? null : goal.constructor.name]);
      },
      stop() {
        calls.push(['pathfinder.stop']);
      }
    },
    loadPlugin() {
      calls.push(['loadPlugin']);
      if (!bot.pathfinder) {
        bot.pathfinder = {
          setMovements(movements) {
            calls.push(['setMovements', movements.allowSprinting]);
          },
          setGoal(goal) {
            calls.push(['setGoal', goal === null ? null : goal.constructor.name]);
          },
          stop() {
            calls.push(['pathfinder.stop']);
          }
        };
      }
    },
    setControlState(name, value) {
      controlStates.set(name, value);
      calls.push(['setControlState', name, value]);
    },
    getControlState(name) {
      return controlStates.get(name) === true;
    },
    async look(yaw, pitch, force) {
      calls.push(['look', yaw, pitch, force]);
    },
    async lookAt(target) {
      calls.push(['lookAt', target.x, target.y, target.z]);
    }
  };

  return bot;
}

test('MovementFeature converts old look degrees to mineflayer radians', async () => {
  const bot = createBot();
  const feature = new MovementFeature();
  feature.attach(bot);

  await feature.lookDegrees(createContext(), 0, 0);
  await feature.lookDegrees(createContext(), 90, 0);
  await feature.lookDegrees(createContext(), -180, -45);

  const lookCalls = bot.calls.filter((entry) => entry[0] === 'look');
  assert.equal(lookCalls.length, 3);
  assert.ok(Math.abs(lookCalls[0][1] - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(lookCalls[0][2] - 0) < 1e-9);
  assert.ok(Math.abs(lookCalls[1][1] - 0) < 1e-9);
  assert.ok(Math.abs(lookCalls[2][1] - (-Math.PI / 2)) < 1e-9);
  assert.ok(Math.abs(lookCalls[2][2] - Math.PI / 4) < 1e-9);
  assert.equal(bot.calls.some((entry) => entry[0] === 'loadPlugin'), false);
});

test('MovementFeature toggles sneak and circle state cleanly', async () => {
  const bot = createBot();
  const feature = new MovementFeature();
  feature.attach(bot);

  feature.toggleSneak(createContext());
  assert.equal(feature.getState().isSneaking, true);

  feature.toggleSneak(createContext());
  assert.equal(feature.getState().isSneaking, false);

  feature.toggleCircle(createContext());
  assert.equal(feature.getState().isCircling, true);

  feature.toggleCircle(createContext());
  assert.equal(feature.getState().isCircling, false);

  feature.toggleCircle(createContext());
  assert.equal(feature.getState().isCircling, true);

  feature.stopCircle();
  assert.equal(feature.getState().isCircling, false);

  feature.stop();
  assert.equal(feature.getState().isSneaking, false);
});

test('MovementFeature.stop skips pathfinder shutdown when bot entity is missing', () => {
  const feature = new MovementFeature();
  feature.attach({
    entity: null,
    pathfinder: {
      stop() {
        throw new Error('pathfinder.stop should not be called without entity');
      },
      setGoal() {
        throw new Error('pathfinder.setGoal should not be called without entity');
      }
    },
    loadPlugin() {},
    setControlState() {}
  });

  assert.doesNotThrow(() => {
    feature.stop();
  });
});

test('MovementFeature loads pathfinder lazily when pathfinder-backed actions are needed', () => {
  const bot = createBot();
  bot.pathfinder = null;

  const feature = new MovementFeature();
  feature.attach(bot);

  assert.equal(bot.calls.some((entry) => entry[0] === 'loadPlugin'), false);

  feature.ensurePathfinderReady();

  assert.deepEqual(bot.calls, [['loadPlugin']]);
});

test('MovementFeature goto defaults to walk-only movements and enables requested options', () => {
  const bot = createBot();
  bot.registry = require('minecraft-data')('1.21.1');
  let captured = null;
  bot.pathfinder.setMovements = (movements) => {
    captured = movements;
  };
  const feature = new MovementFeature();
  feature.attach(bot);

  feature.goto(10, 64, 20, ['dig', 'sprint']);
  assert.equal(captured.canDig, true);
  assert.equal(captured.allowSprinting, true);
  assert.equal(captured.allow1by1towers, false);
  assert.equal(captured.allowParkour, false);

  feature.goto(10, 64, 20, []);
  assert.equal(captured.canDig, false);
  assert.equal(captured.allowSprinting, false);
  assert.equal(captured.allow1by1towers, false);
  assert.equal(captured.allowParkour, false);
});
