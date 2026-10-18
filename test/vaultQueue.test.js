const test = require('node:test');
const assert = require('node:assert/strict');
const { VaultFeature } = require('../src/features/vault/VaultFeature');

function createContext() {
  const info = [];
  const errors = [];
  return {
    info,
    errors,
    replyInfo: (m) => info.push(m),
    replyError: (m) => errors.push(m),
    get text() { return info.concat(errors).join('\n'); }
  };
}

// 车头: 直接注入假 bot 与假遗留模块(跳过 attach 里的 pathfinder 初始化)
function createLead(options = {}) {
  const calls = [];
  const bot = {
    chat: (message) => calls.push(message)
  };

  const feature = new VaultFeature({
    logger: null,
    getSequence: () => 1,
    getCapabilities: () => (options.capabilities || {
      entityHandling: true,
      terrainHandling: true,
      inventoryHandling: true
    })
  });
  feature.bot = bot;
  feature.impl = options.impl === undefined
    ? {
      openNearestVault: async () => ({
        success: true,
        position: { x: 1, y: 2, z: 3 },
        type: '普通宝库'
      }),
      cleanupTrial: () => {}
    }
    : options.impl;

  return { feature, bot, calls };
}

test('完整模式但未加载遗留模块时给出明确提示', async () => {
  const { feature } = createLead({ impl: null });
  const context = createContext();
  await feature.runQueue(context, ['B1']);
  assert.match(context.text, /没有加载宝库模块/);
});

test('非完整模式时拒绝并回显当前能力', async () => {
  const { feature } = createLead({
    capabilities: { entityHandling: false, terrainHandling: false, inventoryHandling: true }
  });
  const context = createContext();
  await feature.runQueue(context, ['B1']);
  assert.match(context.text, /需要完整模式/);
  assert.match(context.text, /entity=off terrain=off/);
});

test('没有目标时报用法', async () => {
  const { feature } = createLead();
  const context = createContext();
  await feature.runQueue(context, []);
  assert.match(context.text, /用法: vaultqueue/);
});

test('队列顺序: tpahere -> 私聊坐标 -> 等待 -> 下一个 -> 最后 /back', async () => {
  const { feature, calls } = createLead();
  const context = createContext();

  await feature.runQueue(context, ['--settle=10', '--delay=20', 'A', 'B']);

  assert.deepEqual(calls, [
    '/tpahere A',
    '/minecraft:w A vault 1 2 3',
    '/tpahere B',
    '/minecraft:w B vault 1 2 3',
    '/back'
  ]);
  assert.match(context.text, /车头已开启宝库 \(1, 2, 3\)/);
  assert.match(context.text, /已让 A 打开 \(1, 2, 3\)/);
  assert.match(context.text, /已让 B 打开 \(1, 2, 3\)/);
  assert.match(context.text, /宝库队列完成: 已派送 2\/2 个 bot/);
  assert.equal(feature.queueRunning, false);
});

test('--no-back 时不回基地', async () => {
  const { feature, calls } = createLead();
  const context = createContext();
  await feature.runQueue(context, ['--settle=5', '--delay=5', '--no-back', 'A']);
  assert.deepEqual(calls, ['/tpahere A', '/minecraft:w A vault 1 2 3']);
  assert.match(context.text, /宝库队列完成/);
});

test('车头开箱失败则不派发任何 bot', async () => {
  const { feature, calls } = createLead({
    impl: {
      openNearestVault: async () => ({ success: false, message: '附近没有宝库' }),
      cleanupTrial: () => {}
    }
  });
  const context = createContext();
  await feature.runQueue(context, ['A', 'B']);
  assert.equal(calls.length, 0);
  assert.match(context.text, /车头开箱失败: 附近没有宝库/);
  assert.equal(feature.queueRunning, false);
});

test('目标名会去重并过滤非法字符', async () => {
  const { feature, calls } = createLead();
  const context = createContext();
  await feature.runQueue(context, ['--settle=5', '--delay=5', '--no-back', 'A', 'A', 'bad name!', 'B']);
  assert.deepEqual(
    calls.filter((c) => c.startsWith('/minecraft:w')),
    ['/minecraft:w A vault 1 2 3', '/minecraft:w B vault 1 2 3']
  );
});

test('cancelQueue 能在中途停止队列', async () => {
  const { feature, calls } = createLead();
  const context = createContext();

  const running = feature.runQueue(context, ['--settle=60', '--delay=5000', 'T1', 'T2']);
  await new Promise((r) => setTimeout(r, 30));
  const cancelled = feature.cancelQueue(context);
  assert.equal(cancelled, true);

  await running;
  assert.deepEqual(calls, ['/tpahere T1', '/minecraft:w T1 vault 1 2 3', '/back']);
  assert.match(context.text, /已请求停止宝库队列/);
  assert.match(context.text, /宝库队列已停止: 已派送 1\/2 个 bot/);
  assert.equal(feature.queueRunning, false);
});

test('stop() 会取消队列并清空遗留模块', async () => {
  const { feature } = createLead();
  const context = createContext();
  const running = feature.runQueue(context, ['--settle=80', '--delay=5000', 'S1']);
  await new Promise((r) => setTimeout(r, 20));

  feature.stop();
  await running;

  assert.equal(feature.queueRunning, false);
  assert.equal(feature.impl, null);
  assert.equal(feature.bot, null);
});

test('--at=x,y,z 时跳过寻路, 直接使用给定坐标', async () => {
  const calls = [];
  const { feature, calls: chatCalls } = createLead({
    impl: {
      openNearestVault: async () => { calls.push('openNearestVault'); return { success: false, message: '不应被调用' }; },
      cleanupTrial: () => {}
    }
  });
  const context = createContext();

  await feature.runQueue(context, ['--settle=5', '--delay=5', '--at=10,20,30', '--no-back', 'A']);

  assert.deepEqual(calls, [], '不应调用 openNearestVault');
  assert.deepEqual(chatCalls, ['/tpahere A', '/minecraft:w A vault 10 20 30']);
  assert.match(context.text, /使用指定宝库坐标 \(10, 20, 30\)/);
});
