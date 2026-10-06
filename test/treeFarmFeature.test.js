const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { TreeFarmFeature, TICK_INTERVAL_MS } = require('../src/features/treefarm/TreeFarmFeature');

const TARGET = { x: 100, y: 64, z: 200 };
const ABOVE = { x: 100, y: 65, z: 200 };

function createContext() {
  const info = [];
  const errors = [];
  return {
    info,
    errors,
    replyInfo: (message) => info.push(message),
    replyError: (message) => errors.push(message)
  };
}

// 完整模式: blockAt 可用; 轻量模式: 没有 blockAt, 只能靠 block_change 包喂缓存
function createHarness(options = {}) {
  const client = new EventEmitter();
  const packets = [];
  client.write = (name, params) => {
    packets.push({ name, params });
  };

  const blocks = new Map([
    [`${TARGET.x},${TARGET.y},${TARGET.z}`, options.soil || 'dirt'],
    [`${ABOVE.x},${ABOVE.y},${ABOVE.z}`, options.above || 'air']
  ]);

  const bot = new EventEmitter();
  bot._client = client;
  bot.swingArm = () => {};
  bot.registry = {
    blocksByStateId: {
      100: { name: 'oak_sapling' },
      200: { name: 'oak_log' },
      300: { name: 'air' }
    }
  };

  if (options.lightweight !== true) {
    bot.blockAt = (position) => {
      const name = blocks.get(`${position.x},${position.y},${position.z}`);
      return name === undefined ? null : { name };
    };
  }

  let sequence = 0;
  const feature = new TreeFarmFeature({
    logger: options.logger || null,
    getSequence: () => {
      sequence += 1;
      return sequence;
    }
  });
  feature.attach(bot);

  return { bot, client, packets, blocks, feature };
}

test('treefarm start 校验参数与目标方块', () => {
  const harness = createHarness();
  const context = createContext();

  {
    const bare = new TreeFarmFeature({});
    const bareContext = createContext();
    bare.handleTreeFarmCommand(bareContext, ['start', '1', '2', '3']);
    assert.match(bareContext.errors.join('\n'), /未连接到服务器/);
  }

  harness.feature.handleTreeFarmCommand(context, ['start', 'x', '64', '200']);
  assert.match(context.errors.join('\n'), /用法: treefarm start <x> <y> <z>/);

  const stoneHarness = createHarness({ soil: 'stone' });
  const stoneContext = createContext();
  stoneHarness.feature.handleTreeFarmCommand(stoneContext, ['start', '100', '64', '200']);
  assert.match(stoneContext.errors.join('\n'), /不是可种植的泥土类方块/);

  const okContext = createContext();
  harness.feature.handleTreeFarmCommand(okContext, ['start', '100', '64', '200']);
  assert.match(okContext.info.join('\n'), /树场已启动/);
  assert.equal(harness.feature.isRunning(), true);
  harness.feature.stop();
});

test('上方为空时每个 tick 用副手(hand=1)对土块种植', () => {
  const harness = createHarness({ above: 'air' });
  harness.feature.handleTreeFarmCommand(createContext(), ['start', '100', '64', '200']);
  harness.packets.length = 0;

  harness.feature.tick();

  assert.equal(harness.packets.length, 1);
  assert.equal(harness.packets[0].name, 'block_place');
  assert.equal(harness.packets[0].params.hand, 1, '种树苗必须显式发副手(服务端不回退)');
  assert.deepEqual(
    { x: harness.packets[0].params.location.x, y: harness.packets[0].params.location.y, z: harness.packets[0].params.location.z },
    TARGET
  );
  assert.equal(harness.feature.getState().plantCount, 1);
  harness.feature.stop();
});

test('上方识别为树苗时才用主手(hand=0)催熟, 且目标是树苗那一格', () => {
  const harness = createHarness({ above: 'oak_sapling' });
  harness.feature.handleTreeFarmCommand(createContext(), ['start', '100', '64', '200']);
  harness.packets.length = 0;

  harness.feature.tick();

  assert.equal(harness.packets.length, 1);
  assert.equal(harness.packets[0].params.hand, 0);
  assert.deepEqual(
    { x: harness.packets[0].params.location.x, y: harness.packets[0].params.location.y, z: harness.packets[0].params.location.z },
    ABOVE
  );
  assert.equal(harness.feature.getState().fertilizeCount, 1);
  harness.feature.stop();
});

test('上方不是树苗(如已长成原木)时不催熟, 只尝试种植', () => {
  const harness = createHarness({ above: 'oak_log' });
  harness.feature.handleTreeFarmCommand(createContext(), ['start', '100', '64', '200']);
  harness.packets.length = 0;

  harness.feature.tick();

  assert.equal(harness.packets.length, 1);
  assert.equal(harness.packets[0].params.hand, 1, '只有 *_sapling 才用骨粉');
  assert.equal(harness.feature.getState().fertilizeCount, 0);
  harness.feature.stop();
});

test('轻量模式(无 blockAt)用 block_change 包喂缓存后能识别树苗', () => {
  const harness = createHarness({ lightweight: true });
  const context = createContext();
  harness.feature.handleTreeFarmCommand(context, ['start', '100', '64', '200']);

  // 还没有任何方块状态: 只能尝试种植, 并给出一次告警
  harness.packets.length = 0;
  harness.feature.tick();
  assert.equal(harness.packets[0].params.hand, 1);
  assert.equal(harness.feature.getState().aboveName, null);

  // 服务端下发上方那一格变成树苗
  harness.client.emit('block_change', { location: { x: ABOVE.x, y: ABOVE.y, z: ABOVE.z }, type: 100 });

  harness.packets.length = 0;
  harness.feature.tick();
  assert.equal(harness.packets[0].params.hand, 0, '缓存识别为树苗后改用骨粉');
  assert.equal(harness.feature.getState().aboveName, 'oak_sapling');
  harness.feature.stop();
});

test('共用 sequence 且 stop 后不再发包', async () => {
  const harness = createHarness({ above: 'air' });
  harness.feature.handleTreeFarmCommand(createContext(), ['start', '100', '64', '200']);
  harness.packets.length = 0;

  harness.feature.tick();
  harness.feature.tick();
  assert.deepEqual(harness.packets.map((entry) => entry.params.sequence), [1, 2], '必须使用注入的共用计数器');

  harness.feature.handleTreeFarmCommand(createContext(), ['stop']);
  harness.packets.length = 0;
  harness.feature.tick();
  assert.equal(harness.packets.length, 0);

  const statusContext = createContext();
  harness.feature.handleTreeFarmCommand(statusContext, ['status']);
  assert.match(statusContext.info.join('\n'), /未运行/);
});

test('定时器按每 2 游戏刻(100ms)触发', async () => {
  const harness = createHarness({ above: 'air' });
  harness.feature.handleTreeFarmCommand(createContext(), ['start', '100', '64', '200']);
  harness.packets.length = 0;

  await new Promise((resolve) => setTimeout(resolve, TICK_INTERVAL_MS * 2 + 60));

  assert.ok(harness.packets.length >= 2, `期望至少 2 个包, 实际 ${harness.packets.length}`);
  assert.equal(TICK_INTERVAL_MS, 100, '默认每 2 游戏刻一次');
  harness.feature.stop();
});
