const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const mineflayer = require('mineflayer');
const {
  BotRuntime,
  normalizeUnsignedPlayerChatPacket,
  normalizeDisconnectText,
  classifyDisconnectReason,
  mergeDisconnectClass
} = require('../src/runtime/BotRuntime');

test('normalizeUnsignedPlayerChatPacket marks missing signatures without changing signed chat', () => {
  const unsigned = { plainMessage: 'bot lock' };
  const unsignedNbt = { plainMessage: 'bot lock' };
  const signed = { plainMessage: 'signed', signature: Buffer.from([1]) };
  const alreadyUnsigned = {
    plainMessage: 'unsigned',
    unsignedChatContent: JSON.stringify({ text: 'unsigned' })
  };

  assert.equal(normalizeUnsignedPlayerChatPacket(unsigned), true);
  assert.deepEqual(JSON.parse(unsigned.unsignedChatContent), { text: 'bot lock' });
  assert.equal(normalizeUnsignedPlayerChatPacket(unsignedNbt, { useNbtComponents: true }), true);
  assert.deepEqual(unsignedNbt.unsignedChatContent, {
    type: 'compound',
    value: {
      text: {
        type: 'string',
        value: 'bot lock'
      }
    }
  });
  assert.equal(normalizeUnsignedPlayerChatPacket(signed), false);
  assert.equal(normalizeUnsignedPlayerChatPacket(alreadyUnsigned), false);
});

test('BotRuntime installs the unsigned player chat guard before protocol listeners', () => {
  const runtime = createRuntime();
  const client = new EventEmitter();
  let protocolSawUnsigned = false;

  client.on('player_chat', (packet) => {
    protocolSawUnsigned = Boolean(packet.unsignedChatContent);
  });
  runtime.attachUnsignedPlayerChatGuard({
    _client: client,
    supportFeature(feature) {
      return feature === 'chatPacketsUseNbtComponents';
    }
  });

  const packet = { plainMessage: 'bot lock' };
  client.emit('player_chat', packet);

  assert.equal(protocolSawUnsigned, true);
  assert.equal(packet.unsignedChatContent.value.text.value, 'bot lock');
  runtime.detachRuntimeListeners();
});

function createRuntimeConfig(tempRoot, overrides = {}) {
  return {
    id: 'alpha',
    enabled: true,
    autoStart: false,
    host: '127.0.0.1',
    port: 25565,
    auth: 'microsoft',
    version: false,
    username: 'alpha@example.com',
    email: 'alpha@example.com',
    viewDistance: 'tiny',
    disableChatSigning: true,
    checkTimeoutInterval: 30000,
    restartOnDisconnect: true,
    restartDelayMs: 1234,
    restartJitterMs: 0,
    paths: {
      accountDir: tempRoot,
      scriptsDir: tempRoot,
      lockHistoryPath: path.join(tempRoot, 'lock_history.txt'),
      authCacheDir: path.join(tempRoot, 'auth-cache'),
      fallbackAuthCacheDir: path.join(tempRoot, 'nmp-cache')
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
      capabilities: {
        entityHandling: true,
        terrainHandling: true
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
    },
    ...overrides
  };
}

function createRuntime(overrides = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-runtime-'));
  return new BotRuntime({
    config: createRuntimeConfig(tempRoot, overrides.config || {}),
    eventStream: overrides.eventStream || {
      publish() {}
    },
    sessionService: overrides.sessionService || {
      load() { return null; },
      save() {},
      delete() {}
    },
    broadcastService: overrides.broadcastService || null,
    protocolGuardConfig: overrides.protocolGuardConfig || null,
    // 默认写进测试临时目录, 避免测试记录污染真实 logs/protocol-errors.log
    protocolErrorLogPath: overrides.protocolErrorLogPath
      || path.join(tempRoot, 'logs', 'protocol-errors.log'),
    diagnosticsConfig: overrides.diagnosticsConfig || null,
    barkNotifier: overrides.barkNotifier || null,
    restartPolicyOptions: overrides.restartPolicyOptions || null,
    openAuthResolver: overrides.openAuthResolver,
    openAuthClientFactory: overrides.openAuthClientFactory,
    socketConnect: overrides.socketConnect
  });
}

test('BotRuntime exposes action and restart state in summaries', () => {
  const runtime = createRuntime({
    config: {
      serverDir: 'server-a',
      botDir: 'alpha-account',
      legacyConfig: {
        trustedPlayers: [],
        autoRestart: 30,
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
    }
  });

  runtime.movementFeature.isCircling = true;
  runtime.movementFeature.isSneaking = true;
  runtime.fishFeature.isFishing = true;
  runtime.rideFeature.isRiding = true;
  runtime.digFeature.isDigging = true;
  runtime.digFeature.isAreaDigging = true;
  runtime.scriptFeature.activeScriptState = { scriptPath: 'demo.txt' };
  runtime.pendingRestartReason = 'disconnect';
  runtime.pendingRestartDelayMs = 2345;
  runtime.pendingRestartScheduledAt = '2025-01-01T00:00:30.000Z';
  runtime.legacyAutoRestartScheduledAt = '2025-01-01T00:00:00.000Z';

  const summary = runtime.getSummary();
  const details = runtime.getDetails();

  assert.equal(summary.serverDir, 'server-a');
  assert.equal(summary.botDir, 'alpha-account');
  assert.equal(details.serverDir, 'server-a');

  assert.deepEqual(summary.actions, {
    fishing: true,
    riding: true,
    circling: true,
    sneaking: true,
    digging: true,
    areaDigging: true,
    scriptRunning: true,
    autoEatEnabled: false,
    autoEating: false,
    treeFarming: false
  });
  assert.deepEqual(summary.capabilities, {
    entityHandling: true,
    terrainHandling: true,
    inventoryHandling: true
  });
  assert.equal(summary.restart.disconnectPolicyEnabled, true);
  assert.equal(summary.restart.disconnectDelayMs, 1234);
  assert.equal(summary.restart.disconnectJitterMs, 0);
  assert.equal(summary.restart.legacyAutoRestartMinutes, 30);
  assert.equal(summary.restart.pendingRestartReason, 'disconnect');
  assert.equal(summary.restart.pendingRestartDelayMs, 2345);
  assert.equal(summary.restart.pendingRestartScheduledAt, '2025-01-01T00:00:30.000Z');
  assert.equal(details.restart.legacyAutoRestartScheduledAt, '2025-01-01T00:00:00.000Z');
});

test('BotRuntime exposes disabled capabilities in summaries', () => {
  const runtime = createRuntime({
    config: {
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
        capabilities: {
          entityHandling: false,
          terrainHandling: true
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
    }
  });

  assert.deepEqual(runtime.getCapabilities(), {
    entityHandling: false,
    terrainHandling: true,
    inventoryHandling: true
  });
  assert.deepEqual(runtime.getSummary().capabilities, {
    entityHandling: false,
    terrainHandling: true,
    inventoryHandling: true
  });
});

test('BotRuntime reports lightweight memory diagnostics without serializing columns', () => {
  const runtime = createRuntime({
    diagnosticsConfig: {
      memoryDetails: {
        enabled: true
      }
    }
  });
  const columns = {
    '0,0': { shouldNotSerialize: true },
    '0,1': { shouldNotSerialize: true },
    '1,0': { shouldNotSerialize: true }
  };
  runtime.state = 'online';
  runtime.desiredRunning = true;
  runtime.bot = {
    username: 'alpha',
    world: {
      async: {
        columns
      }
    },
    entities: {
      1: {},
      2: {}
    },
    players: {
      alpha: {},
      beta: {}
    },
    pathfinder: {},
    physicsEnabled: true,
    _client: {
      ended: false,
      state: 'play',
      socket: {
        destroyed: false,
        bytesRead: 12345,
        bytesWritten: 6789
      }
    }
  };
  runtime.diagnostics.totalChunkPackets.mapChunk = 12;
  runtime.diagnostics.currentChunkPackets.mapChunk = 5;

  const diagnostics = runtime.getRuntimeDiagnostics();

  assert.equal(diagnostics.id, 'alpha');
  assert.equal(diagnostics.state, 'online');
  assert.equal(diagnostics.desiredRunning, true);
  assert.equal(diagnostics.hasBot, true);
  assert.equal(diagnostics.worldColumns, 3);
  assert.equal(diagnostics.entities, 2);
  assert.equal(diagnostics.players, 2);
  assert.equal(diagnostics.pathfinderLoaded, true);
  assert.equal(diagnostics.client.ended, false);
  assert.equal(diagnostics.client.bytesRead, 12345);
  assert.equal(diagnostics.client.bytesWritten, 6789);
  assert.equal(diagnostics.chunkPackets.total.mapChunk, 12);
  assert.equal(diagnostics.chunkPackets.currentConnection.mapChunk, 5);
  assert.equal(diagnostics.chunkPackets.maxWorldColumns, 3);
  assert.deepEqual(diagnostics.endedBotRefs, []);
});

test('BotRuntime skips packet diagnostics listeners when memory details are disabled', () => {
  const runtime = createRuntime();
  const listeners = [];
  runtime.attachRuntimeDiagnostics({
    _client: {
      on(packetName) {
        listeners.push(packetName);
      }
    }
  });

  assert.equal(runtime.isMemoryDetailsEnabled(), false);
  assert.deepEqual(listeners, []);
  assert.equal(runtime.diagnostics.connectionCount, 0);
});

test('BotRuntime detaches runtime diagnostics listeners', () => {
  const runtime = createRuntime({
    diagnosticsConfig: {
      memoryDetails: {
        enabled: true
      }
    }
  });
  const client = new EventEmitter();
  const bot = {
    _client: client
  };

  runtime.bot = {
    world: {
      async: {
        columns: {}
      }
    }
  };

  runtime.attachRuntimeDiagnostics(bot);
  assert.equal(client.listenerCount('map_chunk'), 1);

  client.emit('map_chunk');
  assert.equal(runtime.diagnostics.totalChunkPackets.mapChunk, 1);

  runtime.detachRuntimeListeners();
  client.emit('map_chunk');

  assert.equal(client.listenerCount('map_chunk'), 0);
  assert.equal(runtime.diagnostics.totalChunkPackets.mapChunk, 1);
});

test('BotRuntime releases ended bot world caches after recording diagnostics', async () => {
  const runtime = createRuntime({
    diagnosticsConfig: {
      memoryDetails: {
        enabled: true
      }
    }
  });
  const bot = {
    world: {
      async: {
        columns: {
          a: {},
          b: {}
        }
      }
    },
    entities: {
      1: {}
    },
    players: {
      alpha: {}
    },
    _client: {
      state: 'play'
    }
  };

  runtime.bot = bot;
  runtime.lastEndAt = '2026-06-02T00:00:00.000Z';
  runtime.rememberEndedBotForDiagnostics(bot, 'end');
  await runtime.finalizeEndedBot(bot, 'end');

  const endedDiagnostics = runtime.getEndedBotRefDiagnostics()[0];
  assert.equal(endedDiagnostics.columnsAtEnd, 2);
  assert.deepEqual(endedDiagnostics.retained, {
    columns: 0,
    entities: 0,
    players: 0
  });
  assert.deepEqual(bot.world.async.columns, {});
  assert.deepEqual(bot.entities, {});
  assert.deepEqual(bot.players, {});
  assert.equal(runtime.bot, null);
  assert.equal(runtime.state, 'stopped');
});

test('BotRuntime records weak references for ended bot diagnostics', () => {
  const runtime = createRuntime({
    diagnosticsConfig: {
      memoryDetails: {
        enabled: true
      }
    }
  });
  const columns = {
    '0,0': {},
    '1,0': {}
  };
  const bot = {
    username: 'alpha',
    world: {
      async: {
        columns
      }
    },
    entities: {
      1: {}
    },
    players: {
      alpha: {}
    },
    _client: {
      state: 'play'
    }
  };

  runtime.lastEndAt = '2026-05-31T05:00:00.000Z';
  runtime.diagnostics.connectionCount = 3;
  runtime.diagnostics.currentConnectionStartedAt = '2026-05-31T04:55:00.000Z';
  runtime.rememberEndedBotForDiagnostics(bot, 'test_end');

  const endedRefs = runtime.getEndedBotRefDiagnostics();

  assert.equal(endedRefs.length, 1);
  assert.equal(endedRefs[0].id, 'alpha');
  assert.equal(endedRefs[0].reason, 'test_end');
  assert.equal(endedRefs[0].endedAt, '2026-05-31T05:00:00.000Z');
  assert.equal(endedRefs[0].connectionCount, 3);
  assert.equal(endedRefs[0].columnsAtEnd, 2);
  assert.equal(endedRefs[0].entitiesAtEnd, 1);
  assert.equal(endedRefs[0].playersAtEnd, 1);
  assert.deepEqual(endedRefs[0].alive, {
    bot: true,
    world: true,
    columns: true,
    entities: true,
    players: true,
    client: true
  });
  assert.deepEqual(endedRefs[0].retained, {
    columns: 2,
    entities: 1,
    players: 1
  });
});

test('BotRuntime schedules and clears legacy auto restart timer', async () => {
  const runtime = createRuntime();
  const reasons = [];
  runtime.legacyAutoRestartMinutes = 0.0002;
  runtime.restart = async (reason) => {
    reasons.push(reason);
  };

  runtime.scheduleLegacyAutoRestart();
  assert.ok(runtime.legacyAutoRestartTimer);
  assert.ok(runtime.legacyAutoRestartScheduledAt);

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(reasons, ['legacy_auto_restart']);
  assert.equal(runtime.legacyAutoRestartTimer, null);
  assert.equal(runtime.legacyAutoRestartScheduledAt, null);
});

test('BotRuntime stop clears legacy auto restart timer without a live bot', async () => {
  const runtime = createRuntime();
  runtime.legacyAutoRestartMinutes = 1;
  runtime.scheduleLegacyAutoRestart();

  assert.ok(runtime.legacyAutoRestartTimer);
  await runtime.stop('manual_stop');
  assert.equal(runtime.legacyAutoRestartTimer, null);
  assert.equal(runtime.state, 'stopped');
});

test('BotRuntime randomizes scheduled restart delay for disconnects', async () => {
  const runtime = createRuntime({
    config: {
      restartDelayMs: 15000,
      restartJitterMs: 30000
    },
    restartPolicyOptions: {
      randomProvider: () => 0.5
    }
  });

  runtime.state = 'online';
  runtime.desiredRunning = true;
  await runtime.handleEnd();

  const expectedJitterMs = Math.floor(0.5 * (30000 + 1));
  const expectedTotalDelayMs = 15000 + expectedJitterMs;
  const restartState = runtime.getRestartState();
  const logs = runtime.logger.getRecent();
  const restartLog = logs.find((entry) => entry.message.includes('[BOT] scheduled restart reason=disconnect'));

  assert.equal(runtime.state, 'waiting_restart');
  assert.equal(restartState.disconnectDelayMs, 15000);
  assert.equal(restartState.disconnectJitterMs, 30000);
  assert.equal(restartState.pendingRestartReason, 'disconnect');
  assert.equal(restartState.pendingRestartDelayMs, expectedTotalDelayMs);
  assert.ok(restartState.pendingRestartScheduledAt);
  assert.ok(restartLog);
  assert.match(restartLog.message, /baseDelayMs=15000/);
  assert.match(restartLog.message, new RegExp(`jitterMs=${expectedJitterMs}`));
  assert.match(restartLog.message, new RegExp(`totalDelayMs=${expectedTotalDelayMs}`));

  runtime.clearRestartTimer();
});

test('BotRuntime does not randomize non-disconnect restart reasons and clears pending restart state', () => {
  const runtime = createRuntime({
    config: {
      restartDelayMs: 15000,
      restartJitterMs: 30000
    },
    restartPolicyOptions: {
      randomProvider: () => 0.999999
    }
  });

  runtime.scheduleRestart('invalid_session_retry', 1000);

  const restartState = runtime.getRestartState();
  const logs = runtime.logger.getRecent();
  const restartLog = logs.find((entry) => entry.message.includes('[BOT] scheduled restart reason=invalid_session_retry'));

  assert.equal(runtime.state, 'waiting_restart');
  assert.equal(restartState.pendingRestartReason, 'invalid_session_retry');
  assert.equal(restartState.pendingRestartDelayMs, 1000);
  assert.ok(restartState.pendingRestartScheduledAt);
  assert.ok(restartLog);
  assert.match(restartLog.message, /baseDelayMs=1000/);
  assert.match(restartLog.message, /jitterMs=0/);
  assert.match(restartLog.message, /totalDelayMs=1000/);

  runtime.clearRestartTimer();
  const clearedRestartState = runtime.getRestartState();
  assert.equal(clearedRestartState.pendingRestartDelayMs, null);
  assert.equal(clearedRestartState.pendingRestartScheduledAt, null);
});

test('BotRuntime records MSA device code prompts in bot logs', () => {
  const runtime = createRuntime();
  runtime.pendingAuthState = {
    usedCachedSession: false,
    deviceCodeIssued: false
  };

  const options = runtime.createMineflayerOptions(null);
  options.onMsaCode({
    message: 'To sign in, use a web browser to open the page https://www.microsoft.com/link and use the code 12345678'
  });

  const logs = runtime.logger.getRecent();
  assert.equal(runtime.pendingAuthState.deviceCodeIssued, true);
  assert.equal(logs.length, 2);
  assert.equal(typeof options.profilesFolder, 'function');
  assert.match(logs[0].message, /\[msa\] First time signing in\. Please authenticate now:/);
  assert.match(logs[1].message, /https:\/\/www\.microsoft\.com\/link/);
});

test('BotRuntime passes keepalive timeout interval to mineflayer options', () => {
  const runtime = createRuntime({
    config: {
      checkTimeoutInterval: 120000
    }
  });

  const options = runtime.createMineflayerOptions(null);

  assert.equal(options.checkTimeoutInterval, 120000);
});

test('BotRuntime pins OpenAuth TCP connections while preserving the configured handshake host', () => {
  const connectCalls = [];
  const socket = {};
  const runtime = createRuntime({
    config: {
      host: 'viaproxy.local',
      port: 25568,
      auth: 'microsoft',
      version: '1.21.11',
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    },
    socketConnect(options) {
      connectCalls.push(options);
      return socket;
    }
  });
  const assignedSockets = [];
  const options = runtime.createMineflayerOptions(null, {
    address: '127.0.0.42',
    family: 4
  });

  options.connect({
    setSocket(value) {
      assignedSockets.push(value);
    }
  });

  assert.equal(options.host, 'viaproxy.local');
  assert.equal(options.port, 25568);
  assert.deepEqual(connectCalls, [{
    host: '127.0.0.42',
    port: 25568,
    family: 4
  }]);
  assert.deepEqual(assignedSockets, [socket]);
});

test('BotRuntime leaves the default minecraft-protocol connector in place when OpenAuth is disabled', () => {
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: false,
        requestTimeoutMs: 4500
      }
    }
  });

  const options = runtime.createMineflayerOptions(null);

  assert.equal(Object.hasOwn(options, 'connect'), false);
});

test('BotRuntime fails closed when an OpenAuth proxy host is not local', async () => {
  const error = Object.assign(new Error('PROXY_NOT_LOOPBACK'), {
    code: 'PROXY_NOT_LOOPBACK'
  });
  const runtime = createRuntime({
    config: {
      host: 'viaproxy.example',
      port: 25568,
      auth: 'microsoft',
      version: '1.21.11',
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    },
    openAuthResolver: async () => {
      throw error;
    }
  });

  await assert.rejects(() => runtime.start(), /PROXY_NOT_LOOPBACK/);

  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.desiredRunning, false);
  assert.equal(runtime.restartTimer, null);
  assert.equal(runtime.lastError, 'OpenAuth PROXY_NOT_LOOPBACK');
  assert.ok(runtime.logger.getRecent().some((entry) => {
    return entry.message.includes('[AUTH][OpenAuth] stopped code=PROXY_NOT_LOOPBACK');
  }));
});

test('BotRuntime does not connect when stopped during OpenAuth DNS validation', async () => {
  let resolveLookup;
  const runtime = createRuntime({
    config: {
      host: 'viaproxy.local',
      port: 25568,
      auth: 'microsoft',
      version: '1.21.11',
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    },
    openAuthResolver: () => new Promise((resolve) => {
      resolveLookup = resolve;
    })
  });

  const startPromise = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.stop('manual_stop');
  resolveLookup({ address: '127.0.0.1', family: 4 });
  await startPromise;

  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.desiredRunning, false);
  assert.equal(runtime.bot, null);
});

test('BotRuntime rejects a non-loopback socket after OpenAuth connects', async () => {
  const quitReasons = [];
  const client = {
    socket: {
      remoteAddress: '192.168.1.25'
    }
  };
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    }
  });
  runtime.desiredRunning = true;
  runtime.bot = {
    _client: client,
    quit(reason) {
      quitReasons.push(reason);
    }
  };

  runtime.startOpenAuthRequestWatchdog(client);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.desiredRunning, false);
  assert.equal(runtime.lastError, 'OpenAuth PROXY_NOT_LOOPBACK');
  assert.deepEqual(quitReasons, ['openauth_proxy_not_loopback']);
});

test('BotRuntime refreshes invalid OpenAuth sessions after one second', () => {
  const deleted = [];
  const quitReasons = [];
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete(email) { deleted.push(email); }
    }
  });
  const sourceClient = {};
  runtime.openAuthClient = sourceClient;
  runtime.lastError = 'OpenAuth OPENAUTH_REQUEST_MISSING';
  runtime.bot = {
    quit(reason) {
      quitReasons.push(reason);
    }
  };

  runtime.handleOpenAuthFailure({
    code: 'MOJANG_SESSION_INVALID',
    retryClass: 'reauth',
    sessionInvalid: true
  }, sourceClient);

  assert.deepEqual(deleted, ['alpha@example.com']);
  assert.deepEqual(quitReasons, ['invalid_session_retry']);
  assert.equal(runtime.pendingRestartReason, 'invalid_session_retry');
  assert.equal(runtime.pendingRestartDelayOverrideMs, 1000);
  assert.equal(runtime.desiredRunning, true);
  assert.equal(runtime.lastError, 'OpenAuth MOJANG_SESSION_INVALID');
});

test('BotRuntime clears the OpenAuth request watchdog as soon as a request arrives', () => {
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    }
  });
  runtime.openAuthRequestWatchdogTimer = setTimeout(() => {}, 60000);

  runtime.markOpenAuthRequestSeen();

  assert.equal(runtime.openAuthRequestSeen, true);
  assert.equal(runtime.openAuthRequestWatchdogTimer, null);
});

test('BotRuntime permanently stops on a missing OpenAuth request during initial startup', () => {
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    }
  });
  const client = {};
  runtime.bot = { _client: client };
  runtime.desiredRunning = true;

  runtime.handleOpenAuthRequestWatchdogTimeout(client, { quit: false });

  assert.equal(runtime.openAuthPermanentFailure, true);
  assert.equal(runtime.desiredRunning, false);
  assert.equal(runtime.pendingRestartReason, null);
  assert.equal(runtime.lastError, 'OpenAuth OPENAUTH_REQUEST_MISSING');
});

test('BotRuntime retries a missing OpenAuth request after a previously successful scheduled reconnect', () => {
  const quitReasons = [];
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    }
  });
  const client = {};
  runtime.bot = {
    _client: client,
    quit(reason) {
      quitReasons.push(reason);
    }
  };
  runtime.spawnCount = 1;
  runtime.openAuthRequestMissingRetryEligible = true;
  runtime.desiredRunning = true;

  runtime.handleOpenAuthRequestWatchdogTimeout(client);

  assert.deepEqual(quitReasons, ['openauth_request_missing']);
  assert.equal(runtime.openAuthPermanentFailure, false);
  assert.equal(runtime.desiredRunning, true);
  assert.equal(runtime.pendingRestartReason, 'openauth_request_missing');
  assert.equal(runtime.lastError, 'OpenAuth OPENAUTH_REQUEST_MISSING');
});

test('BotRuntime ignores a missing-request watchdog from an older OpenAuth connection', () => {
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    }
  });
  const currentClient = {};
  runtime.bot = { _client: currentClient };
  runtime.openAuthRequestMissingRetryEligible = true;
  runtime.desiredRunning = true;

  runtime.handleOpenAuthRequestWatchdogTimeout({});

  assert.equal(runtime.openAuthPermanentFailure, false);
  assert.equal(runtime.pendingRestartReason, null);
  assert.equal(runtime.lastError, null);
});

test('BotRuntime does not retry a missing OpenAuth request when disconnect restarts are disabled', () => {
  const runtime = createRuntime({
    config: {
      restartOnDisconnect: false,
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    }
  });
  const client = {};
  runtime.bot = { _client: client };
  runtime.spawnCount = 1;
  runtime.openAuthRequestMissingRetryEligible = true;
  runtime.desiredRunning = true;

  runtime.handleOpenAuthRequestWatchdogTimeout(client, { quit: false });

  assert.equal(runtime.openAuthPermanentFailure, true);
  assert.equal(runtime.desiredRunning, false);
  assert.equal(runtime.pendingRestartReason, null);
});

test('BotRuntime ignores late OpenAuth failures after a permanent stop', () => {
  const deleted = [];
  const quitReasons = [];
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete(email) { deleted.push(email); }
    }
  });
  const sourceClient = {};
  runtime.openAuthClient = sourceClient;
  runtime.openAuthPermanentFailure = true;
  runtime.desiredRunning = false;
  runtime.bot = {
    quit(reason) {
      quitReasons.push(reason);
    }
  };

  runtime.handleOpenAuthFailure({
    code: 'MOJANG_SESSION_INVALID',
    retryClass: 'reauth',
    sessionInvalid: true
  }, sourceClient);

  assert.deepEqual(deleted, []);
  assert.deepEqual(quitReasons, []);
  assert.equal(runtime.desiredRunning, false);
  assert.equal(runtime.pendingRestartReason, null);
});

test('BotRuntime stops without reconnecting when a connection ends before OpenAuth is requested', async () => {
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    }
  });
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.openAuthRequestSeen = false;

  await runtime.handleEnd();

  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.desiredRunning, false);
  assert.equal(runtime.restartTimer, null);
  assert.equal(runtime.lastError, 'OpenAuth OPENAUTH_REQUEST_MISSING');
});

test('BotRuntime preserves cached-session refresh when OpenAuth ends before its first request', async () => {
  const deleted = [];
  const quitReasons = [];
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    },
    sessionService: {
      load() { return null; },
      save() {},
      delete(email) {
        deleted.push(email);
        return true;
      }
    }
  });
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.bot = {
    quit(reason) {
      quitReasons.push(reason);
    }
  };

  runtime.handleError(new Error('ForbiddenOperationException'));
  await runtime.handleEnd();

  assert.deepEqual(deleted, ['alpha@example.com']);
  assert.deepEqual(quitReasons, ['invalid_session_retry']);
  assert.equal(runtime.openAuthPermanentFailure, false);
  assert.equal(runtime.desiredRunning, true);
  assert.equal(runtime.state, 'waiting_restart');
  assert.equal(runtime.pendingRestartReason, 'invalid_session_retry');
  assert.equal(runtime.pendingRestartDelayMs, 1000);
  assert.equal(runtime.lastError, 'ForbiddenOperationException');
  assert.ok(runtime.logger.getRecent().some((entry) => {
    return entry.message.includes('scheduling credential refresh sessionDeleted=true');
  }));

  runtime.clearRestartTimer();
});

test('BotRuntime retries with cached session kept on Xbox rate limit', async () => {
  const deleted = [];
  const quitReasons = [];
  const runtime = createRuntime({
    sessionService: {
      load() { return null; },
      save() {},
      delete(email) {
        deleted.push(email);
        return true;
      }
    }
  });
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.bot = {
    quit(reason) {
      quitReasons.push(reason);
    }
  };

  runtime.handleError(new Error('429 Too Many Requests {\n"path" : "/authentication/login_with_xbox"\n}'));
  await runtime.handleEnd();

  assert.deepEqual(deleted, []);
  assert.deepEqual(quitReasons, ['retryable_error']);
  assert.equal(runtime.desiredRunning, true);
  assert.equal(runtime.state, 'waiting_restart');
  assert.equal(runtime.pendingRestartReason, 'retryable_error');
  assert.equal(runtime.pendingRestartDelayMs, 1234);
  assert.ok(runtime.lastError.includes('429 Too Many Requests'));
  assert.ok(runtime.lastError.includes('/authentication/login_with_xbox'));

  runtime.clearRestartTimer();
});

test('BotRuntime disposes OpenAuth work when stopped without a live bot', async () => {
  let disposeCount = 0;
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    }
  });
  runtime.openAuthClient = {
    dispose() {
      disposeCount += 1;
    }
  };

  await runtime.stop('manual_stop');

  assert.equal(disposeCount, 1);
  assert.equal(runtime.openAuthClient, null);
});

test('BotRuntime records synchronous startup failures in bot logs', async () => {
  const originalCreateBot = mineflayer.createBot;
  const events = [];
  const runtime = createRuntime({
    eventStream: {
      publish(event, data) {
        events.push({ event, data });
      }
    }
  });

  mineflayer.createBot = () => {
    throw new Error('createBot failed');
  };

  try {
    await assert.rejects(() => runtime.start(), /createBot failed/);
  } finally {
    mineflayer.createBot = originalCreateBot;
  }

  const logs = runtime.logger.getRecent();
  assert.equal(runtime.state, 'waiting_restart');
  assert.equal(runtime.desiredRunning, true);
  assert.equal(runtime.pendingRestartReason, 'retryable_error');
  assert.equal(runtime.pendingRestartDelayMs, 1234);
  assert.equal(runtime.lastError, 'createBot failed');
  assert.ok(logs.some((entry) => entry.botId === 'alpha' && entry.message.includes('[BOT] startup failed')));
  assert.ok(events.some((entry) => entry.event === 'botStatus' && entry.data.state === 'stopped'));
  assert.ok(events.some((entry) => entry.event === 'botStatus' && entry.data.state === 'waiting_restart'));
  runtime.clearRestartTimer();
});

test('BotRuntime summarizes kick and error failures for status output', () => {
  const runtime = createRuntime();

  runtime.handleError(new Error('ForbiddenOperationException'));
  runtime.lastKick = 'Connection throttled! Please wait before reconnecting.';
  runtime.refreshFailureState();

  const summary = runtime.getSummary();

  assert.equal(summary.lastError, 'ForbiddenOperationException');
  assert.equal(summary.lastKick, 'Connection throttled! Please wait before reconnecting.');
  assert.match(summary.lastFailure, /kick: Connection throttled!/);
  assert.match(summary.lastFailure, /error: ForbiddenOperationException/);
  assert.ok(summary.lastFailureAt);

  runtime.clearRestartTimer();
});

test('BotRuntime failure and restart timestamps use local offset form (no UTC Z)', () => {
  const runtime = createRuntime();

  runtime.handleError(new Error('ForbiddenOperationException'));
  runtime.refreshFailureState();

  const offsetForm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;
  assert.match(runtime.lastFailureAt, offsetForm);
  assert.equal(runtime.lastFailureAt.endsWith('Z'), false);

  runtime.scheduleRestart('retryable_error', 1000);
  assert.match(runtime.pendingRestartScheduledAt, offsetForm);
  assert.equal(runtime.pendingRestartScheduledAt.endsWith('Z'), false);

  runtime.clearRestartTimer();
});

test('BotRuntime denies resource packs by default', () => {
  const runtime = createRuntime();
  const writes = [];

  runtime.handleResourcePack({
    _client: {
      write(name, payload) {
        writes.push({ name, payload });
      }
    }
  }, 'https://example.com/pack.zip', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

  assert.deepEqual(writes, [
    {
      name: 'resource_pack_receive',
      payload: {
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        result: 1
      }
    }
  ]);
});

test('BotRuntime getPingText reports server-measured latency', () => {
  const runtime = createRuntime();
  runtime.bot = {
    username: 'alpha',
    player: { ping: 42 }
  };
  assert.equal(runtime.getPingText(), 'Ping: 42ms');
});

test('BotRuntime getPingText falls back to players map and handles missing ping', () => {
  const runtime = createRuntime();
  runtime.bot = {
    username: 'alpha',
    players: { alpha: { ping: 17 } }
  };
  assert.equal(runtime.getPingText(), 'Ping: 17ms');

  runtime.bot = { username: 'alpha', player: {} };
  assert.equal(runtime.getPingText(), '暂无延迟数据');

  runtime.bot = null;
  assert.equal(runtime.getPingText(), '机器人尚未连接');
});

test('BotRuntime getPingText prefers measured RTT over player_info latency', () => {
  const runtime = createRuntime();
  runtime.bot = { username: 'alpha', player: { ping: 42 } };
  runtime.latencyMs = 87;
  assert.equal(runtime.getPingText(), 'Ping: 87ms');
});

test('BotRuntime handles ping_response and computes RTT', () => {
  const runtime = createRuntime();
  const sentAt = Date.now() - 50;
  runtime.pendingPingId = sentAt;
  runtime.handlePingResponse({ id: sentAt });
  assert.ok(Math.abs(runtime.latencyMs - 50) < 5);
  assert.equal(runtime.pendingPingId, null);
});

test('BotRuntime ignores stale ping_response', () => {
  const runtime = createRuntime();
  runtime.pendingPingId = 12345;
  runtime.handlePingResponse({ id: 99999 });
  assert.equal(runtime.latencyMs, null);
  assert.equal(runtime.pendingPingId, 12345);
});

test('BotRuntime measurePing sends one ping_request and resolves on pong', async () => {
  const runtime = createRuntime();
  const writes = [];
  runtime.bot = {
    _client: {
      state: 'play',
      write(name, payload) {
        writes.push({ name, payload });
      }
    }
  };
  const promise = runtime.measurePing();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'ping_request');
  const sentId = Number(writes[0].payload.id);
  assert.ok(Number.isInteger(sentId) && sentId > 0);

  setTimeout(() => runtime.handlePingResponse({ id: sentId }), 5);
  const result = await promise;
  assert.equal(result.ok, true);
  assert.match(result.text, /^Ping: \d+ms$/);
  assert.equal(runtime.pendingPingId, null);
});

test('BotRuntime measurePing reports not connected without a bot or outside play', async () => {
  const runtime = createRuntime();
  runtime.bot = null;
  let result = await runtime.measurePing();
  assert.equal(result.ok, false);
  assert.equal(result.text, '机器人尚未连接');

  runtime.bot = { _client: { state: 'login' } };
  result = await runtime.measurePing();
  assert.equal(result.ok, false);
  assert.equal(result.text, '机器人尚未连接');
});

test('BotRuntime measurePing falls back to cached latency on timeout', async () => {
  const runtime = createRuntime();
  runtime.bot = {
    _client: {
      state: 'play',
      write() {}
    }
  };
  runtime.latencyMs = 88;
  const result = await runtime.measurePing(200);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Ping: 88ms（缓存）');
  assert.equal(runtime.pendingPingId, null);
});

test('BotRuntime applyPhysicsStandby is a no-op when standby disabled', () => {
  const runtime = createRuntime();
  runtime.bot = { physicsEnabled: true };
  runtime.applyPhysicsStandby(false);
  runtime.applyPhysicsStandby(true);
  assert.equal(runtime.bot.physicsEnabled, true);
});

test('BotRuntime applyPhysicsStandby controls physics when enabled', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: {
        trustedPlayers: [],
        autoRestart: 0,
        teleport: { mode: 'whitelist', whitelistFile: 'whitelist.txt' },
        logging: {},
        behavior: { physicsStandby: true },
        display: {},
        fish: false,
        ScriptScheduler: { Enabled: false, TaskList: [] },
        attack: { autoAttack: false, attackRange: 3, attackInterval: 2000, targetFilter: {} },
        blockBreakDetection: { enabled: false, alertTrustedPlayers: [], monitoredBlocks: [] },
        monitoring: { enabled: false, targetTypes: [] },
        recording: { enabled: false }
      }
    }
  });
  runtime.bot = { physicsEnabled: true };
  runtime.applyPhysicsStandby(false);
  assert.equal(runtime.bot.physicsEnabled, false);
  runtime.applyPhysicsStandby(true);
  assert.equal(runtime.bot.physicsEnabled, true);
});

function makeLegacyConfig(capabilities) {
  return {
    trustedPlayers: [],
    autoRestart: 0,
    teleport: { mode: 'whitelist', whitelistFile: 'whitelist.txt' },
    logging: {},
    behavior: {},
    capabilities,
    display: {},
    fish: false,
    ScriptScheduler: { Enabled: false, TaskList: [] },
    attack: { autoAttack: false, attackRange: 3, attackInterval: 2000, targetFilter: {} },
    blockBreakDetection: { enabled: false, alertTrustedPlayers: [], monitoredBlocks: [] },
    monitoring: { enabled: false, targetTypes: [] },
    recording: { enabled: false }
  };
}

test('BotRuntime isLightweightMode only when both capabilities are disabled', () => {
  const full = createRuntime({ config: { legacyConfig: makeLegacyConfig({ entityHandling: true, terrainHandling: true }) } });
  assert.equal(full.isLightweightMode(), false);

  const noEntity = createRuntime({ config: { legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: true }) } });
  assert.equal(noEntity.isLightweightMode(), false);

  const noTerrain = createRuntime({ config: { legacyConfig: makeLegacyConfig({ entityHandling: true, terrainHandling: false }) } });
  assert.equal(noTerrain.isLightweightMode(), false);

  const light = createRuntime({ config: { legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false }) } });
  assert.equal(light.isLightweightMode(), true);
});

test('BotRuntime isInventoryHandlingEnabled defaults on and honors explicit disable', () => {
  const on = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });
  assert.equal(on.isInventoryHandlingEnabled(), true);

  const off = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({
        entityHandling: false,
        terrainHandling: false,
        inventoryHandling: false
      })
    }
  });
  assert.equal(off.isInventoryHandlingEnabled(), false);
});

test('BotRuntime attachLightInventoryCore mounts zero-entity inventory on lightweight bot', () => {
  const registry = require('prismarine-registry')('1.21.11');
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });
  const writes = [];
  const client = new EventEmitter();
  client.write = (name, payload) => {
    writes.push({ name, payload });
  };
  const bot = {
    _client: client,
    registry,
    version: '1.21.11'
  };

  runtime.attachLightInventoryCore(bot);

  assert.ok(bot.inventory, 'bot.inventory mounted');
  assert.equal(bot.inventory.id, 0);
  assert.equal(typeof bot.clickWindow, 'function');
  assert.equal(typeof bot.toss, 'function');
  assert.equal(typeof bot.moveSlotItem, 'function');
  assert.equal(typeof bot.setQuickBarSlot, 'function');
  runtime.detachRuntimeListeners();
});

test('BotRuntime attachLightweightFeatures mounts inventory and window features', () => {
  const registry = require('prismarine-registry')('1.21.11');
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });
  const writes = [];
  const client = new EventEmitter();
  client.write = (name, payload) => {
    writes.push({ name, payload });
  };
  const bot = new EventEmitter();
  bot._client = client;
  bot.registry = registry;
  bot.version = '1.21.11';

  runtime.attachLightweightFeatures(bot);

  assert.ok(bot.inventory, 'bot.inventory mounted');
  assert.equal(runtime.windowFeature.bot, bot, 'WindowFeature 在轻量模式也挂载');
  assert.equal(runtime.inventoryFeature.bot, bot);

  // 服务器打开的菜单窗口: 面板取到的快照应与普通模式一致(带标题与容器槽位)
  client.emit('open_window', { windowId: 6, inventoryType: 2, windowTitle: { text: '商店' }, stateId: 1 });
  const items = Array.from({ length: 63 }, () => ({ present: false }));
  client.emit('window_items', { windowId: 6, items, stateId: 2 });

  const snapshot = runtime.getWindowSnapshot();
  assert.ok(snapshot, 'lightweight snapshot exists');
  assert.equal(snapshot.id, 6);
  assert.equal(snapshot.name, 'chest');
  assert.equal(snapshot.title, '商店');
  assert.equal(snapshot.inventoryStart, 27);

  runtime.detachFeaturesFromBot();
  runtime.detachRuntimeListeners();
});

test('BotRuntime attachUnsignedChatWindowGuard neutralizes the lastSeen window without profile keys', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });

  const writes = [];
  const client = new EventEmitter();
  client.profileKeys = null; // 无签名密钥(disableChatSigning 生效)
  client.write = (name, params) => {
    writes.push({ name, params });
  };
  const bot = { _client: client, version: '1.21.11' };

  runtime.attachUnsignedChatWindowGuard(bot);

  // 上游上报窗口(可能与服务端漂移) => 被改写成恒定空更新
  client.write('chat_message', {
    message: 'hi',
    timestamp: 1n,
    salt: 2n,
    signature: undefined,
    offset: 7,
    acknowledged: Buffer.from([0xff, 0xff, 0xff]),
    checksum: 42
  });

  const chatWrite = writes.find((entry) => entry.name === 'chat_message');
  assert.ok(chatWrite, 'chat_message 仍被写出');
  assert.equal(chatWrite.params.offset, 0);
  assert.deepEqual(chatWrite.params.acknowledged, Buffer.from([0, 0, 0]));
  assert.equal(chatWrite.params.checksum, 0, '0 = 原版 IGNORE_CHECKSUM');
  assert.equal(chatWrite.params.message, 'hi', '其余字段不动');

  // 已签名命令包走同一个窗口字段(名为 messageCount)
  client.write('chat_command_signed', {
    command: 'list',
    timestamp: 1n,
    salt: 2n,
    argumentSignatures: [],
    messageCount: 5,
    acknowledged: Buffer.from([0xff, 0xff, 0xff]),
    checksum: 9
  });
  const commandWrite = writes.find((entry) => entry.name === 'chat_command_signed');
  assert.equal(commandWrite.params.messageCount, 0);
  assert.deepEqual(commandWrite.params.acknowledged, Buffer.from([0, 0, 0]));
  assert.equal(commandWrite.params.checksum, 0);

  // 关键回归: 禁用签名时, 即使 client.profileKeys 仍存在(实测如此), 也必须归一到空更新,
  // 否则会放行上游"新消息插 index 0"的错位窗口 => 服务端踢出或静默断开
  client.profileKeys = { private: Buffer.alloc(1) };
  client.write('chat_message', { message: 'x', offset: 23, acknowledged: Buffer.from([0xff, 0xff, 0xf0]), checksum: 182 });
  const signedWrite = writes.filter((entry) => entry.name === 'chat_message').pop();
  assert.equal(signedWrite.params.offset, 0, '偏移必须归零');
  assert.deepEqual(signedWrite.params.acknowledged, Buffer.from([0, 0, 0]), '位图必须清空');
  assert.equal(signedWrite.params.checksum, 0);
  const overrideLogs = runtime.logger.getRecent().filter((entry) => entry.message.includes('非空 lastSeen 窗口'));
  assert.equal(overrideLogs.length, 1, '首次覆盖非空窗口只告警一次');

  // 其它包不受影响
  client.write('keep_alive', { keepAliveId: 1n });
  assert.equal(writes.filter((entry) => entry.name === 'keep_alive').length, 1);

  // 解绑后恢复原始 write
  runtime.detachRuntimeListeners();
  client.profileKeys = null;
  client.write('chat_message', { message: 'after', offset: 4, acknowledged: Buffer.from([9]), checksum: 9 });
  const restored = writes.filter((entry) => entry.name === 'chat_message').pop();
  assert.equal(restored.params.offset, 4, '解绑后不再改写');
});

test('BotRuntime attachUnsignedChatWindowGuard leaves the window alone when signing is enabled', () => {
  const runtime = createRuntime({
    config: {
      disableChatSigning: false,
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });

  const writes = [];
  const client = new EventEmitter();
  client.profileKeys = { private: Buffer.alloc(1) };
  client.write = (name, params) => {
    writes.push({ name, params });
  };
  const bot = { _client: client, version: '1.21.11' };

  runtime.attachUnsignedChatWindowGuard(bot);

  client.write('chat_message', { message: 'signed', offset: 3, acknowledged: Buffer.from([1, 2, 3]), checksum: 7 });
  const signedWrite = writes.filter((entry) => entry.name === 'chat_message').pop();
  assert.equal(signedWrite.params.offset, 3, '启用签名且有密钥时保持上游行为');
  assert.deepEqual(signedWrite.params.acknowledged, Buffer.from([1, 2, 3]));
  assert.equal(signedWrite.params.checksum, 7);

  // 启用签名但没有密钥时, 仍然要归一(继承旧行为)
  client.profileKeys = null;
  client.write('chat_message', { message: 'nokey', offset: 5, acknowledged: Buffer.from([9]), checksum: 9 });
  const noKeyWrite = writes.filter((entry) => entry.name === 'chat_message').pop();
  assert.equal(noKeyWrite.params.offset, 0);
  assert.deepEqual(noKeyWrite.params.acknowledged, Buffer.from([0, 0, 0]));
  assert.equal(noKeyWrite.params.checksum, 0);
});

test('BotRuntime attachUnsignedChatWindowGuard skips versions without the ack window fields', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });

  const writes = [];
  const client = new EventEmitter();
  client.profileKeys = null;
  client.write = (name, params) => {
    writes.push({ name, params });
  };
  // 1.16.5 的 chat_message 只有 message/position, 没有 acknowledged/checksum
  const bot = { _client: client, version: '1.16.5' };

  runtime.attachUnsignedChatWindowGuard(bot);
  client.write('chat_message', { message: 'hi', offset: 3 });

  assert.equal(writes[0].params.offset, 3, '不介入旧协议');
});

test('BotRuntime attaches eat feature in lightweight mode', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });

  const client = new EventEmitter();
  client.write = () => {};
  const bot = new EventEmitter();
  bot._client = client;
  bot.version = '1.21.11';

  // 只验证"接线": 轻量背包核心/窗口/背包特性会起定时器与装包, 这里换成空实现,
  // 避免测试进程被它们的定时器挂住(这正是本次回归要覆盖的"eatFeature 漏挂"点)
  const attached = [];
  runtime.attachLightInventoryCore = () => {};
  runtime.inventoryFeature.attach = () => attached.push('inventory');
  runtime.windowFeature.attach = () => attached.push('window');

  runtime.attachLightweightFeatures(bot);

  assert.equal(runtime.isLightweightMode(), true);
  assert.equal(runtime.eatFeature.bot, bot, '轻量模式必须 attach eatFeature, 否则 eat/autoeat 会报 eat feature not attached');
  assert.equal(runtime.autoEatController.bot, bot, '轻量模式必须 attach autoEatController');
  assert.deepEqual(attached, ['inventory', 'window']);

  runtime.eatFeature.detach();
  runtime.autoEatController.detach();
});

test('BotRuntime desync watchdog reconnects when nothing arrives after an ignored parse error', async () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    },
    protocolGuardConfig: { logParseErrors: true, desyncSilenceMs: 60 }
  });

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-desync-'));
  const logFile = path.join(logDir, 'protocol-errors.log');
  runtime.protocolErrorLogPath = logFile;

  const client = new EventEmitter();
  client.deserializer = new EventEmitter();
  client.state = 'play';
  const quitReasons = [];
  const bot = {
    _client: client,
    quit: (reason) => quitReasons.push(reason)
  };

  runtime.attachProtocolParseGuard(bot);

  // 协议保护吞掉一个 Slot/组件 NBT 解析异常
  client.deserializer.emit('malformed_packet_ignored', {
    packetId: 16,
    chunkLength: 512,
    ignoredCount: 1,
    burstLimit: 20,
    burstWindowMs: 60000,
    errorMessage: 'Read error for undefined : array size is abnormally large, not reading: 591808068'
  });

  assert.deepEqual(quitReasons, [], '刚吞包时不应立即断开');

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(quitReasons, ['protocol_desync'], '静默超时后主动断开重连');
  assert.match(fs.readFileSync(logFile, 'utf8'), /parse error ignored .*array size is abnormally large/);
});

test('BotRuntime desync watchdog is cancelled once another packet arrives', async () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    },
    protocolGuardConfig: { logParseErrors: false, desyncSilenceMs: 80 }
  });

  const client = new EventEmitter();
  client.deserializer = new EventEmitter();
  client.state = 'play';
  const quitReasons = [];
  const bot = { _client: client, quit: (reason) => quitReasons.push(reason) };

  runtime.attachProtocolParseGuard(bot);
  client.deserializer.emit('malformed_packet_ignored', { ignoredCount: 1, errorMessage: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  client.emit('packet', {}, { name: 'keep_alive' }); // 连接还活着

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(quitReasons, [], '期间收到包 => 不重连');
});

test('BotRuntime desync watchdog can be disabled and falls back to a built-in default', async () => {
  const disabled = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    },
    protocolGuardConfig: { logParseErrors: false, desyncSilenceMs: 0 }
  });

  const clientA = new EventEmitter();
  clientA.deserializer = new EventEmitter();
  clientA.state = 'play';
  const quitA = [];
  disabled.attachProtocolParseGuard({ _client: clientA, quit: (reason) => quitA.push(reason) });
  clientA.deserializer.emit('malformed_packet_ignored', { ignoredCount: 1, errorMessage: 'x' });
  assert.equal(disabled.desyncWatchdogTimer, null, 'desyncSilenceMs=0 时不设看门狗');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(quitA, []);

  // 未配置该项时使用内置默认值(不会静默失效)
  const fallback = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    },
    protocolGuardConfig: { logParseErrors: false }
  });

  const clientB = new EventEmitter();
  clientB.deserializer = new EventEmitter();
  clientB.state = 'play';
  fallback.attachProtocolParseGuard({ _client: clientB, quit: () => {} });
  clientB.deserializer.emit('malformed_packet_ignored', { ignoredCount: 1, errorMessage: 'x' });
  assert.notEqual(fallback.desyncWatchdogTimer, null, '未配置时用内置默认(8s)');
  fallback.clearDesyncWatchdog();
  assert.equal(fallback.desyncWatchdogTimer, null);
});

test('BotRuntime desync watchdog also covers parse errors that were not swallowed', async () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    },
    protocolGuardConfig: { logParseErrors: true, desyncSilenceMs: 60 }
  });

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-desync-unswallowed-'));
  const logFile = path.join(logDir, 'protocol-errors.log');
  runtime.protocolErrorLogPath = logFile;

  const client = new EventEmitter();
  client.deserializer = new EventEmitter();
  client.state = 'play';
  const quitReasons = [];
  const bot = {
    _client: client,
    quit: (reason) => quitReasons.push(reason)
  };

  runtime.attachProtocolParseGuard(bot);

  // 突发超限: 协议保护不再吞包, 错误抛给上层(实测上层不会立刻断开, 会拖到 35s 保活超时)
  client.deserializer.emit('packet_parse_error', {
    packetId: 16,
    chunkLength: 512,
    ignoredCount: 20,
    reason: 'burst_limit',
    burstLimit: 20,
    burstWindowMs: 60000,
    errorMessage: 'Read error for undefined : array size is abnormally large, not reading: 591808068'
  });

  assert.deepEqual(quitReasons, [], '刚抛出时不应立即断开');
  assert.notEqual(runtime.desyncWatchdogTimer, null, '未吞掉的解析异常同样要布置看门狗');

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(quitReasons, ['protocol_desync'], '静默超时后主动断开重连');
  assert.match(fs.readFileSync(logFile, 'utf8'), /parse error unswallowed .*reason=burst_limit/);
});

test('BotRuntime logs the end reason and time since the last outgoing chat', async () => {
  const runtime = createRuntime();
  runtime.state = 'online';
  runtime.diagnostics.currentConnectionStartedAt = new Date(Date.now() - 5000).toISOString();
  runtime.lastOutgoingChatAt = Date.now() - 1500;
  runtime.lastOutgoingChatIsCommand = false;

  await runtime.handleEnd(undefined, 'socketClosed');

  const logs = runtime.logger.getRecent();
  const endLog = logs.find((entry) => entry.message.includes('[BOT] end'));
  assert.ok(endLog, '应输出 [BOT] end');
  assert.match(endLog.message, /reason=socketClosed/);
  assert.match(endLog.message, /uptime=[45]s/);
  assert.match(endLog.message, /sinceLastChat=1\.[0-9]s\(chat\)/);
  assert.equal(runtime.lastEndReason, 'socketClosed');
});

test('BotRuntime end reason and context survive missing or structured reasons', async () => {
  const runtime = createRuntime();
  runtime.state = 'online';

  assert.equal(runtime.describeEndReason(undefined), 'unknown');
  assert.equal(runtime.describeEndReason('keepAliveError'), 'keepAliveError');
  assert.equal(runtime.describeEndReason({ text: 'kicked by admin' }), '{"text":"kicked by admin"}');
  assert.match(runtime.describeEndContext(), /sinceLastChat=none/);

  runtime.lastOutgoingChatAt = Date.now();
  runtime.lastOutgoingChatIsCommand = true;
  assert.match(runtime.describeEndContext(), /sinceLastChat=[0-9.]+s\(command\)/);

  await runtime.handleEnd(undefined, { extra: 'x'.repeat(400) });
  assert.equal(runtime.lastEndReason.length, 183, '过长 reason 截断并加省略号');
});

test('BotRuntime records outgoing chat packet metadata at the write layer', () => {
  const runtime = createRuntime();
  const client = new EventEmitter();
  client.write = () => {};
  const bot = { version: '1.21.11', _client: client };

  runtime.attachUnsignedChatWindowGuard(bot);

  client.write('chat_message', {
    message: '1',
    offset: 0,
    acknowledged: Buffer.alloc(3, 0),
    checksum: 0
  });
  client.write('keep_alive', { keepAliveId: 1n });

  assert.equal(runtime.chatSendCount, 1, '只统计聊天类包');
  assert.equal(runtime.lastOutgoingChatIsCommand, false);
  assert.match(runtime.lastOutgoingChatPacket, /^chat_message\(offset=0 ackBits=0 checksum=0\)$/);
  assert.match(runtime.describeEndContext(), /chatSends=1 lastChatPacket=chat_message/);

  client.write('chat_command_signed', {
    command: 'me',
    messageCount: 0,
    acknowledged: Buffer.from([1, 0, 0]),
    checksum: 0
  });

  assert.equal(runtime.chatSendCount, 2);
  assert.equal(runtime.lastOutgoingChatIsCommand, true);
  assert.match(runtime.lastOutgoingChatPacket, /ackBits=1/);
});

test('BotRuntime executes lock-after-expire command when online', () => {
  const chats = [];
  const runtime = createRuntime({
    config: {
      legacyConfig: {
        ...makeLegacyConfig({ entityHandling: false, terrainHandling: false }),
        behavior: { lockAfterExpireCommand: '/home' }
      }
    }
  });
  runtime.state = 'online';
  runtime.bot = {
    chat(message) {
      chats.push(message);
    }
  };

  runtime.handleLockExpired({ owner: 'owner1' }, 'timer_expire');

  assert.deepEqual(chats, ['/home', '/minecraft:w owner1 锁已到期，预设命令已执行: /home']);
  assert.equal(runtime.pendingLockExpireCommand, null);
});

test('BotRuntime queues lock-after-expire command offline and flushes on ready', () => {
  const chats = [];
  const runtime = createRuntime({
    config: {
      legacyConfig: {
        ...makeLegacyConfig({ entityHandling: false, terrainHandling: false }),
        behavior: { lockAfterExpireCommand: '/home' }
      }
    }
  });
  runtime.state = 'stopped';
  runtime.bot = null;

  runtime.handleLockExpired({ owner: 'owner1' }, 'startup_expire');
  assert.equal(runtime.pendingLockExpireCommand, '/home');
  assert.deepEqual(chats, []);

  runtime.state = 'online';
  runtime.bot = {
    chat(message) {
      chats.push(message);
    }
  };
  runtime.flushPendingLockExpireCommand();

  assert.deepEqual(chats, ['/home']);
  assert.equal(runtime.pendingLockExpireCommand, null);
});

test('BotRuntime skips lock-after-expire command when configured empty', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: {
        ...makeLegacyConfig({ entityHandling: false, terrainHandling: false }),
        behavior: { lockAfterExpireCommand: '' }
      }
    }
  });
  runtime.state = 'online';
  const chats = [];
  runtime.bot = {
    chat(message) {
      chats.push(message);
    }
  };

  runtime.handleLockExpired({ owner: 'owner1' }, 'timer_expire');

  assert.deepEqual(chats, ['/minecraft:w owner1 锁已到期，预设命令未执行']);
  assert.equal(runtime.pendingLockExpireCommand, null);
});

test('BotRuntime honors per-lock autoExecAfterExpire override', () => {
  const chats = [];
  const runtime = createRuntime({
    config: {
      legacyConfig: {
        ...makeLegacyConfig({ entityHandling: false, terrainHandling: false }),
        behavior: { lockAfterExpireCommand: '/home' }
      }
    }
  });
  runtime.state = 'online';
  runtime.bot = {
    chat(message) {
      chats.push(message);
    }
  };

  // false: 本次锁到期不执行(仍通知未执行)
  runtime.handleLockExpired({ owner: 'owner1', autoExecAfterExpire: false }, 'timer_expire');
  assert.deepEqual(chats, ['/minecraft:w owner1 锁已到期，预设命令未执行']);
  assert.equal(runtime.pendingLockExpireCommand, null);

  // true: 执行
  runtime.handleLockExpired({ owner: 'owner1', autoExecAfterExpire: true }, 'timer_expire');
  assert.deepEqual(chats, [
    '/minecraft:w owner1 锁已到期，预设命令未执行',
    '/home',
    '/minecraft:w owner1 锁已到期，预设命令已执行: /home'
  ]);
});

test('BotRuntime lock autoExecAfterExpire true falls back to /home when global config empty', () => {
  const chats = [];
  const runtime = createRuntime({
    config: {
      legacyConfig: {
        ...makeLegacyConfig({ entityHandling: false, terrainHandling: false }),
        behavior: { lockAfterExpireCommand: '' }
      }
    }
  });
  runtime.state = 'online';
  runtime.bot = {
    chat(message) {
      chats.push(message);
    }
  };

  runtime.handleLockExpired({ owner: 'owner1', autoExecAfterExpire: true }, 'timer_expire');
  assert.deepEqual(chats, ['/home', '/minecraft:w owner1 锁已到期，预设命令已执行: /home']);
});

test('BotRuntime does not notify CONSOLE panel lock owner on expiry', () => {
  const chats = [];
  const runtime = createRuntime({
    config: {
      legacyConfig: {
        ...makeLegacyConfig({ entityHandling: false, terrainHandling: false }),
        behavior: { lockAfterExpireCommand: '/home' }
      }
    }
  });
  runtime.state = 'online';
  runtime.bot = {
    chat(message) {
      chats.push(message);
    }
  };

  // 面板锁 owner=CONSOLE: 执行预设命令但不再私聊通知(CONSOLE 非游戏内玩家)
  runtime.handleLockExpired({ owner: 'CONSOLE', source: 'http' }, 'timer_expire');
  assert.deepEqual(chats, ['/home']);
});

test('BotRuntime getWindowSnapshot falls back to lightweight inventory window0', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });
  const slots = Array.from({ length: 46 }, () => null);
  runtime.bot = {
    inventory: {
      id: 0,
      type: 'minecraft:inventory',
      inventoryStart: 9,
      inventoryEnd: 45,
      slots
    }
  };

  const snapshot = runtime.getWindowSnapshot();
  assert.ok(snapshot, 'snapshot returned');
  assert.equal(snapshot.name, 'inventory');
  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.id, 0);
  assert.deepEqual(snapshot.slots, []);
});

test('BotRuntime decompressor error is caught, logged, persisted and closes only that bot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-decompressor-'));
  const errorLogPath = path.join(tempDir, 'protocol-errors.log');
  const runtime = createRuntime();
  runtime.protocolErrorLogPath = errorLogPath;

  const quitReasons = [];
  const decompressor = new EventEmitter();
  const client = new EventEmitter();
  client.decompressor = decompressor;
  client.end = (reason) => quitReasons.push(['client.end', reason]);
  runtime.bot = {
    _client: client,
    quit(reason) {
      quitReasons.push(['bot.quit', reason]);
    }
  };

  runtime.ensureDecompressorErrorGuard({ _client: client });
  decompressor.emit('error', { code: 'Z_DATA_ERROR', errno: -3, message: 'incorrect header check' });

  assert.deepEqual(quitReasons, [['bot.quit', 'protocol_decompressor_error']]);
  assert.ok(runtime.logger.getRecent().some((entry) => {
    return entry.level === 'error' && entry.message.includes('decompressor error');
  }));
  assert.ok(fs.existsSync(errorLogPath), 'protocol-errors.log persisted');
  const content = fs.readFileSync(errorLogPath, 'utf8');
  assert.match(content, /decompressor error code=Z_DATA_ERROR message=incorrect header check/);
  runtime.detachRuntimeListeners();
});

test('BotRuntime decompressor guard attaches after state change and is idempotent', async () => {
  const runtime = createRuntime();
  const quitReasons = [];
  const client = new EventEmitter();
  client.decompressor = null;
  client.end = () => {};
  runtime.bot = {
    _client: client,
    quit(reason) {
      quitReasons.push(reason);
    }
  };

  runtime.ensureDecompressorErrorGuard({ _client: client });

  // 初始无 decompressor, state 切换后补挂
  client.emit('state', 'login', 'handshaking');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitReasons.length, 0);

  const decompressor = new EventEmitter();
  client.decompressor = decompressor;
  client.emit('state', 'play', 'login');
  await new Promise((resolve) => setImmediate(resolve));

  decompressor.emit('error', new Error('boom'));
  assert.deepEqual(quitReasons, ['protocol_decompressor_error']);

  // 幂等: 再次调用不重复挂监听
  runtime.ensureDecompressorErrorGuard({ _client: client });
  decompressor.emit('error', new Error('boom again'));
  assert.deepEqual(quitReasons, ['protocol_decompressor_error', 'protocol_decompressor_error']);
  runtime.detachRuntimeListeners();
});

test('BotRuntime attachChunkBatchReply replies minimum rate on chunk_batch_finished', () => {
  const runtime = createRuntime({
    config: {
      chunkBatchReplyChunksPerTick: 0.01,
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });
  const writes = [];
  const client = new EventEmitter();
  client.write = (name, payload) => {
    writes.push({ name, payload });
  };

  runtime.attachChunkBatchReply({ _client: client });

  client.emit('chunk_batch_finished', { batchSize: 9 });
  client.emit('chunk_batch_finished', { batchSize: 3 });

  assert.deepEqual(writes, [
    { name: 'chunk_batch_received', payload: { chunksPerTick: 0.01 } },
    { name: 'chunk_batch_received', payload: { chunksPerTick: 0.01 } }
  ]);
  runtime.detachRuntimeListeners();
});

test('BotRuntime attachChunkBatchReply stays silent when configured to zero or missing', () => {
  const disabled = createRuntime({
    config: {
      chunkBatchReplyChunksPerTick: 0,
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });
  const writes = [];
  const client = new EventEmitter();
  client.write = (name, payload) => {
    writes.push({ name, payload });
  };

  disabled.attachChunkBatchReply({ _client: client });
  client.emit('chunk_batch_finished', { batchSize: 9 });
  assert.equal(writes.length, 0);
  disabled.detachRuntimeListeners();

  const missing = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });
  const writes2 = [];
  const client2 = new EventEmitter();
  client2.write = (name, payload) => {
    writes2.push({ name, payload });
  };

  missing.attachChunkBatchReply({ _client: client2 });
  client2.emit('chunk_batch_finished', { batchSize: 9 });
  assert.equal(writes2.length, 0);
  missing.detachRuntimeListeners();
});

test('BotRuntime attachChunkBatchReply tolerates a client without write', () => {
  const runtime = createRuntime({
    config: {
      chunkBatchReplyChunksPerTick: 0.01,
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });
  const client = new EventEmitter();

  runtime.attachChunkBatchReply({ _client: client });
  client.emit('chunk_batch_finished', { batchSize: 9 });
  runtime.detachRuntimeListeners();
});

test('BotRuntime createMineflayerOptions whitelists plugins in lightweight mode', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });
  const options = runtime.createMineflayerOptions(null, null);
  assert.equal(options.loadInternalPlugins, false);
  assert.deepEqual(options.plugins, { chat: true, game: true, health: true, settings: true, resource_pack: true, team: true });
});

test('BotRuntime createMineflayerOptions keeps full plugins in normal mode', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: true, terrainHandling: true })
    }
  });
  const options = runtime.createMineflayerOptions(null, null);
  assert.equal(options.loadInternalPlugins, undefined);
  assert.equal(options.plugins, undefined);
});

test('BotRuntime handleBotReady is guarded against re-entry', () => {
  const runtime = createRuntime();
  runtime.state = 'online';
  const spawnCountBefore = runtime.spawnCount;
  runtime.handleBotReady();
  assert.equal(runtime.spawnCount, spawnCountBefore);
});

test('BotRuntime accepts resource packs when enabled in config', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: {
        trustedPlayers: [],
        autoRestart: 0,
        teleport: {
          mode: 'whitelist',
          whitelistFile: 'whitelist.txt'
        },
        logging: {},
        behavior: {
          whitelistReloadMinutes: 0,
          enableResourcePack: true
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
    }
  });
  const writes = [];

  runtime.handleResourcePack({
    _client: {
      write(name, payload) {
        writes.push({ name, payload });
      }
    }
  }, 'https://example.com/pack.zip', {
    toString() {
      return '4a89c510-7e2f-3080-bc63-be3bd547d24d';
    }
  });

  assert.deepEqual(writes, [
    {
      name: 'resource_pack_receive',
      payload: {
        uuid: '4a89c510-7e2f-3080-bc63-be3bd547d24d',
        result: 3
      }
    },
    {
      name: 'resource_pack_receive',
      payload: {
        uuid: '4a89c510-7e2f-3080-bc63-be3bd547d24d',
        result: 0
      }
    }
  ]);
});

test('BotRuntime suppresses ignorable protocol parse warnings when disabled', () => {
  const runtime = createRuntime({
    protocolGuardConfig: {
      logParseErrors: false
    }
  });

  runtime.handleError(new Error('slot compound invalid tag: 70 > 20'));

  assert.equal(runtime.getDetails().logs.length, 0);
});

function createAuthPaths(tempDir) {
  return {
    accountDir: tempDir,
    scriptsDir: tempDir,
    lockHistoryPath: path.join(tempDir, 'lock_history.txt'),
    authCacheDir: path.join(tempDir, 'auth-cache'),
    fallbackAuthCacheDir: path.join(tempDir, 'nmp-cache')
  };
}

function xblCachePath(tempDir, email) {
  const hash = crypto.createHash('sha1').update(email ?? '', 'binary').digest('hex').slice(0, 6);
  return path.join(tempDir, 'auth-cache', `${hash}_xbl-cache.json`);
}

function makeXbox403Error() {
  const error = new Error('403 Forbidden {}');
  error.stack = [
    'Error: 403 Forbidden {}',
    '    at checkStatus (D:\\mineflayer\\node_modules\\prismarine-auth\\src\\common\\Util.js:10:11)',
    '    at async XboxTokenManager.getTitleToken (D:\\mineflayer\\node_modules\\prismarine-auth\\src\\TokenManagers\\XboxTokenManager.js:258:17)'
  ].join('\n');
  return error;
}

test('BotRuntime resets xbl cache and retries on prismarine-auth xbox 403 during startup', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth403-'));
  const runtime = createRuntime({ config: { paths: createAuthPaths(tempDir) } });
  runtime.state = 'starting';
  const cachePath = xblCachePath(tempDir, 'alpha@example.com');

  try {
    runtime.handleError(makeXbox403Error());

    assert.ok(fs.existsSync(cachePath), 'xbl cache file written');
    assert.equal(fs.readFileSync(cachePath, 'utf8'), '{}');
    assert.equal(runtime.pendingRestartReason, 'auth_cache_reset');
  } finally {
    runtime.clearRestartTimer();
  }
});

test('BotRuntime leaves other 403 or non-xbox errors untouched', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth403-neg-'));
  const cachePath = xblCachePath(tempDir, 'alpha@example.com');

  // 1) 403 但不在登录阶段(online)
  const onlineRuntime = createRuntime({ config: { paths: createAuthPaths(tempDir) } });
  onlineRuntime.state = 'online';
  onlineRuntime.handleError(makeXbox403Error());
  assert.equal(onlineRuntime.pendingRestartReason, null);
  assert.equal(fs.existsSync(cachePath), false);

  // 2) 403 但堆栈不是 prismarine-auth
  const foreignRuntime = createRuntime({ config: { paths: createAuthPaths(tempDir) } });
  foreignRuntime.state = 'starting';
  const foreignError = new Error('403 Forbidden {}');
  foreignError.stack = 'Error: 403 Forbidden {}\n    at someOtherClient (D:\\app\\client.js:1:1)';
  foreignRuntime.handleError(foreignError);
  assert.equal(foreignRuntime.pendingRestartReason, null);
  assert.equal(fs.existsSync(cachePath), false);

  // 3) prismarine-auth 堆栈但不是 XboxTokenManager
  const otherStageRuntime = createRuntime({ config: { paths: createAuthPaths(tempDir) } });
  otherStageRuntime.state = 'starting';
  const otherStageError = new Error('403 Forbidden {}');
  otherStageError.stack = 'Error: 403 Forbidden {}\n    at async MsaTokenManager.getAccessToken (D:\\mineflayer\\node_modules\\prismarine-auth\\src\\TokenManagers\\MsaTokenManager.js:1:1)';
  otherStageRuntime.handleError(otherStageError);
  assert.equal(otherStageRuntime.pendingRestartReason, null);
  assert.equal(fs.existsSync(cachePath), false);
});

test('BotRuntime resetAuthCache is safe without existing cache directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth403-safe-'));
  const runtime = createRuntime({
    config: {
      paths: {
        ...createAuthPaths(tempDir),
        authCacheDir: path.join(tempDir, 'missing-auth-cache')
      }
    }
  });

  assert.doesNotThrow(() => runtime.resetAuthCache('xbl'));
});

test('BotRuntime pushes bark notification on prismarine-auth xbox 403 with cooldown', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth403-bark-'));
  const notifications = [];
  const notifier = {
    isEnabled: () => true,
    getCooldownMs: () => 600000,
    notify(payload) {
      notifications.push(payload);
      return Promise.resolve({ ok: true, reason: null, elapsedMs: 12 });
    }
  };
  const runtime = createRuntime({
    config: { paths: createAuthPaths(tempDir) },
    barkNotifier: notifier
  });
  runtime.state = 'starting';

  try {
    runtime.handleError(makeXbox403Error());
    // 真实流程: 403 后进入 waiting_restart, 冷却期内重试再次进入开始阶段并又遇 403
    runtime.state = 'starting';
    runtime.handleError(makeXbox403Error());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(notifications.length, 1, 'only one push within cooldown');
    assert.equal(notifications[0].title, 'MULTIBOT Downdetector');
    assert.match(notifications[0].body, /alpha/);
    assert.match(notifications[0].body, /认证403/);
    assert.ok(runtime.logger.getRecent().some((entry) => entry.message.includes('bark 403 push skipped (cooldown)')));
    assert.ok(runtime.logger.getRecent().some((entry) => entry.message.includes('bark 403 push ok')));
  } finally {
    runtime.clearRestartTimer();
  }
});

test('BotRuntime logs desensitized bark failure reason', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth403-bark-fail-'));
  const notifier = {
    isEnabled: () => true,
    getCooldownMs: () => 600000,
    notify() {
      return Promise.resolve({ ok: false, reason: 'timeout', elapsedMs: 20030 });
    }
  };
  const runtime = createRuntime({
    config: { paths: createAuthPaths(tempDir) },
    barkNotifier: notifier
  });
  runtime.state = 'starting';

  try {
    runtime.handleError(makeXbox403Error());
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(runtime.logger.getRecent().some((entry) => {
      return entry.message.includes('bark 403 push fail reason=timeout');
    }));
  } finally {
    runtime.clearRestartTimer();
  }
});

test('BotRuntime skips bark notification when notifier is disabled', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth403-bark-off-'));
  let called = 0;
  const notifier = {
    isEnabled: () => false,
    getCooldownMs: () => 600000,
    notify() {
      called++;
      return Promise.resolve(true);
    }
  };
  const runtime = createRuntime({
    config: { paths: createAuthPaths(tempDir) },
    barkNotifier: notifier
  });
  runtime.state = 'starting';

  try {
    runtime.handleError(makeXbox403Error());
    assert.equal(called, 0);
  } finally {
    runtime.clearRestartTimer();
  }
});

// 事件层通知(notifyEvent/notifyRecovery)的假通知器: 只记录调用, 不落盘
function createEventNotifierStub(options = {}) {
  const events = [];
  const recoveries = [];
  const pending = new Set();

  return {
    events,
    recoveries,
    pending,
    isEnabled: () => options.enabled !== false,
    getEventConfig: () => Object.assign({ enabled: true, cooldownMs: 0, threshold: 3 }, options.eventConfig || {}),
    notifyEvent(payload) {
      events.push(payload);
      pending.add(payload.key);
      return Promise.resolve({ sent: true, ok: true, reason: null, folded: 0, suppressed: 0 });
    },
    notifyRecovery(payload) {
      recoveries.push(payload);
      pending.delete(payload.key);
      return Promise.resolve({ sent: true, reason: null, durationMs: 1000 });
    },
    hasPendingFailure: (key) => pending.has(key),
    clearEventState: (key) => pending.delete(key)
  };
}

test('BotRuntime pushes critical notification when MSA asks for interactive login', () => {
  const notifier = createEventNotifierStub();
  const runtime = createRuntime({ barkNotifier: notifier });
  runtime.pendingAuthState = { deviceCodeIssued: false };

  runtime.handleMsaCode({ message: '请打开 https://microsoft.com/link 输入 ABCD-EFGH' });

  assert.equal(runtime.pendingAuthState.deviceCodeIssued, true);
  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'deviceCode');
  assert.equal(notifier.events[0].key, 'auth:device-code:alpha');
  assert.equal(notifier.events[0].severity, 'critical');
  assert.equal(notifier.events[0].label, 'alpha');
  assert.match(notifier.events[0].body, /设备码登录/);
});

test('BotRuntime pushes critical notification when OpenAuth stops permanently', () => {
  const notifier = createEventNotifierStub();
  const runtime = createRuntime({ barkNotifier: notifier });

  runtime.stopForOpenAuthFailure('ACCOUNT_SUSPENDED');

  assert.equal(runtime.openAuthPermanentFailure, true);
  assert.equal(runtime.desiredRunning, false);
  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'openAuthPermanentFailure');
  assert.equal(notifier.events[0].key, 'auth:permanent:alpha');
  assert.equal(notifier.events[0].severity, 'critical');
  assert.match(notifier.events[0].body, /ACCOUNT_SUSPENDED/);
});

test('BotRuntime pushes critical notification on refresh token invalidation', () => {
  const notifier = createEventNotifierStub();
  const runtime = createRuntime({ barkNotifier: notifier });

  runtime.handleError(new Error('invalid_grant: AADSTS700082: The refresh token has expired'));

  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'refreshTokenInvalid');
  assert.equal(notifier.events[0].key, 'auth:refresh-token:alpha');
  assert.equal(notifier.events[0].severity, 'critical');
  assert.match(runtime.lastError, /invalid_grant/);
});

test('BotRuntime does not treat a transient token refresh failure as invalid credentials', () => {
  const notifier = createEventNotifierStub();
  const runtime = createRuntime({ barkNotifier: notifier });

  // 裸 "refresh token" 太宽: 临时的刷新网络失败不该报"凭据已失效, 需要人工重新登录"
  runtime.handleError(new Error('Failed to refresh token: network error while contacting login server'));
  runtime.handleError(new Error('socket hang up during token refresh'));

  assert.equal(notifier.events.length, 0);
});

test('BotRuntime pushes critical notification when the account is rejected or banned', () => {
  const notifier = createEventNotifierStub();
  const runtime = createRuntime({ barkNotifier: notifier });

  runtime.handleError(new Error('You are banned from this server!'));

  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'authRejected');
  assert.equal(notifier.events[0].key, 'auth:rejected:alpha');
  assert.equal(notifier.events[0].severity, 'critical');
});

test('BotRuntime invalid_session failures notify after the configured threshold', () => {
  const notifier = createEventNotifierStub({ eventConfig: { threshold: 3, windowMs: 3600000 } });
  const runtime = createRuntime({ barkNotifier: notifier });

  runtime.trackInvalidSessionRetry();
  runtime.trackInvalidSessionRetry();
  assert.equal(notifier.events.length, 0, '前两次属于正常自愈, 不打扰');

  assert.equal(runtime.trackInvalidSessionRetry(), 3);
  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'invalidSession');
  assert.equal(notifier.events[0].key, 'auth:invalid-session:alpha');
  assert.equal(notifier.events[0].severity, 'critical');
  assert.match(notifier.events[0].body, /60 分钟内登录会话失效 3 次/);
});

test('BotRuntime keeps counting invalid_session failures across restarts and ready cycles', () => {
  // 回归(评审指出): 以前复位写在 handleBotReady 里, 而每次失效后都会重启,
  // 登录成功即 ready -> 计数被清零 -> 阈值永远到不了(功能形同失效)。
  const notifier = createEventNotifierStub({ eventConfig: { threshold: 3, windowMs: 3600000 } });
  const runtime = createRuntime({ barkNotifier: notifier });

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    assert.equal(runtime.trackInvalidSessionRetry(), cycle, `第 ${cycle} 次失效应累计到 ${cycle}`);
    runtime.state = 'starting';
    runtime.handleBotReady();
    assert.equal(runtime.state, 'online', '每轮都应成功上线');
  }

  assert.equal(notifier.events.length, 1, '跨"失效->重启->上线"循环后, 第 3 次仍应报警');
  assert.match(notifier.events[0].body, /失效 3 次/);
});

test('BotRuntime invalid_session counter resets after the configured window', () => {
  const notifier = createEventNotifierStub({ eventConfig: { threshold: 3, windowMs: 60000 } });
  const runtime = createRuntime({ barkNotifier: notifier });

  runtime.trackInvalidSessionRetry();
  runtime.trackInvalidSessionRetry();

  // 把窗口起点推回过去, 等价于"那两次失效发生在 2 分钟前"
  runtime.invalidSessionTracker.windowStartedAt -= 120000;

  assert.equal(runtime.trackInvalidSessionRetry(), 1, '窗口过期后重新计数');
  assert.equal(notifier.events.length, 0);
});

test('BotRuntime still uses the dedicated 403 push instead of the event layer', async () => {
  const stub = createEventNotifierStub();
  const authPushes = [];
  const notifier = Object.assign({}, stub, {
    getCooldownMs: () => 600000,
    notify(payload) {
      authPushes.push(payload);
      return Promise.resolve({ ok: true, reason: null, elapsedMs: 5 });
    }
  });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-auth403-mixed-'));
  const runtime = createRuntime({
    config: { paths: createAuthPaths(tempDir) },
    barkNotifier: notifier
  });
  runtime.state = 'starting';

  try {
    runtime.handleError(makeXbox403Error());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(authPushes.length, 1, '403 仍走专用推送');
    assert.match(authPushes[0].body, /认证403/);
    assert.equal(stub.events.length, 0, '403 不应重复触发事件层');
  } finally {
    runtime.clearRestartTimer();
  }
});

test('BotRuntime pushes restart-exhausted notification and reports recovery when back online', async () => {
  const notifier = createEventNotifierStub();
  const runtime = createRuntime({
    config: {
      restartDelayScheduleMs: [60000, 300000],
      restartDelayScheduleRepeatLast: false,
      restartJitterMs: 0
    },
    restartPolicyOptions: {
      randomProvider: () => 0
    },
    barkNotifier: notifier
  });
  runtime.connectionEpoch = 1;
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.lastDisconnectClass = 'backend_unavailable';
  runtime.lastError = 'Could not connect to the backend server!';
  runtime.restartAttempt = 2;

  await runtime.handleEnd(1);

  assert.equal(runtime.restartScheduleExhausted, true);
  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'restartExhausted');
  assert.equal(notifier.events[0].key, 'bot:exhausted:alpha');
  assert.equal(notifier.events[0].severity, 'critical');
  assert.match(notifier.events[0].body, /自动重连已用尽/);

  await runtime.notifyBarkRecoveryForOnline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notifier.recoveries.length, 1, '恢复只推一条');
  assert.match(notifier.recoveries[0].body, /已恢复在线/);
  assert.equal(notifier.pending.has('bot:exhausted:alpha'), false);
});

test('BotRuntime clears every pending bot event state when recovering online', async () => {
  const notifier = createEventNotifierStub();
  const runtime = createRuntime({ barkNotifier: notifier });

  runtime.notifyBarkEvent({ type: 'restartExhausted', key: 'bot:exhausted:alpha', severity: 'critical', body: 'a' });
  runtime.notifyBarkEvent({ type: 'botStuck', key: 'bot:stuck:alpha', severity: 'critical', body: 'b' });
  runtime.notifyBarkEvent({ type: 'deviceCode', key: 'auth:device-code:alpha', severity: 'critical', body: 'c' });

  await runtime.notifyBarkRecoveryForOnline();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notifier.recoveries.length, 1);
  assert.equal(runtime.barkNotifier.hasPendingFailure('bot:exhausted:alpha'), false);
  assert.equal(runtime.barkNotifier.hasPendingFailure('bot:stuck:alpha'), false);
  assert.equal(runtime.barkNotifier.hasPendingFailure('auth:device-code:alpha'), false);
});

test('BotRuntime event notifications are skipped when the notifier is disabled', () => {
  const notifier = createEventNotifierStub({ enabled: false });
  const runtime = createRuntime({ barkNotifier: notifier });
  runtime.pendingAuthState = { deviceCodeIssued: false };

  runtime.handleMsaCode({ message: 'code' });
  runtime.handleError(new Error('invalid_grant'));
  runtime.stopForOpenAuthFailure('X');

  assert.equal(notifier.events.length, 0);
});

test('classifyDisconnectReason recognizes ViaProxy backend messages', () => {
  assert.equal(
    classifyDisconnectReason('Could not connect to the backend server!'),
    'backend_unavailable'
  );
  assert.equal(
    classifyDisconnectReason('An error occurred while connecting to the backend server: Connection timed out'),
    'backend_unavailable'
  );
});

test('classifyDisconnectReason unwraps components, strips colors, and matches partial suffixes', () => {
  assert.equal(
    classifyDisconnectReason({ text: '§cCould not connect to the backend server!' }),
    'backend_unavailable'
  );
  assert.equal(
    classifyDisconnectReason({
      type: 'compound',
      value: {
        color: { type: 'string', value: 'red' },
        text: {
          type: 'string',
          value: 'Could not connect to the backend server!'
        }
      }
    }),
    'backend_unavailable'
  );
  assert.equal(
    classifyDisconnectReason({
      extra: [
        { text: 'Could not connect to the' },
        { text: ' backend server!' }
      ]
    }),
    'backend_unavailable'
  );
  assert.equal(
    classifyDisconnectReason({
      translate: 'multiplayer.disconnect.unknown',
      extra: [
        { text: 'An error occurred while connecting to the backend server: read ECONNRESET' }
      ]
    }),
    'backend_unavailable'
  );
});

test('classifyDisconnectReason returns null for unrelated messages', () => {
  assert.equal(classifyDisconnectReason('You were kicked from the server'), null);
  assert.equal(classifyDisconnectReason('backend server'), null);
  assert.equal(classifyDisconnectReason(''), null);
  assert.equal(classifyDisconnectReason(null), null);
});

test('normalizeDisconnectText unwraps components and strips Minecraft formatting', () => {
  assert.equal(
    normalizeDisconnectText({ text: '§cHello' }),
    'Hello'
  );
  assert.equal(
    normalizeDisconnectText({
      extra: [
        { text: 'A' },
        { text: ' §lB' }
      ]
    }),
    'A B'
  );
  assert.equal(
    normalizeDisconnectText({
      type: 'compound',
      value: {
        color: { type: 'string', value: 'red' },
        text: { type: 'string', value: '§cHello' }
      }
    }),
    'Hello'
  );
  assert.equal(normalizeDisconnectText('plain text'), 'plain text');
});

test('mergeDisconnectClass upgrades unknown and never downgrades backend_unavailable', () => {
  assert.equal(mergeDisconnectClass('unknown', 'backend_unavailable'), 'backend_unavailable');
  assert.equal(mergeDisconnectClass('unknown', 'ordinary_disconnect'), 'ordinary_disconnect');
  assert.equal(mergeDisconnectClass('ordinary_disconnect', 'backend_unavailable'), 'backend_unavailable');
  assert.equal(mergeDisconnectClass('backend_unavailable', 'ordinary_disconnect'), 'backend_unavailable');
  assert.equal(mergeDisconnectClass('backend_unavailable', 'unknown'), 'backend_unavailable');
});

test('BotRuntime upgrades disconnect classification within the same connection epoch', () => {
  const runtime = createRuntime();
  runtime.connectionEpoch = 1;

  runtime.recordDisconnectClass(1, 'unknown', 'unrelated disconnect');
  assert.equal(runtime.lastDisconnectClass, 'unknown');

  runtime.recordDisconnectClass(
    1,
    'backend_unavailable',
    'Could not connect to the backend server!'
  );
  assert.equal(runtime.lastDisconnectClass, 'backend_unavailable');
  assert.equal(
    runtime.lastNormalizedDisconnectReason,
    'Could not connect to the backend server!'
  );

  runtime.recordDisconnectClass(1, 'ordinary_disconnect', 'late ordinary message');
  assert.equal(runtime.lastDisconnectClass, 'backend_unavailable');
});

test('BotRuntime ignores stale classification events from an older connection', () => {
  const runtime = createRuntime();
  runtime.connectionEpoch = 2;

  runtime.recordDisconnectClass(1, 'backend_unavailable', 'old backend message');
  assert.equal(runtime.lastDisconnectClass, 'unknown');
  assert.equal(runtime.lastNormalizedDisconnectReason, null);

  runtime.recordDisconnectClass(2, 'ordinary_disconnect', 'current message');
  assert.equal(runtime.lastDisconnectClass, 'ordinary_disconnect');
});

test('BotRuntime schedules reconnect for backend_unavailable before OpenAuth request', async () => {
  const runtime = createRuntime({
    config: {
      restartDelayMs: 15000,
      restartJitterMs: 30000
    },
    restartPolicyOptions: {
      randomProvider: () => 0
    }
  });
  runtime.connectionEpoch = 1;
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.lastDisconnectClass = 'backend_unavailable';
  runtime.lastError = 'Could not connect to the backend server!';

  await runtime.handleEnd(1);

  assert.equal(runtime.state, 'waiting_restart');
  assert.equal(runtime.pendingRestartReason, 'backend_unavailable');
  assert.equal(runtime.pendingRestartDelayMs, 15000);
  const logs = runtime.logger.getRecent();
  assert.ok(logs.some((entry) => entry.message.includes('reason=backend_unavailable')));
  assert.ok(!logs.some((entry) => entry.message.includes('OPENAUTH_REQUEST_MISSING')));
  runtime.clearRestartTimer();
});

test('BotRuntime stops with OPENAUTH_REQUEST_MISSING for unknown pre-request disconnect', async () => {
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      }
    }
  });
  runtime.connectionEpoch = 1;
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.lastDisconnectClass = 'unknown';
  runtime.lastError = 'unrelated disconnect';

  await runtime.handleEnd(1);

  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.desiredRunning, false);
  assert.equal(runtime.openAuthPermanentFailure, true);
  assert.equal(runtime.restartTimer, null);
});

test('BotRuntime backend_unavailable with restartOnDisconnect=false stops and keeps reason', async () => {
  const runtime = createRuntime({
    config: {
      restartOnDisconnect: false,
      restartDelayMs: 15000,
      restartJitterMs: 0
    }
  });
  runtime.connectionEpoch = 1;
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.lastDisconnectClass = 'backend_unavailable';
  runtime.lastError = 'Could not connect to the backend server!';

  await runtime.handleEnd(1);

  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.restartTimer, null);
  assert.equal(runtime.lastError, 'Could not connect to the backend server!');
});

test('BotRuntime increments restartAttempt when a schedule is configured', async () => {
  const runtime = createRuntime({
    config: {
      restartDelayScheduleMs: [60000, 300000],
      restartJitterMs: 0
    },
    restartPolicyOptions: {
      randomProvider: () => 0
    }
  });
  runtime.connectionEpoch = 1;
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.lastDisconnectClass = 'backend_unavailable';
  runtime.lastError = 'An error occurred while connecting to the backend server: timeout';

  await runtime.handleEnd(1);

  assert.equal(runtime.restartAttempt, 1);
  assert.equal(runtime.pendingRestartDelayMs, 60000);
  const logs = runtime.logger.getRecent();
  assert.ok(logs.some((entry) => {
    return entry.message.includes('reason=backend_unavailable attempt=1 baseDelayMs=60000');
  }));
  runtime.clearRestartTimer();
});

test('BotRuntime uses the configured reconnect schedule when OpenAuth is missing after a successful spawn', async () => {
  const runtime = createRuntime({
    config: {
      openAuth: {
        enabled: true,
        requestTimeoutMs: 4500
      },
      restartDelayScheduleMs: [60000, 300000],
      restartJitterMs: 0
    },
    restartPolicyOptions: {
      randomProvider: () => 0
    }
  });
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.spawnCount = 1;
  runtime.openAuthRequestMissingRetryEligible = true;

  await runtime.handleEnd();

  assert.equal(runtime.openAuthPermanentFailure, false);
  assert.equal(runtime.state, 'waiting_restart');
  assert.equal(runtime.pendingRestartReason, 'openauth_request_missing');
  assert.equal(runtime.pendingRestartDelayMs, 60000);
  assert.equal(runtime.restartAttempt, 1);
  runtime.clearRestartTimer();
});

test('BotRuntime does not increment restartAttempt when no schedule is configured', async () => {
  const runtime = createRuntime({
    config: {
      restartDelayMs: 15000,
      restartJitterMs: 0
    },
    restartPolicyOptions: {
      randomProvider: () => 0
    }
  });
  runtime.connectionEpoch = 1;
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.lastDisconnectClass = 'backend_unavailable';
  runtime.lastError = 'Could not connect to the backend server!';

  await runtime.handleEnd(1);

  assert.equal(runtime.restartAttempt, 0);
  assert.equal(runtime.pendingRestartDelayMs, 15000);
  const logs = runtime.logger.getRecent();
  assert.ok(!logs.some((entry) => entry.message.includes('attempt=')));
  runtime.clearRestartTimer();
});

test('BotRuntime stops after schedule exhaustion when repeatLast=false', async () => {
  const runtime = createRuntime({
    config: {
      restartDelayScheduleMs: [60000, 300000],
      restartDelayScheduleRepeatLast: false,
      restartJitterMs: 0
    },
    restartPolicyOptions: {
      randomProvider: () => 0
    }
  });
  runtime.connectionEpoch = 1;
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.lastDisconnectClass = 'backend_unavailable';
  runtime.lastError = 'Could not connect to the backend server!';
  runtime.restartAttempt = 2;

  await runtime.handleEnd(1);

  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.desiredRunning, false);
  assert.equal(runtime.restartScheduleExhausted, true);
  assert.equal(runtime.restartTimer, null);
  assert.equal(runtime.pendingRestartDelayMs, null);
  const logs = runtime.logger.getRecent();
  assert.ok(logs.some((entry) => {
    return entry.message.includes('[BOT] reconnect attempts exhausted reason=backend_unavailable attempts=2');
  }));
});

test('BotRuntime manual start resets attempts even from waiting_restart', async () => {
  const originalCreateBot = mineflayer.createBot;
  mineflayer.createBot = () => {
    throw new Error('createBot failed');
  };
  const runtime = createRuntime();
  runtime.restartAttempt = 3;
  runtime.restartScheduleExhausted = true;
  runtime.spawnCount = 1;
  runtime.openAuthRequestMissingRetryEligible = true;
  runtime.state = 'waiting_restart';
  runtime.desiredRunning = true;

  try {
    await assert.rejects(() => runtime.start({ source: 'manual' }), /createBot failed/);
  } finally {
    mineflayer.createBot = originalCreateBot;
  }

  assert.equal(runtime.restartAttempt, 0);
  assert.equal(runtime.restartScheduleExhausted, false);
  assert.equal(runtime.openAuthRequestMissingRetryEligible, false);
  runtime.clearRestartTimer();
});

test('BotRuntime scheduled restart start does not reset attempts', async () => {
  const originalCreateBot = mineflayer.createBot;
  mineflayer.createBot = () => {
    throw new Error('createBot failed');
  };
  const runtime = createRuntime();
  runtime.restartAttempt = 3;
  runtime.restartScheduleExhausted = false;
  runtime.spawnCount = 1;
  runtime.state = 'waiting_restart';
  runtime.desiredRunning = true;

  try {
    await assert.rejects(
      () => runtime.start({ source: 'scheduled_restart' }),
      /createBot failed/
    );
  } finally {
    mineflayer.createBot = originalCreateBot;
  }

  assert.equal(runtime.restartAttempt, 3);
  assert.equal(runtime.openAuthRequestMissingRetryEligible, true);
  runtime.clearRestartTimer();
});

test('BotRuntime spawn and manual stop reset attempts and exhaustion state', async () => {
  const runtime = createRuntime();
  runtime.restartAttempt = 4;
  runtime.restartScheduleExhausted = true;
  runtime.state = 'online';
  runtime.desiredRunning = true;

  await runtime.stop('manual_stop');

  assert.equal(runtime.restartAttempt, 0);
  assert.equal(runtime.restartScheduleExhausted, false);
});

test('BotRuntime exposes schedule state in restart summary', () => {
  const runtime = createRuntime({
    config: {
      restartDelayScheduleMs: [60000, 300000],
      restartDelayScheduleRepeatLast: false,
      restartJitterMs: 0
    }
  });
  runtime.restartAttempt = 2;
  runtime.restartScheduleExhausted = true;

  const state = runtime.getRestartState();

  assert.equal(state.restartAttempt, 2);
  assert.equal(state.restartScheduleLength, 2);
  assert.equal(state.restartScheduleRepeatLast, false);
  assert.equal(state.restartScheduleExhausted, true);
});

test('BotRuntime restart summary reports zero schedule state when not configured', () => {
  const runtime = createRuntime();
  const state = runtime.getRestartState();

  assert.equal(state.restartAttempt, 0);
  assert.equal(state.restartScheduleLength, 0);
  assert.equal(state.restartScheduleRepeatLast, true);
  assert.equal(state.restartScheduleExhausted, false);
});

test('startup timeout quits bot when still starting, like a disconnect', async () => {
  const runtime = createRuntime({ config: { startupTimeoutMs: 1 } });
  const quitCalls = [];
  const mockBot = {
    _client: { state: 'handshaking' },
    quit: (reason) => {
      quitCalls.push(reason);
    }
  };
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.bot = mockBot;

  runtime.scheduleStartupWarning(mockBot);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(quitCalls.length, 1);
  assert.equal(quitCalls[0], 'startup_timeout');
  runtime.clearStartupWarningTimer();
});

test('startup timeout does not quit when openauth flow is active', async () => {
  const runtime = createRuntime({ config: { startupTimeoutMs: 1 } });
  const quitCalls = [];
  const mockBot = {
    _client: { state: 'handshaking' },
    quit: (reason) => {
      quitCalls.push(reason);
    }
  };
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.bot = mockBot;
  runtime.isOpenAuthEnabled = () => true;

  runtime.scheduleStartupWarning(mockBot);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(quitCalls.length, 0);
  runtime.clearStartupWarningTimer();
});

test('startup timeout falls back to scheduled restart when quit throws', async () => {
  const runtime = createRuntime({ config: { startupTimeoutMs: 1 } });
  const mockBot = {
    _client: { state: 'handshaking' },
    quit: () => {
      throw new Error('client not ready');
    }
  };
  runtime.state = 'starting';
  runtime.desiredRunning = true;
  runtime.bot = mockBot;

  runtime.scheduleStartupWarning(mockBot);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(runtime.state, 'waiting_restart');
  assert.equal(runtime.pendingRestartReason, 'disconnect');
  runtime.clearStartupWarningTimer();
  runtime.clearRestartTimer();
});

test('forceDestroyStaleSockets destroys leftover socket and clears reference', async () => {
  const runtime = createRuntime();
  const socket = {
    destroyed: false,
    destroy: () => {
      socket.destroyed = true;
    }
  };
  runtime.lastClientForCleanup = { socket };

  await runtime.forceDestroyStaleSockets();

  assert.equal(socket.destroyed, true);
  assert.equal(runtime.lastClientForCleanup, null);
});

test('stop force-destroys leftover socket when bot reference is gone', async () => {
  const runtime = createRuntime();
  const socket = {
    destroyed: false,
    destroy: () => {
      socket.destroyed = true;
    }
  };
  runtime.bot = null;
  runtime.lastClientForCleanup = { socket };

  await runtime.stop('manual_stop');

  assert.equal(socket.destroyed, true);
  assert.equal(runtime.lastClientForCleanup, null);
  assert.equal(runtime.state, 'stopped');
});

test('stop force-destroys leftover socket when quit throws', async () => {
  const runtime = createRuntime();
  const socket = {
    destroyed: false,
    destroy: () => {
      socket.destroyed = true;
    }
  };
  const client = { socket };
  const bot = new EventEmitter();
  bot._client = client;
  bot.quit = () => {
    throw new Error('client not ready');
  };
  runtime.bot = bot;
  runtime.lastEndAt = null;

  await runtime.stop('manual_stop');

  assert.equal(socket.destroyed, true);
  assert.equal(runtime.state, 'stopped');
  assert.ok(runtime.lastEndAt, 'quit 失败/end 未触发时也必须补上连接结束时刻');
  assert.equal(runtime.lastEndAt, runtime.diagnostics.currentConnectionEndedAt);
});

test('finalizeEndedBot backfills the connection end time without moving it backwards', async () => {
  const runtime = createRuntime();
  const bot = new EventEmitter();
  runtime.bot = bot;
  runtime.state = 'stopping';

  await runtime.finalizeEndedBot(bot, 'manual_stop');
  const backfilled = runtime.lastEndAt;
  assert.ok(backfilled, '缺少结束时刻时兜底写入');

  const newer = new Date(Date.parse(backfilled) + 60000).toISOString();
  runtime.lastEndAt = newer;
  await runtime.finalizeEndedBot(null, 'end');
  assert.equal(runtime.lastEndAt, newer, '迟到的 finalize 不得把较新的结束时刻改旧');
});

test('BotRuntime records the expected-running start before creating the bot', async () => {
  const runtime = createRuntime();
  assert.equal(runtime.expectedRunningSince, null, '初始为空');

  let seenDuringStart = null;
  runtime.createMineflayerOptions = () => {
    seenDuringStart = runtime.expectedRunningSince;
    throw new Error('stop-before-createBot');
  };

  await assert.rejects(() => runtime.start(), /stop-before-createBot/);

  assert.ok(seenDuringStart, 'start() 在创建连接之前就已记录本次启动起点');
  assert.ok(Number.isFinite(Date.parse(seenDuringStart)), '格式可被 Date.parse 解析');
  assert.equal(runtime.getSummary().expectedRunningSince, seenDuringStart, '面板摘要暴露该字段');

  runtime.bot = null;
  await runtime.stop('manual_stop');
  assert.equal(runtime.expectedRunningSince, null, '停止后清空, 避免陈旧基准被复用');
  assert.equal(runtime.getSummary().expectedRunningSince, null);
});

test('BotRuntime lightweight mode acknowledges server teleports', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });

  const client = new EventEmitter();
  const writes = [];
  client.write = (name, params) => { writes.push({ name, params }); };
  const bot = new EventEmitter();
  bot._client = client;
  bot.version = '1.21.11';

  // 直接调用真实的位置/传送确认附加路径(它与世界数据无关, 轻量模式必须自己确认传送)
  runtime.attachLightweightPositionTracking(bot);

  // 模拟服务端下发带 teleportId 的 position 包(轻量模式没有物理插件, 必须自己确认)
  client.emit('position', { x: 1, y: 2, z: 3, yaw: 90, pitch: 0, flags: 0, teleportId: 42 });
  const ack = writes.find((entry) => entry.name === 'teleport_confirm');
  assert.ok(ack, '必须回传 teleport_confirm');
  assert.equal(ack.params.teleportId, 42);

  // 没有 teleportId 的普通 position 包不应产生确认
  writes.length = 0;
  client.emit('position', { x: 4, y: 5, z: 6, yaw: 0, pitch: 0, flags: 0 });
  assert.equal(writes.filter((entry) => entry.name === 'teleport_confirm').length, 0);

  runtime.eatFeature.detach();
  runtime.autoEatController.detach();
  runtime.treeFarmFeature.detach();
});

test('BotRuntime lightweight rotation round-trips (eat must not turn the bot)', () => {
  const runtime = createRuntime({
    config: {
      legacyConfig: makeLegacyConfig({ entityHandling: false, terrainHandling: false })
    }
  });

  const client = new EventEmitter();
  client.write = () => {};
  const bot = new EventEmitter();
  bot._client = client;
  bot.version = '1.21.11';

  runtime.attachLightweightPositionTracking(bot);

  // 服务端下发的朝向是 notchian 角度
  client.emit('position', { x: 0, y: 64, z: 0, yaw: 90, pitch: 45, flags: 0, teleportId: 7 });

  // 存储必须与 mineflayer 的 bot.entity 约定一致
  assert.ok(Math.abs(runtime.lastKnownYaw - (Math.PI - Math.PI / 2)) < 1e-9, 'yaw 应存成 PI - 90deg');
  assert.ok(Math.abs(runtime.lastKnownPitch - (-Math.PI / 4)) < 1e-9, 'pitch 应存成 -45deg');

  // 进食时注入 use_item.rotation 必须原样回到 notchian 角度(否则服务端会把视角转过去)
  const rotation = runtime.eatFeature.resolveUseItemRotation();
  assert.ok(Math.abs(rotation.y - 90) < 0.01, `yaw 应回到 90, 实际 ${rotation.y}`);
  assert.ok(Math.abs(rotation.x - 45) < 0.01, `pitch 应回到 45, 实际 ${rotation.x}`);

  runtime.eatFeature.detach();
  runtime.autoEatController.detach();
  runtime.treeFarmFeature.detach();
});

test('forceDestroyStaleSockets destroys every tracked leftover socket and clears the set', async () => {
  const runtime = createRuntime();
  const make = (name) => {
    const socket = {
      destroyed: false,
      destroy() {
        socket.destroyed = true;
      }
    };
    return { name, socket };
  };
  const a = make('a');
  const b = make('b');
  const c = make('c');
  runtime.staleClients.add(a);
  runtime.staleClients.add(b);
  runtime.staleClients.add(c);

  const destroyed = await runtime.forceDestroyStaleSockets();

  assert.equal(destroyed, 3, '应销毁全部 3 条残留 socket, 而不是只清最近一条');
  assert.equal(a.socket.destroyed, true);
  assert.equal(b.socket.destroyed, true);
  assert.equal(c.socket.destroyed, true);
  assert.equal(runtime.staleClients.size, 0);
});

test('finalizeEndedBot tracks the ended client for the next cleanup pass', async () => {
  const runtime = createRuntime();
  const socket = {
    destroyed: false,
    destroy() {
      socket.destroyed = true;
    }
  };
  const client = { socket };
  const bot = new EventEmitter();
  bot._client = client;
  runtime.bot = bot;

  await runtime.finalizeEndedBot(bot, 'end', { publishStopped: false });

  assert.equal(runtime.staleClients.has(client), true, '结束的连接应进入待清理集合');
  assert.equal(runtime.bot, null);
});

test('proxy duplicate-login end sets cooldown and floors the restart delay', async () => {
  const runtime = createRuntime();
  const socket = {
    destroyed: false,
    destroy() {
      socket.destroyed = true;
    }
  };
  const client = { socket };
  const bot = new EventEmitter();
  bot._client = client;
  bot.end = () => {};
  runtime.bot = bot;
  runtime.desiredRunning = true;

  await runtime.handleEnd(runtime.connectionEpoch, 'You are already connected to this proxy!');

  assert.ok(runtime.proxySessionBusyUntilMs > Date.now(), '代理重复登录应写入冷却截止时间');
  assert.ok(
    runtime.pendingRestartDelayMs >= 200000,
    `冷却期内的重启延迟应被抬高, 实际 ${runtime.pendingRestartDelayMs}`
  );

  runtime.clearRestartTimer();
});
