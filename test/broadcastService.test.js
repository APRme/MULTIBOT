const test = require('node:test');
const assert = require('node:assert/strict');
const { BroadcastService } = require('../src/control/BroadcastService');

test('BroadcastService sends chat to all online runtimes only and mirrors receipt to bot logs', () => {
  const calls = [];
  const captures = [];
  const service = new BroadcastService();

  service.registerRuntime({
    config: { id: 'alpha' },
    state: 'online',
    bot: {},
    logger: {
      capture(level, message) {
        captures.push(['alpha', level, message]);
      }
    },
    sendChat(message) {
      calls.push(['alpha', message]);
    }
  });
  service.registerRuntime({
    config: { id: 'beta' },
    state: 'online',
    bot: {},
    logger: {
      capture(level, message) {
        captures.push(['beta', level, message]);
      }
    },
    sendChat(message) {
      calls.push(['beta', message]);
    }
  });
  service.registerRuntime({
    config: { id: 'gamma' },
    state: 'stopped',
    bot: {},
    sendChat(message) {
      calls.push(['gamma', message]);
    }
  });

  const delivered = service.broadcastSend('hello', 'alpha');

  assert.deepEqual(delivered, ['alpha', 'beta']);
  assert.deepEqual(calls, [
    ['alpha', 'hello'],
    ['beta', 'hello']
  ]);
  assert.deepEqual(captures, [
    ['alpha', 'info', '[BROADCAST] received send source=alpha message=hello'],
    ['beta', 'info', '[BROADCAST] received send source=alpha message=hello']
  ]);
});

test('BroadcastService broadcasts inv commands and aggregates results', async () => {
  const calls = [];
  const captures = [];
  const service = new BroadcastService();

  service.registerRuntime({
    config: { id: 'alpha' },
    state: 'online',
    bot: {},
    logger: {
      capture(level, message) {
        captures.push(['alpha', level, message]);
      }
    },
    async executeCommand(command, context) {
      calls.push(['alpha', command, context.source, context.label]);
      context.replyInfo('已丢弃主物品栏全部物品，共 3 组 64 个');
      return true;
    }
  });

  service.registerRuntime({
    config: { id: 'beta' },
    state: 'online',
    bot: {},
    logger: {
      capture(level, message) {
        captures.push(['beta', level, message]);
      }
    },
    async executeCommand(command, context) {
      calls.push(['beta', command, context.source, context.label]);
      context.replyInfo('请先关闭当前容器界面，再执行 inv dropall');
      return true;
    }
  });

  service.registerRuntime({
    config: { id: 'gamma' },
    state: 'stopped',
    bot: {},
    async executeCommand(command, context) {
      calls.push(['gamma', command, context.source, context.label]);
      context.replyInfo('should not run');
      return true;
    }
  });

  const result = await service.broadcastCommand('inv dropall', {
    sourceBotId: 'alpha',
    source: 'whisper',
    sender: 'example_player'
  });

  assert.deepEqual(calls, [
    ['alpha', 'inv dropall', 'broadcast', 'broadcast:alpha'],
    ['beta', 'inv dropall', 'broadcast', 'broadcast:alpha']
  ]);
  assert.deepEqual(captures, [
    ['alpha', 'info', '[BROADCAST] received command source=alpha command=inv dropall'],
    ['beta', 'info', '[BROADCAST] received command source=alpha command=inv dropall']
  ]);
  assert.deepEqual(result, {
    command: 'inv dropall',
    successBotIds: ['alpha'],
    failed: [{ botId: 'beta', error: '请先关闭当前容器界面，再执行 inv dropall' }],
    skippedBotIds: ['gamma']
  });
});

test('BroadcastService broadcasts eat commands and aggregates failures from replies', async () => {
  const calls = [];
  const captures = [];
  const service = new BroadcastService();

  service.registerRuntime({
    config: { id: 'alpha' },
    state: 'online',
    bot: {},
    logger: {
      capture(level, message) {
        captures.push(['alpha', level, message]);
      }
    },
    async executeCommand(command, context) {
      calls.push(['alpha', command, context.source, context.label]);
      return true;
    }
  });

  service.registerRuntime({
    config: { id: 'beta' },
    state: 'online',
    bot: {},
    logger: {
      capture(level, message) {
        captures.push(['beta', level, message]);
      }
    },
    async executeCommand(command, context) {
      calls.push(['beta', command, context.source, context.label]);
      context.replyError('当前正在钓鱼，请先使用 fish 停止钓鱼');
      return true;
    }
  });

  const result = await service.broadcastCommand('eat bread', {
    sourceBotId: 'alpha',
    source: 'whisper',
    sender: 'example_player'
  });

  assert.deepEqual(calls, [
    ['alpha', 'eat bread', 'broadcast', 'broadcast:alpha'],
    ['beta', 'eat bread', 'broadcast', 'broadcast:alpha']
  ]);
  assert.deepEqual(captures, [
    ['alpha', 'info', '[BROADCAST] received command source=alpha command=eat bread'],
    ['beta', 'info', '[BROADCAST] received command source=alpha command=eat bread']
  ]);
  assert.deepEqual(result, {
    command: 'eat bread',
    successBotIds: ['alpha'],
    failed: [{ botId: 'beta', error: '当前正在钓鱼，请先使用 fish 停止钓鱼' }],
    skippedBotIds: []
  });
});

test('BroadcastService broadcastSend is isolated per serverDir', () => {
  const service = new BroadcastService();
  const sent = {};

  const makeRuntime = (id, serverDir) => {
    sent[id] = [];
    return {
      config: { id, serverDir, username: id },
      state: 'online',
      bot: {},
      sendChat(message) {
        sent[id].push(message);
      }
    };
  };

  const alpha = makeRuntime('alpha', 'server-a');
  const beta = makeRuntime('beta', 'server-a');
  const gamma = makeRuntime('gamma', 'server-b');
  [alpha, beta, gamma].forEach((r) => service.registerRuntime(r));

  const delivered = service.broadcastSend('hi from a', 'alpha');

  assert.deepEqual(delivered.sort(), ['alpha', 'beta']);
  assert.equal(sent.gamma.length, 0, 'server-b bot must not receive cross-server message');
  assert.equal(sent.alpha.length, 1);
  assert.equal(sent.beta.length, 1);

  const deliveredFromB = service.broadcastSend('hi from b', 'gamma');
  assert.deepEqual(deliveredFromB, ['gamma']);
});

test('BroadcastService broadcastCommand is isolated per serverDir', async () => {
  const service = new BroadcastService();
  const executed = {};

  const makeRuntime = (id, serverDir) => {
    executed[id] = [];
    return {
      config: { id, serverDir, username: id },
      state: 'online',
      bot: {},
      async executeCommand(command) {
        executed[id].push(command);
        return true;
      }
    };
  };

  const alpha = makeRuntime('alpha', 'server-a');
  const beta = makeRuntime('beta', 'server-a');
  const gamma = makeRuntime('gamma', 'server-b');
  [alpha, beta, gamma].forEach((r) => service.registerRuntime(r));

  const result = await service.broadcastCommand('inv info', { sourceBotId: 'alpha' });

  assert.deepEqual(result.successBotIds.sort(), ['alpha', 'beta']);
  assert.deepEqual(result.skippedBotIds, ['gamma']);
  assert.deepEqual(executed.gamma, [], 'server-b bot must not run the command');
});

test('BroadcastService collectLockStatuses filters by serverDir', () => {
  const service = new BroadcastService();

  const makeRuntime = (id, serverDir, lock) => ({
    config: { id, serverDir, username: id },
    state: 'online',
    bot: {},
    lockFeature: {
      getTeleportLockStatus() {
        return lock;
      }
    }
  });

  service.registerRuntime(makeRuntime('alpha', 'server-a', {
    locked: true, owner: 'owner1', reason: '挂机', remainingText: '30m'
  }));
  service.registerRuntime(makeRuntime('beta', 'server-a', { locked: false }));
  service.registerRuntime(makeRuntime('gamma', 'server-b', { locked: false }));
  service.registerRuntime(makeRuntime('delta', 'server-a', { locked: false }));
  const stopped = makeRuntime('zeta', 'server-a', { locked: false });
  stopped.state = 'stopped';
  service.registerRuntime(stopped);

  const onA = service.collectLockStatuses('server-a');
  assert.deepEqual(onA.map((e) => e.botId).sort(), ['alpha', 'beta', 'delta']);
  assert.equal(onA.find((e) => e.botId === 'alpha').lock.locked, true);

  const all = service.collectLockStatuses(null);
  assert.deepEqual(all.map((e) => e.botId).sort(), ['alpha', 'beta', 'delta', 'gamma']);
});

test('BroadcastService broadcastSend fails closed without a valid source bot', () => {
  const service = new BroadcastService();
  const sent = [];
  const makeRuntime = (id, serverDir) => {
    return {
      config: { id, serverDir, username: id },
      state: 'online',
      bot: {},
      sendChat(message) {
        sent.push([id, message]);
      }
    };
  };
  service.registerRuntime(makeRuntime('alpha', 'server-a'));
  service.registerRuntime(makeRuntime('gamma', 'server-b'));

  // null 源与未注册源均不广播(绝不跨服务器)
  assert.deepEqual(service.broadcastSend('hi', null), []);
  assert.deepEqual(service.broadcastSend('hi', 'ghost-bot'), []);
  assert.deepEqual(sent, []);
});

test('BroadcastService broadcastCommand fails closed without a valid source bot', async () => {
  const service = new BroadcastService();
  const executed = [];
  service.registerRuntime({
    config: { id: 'alpha', serverDir: 'server-a', username: 'alpha' },
    state: 'online',
    bot: {},
    async executeCommand(command) {
      executed.push(['alpha', command]);
      return true;
    }
  });

  const result = await service.broadcastCommand('inv info', { sourceBotId: 'ghost-bot' });
  assert.deepEqual(result.successBotIds, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skippedBotIds, []);
  assert.deepEqual(executed, []);
});
