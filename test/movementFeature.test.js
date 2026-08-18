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

test('MovementFeature restores the physics plugin before pathfinder when controls are missing', () => {
  const bot = createBot();
  delete bot.setControlState;
  const originalLoadPlugin = bot.loadPlugin;
  bot.loadPlugin = (plugin) => {
    bot.calls.push(['loadPlugin', plugin.name]);
    if (plugin.name === 'inject') {
      bot.setControlState = () => {};
    } else {
      originalLoadPlugin();
    }
  };

  const feature = new MovementFeature();
  feature.attach(bot);

  assert.doesNotThrow(() => feature.ensurePhysicsReady());
  assert.equal(typeof bot.setControlState, 'function');
  assert.deepEqual(bot.calls, [['loadPlugin', 'inject']]);
});

test('MovementFeature reports a clear error when physics controls cannot be restored', () => {
  const bot = createBot();
  delete bot.setControlState;
  const feature = new MovementFeature();
  feature.attach(bot);

  assert.throws(
    () => feature.ensurePhysicsReady(),
    /mineflayer 物理插件未加载，无法执行寻路/
  );
});

test('MovementFeature waits for delayed physics plugin injection', async () => {
  const bot = createBot();
  delete bot.setControlState;
  let loadCalls = 0;
  bot.loadPlugin = () => {
    loadCalls += 1;
    setTimeout(() => {
      bot.setControlState = () => {};
    }, 20);
  };

  const feature = new MovementFeature();
  feature.attach(bot);
  await feature.waitForPhysicsReady(200, 5);

  assert.equal(typeof bot.setControlState, 'function');
  assert.ok(loadCalls >= 1);
});

test('MovementFeature waits for the locked height and world collision data', async () => {
  const bot = createBot();
  bot.entity.position = new Vec3(0, 0, 0);
  let ready = false;
  bot.blockAt = (position) => {
    assert.equal(typeof position.floored, 'function');
    return ready && position.y === 73
      ? { position: new Vec3(0, 73, 0), shapes: [[0, 0, 0, 1, 0.5, 1]] }
      : null;
  };

  const feature = new MovementFeature();
  feature.attach(bot);
  const pending = feature.waitForLockedHeightReady(74, 200, 5);
  setTimeout(() => {
    bot.entity.position = new Vec3(0, 73.5, 0);
    ready = true;
  }, 20);

  await pending;
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

test('MovementFeature gotoExact supports a warehouse height lock without changing regular goto', () => {
  const bot = createBot();
  bot.registry = require('minecraft-data')('1.21.1');
  let captured = null;
  let goal = null;
  bot.pathfinder.setMovements = (movements) => {
    captured = movements;
  };
  bot.pathfinder.setGoal = (nextGoal) => {
    goal = nextGoal;
  };
  const feature = new MovementFeature();
  feature.attach(bot);

  feature.gotoExact(3, 64, 4, [], { lockY: 64 });
  assert.equal(goal.constructor.name, 'LockedGoalBlock');
  assert.equal(goal instanceof require('mineflayer-pathfinder').goals.GoalBlock, true);
  assert.equal(captured.lockY, 64);
  assert.equal(typeof captured.getNeighbors, 'function');
  assert.throws(() => feature.gotoExact(3, 65, 4, [], { lockY: 65 }), /当前高度不是锁定高度/);
});

test('MovementFeature accepts a locked half-height stair endpoint', () => {
  const bot = createBot();
  bot.registry = require('minecraft-data')('1.21.1');
  bot.entity.position = new Vec3(71.25, 73.5, 132.5);
  bot.entity.onGround = true;
  bot.blockAt = (position) => position.y === 73
    ? {
      position: new Vec3(71, 73, 132),
      shapes: [[0, 0, 0, 0.5, 0.5, 1], [0.5, 0, 0, 1, 1, 1]]
    }
    : null;
  let goal = null;
  bot.pathfinder.setGoal = (nextGoal) => {
    goal = nextGoal;
  };

  const feature = new MovementFeature();
  feature.attach(bot);
  feature.gotoExact(71, 74, 132, [], { lockY: 74 });

  assert.equal(goal.isEnd({ x: 71, y: 73, z: 132 }), true);
  assert.equal(goal.isEnd({ x: 71, y: 72, z: 132 }), false);
});

test('MovementFeature gotoLookAtBlock uses the configured safe interaction reach', () => {
  const bot = createBot();
  bot.registry = require('minecraft-data')('1.21.1');
  bot.world = { raycast() {} };
  let goal = null;
  bot.pathfinder.setGoal = (nextGoal) => {
    goal = nextGoal;
  };
  const feature = new MovementFeature();
  feature.attach(bot);

  feature.gotoLookAtBlock(3, 65, 4, [], { lockY: 64, reach: 3.5 });

  assert.equal(goal.constructor.name, 'GoalLookAtBlock');
  assert.equal(goal.reach, 3.5);
  assert.equal(goal.world, bot.world);
});

const { EventEmitter } = require('events');

function createGoalBot() {
  const bot = new EventEmitter();
  bot.pathfinder = {};
  bot.entity = {};
  return bot;
}

test('MovementFeature.awaitGoalReached resolves on goal_reached', async () => {
  const logs = [];
  const feature = new MovementFeature({
    logger: {
      info(message) {
        logs.push(message);
      }
    }
  });
  const bot = createGoalBot();

  const promise = feature.awaitGoalReached(bot, 1000);
  bot.emit('goal_reached', { pos: { x: 73, y: 75, z: 107 } });
  await promise;
  assert.deepEqual(logs, ['[MOVE] 已到达目标位置 x=73 y=75 z=107']);
});

test('MovementFeature.awaitGoalReached rejects on timeout', async () => {
  const feature = new MovementFeature();
  const bot = createGoalBot();

  await assert.rejects(
    feature.awaitGoalReached(bot, 50),
    /等待到达超时/
  );
});

test('MovementFeature.awaitGoalReached rejects when pathfinder reports noPath', async () => {
  const feature = new MovementFeature();
  const bot = createGoalBot();
  const promise = feature.awaitGoalReached(bot, 1000);
  bot.emit('path_update', { status: 'noPath' });
  await assert.rejects(promise, /未找到可达路径/);
});

test('MovementFeature.awaitGoalReached rejects and cleans up when pathfinder is stuck', async () => {
  const feature = new MovementFeature();
  const bot = createGoalBot();
  bot.entity = { position: new Vec3(0, 74, 0), onGround: true };
  const promise = feature.awaitGoalReached(bot, 1000, { lockY: 74 });

  bot.emit('path_reset', 'stuck');

  await assert.rejects(promise, /寻路器卡住/);
  assert.equal(bot.listenerCount('goal_reached'), 0);
  assert.equal(bot.listenerCount('path_update'), 0);
  assert.equal(bot.listenerCount('path_reset'), 0);
  assert.equal(bot.listenerCount('death'), 0);
});

test('MovementFeature.awaitGoalReached keeps legacy behavior for non-warehouse stuck resets', async () => {
  const feature = new MovementFeature();
  const bot = createGoalBot();
  const promise = feature.awaitGoalReached(bot, 1000);

  bot.emit('path_reset', 'stuck');
  bot.emit('goal_reached', { pos: { x: 1, y: 64, z: 1 } });

  await promise;
});

test('MovementFeature.awaitGoalReached rejects a path that leaves the locked height', async () => {
  const feature = new MovementFeature();
  const bot = createGoalBot();
  let stopped = false;
  bot.entity = { position: { y: 74 } };
  bot.pathfinder.stop = () => {
    stopped = true;
  };

  const promise = feature.awaitGoalReached(bot, 1000, { lockY: 74 });
  bot.emit('path_update', {
    status: 'success',
    path: [{ x: 1, y: 74, z: 1 }, { x: 2, y: 75, z: 1 }]
  });

  await assert.rejects(promise, /违反锁定高度/);
  assert.equal(stopped, true);
});

test('MovementFeature.awaitGoalReached accepts a post-processed half-height path node', async () => {
  const feature = new MovementFeature();
  const bot = createGoalBot();
  bot.entity = {
    position: new Vec3(71.25, 74, 132.5),
    onGround: true
  };
  bot.blockAt = (position) => position.y === 73
    ? {
      position: new Vec3(71, 73, 132),
      shapes: [[0, 0, 0, 0.5, 0.5, 1], [0.5, 0, 0, 1, 1, 1]]
    }
    : null;
  const promise = feature.awaitGoalReached(bot, 1000, { lockY: 74 });
  bot.emit('path_update', {
    status: 'success',
    path: [{ x: 71.25, y: 73.5, z: 132.5 }]
  });
  bot.entity.position.y = 73.5;
  bot.emit('goal_reached', { pos: { x: 71, y: 74, z: 132 } });
  await promise;
});

test('MovementFeature recovery path accepts y=73..74 and rejects other heights', async () => {
  const feature = new MovementFeature();
  const acceptedBot = createGoalBot();
  acceptedBot.entity = { position: new Vec3(1, 74, 1), onGround: true };
  feature.attach(acceptedBot);
  const accepted = feature.awaitGoalReached(acceptedBot, 1000, { recoveryLockY: 74 });
  acceptedBot.emit('path_update', {
    status: 'success',
    path: [{ x: 0, y: 73, z: 0 }, { x: 1, y: 74, z: 1 }]
  });
  acceptedBot.emit('goal_reached', { pos: { x: 1, y: 74, z: 1 } });
  await accepted;
  assert.deepEqual(feature.lastLockedPosition, { x: 1, y: 74, z: 1, lockY: 74 });

  const rejectedBot = createGoalBot();
  rejectedBot.entity = { position: new Vec3(0, 73, 0), onGround: true };
  const rejected = feature.awaitGoalReached(rejectedBot, 1000, { recoveryLockY: 74 });
  rejectedBot.emit('path_update', {
    status: 'success',
    path: [{ x: 0, y: 72, z: 0 }]
  });
  await assert.rejects(rejected, /恢复路径超出允许高度 y=73\.\.74/);
});

test('MovementFeature finds the nearest safe locked-height recovery position', () => {
  const bot = createBot();
  bot.entity.position = new Vec3(0.5, 73, 0.5);
  bot.entity.onGround = true;
  bot.blockAt = (position) => {
    if (position.x === 2 && position.z === 0 && position.y === 73) {
      return { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] };
    }
    if (position.x === 2 && position.z === 0 && [74, 75].includes(position.y)) {
      return { name: 'air', shapes: [], boundingBox: 'empty' };
    }
    return null;
  };
  const feature = new MovementFeature();
  feature.attach(bot);

  assert.deepEqual(feature.findNearestLockedRecoveryPosition(74), { x: 2, y: 74, z: 0 });
});

test('MovementFeature falls back to the last successful point within 12 blocks', () => {
  const bot = createBot();
  bot.entity.position = new Vec3(0.5, 73, 0.5);
  bot.entity.onGround = true;
  bot.blockAt = (position) => {
    if (position.x === 8 && position.z === 0 && position.y === 73) {
      return { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] };
    }
    if (position.x === 8 && position.z === 0 && [74, 75].includes(position.y)) {
      return { name: 'air', shapes: [], boundingBox: 'empty' };
    }
    return null;
  };
  const feature = new MovementFeature();
  feature.attach(bot);
  feature.lastLockedPosition = { x: 8, y: 74, z: 0, lockY: 74 };

  assert.deepEqual(feature.getLockedRecoveryTargets(74), [
    { x: 8, y: 74, z: 0, source: 'last_success' }
  ]);
});

test('MovementFeature recovers to a safe lockY point with restricted movements', async () => {
  const bot = createBot();
  bot.registry = require('minecraft-data')('1.21.1');
  bot.entity.position = new Vec3(0, 73, 0);
  bot.entity.onGround = true;
  let movements = null;
  bot.pathfinder.setMovements = (value) => {
    movements = value;
  };
  const feature = new MovementFeature();
  feature.attach(bot);
  feature.getLockedRecoveryTargets = () => [{ x: 2, y: 74, z: 0, source: 'nearest' }];
  feature.awaitGoalReached = async () => {
    bot.entity.position = new Vec3(2, 74, 0);
  };

  const result = await feature.recoverLockedHeight(74);

  assert.deepEqual(result, {
    recovered: true,
    target: { x: 2, y: 74, z: 0, source: 'nearest' }
  });
  assert.equal(movements.minRecoveryY, 73);
  assert.equal(movements.lockY, 74);
  assert.equal(movements.canDig, false);
  assert.equal(movements.allowParkour, false);
  assert.equal(movements.allowSprinting, false);
});

test('MovementFeature.awaitGoalReached rejects on death', async () => {
  const feature = new MovementFeature();
  const bot = createGoalBot();

  const promise = feature.awaitGoalReached(bot, 1000);
  bot.emit('death');
  await assert.rejects(promise, /bot 死亡/);
});

test('MovementFeature.awaitGoalReached rejects when pathfinder missing', async () => {
  const feature = new MovementFeature();
  await assert.rejects(feature.awaitGoalReached({}, 50), /pathfinder 未初始化/);
  await assert.rejects(feature.awaitGoalReached(null, 50), /pathfinder 未初始化/);
});

test('MovementFeature.awaitGoalReached cleans up listeners after settle', async () => {
  const feature = new MovementFeature();
  const bot = createGoalBot();
  let goalListeners = 0;
  let deathListeners = 0;
  const captureListenerCounts = () => {
    goalListeners = bot.listeners('goal_reached').length;
    deathListeners = bot.listeners('death').length;
    return 0;
  };

  const promise = feature.awaitGoalReached(bot, 1000);
  bot.emit('goal_reached');
  await promise;
  captureListenerCounts();
  assert.equal(goalListeners, 0);
  assert.equal(deathListeners, 0);
});
