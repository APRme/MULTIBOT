const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { CplaceFeature } = require('../src/features/cplace/CplaceFeature');

function createContext() {
  const messages = [];
  return {
    label: 'tester',
    replyInfo(message) {
      messages.push({ type: 'info', message });
    },
    replyError(message) {
      messages.push({ type: 'error', message });
    },
    reply(message, mode = 'tell') {
      messages.push({ type: mode, message });
    },
    get messages() {
      return messages;
    }
  };
}

test('CplaceFeature loads vendored module and proxies commands', async () => {
  const feature = new CplaceFeature({
    paths: {
      legacyModulesDir: path.resolve(__dirname, '..', 'src', 'legacy', 'assn')
    }
  });
  const bot = {
    heldItem: null,
    inventory: {
      slots: [],
      inventoryStart: 9,
      inventoryEnd: 36,
      hotbarStart: 36,
      hotbarEnd: 44
    },
    quickBarSlot: 0
  };
  const context = createContext();

  feature.attach(bot);
  await feature.handleCommand(context, 'cplace');
  await feature.handleStopCommand(context);
  feature.stop();

  assert.ok(context.messages.some((entry) => entry.message.includes('手中没有物品') || entry.message.includes('可放置的方块')));
  assert.ok(context.messages.some((entry) => entry.message.includes('当前没有在持续放置') || entry.message.includes('正在停止持续放置')));
});
