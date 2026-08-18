const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { InventoryFeature } = require('../src/features/inventory/InventoryFeature');

test('InventoryFeature stops legacy inventory module and clears bot references', () => {
  const feature = new InventoryFeature({
    paths: {
      legacyModulesDir: path.resolve(__dirname, '..', 'src', 'legacy', 'assn')
    }
  });
  const bot = {
    inventory: {
      slots: [],
      hotbarStart: 36
    }
  };

  feature.attach(bot);

  assert.equal(feature.bot, bot);
  assert.equal(feature.impl.getInvStatus().isProcessingQueue, true);
  assert.equal(feature.impl.getInvStatus().hasBot, true);

  feature.stop();

  assert.equal(feature.bot, null);
  assert.equal(feature.impl, null);
});
