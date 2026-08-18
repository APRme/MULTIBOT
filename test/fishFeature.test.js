const test = require('node:test');
const assert = require('node:assert/strict');
const { FishFeature } = require('../src/features/fish/FishFeature');

test('FishFeature auto starts on spawn when enabled', async () => {
  const calls = [];
  const context = { source: 'auto' };
  const feature = new FishFeature({
    autoStartEnabled: true,
    autoStartDelayMs: 5,
    createAutoContext() {
      return context;
    }
  });

  feature.handleFishCommand = async (receivedContext) => {
    calls.push(receivedContext);
    return true;
  };

  feature.attach({});
  feature.handleSpawn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  feature.stop();

  assert.deepEqual(calls, [context]);
});
