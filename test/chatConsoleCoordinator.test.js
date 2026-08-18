const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatConsoleCoordinator } = require('../src/logging/ChatConsoleCoordinator');

function createRuntime(id, serverDir = 'my_server') {
  return {
    config: {
      id,
      serverDir
    }
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('ChatConsoleCoordinator aggregates identical same-server chat lines into one backend console entry and mirrors them to each bot log', async () => {
  const writes = [];
  const loggerCalls = [];
  const coordinator = new ChatConsoleCoordinator({
    batchWindowMs: 15,
    writer(entry) {
      writes.push(entry);
    }
  });

  coordinator.submit({
    runtime: createRuntime('example_bot'),
    logger: {
      info(message) {
        loggerCalls.push(['info', 'example_bot', message]);
      },
      capture(level, message) {
        loggerCalls.push(['capture', 'example_bot', level, message]);
      }
    },
    level: 'info',
    message: '[CHAT] exampleplayer joined the game'
  });
  coordinator.submit({
    runtime: createRuntime('example_net'),
    logger: {
      info(message) {
        loggerCalls.push(['info', 'example_net', message]);
      },
      capture(level, message) {
        loggerCalls.push(['capture', 'example_net', level, message]);
      }
    },
    level: 'info',
    message: '[CHAT] exampleplayer joined the game'
  });

  await wait(40);

  assert.deepEqual(loggerCalls, [
    ['capture', 'example_bot', 'info', '[CHAT] exampleplayer joined the game'],
    ['capture', 'example_net', 'info', '[CHAT] exampleplayer joined the game']
  ]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    label: 'my_server',
    level: 'info',
    message: '[CHAT] exampleplayer joined the game',
    botIds: ['example_bot', 'example_net']
  });
});

test('ChatConsoleCoordinator keeps single-recipient chat output on the original bot logger', async () => {
  const writes = [];
  const loggerCalls = [];
  const coordinator = new ChatConsoleCoordinator({
    batchWindowMs: 15,
    writer(entry) {
      writes.push(entry);
    }
  });

  coordinator.submit({
    runtime: createRuntime('example_bot'),
    logger: {
      info(message) {
        loggerCalls.push(message);
      }
    },
    level: 'info',
    message: '[CHAT] only one bot saw this message'
  });

  await wait(40);

  assert.deepEqual(writes, []);
  assert.deepEqual(loggerCalls, ['[CHAT] only one bot saw this message']);
});

test('ChatConsoleCoordinator prints later identical public chat lines again after the batch window', async () => {
  const writes = [];
  const coordinator = new ChatConsoleCoordinator({
    batchWindowMs: 15,
    writer(entry) {
      writes.push(entry);
    }
  });

  coordinator.submit({
    runtime: createRuntime('example_bot'),
    logger: { capture() {} },
    level: 'info',
    message: '[CHAT] same public line'
  });
  coordinator.submit({
    runtime: createRuntime('example_net'),
    logger: { capture() {} },
    level: 'info',
    message: '[CHAT] same public line'
  });

  await wait(40);

  coordinator.submit({
    runtime: createRuntime('example_bot'),
    logger: { capture() {} },
    level: 'info',
    message: '[CHAT] same public line'
  });
  coordinator.submit({
    runtime: createRuntime('example_net'),
    logger: { capture() {} },
    level: 'info',
    message: '[CHAT] same public line'
  });

  await wait(40);

  assert.equal(writes.length, 2);
  assert.equal(writes[0].label, 'my_server');
  assert.equal(writes[1].label, 'my_server');
  assert.equal(writes[0].message, '[CHAT] same public line');
  assert.equal(writes[1].message, '[CHAT] same public line');
});
