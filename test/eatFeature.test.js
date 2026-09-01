const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { EatFeature } = require('../src/features/eat/EatFeature');

function createContext() {
  const messages = [];
  return {
    replyInfo(message) {
      messages.push({ type: 'info', message });
    },
    replyError(message) {
      messages.push({ type: 'error', message });
    },
    get messages() {
      return messages;
    }
  };
}

test('EatFeature supports numeric IDs and restores quickbar slot', async () => {
  const calls = [];
  const breadItem = { type: 7, slot: 37, name: 'bread', displayName: 'Bread', count: 1 };
  const stoneItem = { type: 1, slot: 36, name: 'stone', displayName: 'Stone', count: 1 };
  const bot = {
    registry: {
      items: {
        7: { name: 'bread' }
      },
      foodsByName: {
        bread: {}
      }
    },
    game: {
      gameMode: 'survival'
    },
    food: 10,
    currentWindow: null,
    usingHeldItem: false,
    quickBarSlot: 0,
    inventory: {
      hotbarStart: 36,
      slots: Object.assign([], {
        36: stoneItem,
        37: breadItem
      })
    },
    heldItem: stoneItem,
    async setQuickBarSlot(slot) {
      calls.push(['setQuickBarSlot', slot]);
      this.quickBarSlot = slot;
      this.heldItem = this.inventory.slots[this.inventory.hotbarStart + slot];
    },
    async moveSlotItem(from, to) {
      calls.push(['moveSlotItem', from, to]);
    },
    async consume() {
      calls.push(['consume']);
    }
  };

  const feature = new EatFeature({
    inventoryFeature: {
      findItem(itemName, exactMatch) {
        calls.push(['findItem', itemName, exactMatch]);
        return [{ item: breadItem }];
      }
    },
    fishFeature: {
      getState() {
        return { isFishing: false };
      }
    }
  });

  feature.attach(bot);
  const context = createContext();
  await feature.handleEatCommand(context, '7');

  assert.deepEqual(calls, [
    ['findItem', 'bread', true],
    ['setQuickBarSlot', 1],
    ['consume'],
    ['setQuickBarSlot', 0]
  ]);
  assert.deepEqual(context.messages, []);
});

test('EatFeature rejects blocked states like fishing, container, and held-item usage', async () => {
  const feature = new EatFeature({
    inventoryFeature: {
      findItem() {
        return [];
      }
    },
    fishFeature: {
      getState() {
        return { isFishing: true };
      }
    }
  });

  const blockedBot = {
    registry: {
      items: {
        7: { name: 'bread' }
      },
      foodsByName: {
        bread: {}
      }
    },
    currentWindow: null,
    usingHeldItem: false,
    inventory: {
      hotbarStart: 36,
      slots: []
    },
    quickBarSlot: 0
  };

  feature.attach(blockedBot);
  const fishingContext = createContext();
  await feature.handleEatCommand(fishingContext, 'bread');
  assert.equal(fishingContext.messages[0].type, 'error');

  blockedBot.currentWindow = {};
  blockedBot.usingHeldItem = false;
  feature.fishFeature = { getState: () => ({ isFishing: false }) };
  const windowContext = createContext();
  await feature.handleEatCommand(windowContext, 'bread');
  assert.equal(windowContext.messages[0].type, 'error');

  blockedBot.currentWindow = null;
  blockedBot.usingHeldItem = true;
  const heldItemContext = createContext();
  await feature.handleEatCommand(heldItemContext, 'bread');
  assert.equal(heldItemContext.messages[0].type, 'error');
});

test('EatFeature supports minecraft:ominous_bottle whitelist consumption', async () => {
  const ominousBottle = {
    type: 999,
    slot: 36,
    name: 'ominous_bottle',
    displayName: 'Ominous Bottle',
    count: 1
  };
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.registry = {
    items: {
      999: { name: 'ominous_bottle' }
    },
    foodsByName: {}
  };
  bot.game = {
    gameMode: 'survival'
  };
  bot.food = 20;
  bot.currentWindow = null;
  bot.usingHeldItem = false;
  bot.quickBarSlot = 0;
  bot.entity = { id: 1 };
  bot.inventory = {
    hotbarStart: 36,
    slots: Object.assign([], {
      36: ominousBottle
    })
  };
  bot.heldItem = ominousBottle;
  let consumeCalled = 0;
  let activateCalled = 0;
  bot.consume = async () => {
    consumeCalled += 1;
  };
  bot.activateItem = () => {
    activateCalled += 1;
    setImmediate(() => {
      bot._client.emit('set_cooldown', { itemID: ominousBottle.type });
    });
  };
  bot.deactivateItem = () => {};
  bot.setQuickBarSlot = async () => {};
  bot.moveSlotItem = async () => {};

  const feature = new EatFeature({
    inventoryFeature: {
      findItem(itemName, exactMatch) {
        assert.equal(itemName, 'ominous_bottle');
        assert.equal(exactMatch, true);
        return [{ item: ominousBottle }];
      }
    },
    fishFeature: {
      getState() {
        return { isFishing: false };
      }
    }
  });

  feature.attach(bot);
  const context = createContext();
  await feature.handleEatCommand(context, 'minecraft:ominous_bottle');

  assert.equal(consumeCalled, 0);
  assert.equal(activateCalled, 1);
  assert.deepEqual(context.messages, []);
});

test('EatFeature preserves current rotation for regular consume use_item packets', async () => {
  const breadItem = {
    type: 7,
    slot: 36,
    name: 'bread',
    displayName: 'Bread',
    count: 1
  };
  const bot = new EventEmitter();
  const packets = [];
  bot._client = new EventEmitter();
  bot._client.write = (name, payload) => {
    packets.push({ name, payload });
  };
  bot.registry = {
    items: {
      7: { name: 'bread' }
    },
    foodsByName: {
      bread: {}
    }
  };
  bot.game = {
    gameMode: 'survival'
  };
  bot.food = 10;
  bot.currentWindow = null;
  bot.usingHeldItem = false;
  bot.quickBarSlot = 0;
  bot.entity = {
    id: 1,
    yaw: Math.PI / 3,
    pitch: -Math.PI / 4
  };
  bot.inventory = {
    hotbarStart: 36,
    slots: Object.assign([], {
      36: breadItem
    })
  };
  bot.heldItem = breadItem;
  bot.consume = async () => {
    bot._client.write('use_item', {
      hand: 0,
      sequence: 1,
      rotation: { x: 0, y: 0 }
    });
  };
  bot.setQuickBarSlot = async () => {};
  bot.moveSlotItem = async () => {};

  const feature = new EatFeature({
    inventoryFeature: {
      findItem() {
        return [{ item: breadItem }];
      }
    },
    fishFeature: {
      getState() {
        return { isFishing: false };
      }
    }
  });

  feature.attach(bot);
  const context = createContext();
  await feature.handleEatCommand(context, 'bread');

  assert.deepEqual(context.messages, []);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].name, 'use_item');
  assert.deepEqual(packets[0].payload.rotation, {
    x: 45,
    y: 120
  });
});

test('EatFeature preserves current rotation for whitelist manual consume packets', async () => {
  const ominousBottle = {
    type: 999,
    slot: 36,
    name: 'ominous_bottle',
    displayName: 'Ominous Bottle',
    count: 1
  };
  const bot = new EventEmitter();
  const packets = [];
  bot._client = new EventEmitter();
  bot._client.write = (name, payload) => {
    packets.push({ name, payload });
  };
  bot.registry = {
    items: {
      999: { name: 'ominous_bottle' }
    },
    foodsByName: {}
  };
  bot.game = {
    gameMode: 'survival'
  };
  bot.food = 20;
  bot.currentWindow = null;
  bot.usingHeldItem = false;
  bot.quickBarSlot = 0;
  bot.entity = {
    id: 1,
    yaw: Math.PI / 2,
    pitch: -Math.PI / 6
  };
  bot.inventory = {
    hotbarStart: 36,
    slots: Object.assign([], {
      36: ominousBottle
    })
  };
  bot.heldItem = ominousBottle;
  bot.consume = async () => {};
  bot.activateItem = () => {
    bot._client.write('use_item', {
      hand: 0,
      sequence: 9,
      rotation: { x: 0, y: 0 }
    });
    setImmediate(() => {
      bot._client.emit('set_cooldown', { itemID: ominousBottle.type });
    });
  };
  bot.deactivateItem = () => {};
  bot.setQuickBarSlot = async () => {};
  bot.moveSlotItem = async () => {};

  const feature = new EatFeature({
    inventoryFeature: {
      findItem() {
        return [{ item: ominousBottle }];
      }
    },
    fishFeature: {
      getState() {
        return { isFishing: false };
      }
    }
  });

  feature.attach(bot);
  const context = createContext();
  await feature.handleEatCommand(context, 'ominous_bottle');

  assert.deepEqual(context.messages, []);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].name, 'use_item');
  assert.deepEqual(packets[0].payload.rotation, {
    x: 30,
    y: 90
  });
});
