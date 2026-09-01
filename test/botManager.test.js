const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BotManager } = require('../src/runtime/BotManager');

function createBotConfig(tempRoot) {
  return {
    id: 'alpha',
    enabled: true,
    autoStart: true,
    host: '127.0.0.1',
    port: 25565,
    auth: 'microsoft',
    version: false,
    username: 'alpha@example.com',
    email: 'alpha@example.com',
    viewDistance: 'tiny',
    disableChatSigning: true,
    restartOnDisconnect: true,
    restartDelayMs: 15000,
    paths: {
      accountDir: tempRoot,
      scriptsDir: tempRoot,
      lockHistoryPath: path.join(tempRoot, 'lock_history.txt')
    },
    legacyConfig: {
      trustedPlayers: [],
      autoRestart: 0,
      teleport: {
        mode: 'whitelist',
        whitelistFile: 'whitelist.txt'
      },
      logging: {},
      behavior: {
        whitelistReloadMinutes: 0
      },
      display: {},
      fish: false,
      ScriptScheduler: {
        Enabled: false,
        TaskList: []
      },
      attack: {
        autoAttack: false,
        attackRange: 3,
        attackInterval: 2000,
        targetFilter: {}
      },
      blockBreakDetection: {
        enabled: false,
        alertTrustedPlayers: [],
        monitoredBlocks: []
      },
      monitoring: {
        enabled: false,
        targetTypes: []
      },
      recording: {
        enabled: false
      }
    }
  };
}

function createManagedBotConfig(tempRoot, overrides = {}) {
  return {
    ...createBotConfig(tempRoot),
    id: overrides.id || 'server__bot',
    serverDir: overrides.serverDir || 'server',
    botDir: overrides.botDir || 'bot',
    accountDir: overrides.botDir || 'bot',
    paths: {
      ...createBotConfig(tempRoot).paths,
      botDir: path.join(tempRoot, overrides.serverDir || 'server', overrides.botDir || 'bot'),
      legacyConfigPath: path.join(tempRoot, overrides.serverDir || 'server', overrides.botDir || 'bot', 'config.json'),
      serverConfigPath: path.join(tempRoot, overrides.serverDir || 'server', 'server.json'),
      whitelistPath: path.join(tempRoot, overrides.serverDir || 'server', overrides.botDir || 'bot', 'whitelist.txt'),
      sourceType: 'multibot_bots'
    },
    ...overrides
  };
}

test('BotManager wires runtimes and delegates operations', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-manager-'));
  const manager = new BotManager({
    masterConfig: {
      bots: [createBotConfig(tempRoot)]
    },
    eventStream: {
      publish() {}
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete() {}
    }
  });

  const runtime = manager.getBot('alpha');
  const calls = [];
  assert.ok(runtime);
  assert.equal(runtime.broadcastService, manager.broadcastService);

  runtime.getSummary = () => ({ id: 'alpha', state: 'stopped' });
  runtime.getDetails = () => ({ id: 'alpha', state: 'online' });
  runtime.start = async () => {
    calls.push(['start']);
    return { id: 'alpha', state: 'starting' };
  };
  runtime.stop = async (reason) => {
    calls.push(['stop', reason]);
    return { id: 'alpha', state: 'stopped' };
  };
  runtime.restart = async (reason) => {
    calls.push(['restart', reason]);
    return { id: 'alpha', state: 'restarting' };
  };
  runtime.createCommandContext = (options) => {
    const messages = [];
    return {
      source: options.source,
      sender: options.sender,
      replyInfo(message) {
        messages.push({ mode: 'whisper', message });
      },
      replyError(message) {
        messages.push({ mode: 'tell', message });
      },
      getMessages() {
        return messages.slice();
      }
    };
  };
  runtime.executeCommand = async (command, context) => {
    calls.push(['executeCommand', command, context.source, context.sender]);
    context.replyInfo('ok');
    return true;
  };

  await manager.start();
  assert.deepEqual(manager.listBots(), [{ id: 'alpha', state: 'stopped' }]);
  assert.deepEqual(manager.getBotDetails('alpha'), { id: 'alpha', state: 'online' });
  assert.deepEqual(await manager.startBot('alpha'), { id: 'alpha', state: 'starting' });
  assert.deepEqual(await manager.stopBot('alpha', 'manual_stop'), { id: 'alpha', state: 'stopped' });
  assert.deepEqual(await manager.restartBot('alpha', 'manual_restart'), { id: 'alpha', state: 'restarting' });

  const commandResult = await manager.executeCommand('alpha', 'health', {
    source: 'http',
    sender: 'panel'
  });
  assert.equal(commandResult.handled, true);
  assert.deepEqual(commandResult.messages, [{ mode: 'whisper', message: 'ok' }]);
  assert.deepEqual(commandResult.bot, { id: 'alpha', state: 'online' });

  await manager.stop('shutdown');

  assert.deepEqual(calls, [
    ['start'],
    ['start'],
    ['stop', 'manual_stop'],
    ['restart', 'manual_restart'],
    ['executeCommand', 'health', 'http', 'panel'],
    ['stop', 'shutdown']
  ]);
});

test('BotManager grows logger buffer for console connector history', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-manager-history-'));

  const defaultManager = new BotManager({
    masterConfig: {
      bots: [createBotConfig(tempRoot)]
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete() {}
    }
  });

  const expandedManager = new BotManager({
    masterConfig: {
      bots: [createBotConfig(tempRoot)]
    },
    consoleConnectorConfig: {
      historyLimit: 800
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete() {}
    }
  });

  assert.equal(defaultManager.getBot('alpha').logger.buffer.limit, 500);
  assert.equal(expandedManager.getBot('alpha').logger.buffer.limit, 800);
});

test('BotManager gates memory diagnostics behind diagnostics.memoryDetails.enabled', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-manager-diagnostics-'));

  const disabledManager = new BotManager({
    masterConfig: {
      bots: [createBotConfig(tempRoot)],
      diagnostics: {
        memoryDetails: {
          enabled: false
        }
      }
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete() {}
    }
  });

  assert.equal(disabledManager.isMemoryDetailsEnabled(), false);
  assert.deepEqual(disabledManager.getBotDiagnostics(), []);
  assert.throws(() => disabledManager.getMemoryDiagnostics(), (error) => {
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /memory diagnostics disabled/);
    return true;
  });

  const enabledManager = new BotManager({
    masterConfig: {
      bots: [createBotConfig(tempRoot)],
      diagnostics: {
        memoryDetails: {
          enabled: true
        }
      }
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete() {}
    }
  });

  assert.equal(enabledManager.isMemoryDetailsEnabled(), true);
  assert.equal(enabledManager.getBot('alpha').isMemoryDetailsEnabled(), true);
  assert.equal(enabledManager.getBotDiagnostics().length, 1);
  assert.equal(enabledManager.getMemoryDiagnostics().botMemory.length, 1);
  assert.deepEqual(enabledManager.getMemoryDiagnostics().endedBotRefs, []);
});

test('BotManager returns 404-style errors for missing bots', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-manager-missing-'));
  const manager = new BotManager({
    masterConfig: {
      bots: [createBotConfig(tempRoot)]
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete() {}
    }
  });

  await assert.rejects(() => manager.startBot('missing'), (error) => {
    assert.equal(error.statusCode, 404);
    assert.match(error.message, /bot not found/);
    return true;
  });
});

test('BotManager interprets console-style input like the legacy console', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-manager-console-'));
  const manager = new BotManager({
    masterConfig: {
      bots: [createBotConfig(tempRoot)]
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete() {}
    }
  });

  const runtime = manager.getBot('alpha');
  const calls = [];

  runtime.getDetails = () => ({ id: 'alpha', state: 'online' });
  runtime.createCommandContext = (options) => {
    const messages = [];
    return {
      source: options.source,
      sender: options.sender,
      replyInfo(message) {
        messages.push({ mode: 'info', message });
      },
      replyError(message) {
        messages.push({ mode: 'error', message });
      },
      getMessages() {
        return messages.slice();
      }
    };
  };
  runtime.executeCommand = async (command, context) => {
    calls.push(['executeCommand', command, context.source, context.sender]);
    if (command === 'health') {
      context.replyInfo('ok');
      return true;
    }
    context.replyInfo(`鍛戒护鏈縼绉绘垨鏈瘑鍒? ${command}`);
    return false;
  };
  runtime.sendChat = (message) => {
    calls.push(['sendChat', message]);
  };
  runtime.stop = async (reason) => {
    calls.push(['stop', reason]);
    return { id: 'alpha', state: 'stopped' };
  };

  const commandResult = await manager.executeConsoleInput('alpha', '/health', {
    source: 'console',
    sender: 'panel'
  });
  const chatResult = await manager.executeConsoleInput('alpha', 'hello world', {
    source: 'console',
    sender: 'panel'
  });
  const fallbackResult = await manager.executeConsoleInput('alpha', '/say hi', {
    source: 'console',
    sender: 'panel'
  });
  const exitResult = await manager.executeConsoleInput('alpha', '/exit', {
    source: 'console',
    sender: 'panel'
  });

  assert.equal(commandResult.handled, true);
  assert.equal(commandResult.inputMode, 'command');
  assert.deepEqual(commandResult.messages, [{ mode: 'info', message: 'ok' }]);

  assert.equal(chatResult.handled, false);
  assert.equal(chatResult.inputMode, 'chat');
  assert.deepEqual(chatResult.messages, []);

  assert.equal(fallbackResult.handled, false);
  assert.equal(fallbackResult.inputMode, 'chat_fallback');
  assert.deepEqual(fallbackResult.messages, []);

  assert.equal(exitResult.handled, true);
  assert.equal(exitResult.inputMode, 'exit');
  assert.deepEqual(exitResult.messages, [{ mode: 'info', message: '正在停止该实例...' }]);
  assert.deepEqual(exitResult.bot, { id: 'alpha', state: 'stopped' });

  assert.deepEqual(calls, [
    ['executeCommand', 'health', 'console', 'panel'],
    ['sendChat', 'hello world'],
    ['executeCommand', 'say hi', 'console', 'panel'],
    ['sendChat', '/say hi'],
    ['stop', 'console_exit']
  ]);
});

test('BotManager can hot replace and remove discovered bot configs by instance', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-manager-instance-'));
  const manager = new BotManager({
    masterConfig: {
      bots: []
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete() {}
    }
  });

  await manager.addOrReplaceBotConfig(createManagedBotConfig(tempRoot, {
    id: 'server__bot',
    serverDir: 'server',
    botDir: 'bot'
  }));

  assert.ok(manager.getBot('server__bot'));
  assert.ok(manager.getBotByInstance('server', 'bot'));

  await manager.addOrReplaceBotConfig(createManagedBotConfig(tempRoot, {
    id: 'custom-id',
    serverDir: 'server',
    botDir: 'bot',
    username: 'custom@example.com',
    email: 'custom@example.com'
  }), {
    reason: 'test_replace'
  });

  assert.equal(manager.getBot('server__bot'), null);
  assert.ok(manager.getBot('custom-id'));
  assert.equal(manager.masterConfig.bots.length, 1);
  assert.equal(manager.masterConfig.bots[0].id, 'custom-id');

  await manager.removeBotByInstance('server', 'bot', 'test_remove');
  assert.equal(manager.getBotByInstance('server', 'bot'), null);
  assert.equal(manager.masterConfig.bots.length, 0);
});
