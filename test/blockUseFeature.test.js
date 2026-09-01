const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { BlockUseFeature } = require('../src/features/blockUse/BlockUseFeature');

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

test('BlockUseFeature useblock looks at and activates target block', async () => {
  const calls = [];
  const targetBlock = {
    name: 'chest',
    position: new Vec3(10, 64, 10)
  };
  const bot = {
    entity: {
      position: new Vec3(9, 64, 9)
    },
    blockAt(position) {
      if (position.x === 10 && position.y === 64 && position.z === 10) {
        return targetBlock;
      }
      return null;
    },
    async look(yaw, pitch) {
      calls.push(['look', yaw, pitch]);
    },
    async activateBlock(block) {
      calls.push(['activateBlock', block.name]);
    }
  };
  const feature = new BlockUseFeature();
  const context = createContext();

  feature.attach(bot);
  await feature.handleUseBlockCommand(context, 10, 64, 10);

  assert.equal(calls[0][0], 'look');
  assert.deepEqual(calls[1], ['activateBlock', 'chest']);
  assert.match(context.messages[0].message, /已尝试与方块交互/);
});

test('BlockUseFeature cuseblock places blocks and stops', async () => {
  const placements = [];
  const bot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    heldItem: {
      name: 'stone'
    },
    blockAt(position) {
      if (position.x === 1 && position.y === 64 && position.z === 0) {
        return {
          name: 'stone',
          boundingBox: 'block',
          position: new Vec3(1, 64, 0)
        };
      }

      if (position.x === 2 && position.y === 64 && position.z === 0) {
        return {
          name: 'air',
          boundingBox: 'empty',
          position: new Vec3(2, 64, 0)
        };
      }

      return null;
    },
    async placeBlock(referenceBlock, faceVector) {
      placements.push([referenceBlock.name, faceVector.x, faceVector.y, faceVector.z]);
    }
  };
  const feature = new BlockUseFeature();
  const context = createContext();

  feature.attach(bot);
  feature.handleContinuousUseBlockCommand(context, 2, 64, 0);
  await new Promise((resolve) => setTimeout(resolve, 550));
  feature.stopContinuousPlacement(context);

  assert.ok(placements.length >= 1);
  assert.match(context.messages[0].message, /已开始持续在/);
  assert.ok(context.messages.some((entry) => /已停止持续放置方块/.test(entry.message)));
});
