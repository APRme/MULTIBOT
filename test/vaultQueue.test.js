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
    get text() { return info.concat(errors).join('\n'); },
    get done() { return info.length + errors.length > 0; }
  };
}

async function waitForText(context, pattern, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(context.text)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pattern.test(context.text);
}

function createLead(options = {}) {
  const calls = [];
  const bot = { chat: (message) => calls.push(message) };

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

test('只保存配置: 不发包, 不执行, 不持久化', async () => {
  const { feature, calls } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['A', 'B', '--delay=7000']);
  assert.equal(await waitForText(context, /配置已保存/), true);

  assert.equal(calls.length, 0);
  assert.deepEqual(feature.queueConfig.targets, ['A', 'B']);
  assert.equal(feature.queueConfig.delayMs, 7000);
  assert.equal(feature.queueConfigPath, undefined);
  assert.match(context.text, /配置已保存\(仅内存/);
  assert.equal(await waitForText(context, /目标: A B/), true);
  assert.equal(await waitForText(context, /vaultqueue --start/), true);
});

test('只改参数时保留已有目标并去重过滤', () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['A', 'B']);
  feature.handleQueueCommand(context, ['--at=9,8,7', '--no-back']);

  assert.deepEqual(feature.queueConfig.targets, ['A', 'B']);
  assert.deepEqual(feature.queueConfig.at, { x: 9, y: 8, z: 7 });
  assert.equal(feature.queueConfig.backAtEnd, false);

  // 去重
  feature.handleQueueCommand(context, ['C', 'C', 'D']);
  assert.deepEqual(feature.queueConfig.targets, ['C', 'D']);

  // 含非法 token 时整条命令被拒, 目标保持上一次配置
  feature.handleQueueCommand(context, ['E', 'bad name!']);
  assert.deepEqual(feature.queueConfig.targets, ['C', 'D']);
  assert.match(context.text, /用法: vaultqueue/);
});

test('--reset 清空配置为默认值', () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['A', '--delay=5000', '--at=1,2,3', '--no-back']);
  feature.handleQueueCommand(context, ['--reset']);

  assert.deepEqual(feature.queueConfig.targets, []);
  assert.equal(feature.queueConfig.delayMs, 8000);
  assert.equal(feature.queueConfig.settleMs, 1200);
  assert.equal(feature.queueConfig.backAtEnd, true);
  assert.equal(feature.queueConfig.at, null);
  assert.match(context.text, /已重置为默认值/);
});

test('--reset 在队列运行中被拒绝', async () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=80', '--delay=5000', 'R1']);
  feature.handleQueueCommand(context, ['--start']);
  await new Promise((r) => setTimeout(r, 20));

  feature.handleQueueCommand(context, ['--reset']);
  assert.match(context.text, /请先发送: vaultqueue stop/);

  feature.cancelQueue();
  await waitForText(context, /已停止/);
});

test('--start 没有配置目标时明确拒绝', async () => {
  const { feature, calls } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--start']);
  await waitForText(context, /还没有配置目标 bot/);
  assert.equal(calls.length, 0);
});

test('--start 按已保存配置执行: tpahere -> 私聊坐标 -> 最后 /back', async () => {
  const { feature, calls } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=10', '--delay=20', 'A', 'B']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /宝库队列完成/), true);
  assert.deepEqual(calls, [
    '/tpahere A',
    '/minecraft:w A vault 1 2 3',
    '/tpahere B',
    '/minecraft:w B vault 1 2 3',
    '/back'
  ]);
});

test('--no-back 时不回基地', async () => {
  const { feature, calls } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=5', '--delay=5', '--no-back', 'A']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /宝库队列完成/), true);
  assert.deepEqual(calls, ['/tpahere A', '/minecraft:w A vault 1 2 3']);
});

test('配置了 --at 时不调用 openNearestVault', async () => {
  const openCalls = [];
  const { feature, calls } = createLead({
    impl: {
      openNearestVault: async () => { openCalls.push(1); return { success: false, message: '不应被调用' }; },
      cleanupTrial: () => {}
    }
  });
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=5', '--delay=5', '--at=10,20,30', '--no-back', 'A']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /宝库队列完成/), true);
  assert.deepEqual(openCalls, []);
  assert.deepEqual(calls, ['/tpahere A', '/minecraft:w A vault 10 20 30']);
});

test('非完整模式拒绝执行并回显能力', async () => {
  const { feature } = createLead({
    capabilities: { entityHandling: false, terrainHandling: false, inventoryHandling: true }
  });
  const context = createContext();

  feature.handleQueueCommand(context, ['A']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /需要完整模式/), true);
  assert.match(context.text, /entity=off terrain=off/);
});

test('完整模式但 impl 缺失且没给 --at 时给出明确提示', async () => {
  const { feature } = createLead({ impl: null });
  const context = createContext();

  feature.handleQueueCommand(context, ['A']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /没有加载宝库模块/), true);
});

test('车头开箱失败则不派发任何 bot', async () => {
  const { feature, calls } = createLead({
    impl: {
      openNearestVault: async () => ({ success: false, message: '附近没有宝库' }),
      cleanupTrial: () => {}
    }
  });
  const context = createContext();

  feature.handleQueueCommand(context, ['A', 'B']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /车头开箱失败/), true);
  assert.equal(calls.length, 0);
});

test('cancelQueue 中途停止, 已拉过来的 bot 仍收到坐标', async () => {
  const { feature, calls } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=60', '--delay=5000', 'T1', 'T2']);
  feature.handleQueueCommand(context, ['--start']);

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(feature.cancelQueue(context), true);

  assert.equal(await waitForText(context, /宝库队列已停止/), true);
  assert.deepEqual(calls, ['/tpahere T1', '/minecraft:w T1 vault 1 2 3', '/back']);
});

test('stop() 取消队列并清空 impl/bot', async () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=80', '--delay=5000', 'S1']);
  feature.handleQueueCommand(context, ['--start']);
  await new Promise((r) => setTimeout(r, 20));

  feature.stop();
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(feature.queueRunning, false);
  assert.equal(feature.impl, null);
  assert.equal(feature.bot, null);
});

test('裸 vaultqueue 回复当前配置 + 帮助说明', async () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, []);
  assert.equal(await waitForText(context, /vaultqueue --reset/), true);

  assert.match(context.text, /当前宝库队列配置\(未做改动\)/);
  assert.doesNotMatch(context.text, /配置已保存/);
  assert.match(context.text, /目标: \(未设置\)/);
  assert.match(context.text, /vaultqueue --start/);
  assert.match(context.text, /vaultqueue --reset/);
  assert.match(context.text, /--delay=ms/);
  assert.equal(await waitForText(context, /重启后需要重新配置/), true);
});
