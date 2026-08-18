const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
    diagnosticsConfig: overrides.diagnosticsConfig || null,
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
    scriptRunning: true
  });
  assert.deepEqual(summary.capabilities, {
    entityHandling: true,
    terrainHandling: true
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
    terrainHandling: true
  });
  assert.deepEqual(runtime.getSummary().capabilities, {
    entityHandling: false,
    terrainHandling: true
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
        destroyed: false
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
  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.lastError, 'createBot failed');
  assert.ok(logs.some((entry) => entry.botId === 'alpha' && entry.message.includes('[BOT] startup failed')));
  assert.ok(events.some((entry) => entry.event === 'botStatus' && entry.data.state === 'stopped'));
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

  await runtime.stop('manual_stop');

  assert.equal(socket.destroyed, true);
  assert.equal(runtime.state, 'stopped');
});
