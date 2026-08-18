const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { ChatFeature, parseChatMessage } = require('../src/features/chat/ChatFeature');

test('parseChatMessage preserves spaces from nested chat fragments', () => {
  const parsed = parseChatMessage({
    text: '「name1」-',
    extra: [
      { text: '[name2]<player>' },
      { text: ' 123' }
    ]
  });

  assert.equal(parsed, '「name1」-[name2]<player> 123');
});

test('parseChatMessage renders translated private messages', () => {
  const parsed = parseChatMessage({
    translate: 'commands.message.display.incoming',
    with: [
      { text: 'example_player' },
      {
        text: '',
        extra: [
          { text: 'health' },
          { '': ' info' }
        ]
      }
    ]
  });

  assert.equal(parsed, 'example_player whispers to you: health info');
});

test('parseChatMessage renders translate templates and empty-key text', () => {
  const parsed = parseChatMessage({
    translate: '%s whispers to you: %s',
    with: [
      { text: 'example_player' },
      {
        extra: [
          { text: 'hello' },
          { '': ' ' },
          { text: 'world' }
        ]
      }
    ]
  });

  assert.equal(parsed, 'example_player whispers to you: hello world');
});

test('parseChatMessage renders sleep progress with numeric with arguments', () => {
  const parsed = parseChatMessage({
    translate: 'sleep.players_sleeping',
    with: [1, 20]
  });

  assert.equal(parsed, '1/20名玩家已入睡');
});

test('parseChatMessage renders numeric with arguments in generic translate paths', () => {
  const parsed = parseChatMessage({
    translate: 'multiplayer.player.joined',
    with: ['example_player', 3]
  });

  // generic 模板只消费第一个 %s，多余 with 参数（含数字）按既有行为忽略
  assert.equal(parsed, 'example_player加入了游戏');
});

test('ChatFeature forwards trusted whisper commands only', async () => {
  const commands = [];
  const contexts = [];
  const feature = new ChatFeature({
    runtime: {
      createCommandContext(options) {
        contexts.push(options);
        return { options };
      },
      async executeCommand(content, context) {
        commands.push([content, context]);
      }
    },
    teleportFeature: {
      handleTeleportRequest() {},
      handleTeleportHereRequest() {}
    },
    trustedPlayers: ['example_player'],
    activityLogFeature: {
      logChatMessage() {}
    }
  });

  await feature.handleMessage('example_player whispers to you: health');
  await feature.handleMessage('someone whispers to you: health');

  assert.deepEqual(contexts, [{ source: 'whisper', sender: 'example_player' }]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], 'health');
});

test('ChatFeature forwards translated trusted whisper commands', async () => {
  const commands = [];
  const contexts = [];
  const feature = new ChatFeature({
    runtime: {
      createCommandContext(options) {
        contexts.push(options);
        return { options };
      },
      async executeCommand(content, context) {
        commands.push([content, context]);
      }
    },
    teleportFeature: {
      handleTeleportRequest() {},
      handleTeleportHereRequest() {}
    },
    trustedPlayers: ['example_player'],
    activityLogFeature: {
      logChatMessage() {}
    }
  });

  await feature.handleMessage({
    translate: 'commands.message.display.incoming',
    with: [
      { text: 'example_player' },
      { text: 'health' }
    ]
  });

  assert.deepEqual(contexts, [{ source: 'whisper', sender: 'example_player' }]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], 'health');
});

test('ChatFeature uses trusted players store for whisper commands when available', async () => {
  const commands = [];
  const contexts = [];
  const feature = new ChatFeature({
    runtime: {
      createCommandContext(options) {
        contexts.push(options);
        return { options };
      },
      async executeCommand(content, context) {
        commands.push([content, context]);
      }
    },
    teleportFeature: {
      handleTeleportRequest() {},
      handleTeleportHereRequest() {}
    },
    trustedPlayers: [],
    trustedPlayersStore: {
      isTrustedPlayer(sender) {
        return String(sender).toLowerCase() === 'fileuser';
      }
    },
    activityLogFeature: {
      logChatMessage() {}
    }
  });

  await feature.handleMessage('FileUser whispers to you: health');
  await feature.handleMessage('Other whispers to you: health');

  assert.deepEqual(contexts, [{ source: 'whisper', sender: 'FileUser' }]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], 'health');
});

test('ChatFeature detects teleport request messages', async () => {
  const calls = [];
  const logs = [];
  const feature = new ChatFeature({
    runtime: {
      createCommandContext() {
        return {};
      },
      async executeCommand() {}
    },
    teleportFeature: {
      handleTeleportRequest(sender) {
        calls.push(['tpa', sender]);
      },
      handleTeleportHereRequest(sender) {
        calls.push(['tpahere', sender]);
      }
    },
    logger: { info(message) { logs.push(message); } },
    trustedPlayers: []
  });

  await feature.handleMessage('example_player 请求传送到你的位置');
  await feature.handleMessage('example_player 请求你传送到他的位置');

  assert.deepEqual(calls, [
    ['tpa', 'example_player'],
    ['tpahere', 'example_player']
  ]);
  assert.deepEqual(logs.filter((message) => message.includes('收到来自')), [
    '[TPA] 收到来自 example_player 的传送请求',
    '[TPAHERE] 收到来自 example_player 的传送至此请求'
  ]);
});

test('ChatFeature detects EssC teleport request messages', async () => {
  const calls = [];
  const feature = new ChatFeature({
    runtime: {
      createCommandContext() {
        return {};
      },
      async executeCommand() {}
    },
    teleportFeature: {
      handleTeleportRequest(sender) {
        calls.push(['tpa', sender]);
      },
      handleTeleportHereRequest(sender) {
        calls.push(['tpahere', sender]);
      }
    },
    trustedPlayers: []
  });

  await feature.handleMessage('EssC »  playerName 想要传送到你这里。\n输入 /tpaccept 接受或 /tpdeny 拒绝。');
  await feature.handleMessage('EssC »  playerName 想要你传送到他们那里。\n输入 /tpaccept 接受或 /tpdeny 拒绝。');
  await feature.handleMessage('EssC »  playerName wants to teleport to you.\nType /tpaccept to accept or /tpdeny to deny.');
  await feature.handleMessage('EssC »  playerName wants you to teleport to them.\nType /tpaccept to accept or /tpdeny to deny.');
  await feature.handleMessage('EssC >  otherPlayer 想要你传送到该玩家位置。\r\n输入 /tpaccept 接受或 /tpdeny 拒绝。');

  assert.deepEqual(calls, [
    ['tpa', 'playerName'],
    ['tpahere', 'playerName'],
    ['tpa', 'playerName'],
    ['tpahere', 'playerName'],
    ['tpahere', 'otherPlayer']
  ]);
});

test('ChatFeature requires the complete message to match a teleport prompt', async () => {
  const calls = [];
  const feature = new ChatFeature({
    runtime: {
      createCommandContext() {
        return {};
      },
      async executeCommand() {}
    },
    teleportFeature: {
      handleTeleportRequest(sender) {
        calls.push(['tpa', sender]);
      },
      handleTeleportHereRequest(sender) {
        calls.push(['tpahere', sender]);
      }
    }
  });

  await feature.handleMessage('Somebody: example_player 请求传送到你的位置');
  await feature.handleMessage('[聊天] example_player 想要你传送到他们那里。');
  await feature.handleMessage('example_player 请求传送到你的位置 只是聊天');
  await feature.handleMessage('OtherPlayer example_player 请求你传送到他的位置');

  assert.deepEqual(calls, []);
});

test('ChatFeature appends strict custom teleport matchers from server config', async () => {
  const calls = [];
  const feature = new ChatFeature({
    runtime: {
      createCommandContext() {
        return {};
      },
      async executeCommand() {}
    },
    teleportPromptMatchers: {
      stripLines: ['^使用 /tpaccept 接受，使用 /tpdeny 拒绝。$'],
      tpa: ['^(?<sender>[A-Za-z0-9_]{1,16}) 向你发起了传送申请$'],
      tpahere: ['^(?<sender>[A-Za-z0-9_]{1,16}) 邀请你传送到其位置$']
    },
    teleportFeature: {
      handleTeleportRequest(sender) {
        calls.push(['tpa', sender]);
      },
      handleTeleportHereRequest(sender) {
        calls.push(['tpahere', sender]);
      }
    }
  });

  await feature.handleMessage('CustomUser 向你发起了传送申请\n使用 /tpaccept 接受，使用 /tpdeny 拒绝。');
  await feature.handleMessage('CustomUser 邀请你传送到其位置');
  await feature.handleMessage('聊天前缀 CustomUser 向你发起了传送申请');

  assert.deepEqual(calls, [
    ['tpa', 'CustomUser'],
    ['tpahere', 'CustomUser']
  ]);
});

test('ChatFeature wraps custom alternations in a full-message boundary', async () => {
  const calls = [];
  const feature = new ChatFeature({
    runtime: {
      createCommandContext() { return {}; },
      async executeCommand() {}
    },
    teleportPromptMatchers: {
      tpa: ['^(?<sender>[A-Za-z0-9_]{1,16}) 安全申请$|(?<sender2>[A-Za-z0-9_]{1,16}) 危险申请']
    },
    teleportFeature: {
      handleTeleportRequest(sender) { calls.push(sender); },
      handleTeleportHereRequest() {}
    }
  });

  await feature.handleMessage('前置内容 BadUser 危险申请');
  assert.deepEqual(calls, []);
});

test('ChatFeature delegates chat console output to the shared coordinator when available', async () => {
  const consoleLogs = [];
  const coordinatorCalls = [];
  const activityLogs = [];
  const feature = new ChatFeature({
    runtime: {
      config: {
        id: 'example_net',
        serverDir: 'my_server'
      },
      createCommandContext() {
        return {};
      },
      async executeCommand() {}
    },
    logger: {
      info(message) {
        consoleLogs.push(message);
      }
    },
    chatConsoleCoordinator: {
      submit(payload) {
        coordinatorCalls.push(payload);
      }
    },
    teleportFeature: {
      handleTeleportRequest() {},
      handleTeleportHereRequest() {}
    },
    trustedPlayers: [],
    activityLogFeature: {
      logChatMessage(message) {
        activityLogs.push(message);
      }
    }
  });

  await feature.handleMessage('hello world');

  assert.deepEqual(consoleLogs, []);
  assert.equal(coordinatorCalls.length, 1);
  assert.equal(coordinatorCalls[0].message, '[CHAT] hello world');
  assert.equal(coordinatorCalls[0].level, 'info');
  assert.equal(coordinatorCalls[0].runtime.config.serverDir, 'my_server');
  assert.deepEqual(activityLogs, [
    'hello world'
  ]);
});

test('ChatFeature detaches message listener and bot reference', () => {
  const bot = new EventEmitter();
  let handled = 0;
  const feature = new ChatFeature({
    runtime: {
      createCommandContext() {
        return {};
      },
      async executeCommand() {}
    },
    teleportFeature: {
      handleTeleportRequest() {},
      handleTeleportHereRequest() {}
    }
  });

  feature.handleMessage = async () => {
    handled += 1;
  };

  feature.attach(bot);
  assert.equal(bot.listenerCount('message'), 1);
  assert.equal(feature.bot, bot);

  feature.detach();
  bot.emit('message', 'hello');

  assert.equal(bot.listenerCount('message'), 0);
  assert.equal(feature.bot, null);
  assert.equal(feature.messageHandler, null);
  assert.equal(handled, 0);
});
