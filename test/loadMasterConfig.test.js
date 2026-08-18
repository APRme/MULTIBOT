const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadMasterConfig,
  normalizeAllowedOrigins,
  normalizeOpenAuthConfig,
  buildDiscoveredBotConfig
} = require('../src/config/loadMasterConfig');

test('loadMasterConfig resolves MULTIBOT sessions dir', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-legacy-repo-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(path.join(repoRoot, 'ASSN', 'example_bot'), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    defaults: {
      auth: 'microsoft',
      version: '1.21.11'
    },
    bots: [
      {
        id: 'apr-m',
        accountDir: 'example_bot',
        host: 'example.org',
        port: 25565,
        username: 'account@example.com',
        email: 'account@example.com'
      }
    ],
    discovery: {
      enabled: false
    }
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.equal(masterConfig.bots.length, 1);
  assert.equal(masterConfig.bots[0].paths.sessionsDir, path.join(appRoot, 'sessions'));
  assert.equal(masterConfig.bots[0].paths.authCacheDir, path.join(appRoot, 'auth-cache'));
  assert.equal(masterConfig.bots[0].paths.accountDir, path.join(repoRoot, 'ASSN', 'example_bot'));
  assert.equal(masterConfig.bots[0].paths.legacyModulesDir, path.join(appRoot, 'src', 'legacy', 'assn'));
  assert.equal(masterConfig.bots[0].paths.scriptsDir, path.join(appRoot, 'scripts'));
  assert.equal(masterConfig.bots[0].paths.foundEntitiesPath, path.join(repoRoot, 'ASSN', 'example_bot', 'found.txt'));
  assert.equal(masterConfig.bots[0].legacyConfig.fish, false);
  assert.equal(masterConfig.bots[0].legacyConfig.autoRestart, 0);
  assert.equal(masterConfig.bots[0].legacyConfig.attack.autoAttack, false);
  assert.equal(masterConfig.bots[0].legacyConfig.blockBreakDetection.enabled, false);
  assert.equal(masterConfig.bots[0].legacyConfig.monitoring.enabled, false);
  assert.equal(masterConfig.bots[0].checkTimeoutInterval, 30000);
  assert.equal(masterConfig.bots[0].restartDelayMs, 60000);
  assert.equal(masterConfig.bots[0].restartJitterMs, 120000);
  assert.deepEqual(masterConfig.api.allowedOrigins, [
    'http://127.0.0.1:18081',
    'http://localhost:18081'
  ]);
  assert.equal(masterConfig.api.bodyLimitBytes, 1024 * 1024);
  assert.equal(masterConfig.api.maxSseClients, 32);
  assert.deepEqual(masterConfig.protocolGuard, {
    enabled: true,
    ignoreMalformedNbtArrayPackets: true,
    burstLimit: 20,
    burstWindowMs: 60000,
    logParseErrors: true
  });
  assert.deepEqual(masterConfig.diagnostics, {
    memoryLogger: {
      enabled: false,
      intervalMs: 10000,
      filePath: './logs/memory-monitor.log'
    },
    memoryDetails: {
      enabled: false
    },
    apiAccessLogger: {
      enabled: true,
      filePath: './logs/api-access.log',
      logToConsole: false,
      includeHeaders: true,
      includeBodyPreview: false
    },
    lifecycleLogger: {
      enabled: true,
      filePath: './logs/lifecycle.log',
      logToConsole: false
    }
  });
  assert.deepEqual(masterConfig.aggregateLogging, {
    enabled: false,
    chat: true,
    playerList: true,
    chatBatchWindowMs: 100,
    playerListIntervalMinutes: 1
  });
  assert.deepEqual(masterConfig.consoleConnector, {
    historyLimit: 300
  });
});

test('normalizeAllowedOrigins validates and deduplicates exact HTTP origins', () => {
  assert.deepEqual(normalizeAllowedOrigins([
    'https://panel.example',
    'https://panel.example',
    'http://127.0.0.1:18081'
  ]), [
    'https://panel.example',
    'http://127.0.0.1:18081'
  ]);
  assert.throws(
    () => normalizeAllowedOrigins(['https://panel.example/path']),
    /invalid api\.allowedOrigins entry/
  );
});

test('loadMasterConfig rejects unsafe server teleport prompt matchers', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-teleport-matchers-invalid-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const serverDir = path.join(appRoot, 'BOTS', 'server_a');
  const botDir = path.join(serverDir, 'bot_a');
  const configPath = path.join(appRoot, 'multibot.config.json');
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    host: '127.0.0.1',
    teleportPromptMatchers: {
      tpa: ['(?<sender>[A-Za-z0-9_]{1,16}) 请求传送到你的位置']
    }
  }), 'utf8');
  fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
    username: 'bot@example.com'
  }), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    api: { token: 'test-token' },
    discovery: { enabled: true, botsRoot: './BOTS' }
  }), 'utf8');

  assert.throws(() => loadMasterConfig({ configPath, repoRoot, appRoot }), /must be anchored/);
});

test('loadMasterConfig discovers bots from BOTS server and bot folders', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-repo-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const botsRoot = path.join(appRoot, 'BOTS');
  const serverDir = path.join(botsRoot, 'my_server_localhost');
  const botDir = path.join(serverDir, 'example_trusted');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(botDir, { recursive: true });

  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    host: '127.0.0.1',
    port: 25565,
    version: '1.21.11',
    restartJitterMs: 30000,
    checkTimeoutInterval: 90000,
    teleportPromptMatchers: {
      stripLines: ['^使用 /tpaccept 接受，使用 /tpdeny 拒绝。$'],
      tpa: ['^(?<sender>[A-Za-z0-9_]{1,16}) 向你发起了传送申请$'],
      tpahere: ['^(?<sender>[A-Za-z0-9_]{1,16}) 邀请你传送到其位置$']
    }
  }), 'utf8');

  fs.writeFileSync(path.join(serverDir, 'default.config.json'), JSON.stringify({
    autoStart: true,
    teleport: {
      mode: 'trustedPlayers',
      whitelistFile: 'shared.txt'
    },
    recording: {
      enabled: true
    }
  }), 'utf8');

  fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
    enabled: true,
    autoStart: false,
    email: 'example-bot@example.com',
    username: 'example-bot@example.com',
    trustedPlayers: ['example_player'],
    autoRestart: 30,
    teleport: {
      whitelistFile: 'bot.txt'
    }
  }), 'utf8');

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    defaults: {
      auth: 'microsoft',
      disableChatSigning: true
    },
    discovery: {
      enabled: true,
      botsRoot: './BOTS'
    },
    bots: []
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.equal(masterConfig.bots.length, 1);
  assert.equal(masterConfig.bots[0].id, 'my_server_localhost__example_trusted');
  assert.equal(masterConfig.bots[0].host, '127.0.0.1');
  assert.equal(masterConfig.bots[0].port, 25565);
  assert.equal(masterConfig.bots[0].restartJitterMs, 30000);
  assert.equal(masterConfig.bots[0].checkTimeoutInterval, 90000);
  assert.equal(masterConfig.bots[0].username, 'example-bot@example.com');
  assert.deepEqual(masterConfig.bots[0].teleportPromptMatchers, {
    stripLines: ['^使用 /tpaccept 接受，使用 /tpdeny 拒绝。$'],
    tpa: ['^(?<sender>[A-Za-z0-9_]{1,16}) 向你发起了传送申请$'],
    tpahere: ['^(?<sender>[A-Za-z0-9_]{1,16}) 邀请你传送到其位置$']
  });
  assert.equal(masterConfig.bots[0].paths.accountDir, botDir);
  assert.equal(masterConfig.bots[0].paths.serverConfigPath, path.join(serverDir, 'server.json'));
  assert.equal(masterConfig.bots[0].paths.defaultLegacyConfigPath, path.join(serverDir, 'default.config.json'));
  assert.equal(masterConfig.bots[0].paths.sessionsDir, path.join(appRoot, 'sessions'));
  assert.equal(masterConfig.bots[0].paths.authCacheDir, path.join(appRoot, 'auth-cache'));
  assert.equal(masterConfig.bots[0].paths.legacyModulesDir, path.join(appRoot, 'src', 'legacy', 'assn'));
  assert.equal(masterConfig.bots[0].paths.scriptsDir, path.join(appRoot, 'scripts'));
  assert.equal(masterConfig.bots[0].paths.foundEntitiesPath, path.join(botDir, 'found.txt'));
  assert.equal(masterConfig.bots[0].legacyConfig.fish, false);
  assert.equal(masterConfig.bots[0].legacyConfig.autoRestart, 30);
  assert.equal(masterConfig.bots[0].autoStart, false);
  assert.equal(masterConfig.bots[0].legacyConfig.teleport.mode, 'trustedPlayers');
  assert.equal(masterConfig.bots[0].legacyConfig.teleport.whitelistFile, 'bot.txt');
  assert.equal(masterConfig.bots[0].legacyConfig.recording.enabled, true);
  assert.equal(masterConfig.bots[0].legacyConfig.attack.autoAttack, false);
  assert.equal(masterConfig.bots[0].legacyConfig.blockBreakDetection.enabled, false);
  assert.equal(masterConfig.bots[0].legacyConfig.monitoring.enabled, false);
});

test('loadMasterConfig reads restart jitter from server connection overrides', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-restart-jitter-connection-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const botsRoot = path.join(appRoot, 'BOTS');
  const serverDir = path.join(botsRoot, 'my_server');
  const botDir = path.join(serverDir, 'Alpha');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(botDir, { recursive: true });

  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    connection: {
      host: '127.0.0.1',
      port: 25565,
      restartDelayMs: 20000,
      restartJitterMs: 45000,
      checkTimeoutInterval: 120000
    }
  }), 'utf8');

  fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
    enabled: true,
    autoStart: false,
    email: 'alpha@example.com',
    username: 'Alpha'
  }), 'utf8');

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    defaults: {
      auth: 'microsoft',
      disableChatSigning: true
    },
    discovery: {
      enabled: true,
      botsRoot: './BOTS'
    },
    bots: []
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.equal(masterConfig.bots.length, 1);
  assert.equal(masterConfig.bots[0].restartDelayMs, 20000);
  assert.equal(masterConfig.bots[0].restartJitterMs, 45000);
  assert.equal(masterConfig.bots[0].checkTimeoutInterval, 120000);
});

test('loadMasterConfig falls back invalid restart jitter values to defaults', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-restart-jitter-invalid-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const botsRoot = path.join(appRoot, 'BOTS');
  const serverDir = path.join(botsRoot, 'my_server');
  const botDir = path.join(serverDir, 'Alpha');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(botDir, { recursive: true });

  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    host: '127.0.0.1',
    port: 25565,
    restartJitterMs: -1,
    checkTimeoutInterval: 0
  }), 'utf8');

  fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
    enabled: true,
    autoStart: false,
    email: 'alpha@example.com',
    username: 'Alpha',
    restartJitterMs: 'abc',
    checkTimeoutInterval: 'abc'
  }), 'utf8');

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    defaults: {
      auth: 'microsoft',
      disableChatSigning: true
    },
    discovery: {
      enabled: true,
      botsRoot: './BOTS'
    },
    bots: []
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.equal(masterConfig.bots.length, 1);
  assert.equal(masterConfig.bots[0].restartDelayMs, 60000);
  assert.equal(masterConfig.bots[0].restartJitterMs, 120000);
  assert.equal(masterConfig.bots[0].checkTimeoutInterval, 30000);
});

test('loadMasterConfig normalizes console connector history limit', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-console-connector-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(path.join(repoRoot, 'ASSN', 'example_bot'), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    consoleConnector: {
      historyLimit: 800
    },
    bots: [
      {
        id: 'apr-m',
        accountDir: 'example_bot',
        host: 'example.org',
        port: 25565,
        username: 'account@example.com',
        email: 'account@example.com'
      }
    ],
    discovery: {
      enabled: false
    }
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.deepEqual(masterConfig.consoleConnector, {
    historyLimit: 800
  });
});

test('loadMasterConfig falls back invalid console connector history limit', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-console-connector-invalid-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(path.join(repoRoot, 'ASSN', 'example_bot'), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    consoleConnector: {
      historyLimit: 0
    },
    bots: [
      {
        id: 'apr-m',
        accountDir: 'example_bot',
        host: 'example.org',
        port: 25565,
        username: 'account@example.com',
        email: 'account@example.com'
      }
    ],
    discovery: {
      enabled: false
    }
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.deepEqual(masterConfig.consoleConnector, {
    historyLimit: 300
  });
});

test('loadMasterConfig normalizes protocol guard overrides', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-protocol-guard-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(path.join(repoRoot, 'ASSN', 'example_bot'), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    protocolGuard: {
      enabled: true,
      ignoreMalformedNbtArrayPackets: true,
      burstLimit: 8,
      burstWindowMs: 120000,
      logParseErrors: false
    },
    bots: [
      {
        id: 'apr-m',
        accountDir: 'example_bot',
        host: 'example.org',
        port: 25565,
        username: 'account@example.com',
        email: 'account@example.com'
      }
    ],
    discovery: {
      enabled: false
    }
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.deepEqual(masterConfig.protocolGuard, {
    enabled: true,
    ignoreMalformedNbtArrayPackets: true,
    burstLimit: 8,
    burstWindowMs: 120000,
    logParseErrors: false
  });
});

test('loadMasterConfig normalizes temporary memory logger settings', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-memory-logger-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(path.join(repoRoot, 'ASSN', 'example_bot'), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    diagnostics: {
      memoryLogger: {
        enabled: true,
        intervalMs: 15000,
        filePath: './logs/custom-memory.log'
      },
      memoryDetails: {
        enabled: true
      },
      apiAccessLogger: {
        enabled: false,
        filePath: './logs/custom-api-access.log',
        logToConsole: true,
        includeHeaders: false
      },
      lifecycleLogger: {
        enabled: false,
        filePath: './logs/custom-lifecycle.log',
        logToConsole: true
      }
    },
    bots: [
      {
        id: 'apr-m',
        accountDir: 'example_bot',
        host: 'example.org',
        port: 25565,
        username: 'account@example.com',
        email: 'account@example.com'
      }
    ],
    discovery: {
      enabled: false
    }
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.deepEqual(masterConfig.diagnostics, {
    memoryLogger: {
      enabled: true,
      intervalMs: 15000,
      filePath: './logs/custom-memory.log'
    },
    memoryDetails: {
      enabled: true
    },
    apiAccessLogger: {
      enabled: false,
      filePath: './logs/custom-api-access.log',
      logToConsole: true,
      includeHeaders: false,
      includeBodyPreview: false
    },
    lifecycleLogger: {
      enabled: false,
      filePath: './logs/custom-lifecycle.log',
      logToConsole: true
    }
  });
});

test('loadMasterConfig enables API access logging by default', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-api-access-logger-default-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(path.join(repoRoot, 'ASSN', 'example_bot'), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    bots: [
      {
        id: 'apr-m',
        accountDir: 'example_bot',
        host: 'example.org',
        port: 25565,
        username: 'account@example.com',
        email: 'account@example.com'
      }
    ],
    discovery: {
      enabled: false
    }
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.deepEqual(masterConfig.diagnostics.apiAccessLogger, {
    enabled: true,
    filePath: './logs/api-access.log',
    logToConsole: false,
    includeHeaders: true,
    includeBodyPreview: false
  });
});

test('loadMasterConfig normalizes aggregate logging settings', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-aggregate-logging-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(path.join(repoRoot, 'ASSN', 'example_bot'), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    aggregateLogging: {
      enabled: true,
      chat: false,
      playerList: true,
      chatBatchWindowMs: 250,
      playerListIntervalMinutes: 0.5
    },
    bots: [
      {
        id: 'apr-m',
        accountDir: 'example_bot',
        host: 'example.org',
        port: 25565,
        username: 'account@example.com',
        email: 'account@example.com'
      }
    ],
    discovery: {
      enabled: false
    }
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.deepEqual(masterConfig.aggregateLogging, {
    enabled: true,
    chat: false,
    playerList: true,
    chatBatchWindowMs: 250,
    playerListIntervalMinutes: 0.5
  });
});

test('loadMasterConfig falls back invalid aggregate logging numbers to defaults', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-aggregate-logging-invalid-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(path.join(repoRoot, 'ASSN', 'example_bot'), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify({
    api: {
      host: '127.0.0.1',
      port: 18080,
      token: 'test-token'
    },
    aggregateLogging: {
      enabled: true,
      chatBatchWindowMs: 0,
      playerListIntervalMinutes: -1
    },
    bots: [
      {
        id: 'apr-m',
        accountDir: 'example_bot',
        host: 'example.org',
        port: 25565,
        username: 'account@example.com',
        email: 'account@example.com'
      }
    ],
    discovery: {
      enabled: false
    }
  }), 'utf8');

  const masterConfig = loadMasterConfig({
    configPath,
    repoRoot,
    appRoot
  });

  assert.deepEqual(masterConfig.aggregateLogging, {
    enabled: true,
    chat: true,
    playerList: true,
    chatBatchWindowMs: 100,
    playerListIntervalMinutes: 1
  });
});

test('normalizeOpenAuthConfig defaults and validates request timeout bounds', () => {
  assert.deepEqual(normalizeOpenAuthConfig(), {
    enabled: false,
    requestTimeoutMs: 4500
  });
  assert.deepEqual(normalizeOpenAuthConfig({
    enabled: false,
    requestTimeoutMs: 1000
  }), {
    enabled: false,
    requestTimeoutMs: 1000
  });
  assert.deepEqual(normalizeOpenAuthConfig({
    enabled: false,
    requestTimeoutMs: 5000
  }), {
    enabled: false,
    requestTimeoutMs: 5000
  });
  assert.throws(
    () => normalizeOpenAuthConfig({ enabled: false, requestTimeoutMs: 999 }),
    /requestTimeoutMs must be an integer from 1000 to 5000/
  );
  assert.throws(
    () => normalizeOpenAuthConfig({ enabled: false, requestTimeoutMs: 5001 }),
    /requestTimeoutMs must be an integer from 1000 to 5000/
  );
});

test('loadMasterConfig applies server-only OpenAuth and locks server connection fields', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-open-auth-discovery-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const serverDir = path.join(appRoot, 'BOTS', 'via-proxy');
  const botDir = path.join(serverDir, 'Alpha');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    host: 'top-level.example',
    port: 25565,
    auth: 'microsoft',
    version: '1.21.11',
    connection: {
      host: 'proxy.example',
      port: 25568,
      auth: 'microsoft',
      version: '1.21.11'
    },
    openAuth: {
      enabled: true,
      requestTimeoutMs: 5000
    }
  }), 'utf8');
  fs.writeFileSync(path.join(serverDir, 'default.config.json'), JSON.stringify({
    host: 'default.example',
    port: 25567,
    auth: 'offline',
    version: '1.20.1',
    openAuth: {
      enabled: true,
      requestTimeoutMs: 1000
    }
  }), 'utf8');
  fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
    username: 'alpha@example.com',
    email: 'alpha@example.com',
    host: 'bot.example',
    port: 25566,
    auth: 'offline',
    version: '1.20.4',
    openAuth: {
      enabled: false,
      requestTimeoutMs: 1000
    },
    restartDelayMs: 12345
  }), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    api: { token: 'test-token' },
    defaults: {
      auth: 'microsoft',
      openAuth: {
        enabled: true,
        requestTimeoutMs: 1000
      }
    },
    discovery: {
      enabled: true,
      botsRoot: './BOTS'
    },
    bots: []
  }), 'utf8');

  const masterConfig = loadMasterConfig({ configPath, repoRoot, appRoot });
  const bot = masterConfig.bots[0];

  assert.equal(bot.host, 'proxy.example');
  assert.equal(bot.port, 25568);
  assert.equal(bot.auth, 'microsoft');
  assert.equal(bot.version, '1.21.11');
  assert.equal(bot.restartDelayMs, 12345);
  assert.deepEqual(bot.openAuth, {
    enabled: true,
    requestTimeoutMs: 5000
  });
});

test('loadMasterConfig applies server-only OpenAuth connection locking to explicit server instances', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-open-auth-explicit-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const serverDir = path.join(appRoot, 'BOTS', 'via-proxy');
  const botDir = path.join(serverDir, 'Alpha');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    connection: {
      host: 'proxy.example',
      port: 25568,
      auth: 'microsoft',
      version: '1.21.11'
    },
    openAuth: {
      enabled: true,
      requestTimeoutMs: 2500
    }
  }), 'utf8');
  fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
    username: 'alpha@example.com',
    email: 'alpha@example.com'
  }), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    api: { token: 'test-token' },
    defaults: { auth: 'microsoft' },
    bots: [{
      id: 'alpha',
      serverDir: 'via-proxy',
      botDir: 'Alpha',
      host: 'bot.example',
      port: 25566,
      auth: 'offline',
      version: '1.20.4',
      username: 'alpha@example.com',
      email: 'alpha@example.com',
      openAuth: { enabled: false }
    }],
    discovery: { enabled: false }
  }), 'utf8');

  const masterConfig = loadMasterConfig({ configPath, repoRoot, appRoot });
  const bot = masterConfig.bots[0];

  assert.equal(bot.host, 'proxy.example');
  assert.equal(bot.port, 25568);
  assert.equal(bot.auth, 'microsoft');
  assert.equal(bot.version, '1.21.11');
  assert.deepEqual(bot.openAuth, {
    enabled: true,
    requestTimeoutMs: 2500
  });
});

test('normalizeOpenAuthConfig rejects enabled configurations without the required server connection', () => {
  assert.throws(
    () => normalizeOpenAuthConfig({ enabled: true }, {
      host: 'proxy.example',
      port: 25568,
      auth: 'offline',
      version: '1.21.11'
    }),
    /server auth to be microsoft/
  );

  assert.throws(
    () => normalizeOpenAuthConfig({ enabled: true }, {
      host: 'proxy.example',
      port: 25568,
      auth: 'microsoft',
      version: '26.1.2'
    }),
    /server version 1\.21\.11/
  );

  assert.throws(
    () => normalizeOpenAuthConfig({ enabled: true }, {
      host: 'proxy.example',
      port: 25568,
      auth: 'microsoft'
    }),
    /connection field: version/
  );

  assert.throws(
    () => normalizeOpenAuthConfig({ enabled: true }, {
      host: 'https://proxy.example:25568',
      port: 25568,
      auth: 'microsoft',
      version: '1.21.11'
    }),
    /hostname or IP address, not a URL/
  );
});

test('loadMasterConfig ignores OpenAuth values from master defaults and bot config', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-open-auth-source-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');
  const accountDir = path.join(repoRoot, 'ASSN', 'Alpha');

  fs.mkdirSync(accountDir, { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    api: { token: 'test-token' },
    defaults: {
      auth: 'microsoft',
      openAuth: { enabled: true, requestTimeoutMs: 1000 }
    },
    bots: [{
      id: 'alpha',
      accountDir: 'Alpha',
      host: 'proxy.example',
      port: 25568,
      auth: 'microsoft',
      version: '1.21.11',
      username: 'alpha@example.com',
      email: 'alpha@example.com',
      openAuth: { enabled: true, requestTimeoutMs: 1000 }
    }],
    discovery: { enabled: false }
  }), 'utf8');

  const masterConfig = loadMasterConfig({ configPath, repoRoot, appRoot });

  assert.deepEqual(masterConfig.bots[0].openAuth, {
    enabled: false,
    requestTimeoutMs: 4500
  });
});

test('loadMasterConfig reads server-level restart schedule for discovered bots and bot cannot override', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-restart-schedule-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const botsRoot = path.join(appRoot, 'BOTS');
  const serverDir = path.join(botsRoot, 'my_server');
  const botDir = path.join(serverDir, 'Alpha');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    host: '127.0.0.1',
    port: 25565,
    restartDelayScheduleMs: [60000, 300000, 600000],
    restartDelayScheduleRepeatLast: false
  }), 'utf8');
  fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
    username: 'alpha@example.com',
    email: 'alpha@example.com',
    restartDelayScheduleMs: [1, 2, 3],
    restartDelayScheduleRepeatLast: false
  }), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    api: { token: 'test-token' },
    discovery: {
      enabled: true,
      botsRoot: './BOTS'
    },
    bots: []
  }), 'utf8');

  const masterConfig = loadMasterConfig({ configPath, repoRoot, appRoot });
  const bot = masterConfig.bots[0];

  assert.deepEqual(bot.restartDelayScheduleMs, [60000, 300000, 600000]);
  assert.equal(bot.restartDelayScheduleRepeatLast, false);
});

test('loadMasterConfig reads server-level restart schedule for explicit server instances', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-restart-schedule-explicit-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const serverDir = path.join(appRoot, 'BOTS', 'via-proxy');
  const botDir = path.join(serverDir, 'Alpha');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    host: '127.0.0.1',
    port: 25568,
    restartDelayScheduleMs: [60000, 300000]
  }), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    api: { token: 'test-token' },
    discovery: {
      enabled: false
    },
    bots: [
      {
        id: 'alpha',
        serverDir: 'via-proxy',
        botDir: 'Alpha',
        username: 'alpha@example.com',
        email: 'alpha@example.com'
      }
    ]
  }), 'utf8');

  const masterConfig = loadMasterConfig({ configPath, repoRoot, appRoot });
  const bot = masterConfig.bots[0];

  assert.deepEqual(bot.restartDelayScheduleMs, [60000, 300000]);
  assert.equal(bot.restartDelayScheduleRepeatLast, true);
});

test('loadMasterConfig defaults restart schedule fields to disabled', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-restart-schedule-default-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    api: { token: 'test-token' },
    discovery: {
      enabled: false
    },
    bots: [
      {
        id: 'alpha',
        accountDir: 'Alpha',
        host: '127.0.0.1',
        port: 25565,
        username: 'alpha@example.com',
        email: 'alpha@example.com'
      }
    ]
  }), 'utf8');

  const masterConfig = loadMasterConfig({ configPath, repoRoot, appRoot });
  const bot = masterConfig.bots[0];

  assert.equal(bot.restartDelayScheduleMs, null);
  assert.equal(bot.restartDelayScheduleRepeatLast, true);
});

test('loadMasterConfig rejects invalid restartDelayScheduleMs values', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-restart-schedule-invalid-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const botsRoot = path.join(appRoot, 'BOTS');
  const serverDir = path.join(botsRoot, 'my_server');
  const botDir = path.join(serverDir, 'Alpha');
  const configPath = path.join(appRoot, 'multibot.config.json');

  const invalidSchedules = [
    [],
    [-1],
    [60.5],
    ['60000'],
    '60000'
  ];

  for (const invalidSchedule of invalidSchedules) {
    fs.rmSync(botsRoot, { recursive: true, force: true });
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
      host: '127.0.0.1',
      port: 25565,
      restartDelayScheduleMs: invalidSchedule
    }), 'utf8');
    fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
      username: 'alpha@example.com',
      email: 'alpha@example.com'
    }), 'utf8');
    fs.writeFileSync(configPath, JSON.stringify({
      api: { token: 'test-token' },
      discovery: {
        enabled: true,
        botsRoot: './BOTS'
      },
      bots: []
    }), 'utf8');

    assert.throws(
      () => loadMasterConfig({ configPath, repoRoot, appRoot }),
      /restartDelayScheduleMs must be a non-empty array of non-negative integers/
    );
  }
});

test('loadMasterConfig rejects non-boolean restartDelayScheduleRepeatLast', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-restart-schedule-repeat-invalid-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const botsRoot = path.join(appRoot, 'BOTS');
  const serverDir = path.join(botsRoot, 'my_server');
  const botDir = path.join(serverDir, 'Alpha');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    host: '127.0.0.1',
    port: 25565,
    restartDelayScheduleMs: [60000],
    restartDelayScheduleRepeatLast: 'yes'
  }), 'utf8');
  fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
    username: 'alpha@example.com',
    email: 'alpha@example.com'
  }), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    api: { token: 'test-token' },
    discovery: {
      enabled: true,
      botsRoot: './BOTS'
    },
    bots: []
  }), 'utf8');

  assert.throws(
    () => loadMasterConfig({ configPath, repoRoot, appRoot }),
    /restartDelayScheduleRepeatLast must be a boolean/
  );
});

test('buildDiscoveredBotConfig matches discovery for restart schedule fields', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-restart-schedule-rebuild-'));
  const appRoot = path.join(repoRoot, 'tests', 'MULTIBOT');
  const botsRoot = path.join(appRoot, 'BOTS');
  const serverDir = path.join(botsRoot, 'my_server');
  const botDir = path.join(serverDir, 'Alpha');
  const configPath = path.join(appRoot, 'multibot.config.json');

  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
    host: '127.0.0.1',
    port: 25565,
    restartDelayScheduleMs: [60000, 300000, 900000],
    restartDelayScheduleRepeatLast: true
  }), 'utf8');
  fs.writeFileSync(path.join(botDir, 'config.json'), JSON.stringify({
    username: 'alpha@example.com',
    email: 'alpha@example.com'
  }), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    api: { token: 'test-token' },
    discovery: {
      enabled: true,
      botsRoot: './BOTS'
    },
    bots: []
  }), 'utf8');

  const discovered = loadMasterConfig({ configPath, repoRoot, appRoot }).bots[0];
  const rebuilt = buildDiscoveredBotConfig({
    repoRoot,
    appRoot,
    defaults: {},
    serverDirName: 'my_server',
    botDirName: 'Alpha'
  });

  assert.deepEqual(rebuilt.restartDelayScheduleMs, discovered.restartDelayScheduleMs);
  assert.equal(rebuilt.restartDelayScheduleRepeatLast, discovered.restartDelayScheduleRepeatLast);
});
