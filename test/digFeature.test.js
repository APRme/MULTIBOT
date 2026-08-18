const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { DigFeature } = require('../src/features/dig/DigFeature');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('DigFeature digs target block successfully', async () => {
  const calls = [];
  const bot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    blockAt(position) {
      if (position.x === 3 && position.y === 64 && position.z === 3) {
        return {
          name: 'stone',
          displayName: '石头',
          diggable: true,
          position
        };
      }
      return null;
    },
    async dig(block) {
      calls.push(['dig', block.name]);
    },
    stopDigging() {
      calls.push(['stopDigging']);
    }
  };
  const feature = new DigFeature();
  const context = createContext();

  feature.attach(bot);
  await feature.handleDigCommand(context, 3, 64, 3);

  assert.deepEqual(calls, [['dig', 'stone']]);
  assert.match(context.messages[0].message, /开始挖掘/);
  assert.match(context.messages[1].message, /成功挖掘/);
});

test('DigFeature supports layered area dig', async () => {
  const calls = [];
  const blocks = new Map([
    ['0,65,0', { name: 'stone', displayName: '石头', diggable: true, position: new Vec3(0, 65, 0) }],
    ['0,64,0', { name: 'dirt', displayName: '泥土', diggable: true, position: new Vec3(0, 64, 0) }]
  ]);
  const bot = {
    entity: {
      position: new Vec3(0, 65, 1)
    },
    blockAt(position) {
      return blocks.get(`${position.x},${position.y},${position.z}`) || null;
    },
    async dig(block) {
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      calls.push(key);
      blocks.delete(key);
    },
    stopDigging() {}
  };
  const feature = new DigFeature({
    areaDigDelayMs: 0
  });
  const context = createContext();

  feature.attach(bot);
  await feature.handleAreaDigCommand(context, 0, 64, 0, 0, 65, 0);

  assert.deepEqual(calls, ['0,65,0', '0,64,0']);
  assert.equal(
    context.messages.some((entry) => /开始挖掘第 1\/2 层/.test(entry.message)),
    true
  );
  assert.equal(
    context.messages.some((entry) => /范围挖掘完成/.test(entry.message)),
    true
  );
});

test('DigFeature stopdig interrupts area dig', async () => {
  const digCalls = [];
  const blocks = new Map([
    ['0,64,0', { name: 'stone', displayName: '石头', diggable: true, position: new Vec3(0, 64, 0) }],
    ['1,64,0', { name: 'stone', displayName: '石头', diggable: true, position: new Vec3(1, 64, 0) }],
    ['2,64,0', { name: 'stone', displayName: '石头', diggable: true, position: new Vec3(2, 64, 0) }]
  ]);
  const stopContext = createContext();
  let stopDiggingCalls = 0;
  let feature = null;

  const bot = {
    entity: {
      position: new Vec3(0, 64, 1)
    },
    blockAt(position) {
      return blocks.get(`${position.x},${position.y},${position.z}`) || null;
    },
    async dig(block) {
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      digCalls.push(key);
      blocks.delete(key);

      if (digCalls.length === 1) {
        setTimeout(() => {
          feature.stopDigging(stopContext);
        }, 0);
        await sleep(10);
      }
    },
    stopDigging() {
      stopDiggingCalls += 1;
    }
  };

  feature = new DigFeature({
    areaDigDelayMs: 0
  });

  const context = createContext();
  feature.attach(bot);
  await feature.handleAreaDigCommand(context, 0, 64, 0, 2, 64, 0);

  assert.deepEqual(digCalls, ['0,64,0']);
  assert.equal(stopDiggingCalls >= 1, true);
  assert.equal(
    stopContext.messages.some((entry) => /正在停止范围挖掘/.test(entry.message)),
    true
  );
  assert.equal(
    context.messages.some((entry) => /范围挖掘已停止/.test(entry.message)),
    true
  );
});

test('DigFeature stopdig stops digging', () => {
  let stopped = false;
  const bot = {
    entity: {
      position: new Vec3(0, 64, 0)
    },
    stopDigging() {
      stopped = true;
    }
  };
  const feature = new DigFeature();
  const context = createContext();

  feature.attach(bot);
  feature.stopDigging(context);

  assert.equal(stopped, true);
  assert.match(context.messages[0].message, /已停止挖掘/);
});
