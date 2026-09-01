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
