const test = require('node:test');
const assert = require('node:assert/strict');

test('vendored legacy modules load from MULTIBOT tree', () => {
  const inventoryModule = require('../src/legacy/assn/inv');
  const vaultModule = require('../src/legacy/assn/trial');
  const cplaceModule = require('../src/legacy/assn/cplace');
  const protocolGuard = require('../src/legacy/assn/protocol-guard-hotfix');

  assert.equal(typeof inventoryModule.initInv, 'function');
  assert.equal(typeof inventoryModule.handleInvCommand, 'function');
  assert.equal(typeof inventoryModule.cleanupInv, 'function');
  assert.equal(typeof vaultModule.initTrial, 'function');
  assert.equal(typeof vaultModule.handleVaultCommand, 'function');
  assert.equal(typeof cplaceModule.initCplace, 'function');
  assert.equal(typeof cplaceModule.handleCplaceCommand, 'function');
  assert.equal(typeof cplaceModule.handleStopCplaceCommand, 'function');
  assert.equal(typeof protocolGuard.applyProtocolGuardHotfix, 'function');
  assert.equal(typeof protocolGuard.isIgnorableMalformedNbtArrayError, 'function');
});

test('legacy inventory module cleanup stops queue and releases bot', () => {
  const modulePath = require.resolve('../src/legacy/assn/inv');
  delete require.cache[modulePath];
  const inventoryModule = require('../src/legacy/assn/inv');

  inventoryModule.initInv({
    inventory: {
      slots: [],
      hotbarStart: 36
    }
  });

  assert.deepEqual(inventoryModule.getInvStatus(), {
    messageQueueLength: 0,
    isProcessingQueue: true,
    hasQueueTimer: true,
    hasBot: true
  });

  inventoryModule.cleanupInv();

  assert.deepEqual(inventoryModule.getInvStatus(), {
    messageQueueLength: 0,
    isProcessingQueue: false,
    hasQueueTimer: false,
    hasBot: false
  });

  delete require.cache[modulePath];
});

test('legacy cplace module cleanup releases bot and target context', () => {
  const modulePath = require.resolve('../src/legacy/assn/cplace');
  delete require.cache[modulePath];
  const cplaceModule = require('../src/legacy/assn/cplace');

  cplaceModule.initCplace({});

  assert.equal(cplaceModule.getCplaceStatus().isContinuousPlacing, false);
  assert.equal(typeof cplaceModule.cleanupCplace, 'function');

  cplaceModule.cleanupCplace();

  assert.deepEqual(cplaceModule.getCplaceStatus(), {
    isContinuousPlacing: false,
    stopContinuousPlacing: true,
    placingInterval: 500,
    stopOnFailures: false,
    targetBlockName: '',
    targetBlockType: null,
    targetLabel: null
  });

  delete require.cache[modulePath];
});

test('legacy trial module cleanup removes tracked listeners', async () => {
  const { EventEmitter } = require('events');
  const { Vec3 } = require('vec3');
  const mcData = require('minecraft-data')('1.21.1');
  const modulePath = require.resolve('../src/legacy/assn/trial');
  delete require.cache[modulePath];
  const trialModule = require('../src/legacy/assn/trial');
  const bot = new EventEmitter();
  bot.pathfinder = {
    setMovements() {},
    setGoal() {}
  };
  bot.registry = mcData;
  bot.version = '1.21.1';
  bot.entity = {
    position: new Vec3(0, 64, 0)
  };
  bot.findBlock = () => ({
    name: 'vault',
    position: new Vec3(1, 64, 1),
    getProperties() {
      return {};
    }
  });
  bot.inventory = {
    items() {
      return [{ name: 'trial_key' }];
    }
  };
  bot.equip = async () => {};
  bot.look = async () => {};
  bot.activateBlock = async () => {};

  trialModule.initTrial(bot);
  trialModule.openNearestVault().catch(() => {});

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bot.listenerCount('goal_reached'), 1);

  trialModule.cleanupTrial();

  assert.equal(typeof trialModule.cleanupTrial, 'function');
  assert.equal(bot.listenerCount('goal_reached'), 0);

  delete require.cache[modulePath];
});
