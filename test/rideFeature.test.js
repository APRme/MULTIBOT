const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { RideFeature } = require('../src/features/ride/RideFeature');

function createBot() {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.pathfinder = {};
  bot.loadPlugin = () => {};
  bot.entity = {
    id: 1
  };
  bot.vehicle = {
    id: 2
  };
  bot.moveVehicle = () => {};
  return bot;
}

test('RideFeature detaches bot and client listeners', () => {
  const bot = createBot();
  const feature = new RideFeature();

  feature.attach(bot);

  assert.equal(bot.listenerCount('mount'), 1);
  assert.equal(bot.listenerCount('dismount'), 1);
  assert.equal(bot._client.listenerCount('set_passengers'), 1);

  feature.detach();

  assert.equal(bot.listenerCount('mount'), 0);
  assert.equal(bot.listenerCount('dismount'), 0);
  assert.equal(bot._client.listenerCount('set_passengers'), 0);
  assert.equal(feature.bot, null);
  assert.equal(feature.getState().isRiding, false);
});

