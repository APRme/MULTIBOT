const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { VaultFeature } = require('../src/features/vault/VaultFeature');

const VAULT = { x: 1, y: 64, z: 0 };
const MIN_STATE_ID = 29467;
const STATE_ID = (phase) => MIN_STATE_ID + ['inactive', 'active', 'unlocking', 'ejecting'].indexOf(phase);

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

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

async function waitForText(context, pattern, timeoutMs = 3000) {
  return waitFor(() => pattern.test(context.text), timeoutMs);
}

function createLead(options = {}) {
  const calls = [];
  const client = new EventEmitter();
  const writes = [];
  client.write = (name, params) => writes.push({ name, params });

  const bot = {
    chat: (message) => calls.push(message),
    _client: client,
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { gameMode: 'survival' },
    inventory: { slots: [], hotbarStart: 36 },
    quickBarSlot: 0,
    setQuickBarSlot: (slot) => { bot.quickBarSlot = slot; },
    moveSlotItem: async (source, dest) => {
      const slots = bot.inventory.slots;
      const temp = slots[dest];
      slots[dest] = slots[source];
      slots[source] = temp;
    },
    swingArm: () => {},
    registry: { blocksByName: { vault: { minStateId: MIN_STATE_ID } } }
  };
  Object.defineProperty(bot, 'heldItem', {
    get() { return bot.inventory.slots[36 + (Number.isFinite(bot.quickBarSlot) ? bot.quickBarSlot : 0)] || null; }
  });
  if (options.withKey !== false) bot.inventory.slots[36] = { name: 'trial_key', count: 1, slot: 36 };

  const feature = new VaultFeature({
    replyToChat: true,
    chatGapMs: 5,
    logger: null,
    getSequence: () => 1,
    activateTimeoutMs: options.activateTimeoutMs || 120,
    getCapabilities: () => (options.capabilities || {
      entityHandling: true,
      terrainHandling: true,
      inventoryHandling: true
    })
  });
  feature.bot = bot;
  feature.impl = options.impl === undefined
    ? { findNearestVault: () => ({ position: { ...VAULT } }), cleanupTrial: () => {} }
    : options.impl;

  return { feature, bot, client, calls, writes };
}

test('只保存配置: 不发包, 不执行, 不持久化', async () => {
  const { feature, calls, writes } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['A', 'B', '--delay=7000']);
  assert.equal(await waitForText(context, /配置已保存/), true);

  assert.equal(calls.length, 0);
  assert.equal(writes.length, 0);
  assert.deepEqual(feature.queueConfig.targets, ['A', 'B']);
  assert.equal(feature.queueConfig.delayMs, 7000);
  assert.equal(feature.queueConfigPath, undefined);
  assert.equal(await waitForText(context, /目标: A B/), true);
});

test('只改参数时保留已有目标并去重过滤', () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['A', 'B']);
  feature.handleQueueCommand(context, ['--at=9,8,7', '--no-back']);
  assert.deepEqual(feature.queueConfig.targets, ['A', 'B']);
  assert.deepEqual(feature.queueConfig.at, { x: 9, y: 8, z: 7 });

  feature.handleQueueCommand(context, ['C', 'C', 'D']);
  assert.deepEqual(feature.queueConfig.targets, ['C', 'D']);

  feature.handleQueueCommand(context, ['E', 'bad name!']);
  assert.deepEqual(feature.queueConfig.targets, ['C', 'D']);
});

test('--reset 清空配置为默认值', async () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['A', '--delay=5000', '--at=1,2,3', '--no-back']);
  feature.handleQueueCommand(context, ['--reset']);

  assert.deepEqual(feature.queueConfig.targets, []);
  assert.equal(feature.queueConfig.delayMs, 8000);
  assert.equal(feature.queueConfig.at, null);
  assert.equal(await waitForText(context, /已重置为默认值/), true);
});

test('裸 vaultqueue 回复当前配置 + 帮助说明', async () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, []);
  assert.equal(await waitForText(context, /当前宝库队列配置/), true);
  assert.equal(await waitForText(context, /vaultqueue --reset/), true);
  assert.equal(await waitForText(context, /重启后需要重新配置/), true);
  assert.doesNotMatch(context.text, /配置已保存/);
});

test('车头不移动: 就地发 block_place 激活后再派单', async () => {
  const { feature, client, calls, writes } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=10', '--delay=10', 'A']);
  feature.handleQueueCommand(context, ['--start']);

  // 车头先自己发一个 block_place
  assert.equal(await waitFor(() => writes.length > 0), true);
  const first = writes[0];
  assert.equal(first.name, 'block_place');
  assert.deepEqual(first.params.location, VAULT);

  // 用 block_change 回放"解锁"状态, 车头判定成功
  client.emit('block_change', { location: VAULT, type: STATE_ID('unlocking') });

  assert.equal(await waitForText(context, /宝库队列完成/), true);
  assert.match(context.text, /距离 1\.\d\d 格/);
  assert.deepEqual(calls, ['/tpahere A', '/minecraft:w A vault 1 64 0', '/back']);
});

test('宝库超出交互距离时明确报错且不移动', async () => {
  const { feature, bot, calls, writes } = createLead({
    impl: { findNearestVault: () => ({ position: { x: 20, y: 64, z: 0 } }), cleanupTrial: () => {} }
  });
  const context = createContext();

  feature.handleQueueCommand(context, ['A']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /宝库在 \d+\.\d\d 格外\(交互上限/), true);
  assert.equal(writes.length, 0, '超距离时不应发包');
  assert.equal(calls.length, 0, '超距离时不应派单');
  assert.deepEqual(bot.entity.position, { x: 0, y: 64, z: 0 }, '车头不应移动');
});

test('30 格内没有宝库时报错', async () => {
  const { feature } = createLead({
    impl: { findNearestVault: () => null, cleanupTrial: () => {} }
  });
  const context = createContext();

  feature.handleQueueCommand(context, ['A']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /30 格内没有找到宝库/), true);
});

test('车头没有钥匙时跳过车头, 继续派送', async () => {
  const { feature, calls } = createLead({ withKey: false });
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=5', '--delay=5', '--no-back', 'A']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /跳过车头/), true);
  assert.equal(await waitForText(context, /宝库队列完成/), true);
  assert.deepEqual(calls, ['/tpahere A', '/minecraft:w A vault 1 64 0']);
});

test('车头已领取过(激活超时)时跳过车头, 继续派送', async () => {
  const { feature, calls } = createLead({ activateTimeoutMs: 60 });
  const context = createContext();

  // 不回应 block_change => 车头激活超时
  feature.handleQueueCommand(context, ['--settle=5', '--delay=5', '--no-back', 'A']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /车头未开箱/, 3000), true);
  assert.equal(await waitForText(context, /宝库队列完成/, 3000), true);
  assert.deepEqual(calls, ['/tpahere A', '/minecraft:w A vault 1 64 0']);
});

test('--at 模式跳过找宝库, 直接派单', async () => {
  const findCalls = [];
  const { feature, calls, writes } = createLead({
    impl: {
      findNearestVault: () => { findCalls.push(1); return null; },
      cleanupTrial: () => {}
    }
  });
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=5', '--delay=5', '--at=10,20,30', '--no-back', 'A']);
  feature.handleQueueCommand(context, ['--start']);

  assert.equal(await waitForText(context, /宝库队列完成/), true);
  assert.deepEqual(findCalls, []);
  assert.equal(writes.length, 0, '--at 模式车头不自己开箱');
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

test('没有配置目标时 --start 被拒', async () => {
  const { feature, calls } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--start']);
  assert.equal(await waitForText(context, /还没有配置目标 bot/), true);
  assert.equal(calls.length, 0);
});

test('cancelQueue 中途停止, 已拉过来的 bot 仍收到坐标', async () => {
  const { feature, client, calls } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=60', '--delay=300', 'T1', 'T2']);
  feature.handleQueueCommand(context, ['--start']);

  await new Promise((r) => setTimeout(r, 20));
  client.emit('block_change', { location: VAULT, type: STATE_ID('unlocking') });

  await waitForText(context, /已让 T1 打开/);
  assert.equal(feature.cancelQueue(context), true);
  assert.equal(await waitForText(context, /宝库队列已停止/), true);
  assert.deepEqual(calls, ['/tpahere T1', '/minecraft:w T1 vault 1 64 0', '/back']);
});

test('stop() 取消队列并清空 impl/bot', async () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=80', '--delay=5000', 'S1']);
  feature.handleQueueCommand(context, ['--start']);
  await new Promise((r) => setTimeout(r, 20));

  feature.stop();
  assert.equal(await waitFor(() => feature.queueRunning === false, 3000), true, '队列应自行收尾');

  assert.equal(feature.queueRunning, false);
  assert.equal(feature.impl, null);
  assert.equal(feature.bot, null);
});

test('--tpa-cooldown 未配置时行为与之前一致(不额外等待)', async () => {
  const stamps = [];
  const { feature, bot } = createLead();
  bot.chat = (message) => { if (String(message).startsWith('/tpahere')) stamps.push(Date.now()); };
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=5', '--delay=20', '--no-back', 'A', 'B']);
  feature.handleQueueCommand(context, ['--start']);
  assert.equal(await waitForText(context, /宝库队列完成/, 4000), true);

  assert.equal(stamps.length, 2);
  // 基线来自聊天节流(每条 900ms), 不是 tpa 冷却
  assert.ok(stamps[1] - stamps[0] < 2600, `默认不应有明显额外等待, 实际 ${stamps[1] - stamps[0]}ms`);
});

test('配置 --tpa-cooldown 后两次 tpahere 至少间隔该值', async () => {
  const stamps = [];
  const { feature, bot } = createLead();
  bot.chat = (message) => { if (String(message).startsWith('/tpahere')) stamps.push(Date.now()); };
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=5', '--delay=20', '--tpa-cooldown=4000', '--no-back', 'A', 'B']);
  feature.handleQueueCommand(context, ['--start']);
  assert.equal(await waitForText(context, /宝库队列完成/, 9000), true);

  assert.equal(stamps.length, 2);
  assert.ok(stamps[1] - stamps[0] >= 3900, `两次 tpahere 应 >=4000ms, 实际 ${stamps[1] - stamps[0]}ms`);
});

test('摘要里显示 tpa 冷却状态, --reset 会清空', async () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--tpa-cooldown=5000']);
  assert.equal(await waitForText(context, /tpa冷却: 5000ms/), true);

  feature.handleQueueCommand(context, ['--reset']);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(feature.queueConfig.tpaCooldownMs, null);
});

test('waitForTeleportAccept 命中"接受/传送"消息即返回 true', async () => {
  const { feature, bot } = createLead();
  const emitter = new EventEmitter();
  bot.on = emitter.on.bind(emitter);
  bot.removeListener = emitter.removeListener.bind(emitter);

  const pending = feature.waitForTeleportAccept(500);
  setTimeout(() => emitter.emit('message', 'APR_mem 接受了你的传送请求'), 20);
  assert.equal(await pending, true);
});

test('waitForTeleportAccept 超时返回 false', async () => {
  const { feature, bot } = createLead();
  const emitter = new EventEmitter();
  bot.on = emitter.on.bind(emitter);
  bot.removeListener = emitter.removeListener.bind(emitter);

  assert.equal(await feature.waitForTeleportAccept(60), false);
});

test('--start 可以与其它参数同行(先应用再执行)', async () => {
  const { feature } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=5', '--delay=5', '--no-back', '--tpa-cooldown=5000', '--start', 'A']);
  assert.equal(await waitForText(context, /宝库队列完成/, 4000), true);
  assert.equal(feature.queueConfig.tpaCooldownMs, 5000);
  assert.deepEqual(feature.queueConfig.targets, ['A']);
});

test('注入 sendCommandToBot 时走进程内投递(不私聊)', async () => {
  const delivered = [];
  const { feature, calls } = createLead();
  feature.sendCommandToBot = async (username, command) => {
    delivered.push([username, command]);
    return true;
  };
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=5', '--delay=5', '--no-back', 'A']);
  feature.handleQueueCommand(context, ['--start']);
  assert.equal(await waitForText(context, /宝库队列完成/, 5000), true);

  assert.deepEqual(delivered, [['A', 'vault 1 64 0']]);
  assert.equal(calls.filter((c) => c.includes('/minecraft:w')).length, 0, '不应再私聊');
});

test('没有 sendCommandToBot 时回退到私聊', async () => {
  const { feature, calls } = createLead();
  const context = createContext();

  feature.handleQueueCommand(context, ['--settle=5', '--delay=5', '--no-back', 'A']);
  feature.handleQueueCommand(context, ['--start']);
  assert.equal(await waitForText(context, /宝库队列完成/, 5000), true);

  assert.deepEqual(calls, ['/tpahere A', '/minecraft:w A vault 1 64 0']);
});
