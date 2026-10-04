const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { RideFeature } = require('../src/features/ride/RideFeature');
const { LightweightEntityIndex, normalizeUuid } = require('../src/features/ride/LightweightEntityIndex');

const CART_UUID = '507a3b7e-7693-4b7a-bd48-811928fba3ba';
const CART_UUID_UPPER = '507A3B7E-7693-4B7A-BD48-811928FBA3BA';
const CART_UUID_NO_DASH = '507a3b7e76934b7abd48811928fba3ba';
const OTHER_CART_UUID = '11112222-3333-4444-5555-666677778888';
const SELF_ENTITY_ID = 7;

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

function createHarness(options = {}) {
  const writes = [];
  const client = new EventEmitter();
  const selfPosition = options.selfPosition || { x: 0, y: 64, z: 0 };

  client.write = (name, params) => {
    writes.push({ name, params });

    // 模拟服务端响应: 上车/下车后回 set_passengers
    if (name === 'use_entity') {
      setImmediate(() => client.emit('set_passengers', { entityId: params.target, passengers: [SELF_ENTITY_ID] }));
    }
    if (name === 'player_input') {
      setImmediate(() => client.emit('set_passengers', { entityId: options.ridingEntityId || 1, passengers: [] }));
    }
  };

  const bot = {
    version: '1.21.11',
    _client: client,
    supportFeature: (feature) => feature === 'fixedPointDelta128'
  };

  const feature = new RideFeature({
    logger: null,
    getSelfPosition: () => selfPosition,
    ...(options.featureOptions || {})
  });
  feature.attachLightweight(bot);

  if (!options.skipLogin) {
    client.emit('login', { entityId: SELF_ENTITY_ID });
  }

  return { client, writes, feature, bot, selfPosition };
}

function spawnCart(client, { entityId, uuid, x = 0, y = 64, z = 0, type = 85 }) {
  client.emit('spawn_entity', {
    entityId,
    objectUUID: uuid,
    type,
    x,
    y,
    z
  });
}

test('normalizeUuid 兼容大小写与缺省连字符', () => {
  assert.equal(normalizeUuid(CART_UUID), normalizeUuid(CART_UUID_UPPER));
  assert.equal(normalizeUuid(CART_UUID), normalizeUuid(CART_UUID_NO_DASH));
  assert.equal(normalizeUuid(null), '');
});

test('LightweightEntityIndex 只索引可骑乘类型, 并支持销毁与传送', () => {
  const client = new EventEmitter();
  const index = new LightweightEntityIndex({ typeIds: [85] });
  index.attach(client, { bot: { version: '1.21.11', supportFeature: () => false } });

  spawnCart(client, { entityId: 42, uuid: CART_UUID });
  spawnCart(client, { entityId: 43, uuid: OTHER_CART_UUID, type: 1, x: 5 });

  assert.equal(index.size, 1, '非矿车/船类型不入索引');
  assert.equal(index.findByUuid(CART_UUID).id, 42);
  assert.equal(index.findByUuid(CART_UUID_UPPER).id, 42);
  assert.equal(index.findByUuid(OTHER_CART_UUID), null);

  client.emit('entity_teleport', { entityId: 42, x: 3, y: 64, z: 4 });
  assert.equal(index.getById(42).x, 3);

  client.emit('entity_destroy', { entityIds: [42] });
  assert.equal(index.size, 0);
  assert.equal(index.findByUuid(CART_UUID), null);
  index.detach();
});

test('轻量模式 ride <uuid> 发出 use_entity 并进入骑乘状态', async () => {
  const harness = createHarness();
  const context = createContext();
  spawnCart(harness.client, { entityId: 42, uuid: CART_UUID, x: 1 });

  await harness.feature.handleRideCommand(context, ['ride', CART_UUID]);

  const useEntity = harness.writes.find((entry) => entry.name === 'use_entity');
  assert.ok(useEntity, '必须发出 use_entity');
  assert.deepEqual(useEntity.params, { target: 42, mouse: 0, hand: 0, sneaking: false });

  assert.deepEqual(context.errors, []);
  assert.match(context.info.join('\n'), /已骑上/);
  assert.deepEqual(harness.feature.getState(), {
    isRiding: true,
    ridingEntityId: 42,
    mode: 'lightweight'
  });
});

test('轻量模式 UUID 大小写/缺连字符同样可命中', async () => {
  const harness = createHarness();
  const context = createContext();
  spawnCart(harness.client, { entityId: 42, uuid: CART_UUID, x: 1 });

  await harness.feature.handleRideCommand(context, ['ride', CART_UUID_UPPER]);
  assert.equal(harness.feature.isRiding, true);

  harness.feature.detach();

  const harness2 = createHarness();
  const context2 = createContext();
  spawnCart(harness2.client, { entityId: 44, uuid: CART_UUID, x: 1 });
  await harness2.feature.handleRideCommand(context2, ['ride', CART_UUID_NO_DASH]);
  assert.equal(harness2.feature.ridingEntityId, 44);
});

test('轻量模式 未知 UUID / 距离过远 都明确报错', async () => {
  const harness = createHarness({ selfPosition: { x: 100, y: 64, z: 100 } });
  const context = createContext();
  spawnCart(harness.client, { entityId: 42, uuid: CART_UUID, x: 0 });

  await harness.feature.handleRideCommand(context, ['ride', OTHER_CART_UUID]);
  assert.match(context.errors.join('\n'), /不在视野内/);
  assert.equal(harness.writes.length, 0, '未命中时不应发交互包');

  context.errors.length = 0;
  await harness.feature.handleRideCommand(context, ['ride', CART_UUID]);
  assert.match(context.errors.join('\n'), /距离过远/);
});

test('轻量模式 骑乘中再发 ride 下车 (player_input)', async () => {
  const harness = createHarness({ ridingEntityId: 42 });
  const context = createContext();
  spawnCart(harness.client, { entityId: 42, uuid: CART_UUID, x: 1 });

  await harness.feature.handleRideCommand(context, ['ride', CART_UUID]);
  assert.equal(harness.feature.isRiding, true);

  harness.writes.length = 0;
  await harness.feature.handleRideCommand(context, ['ride']);

  const playerInput = harness.writes.filter((entry) => entry.name === 'player_input');
  assert.ok(playerInput.length > 0, '下车必须发 player_input');
  assert.equal(playerInput[0].params.inputs.shift, true);
  assert.match(context.info.join('\n'), /已下来/);
  assert.equal(harness.feature.isRiding, false);
});

test('轻量模式 ride 无参: 未骑乘时挑最近的矿车', async () => {
  const harness = createHarness();
  const context = createContext();
  spawnCart(harness.client, { entityId: 42, uuid: CART_UUID, x: 8 });
  spawnCart(harness.client, { entityId: 43, uuid: OTHER_CART_UUID, x: 2 });

  await harness.feature.handleRideCommand(context, ['ride']);

  const useEntity = harness.writes.find((entry) => entry.name === 'use_entity');
  assert.ok(useEntity);
  assert.equal(useEntity.params.target, 43, '应选最近的那辆');
});

test('轻量模式 ride player / ride w 明确拒绝并给出用法', async () => {
  const harness = createHarness();
  const context = createContext();

  await harness.feature.handleRideCommand(context, ['ride', 'player']);
  await harness.feature.handleRideCommand(context, ['ride', 'w']);
  await harness.feature.handleRideCommand(context, ['ride', 'bogus']);

  const text = context.errors.join('\n');
  assert.match(text, /不支持 ride player/);
  assert.match(text, /不支持 ride w/);
  assert.match(text, /用法: ride \| ride <uuid>/);
});

test('轻量模式 未捕获 login 时按交互结果推断自身 entityId(自愈)', async () => {
  const harness = createHarness({ skipLogin: true });
  const context = createContext();
  spawnCart(harness.client, { entityId: 42, uuid: CART_UUID, x: 1 });

  await harness.feature.handleRideCommand(context, ['ride', CART_UUID]);

  assert.deepEqual(context.errors, [], '自愈后应判定为上车成功');
  assert.equal(harness.feature.lightweightIndex.selfEntityId, SELF_ENTITY_ID);
  assert.equal(harness.feature.isRiding, true);
  assert.equal(harness.feature.ridingEntityId, 42);
});

test('轻量模式 索引为空/UUID 不匹配时的报错自带索引概况', async () => {
  const empty = createHarness();
  const emptyContext = createContext();

  await empty.feature.handleRideCommand(emptyContext, ['ride', CART_UUID]);
  assert.match(emptyContext.errors.join('\n'), /不在视野内/);
  assert.match(emptyContext.errors.join('\n'), /已索引 0 个可骑乘实体/);

  emptyContext.errors.length = 0;
  await empty.feature.handleRideCommand(emptyContext, ['ride']);
  assert.match(emptyContext.errors.join('\n'), /已索引 0 个可骑乘实体/);

  const indexed = createHarness();
  const indexedContext = createContext();
  spawnCart(indexed.client, { entityId: 42, uuid: CART_UUID, x: 1 });

  await indexed.feature.handleRideCommand(indexedContext, ['ride', OTHER_CART_UUID]);
  assert.match(indexedContext.errors.join('\n'), /已索引 1 个可骑乘实体: 507a3b7e\(id=42\)/);
});

test('轻量模式 索引到可骑乘实体时回调可用于日志', () => {
  const client = new EventEmitter();
  const indexed = [];
  const index = new LightweightEntityIndex({
    typeIds: [85],
    onIndexed: (entity) => indexed.push(entity)
  });
  index.attach(client, { bot: { version: '1.21.11', supportFeature: () => false } });

  spawnCart(client, { entityId: 42, uuid: CART_UUID });
  spawnCart(client, { entityId: 43, uuid: OTHER_CART_UUID, type: 1 });

  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].id, 42);
  index.detach();
});

test('轻量模式 交互过早时会持续重试直到收到上车确认', async () => {
  const writes = [];
  const client = new EventEmitter();
  let attempt = 0;

  client.write = (name, params) => {
    writes.push({ name, params });
    // 模拟 vanilla 行为: 前两次交互(玩家刚加入的窗口内)被服务端忽略, 第三次才生效
    if (name === 'use_entity') {
      attempt += 1;
      if (attempt >= 3) {
        setImmediate(() => client.emit('set_passengers', { entityId: params.target, passengers: [SELF_ENTITY_ID] }));
      }
    }
  };

  const bot = { version: '1.21.11', _client: client, supportFeature: () => true };
  const feature = new RideFeature({
    logger: null,
    getSelfPosition: () => ({ x: 0, y: 64, z: 0 }),
    mountAttemptMs: 40,
    mountTotalMs: 3000
  });
  feature.attachLightweight(bot);
  client.emit('login', { entityId: SELF_ENTITY_ID });
  spawnCart(client, { entityId: 42, uuid: CART_UUID, x: 1 });

  const context = createContext();
  await feature.handleRideCommand(context, ['ride', CART_UUID]);

  assert.deepEqual(context.errors, []);
  assert.match(context.info.join('\n'), /已骑上/);
  assert.equal(attempt >= 3, true, '必须重试到成功为止');
  assert.equal(feature.isRiding, true);
  assert.equal(feature.ridingEntityId, 42);
});

test('轻量模式 始终收不到确认时按交互次数报失败', async () => {
  const harness = createHarness({
    featureOptions: { mountAttemptMs: 30, mountTotalMs: 150 }
  });
  const context = createContext();
  harness.client.removeAllListeners('set_passengers');
  // 让 write 不再自动回 set_passengers(默认 harness 会回, 这里改成永不回)
  harness.client.write = () => {};
  spawnCart(harness.client, { entityId: 42, uuid: CART_UUID, x: 1 });

  await harness.feature.handleRideCommand(context, ['ride', CART_UUID]);

  assert.match(context.errors.join('\n'), /交互 \d+ 次均未收到上车确认/);
  assert.equal(harness.feature.isRiding, false);
});

test('轻量模式 载具被销毁或连接结束时骑乘状态复位', async () => {
  const harness = createHarness();
  const context = createContext();
  spawnCart(harness.client, { entityId: 42, uuid: CART_UUID, x: 1 });
  await harness.feature.handleRideCommand(context, ['ride', CART_UUID]);
  assert.equal(harness.feature.isRiding, true);

  harness.client.emit('entity_destroy', { entityIds: [42] });
  assert.equal(harness.feature.isRiding, false);
  assert.equal(harness.feature.ridingEntityId, null);

  harness.client.emit('set_passengers', { entityId: 43, passengers: [SELF_ENTITY_ID] });
  assert.equal(harness.feature.isRiding, true, '重新收到 set_passengers 时恢复');
  harness.client.emit('end', 'socketClosed');
  assert.equal(harness.feature.isRiding, false);
});
