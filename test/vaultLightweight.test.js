const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { VaultFeature, decodeVaultState, parseCoordinates } = require('../src/features/vault/VaultFeature');

const VAULT = { x: 100, y: 64, z: 200 };
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
    get text() { return info.concat(errors).join('\n'); },
    get done() { return info.length + errors.length > 0; }
  };
}

async function waitForDone(context, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !context.done) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return context.done;
}

// 轻量模式: 没有 blockAt/findBlock, 只有 _client + 轻量背包
function createHarness(options = {}) {
  const client = new EventEmitter();
  const writes = [];
  client.write = (name, params) => {
    writes.push({ name, params });
  };

  const bot = new EventEmitter();
  bot._client = client;
  bot.registry = { blocksByName: { vault: { minStateId: MIN_STATE_ID } } };
  bot.inventory = { slots: [], hotbarStart: 36 };
  bot.quickBarSlot = 0;
  bot.swingArm = () => {};
  bot.setQuickBarSlot = (slot) => { bot.quickBarSlot = slot; };
  const moves = [];
  bot.moveSlotItem = async (source, dest) => { moves.push([source, dest]); };

  let sequence = 0;
  const feature = new VaultFeature({
    logger: null,
    activateTimeoutMs: options.activateTimeoutMs || 60,
    getSequence: () => { sequence += 1; return sequence; }
  });
  feature.attach(bot);

  return { bot, client, writes, moves, feature };
}

function setSlot(harness, slot, item) {
  harness.bot.inventory.slots[slot] = item;
}

test('parseCoordinates / decodeVaultState 基础行为', () => {
  assert.equal(parseCoordinates([]), null);
  assert.equal(parseCoordinates(['1', '2']), 'invalid');
  assert.equal(parseCoordinates(['a', '2', '3']), 'invalid');
  assert.deepEqual(parseCoordinates(['100', '64.9', '200']), { x: 100, y: 64, z: 200 });

  assert.equal(decodeVaultState(STATE_ID('inactive'), MIN_STATE_ID), 'inactive');
  assert.equal(decodeVaultState(STATE_ID('unlocking'), MIN_STATE_ID), 'unlocking');
  assert.equal(decodeVaultState(STATE_ID('ejecting'), MIN_STATE_ID), 'ejecting');
  // 不详宝库同样是 4 周期
  assert.equal(decodeVaultState(STATE_ID('unlocking') + 4, MIN_STATE_ID), 'unlocking');
});

test('轻量模式 attach 不加载遗留模块(避免 pathfinder)', () => {
  const harness = createHarness();
  assert.equal(harness.feature.hasTerrainData(), false);
  assert.equal(harness.feature.impl, null, '轻量模式不能 initTrial');
});

test('轻量模式不给坐标时明确拒绝', () => {
  const harness = createHarness();
  const context = createContext();
  harness.feature.handleCommand(context, []);
  assert.match(context.text, /轻量模式需要提供宝库坐标/);
});

test('坐标数量不对时报用法错误', () => {
  const harness = createHarness();
  const context = createContext();
  harness.feature.handleCommand(context, ['1', '2']);
  assert.match(context.text, /用法: vault \[x y z\]/);
});

test('背包没有钥匙时报错且不发包', () => {
  const harness = createHarness();
  const context = createContext();
  harness.feature.handleCommand(context, ['100', '64', '200']);
  assert.match(context.text, /背包里没有宝库钥匙/);
  assert.equal(harness.writes.length, 0);
});

test('单个 block_place 解锁: 字段正确且 unlocking 判定成功', async () => {
  const harness = createHarness();
  const context = createContext();
  setSlot(harness, 9, { name: 'trial_key', count: 1, slot: 9 });

  harness.feature.handleCommand(context, ['100', '64', '200']);

  // 等包发出(钥匙会先被换到主手)
  const deadline = Date.now() + 800;
  while (Date.now() < deadline && harness.writes.length === 0) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(harness.writes.length, 1, '只应发 1 个 block_place');
  const { name, params } = harness.writes[0];
  assert.equal(name, 'block_place');
  assert.equal(params.hand, 0);
  assert.deepEqual(params.location, VAULT);
  assert.equal(params.direction, 1);
  assert.equal(params.cursorX, 0.5);
  assert.equal(params.sequence, 1, 'sequence 使用注入的共用计数器');
  assert.deepEqual(harness.moves[0], [9, 36], '钥匙应被移到主手槽');

  harness.client.emit('block_change', { location: VAULT, type: STATE_ID('unlocking') });
  assert.equal(await waitForDone(context), true);
  assert.match(context.text, /已激活宝库 \(100, 64, 200\)/);
  assert.match(context.text, /trial_key/);
});

test('ejecting 也算成功', async () => {
  const harness = createHarness();
  const context = createContext();
  setSlot(harness, 36, { name: 'trial_key', count: 2, slot: 36 });
  harness.feature.handleCommand(context, ['100', '64', '200']);

  const deadline = Date.now() + 800;
  while (Date.now() < deadline && harness.writes.length === 0) {
    await new Promise((r) => setTimeout(r, 10));
  }
  harness.client.emit('block_change', { location: VAULT, type: STATE_ID('ejecting') });
  assert.equal(await waitForDone(context), true);
  assert.match(context.text, /已激活宝库/);
});

test('其它坐标或 inactive 状态不误判, 超时后报未确认并摘除监听', async () => {
  const harness = createHarness({ activateTimeoutMs: 80 });
  const context = createContext();
  setSlot(harness, 36, { name: 'trial_key', count: 1, slot: 36 });
  harness.feature.handleCommand(context, ['100', '64', '200']);

  const deadline = Date.now() + 800;
  while (Date.now() < deadline && harness.writes.length === 0) {
    await new Promise((r) => setTimeout(r, 10));
  }

  harness.client.emit('block_change', { location: { x: 999, y: 64, z: 200 }, type: STATE_ID('unlocking') });
  harness.client.emit('block_change', { location: VAULT, type: STATE_ID('inactive') });

  assert.equal(await waitForDone(context), true);
  assert.match(context.text, /未确认宝库已激活/);
  assert.equal(harness.client.listenerCount('block_change'), 0, '超时后必须摘除监听');
  assert.equal(harness.client.listenerCount('block_update'), 0);
});

test('普通钥匙无反应时自动改用不详钥匙', async () => {
  const harness = createHarness({ activateTimeoutMs: 70 });
  const context = createContext();
  setSlot(harness, 36, { name: 'trial_key', count: 1, slot: 36 });
  setSlot(harness, 37, { name: 'ominous_trial_key', count: 1, slot: 37 });

  harness.feature.handleCommand(context, ['100', '64', '200']);

  // 第一把钥匙超时后会自动换第二把: 等第二个包出现再回状态
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && harness.writes.length < 2) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(harness.writes.length, 2, '应先后发出 2 个包');
  assert.deepEqual(harness.writes.map((w) => w.params.sequence), [1, 2]);

  harness.client.emit('block_change', { location: VAULT, type: STATE_ID('unlocking') });
  assert.equal(await waitForDone(context), true);
  assert.match(context.text, /ominous_trial_key/);
});
