const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandDispatcher } = require('../src/command/CommandDispatcher');

function createContext(overrides = {}) {
  const messages = [];
  return {
    source: overrides.source || 'http',
    sender: overrides.sender || 'tester',
    replyInfo(message) {
      messages.push({ type: 'info', message });
    },
    replyError(message) {
      messages.push({ type: 'error', message });
    },
    get messages() {
      return messages;
    }
  };
}

function createDispatcher(calls, overrides = {}) {
  const capabilities = overrides.capabilities || {
    entityHandling: true,
    terrainHandling: true
  };

  const runtime = {
    getCapabilities() {
      return capabilities;
    },
    getHealthText() {
      return 'ok';
    },
    getPositionText() {
      return 'pos';
    },
    sendChat(message) {
      calls.push(['sendChat', message]);
    },
    broadcastSend(message) {
      calls.push(['broadcastSend', message]);
      return ['bot-a'];
    },
    async broadcastCommand(command, options) {
      calls.push(['broadcastCommand', command, options]);
      return {
        command,
        successBotIds: ['bot-a'],
        failed: [],
        skippedBotIds: ['bot-b']
      };
    },
    async changeSlot(slotNumber) {
      calls.push(['changeSlot', slotNumber]);
    },
    stopAllActions() {
      calls.push(['stopAllActions']);
    },
    getEntityListText() {
      return 'entities';
    },
    ...(overrides.runtime || {})
  };

  return new CommandDispatcher({
    runtime,
    lockFeature: {
      async handleLockCommand() { return false; },
      async handleUnlockCommand() { return false; },
      shouldEnforceWhisperLock() { return false; },
      isAllowedWhisperCommandDuringLock() { return true; },
      replyTeleportLockBlocked() {
        calls.push(['lockBlocked']);
      },
      ...(overrides.lockFeature || {})
    },
    inventoryFeature: {
      async handleCommand(context, trimmed) {
        calls.push(['inv', trimmed]);
      },
      getQuickbarText() {
        return '快捷栏信息: 1:stone';
      },
      ...(overrides.inventoryFeature || {})
    },
    movementFeature: {
      goto(x, y, z, movementOptions) {
        calls.push(['goto', x, y, z, movementOptions]);
      },
      async lookDegrees(context, yaw, pitch) {
        calls.push(['look', yaw, pitch]);
        return true;
      },
      toggleSneak() {
        calls.push(['shift']);
        return true;
      },
      toggleCircle() {
        calls.push(['circle']);
        return true;
      },
      stopCircle() {
        calls.push(['stopCircle']);
      },
      ...(overrides.movementFeature || {})
    },
    rideFeature: {
      async handleRideCommand(context, parts) {
        calls.push(['ride', parts.join(' ')]);
        return true;
      },
      ...(overrides.rideFeature || {})
    },
    fishFeature: {
      async handleFishCommand() {
        calls.push(['fish']);
        return true;
      },
      ...(overrides.fishFeature || {})
    },
    eatFeature: {
      async handleEatCommand(context, itemArg) {
        calls.push(['eat', itemArg]);
        return true;
      },
      ...(overrides.eatFeature || {})
    },
    attackFeature: {
      async handleAttackNearestCommand() {
        calls.push(['attack']);
        return true;
      },
      ...(overrides.attackFeature || {})
    },
    entityInteractFeature: {
      async handleInteractNearestCommand() {
        calls.push(['interact']);
        return true;
      },
      ...(overrides.entityInteractFeature || {})
    },
    blockUseFeature: {
      async handleUseBlockCommand(context, x, y, z) {
        calls.push(['useblock', x, y, z]);
        return true;
      },
      async handleContinuousUseBlockCommand(context, x, y, z) {
        calls.push(['cuseblock', x, y, z]);
        return true;
      },
      stopContinuousPlacement() {
        calls.push(['stopplace']);
        return true;
      },
      ...(overrides.blockUseFeature || {})
    },
    digFeature: {
      async handleDigCommand(context, x, y, z) {
        calls.push(['dig', x, y, z]);
        return true;
      },
      async handleAreaDigCommand(context, x1, y1, z1, x2, y2, z2) {
        calls.push(['areadig', x1, y1, z1, x2, y2, z2]);
        return true;
      },
      stopDigging() {
        calls.push(['stopdig']);
        return true;
      },
      ...(overrides.digFeature || {})
    },
    cplaceFeature: {
      async handleCommand(context, trimmed) {
        calls.push(['cplace', trimmed]);
        return true;
      },
      async handleStopCommand() {
        calls.push(['stopcplace']);
        return true;
      },
      ...(overrides.cplaceFeature || {})
    },
    vaultFeature: {
      handleCommand() {
        calls.push(['vault']);
      },
      ...(overrides.vaultFeature || {})
    },
    scriptFeature: {
      async tryHandleScriptControlCommand() { return false; },
      stopActiveScript() {
        calls.push(['stopscript']);
        return false;
      },
      ...(overrides.scriptFeature || {})
    },
    recorderFeature: {
      getStatusText() { return 'record'; },
      async finish() {
        calls.push(['finishrecord']);
      },
      async abort() {
        calls.push(['abortrecord']);
      },
      ...(overrides.recorderFeature || {})
    },
    teleportFeature: {
      refreshWhitelist() {
        calls.push(['reloadwhitelist']);
        return { count: 2 };
      },
      ...(overrides.teleportFeature || {})
    }
  });
}

test('CommandDispatcher routes migrated MULTIBOT commands', async () => {
  const calls = [];
  const dispatcher = createDispatcher(calls);
  const context = createContext();

  await dispatcher.dispatch('help', context);
  await dispatcher.dispatch('send hello', context);
  await dispatcher.dispatch('broadcast send hi all', context);
  await dispatcher.dispatch('broadcast inv dropall', context);
  await dispatcher.dispatch('broadcast eat bread', context);
  await dispatcher.dispatch('inv quickbar', context);
  await dispatcher.dispatch('changeslot info', context);
  await dispatcher.dispatch('changeslot 2', context);
  await dispatcher.dispatch('look 90 0', context);
  await dispatcher.dispatch('goto 1 2 3 true', context);
  await dispatcher.dispatch('shift', context);
  await dispatcher.dispatch('circle', context);
  await dispatcher.dispatch('ride player', context);
  await dispatcher.dispatch('fish', context);
  await dispatcher.dispatch('eat bread', context);
  await dispatcher.dispatch('attack @n', context);
  await dispatcher.dispatch('interact @n', context);
  await dispatcher.dispatch('useblock 10 64 10', context);
  await dispatcher.dispatch('cuseblock 10 64 11', context);
  await dispatcher.dispatch('stopplace', context);
  await dispatcher.dispatch('stop cuseblock', context);
  await dispatcher.dispatch('dig 1 2 3', context);
  await dispatcher.dispatch('dig 1 2 3 4 5 6', context);
  await dispatcher.dispatch('stopdig', context);
  await dispatcher.dispatch('cplace 1000', context);
  await dispatcher.dispatch('stopcplace', context);
  await dispatcher.dispatch('vault', context);
  await dispatcher.dispatch('reloadwhitelist', context);
  await dispatcher.dispatch('recordstatus', context);
  await dispatcher.dispatch('finishrecord', context);
  await dispatcher.dispatch('abortrecord', context);
  await dispatcher.dispatch('stop', context);
  await dispatcher.dispatch('entity list', context);

  assert.deepEqual(calls, [
    ['sendChat', 'hello'],
    ['broadcastSend', 'hi all'],
    ['broadcastCommand', 'inv dropall', { source: 'http', sender: 'tester' }],
    ['broadcastCommand', 'eat bread', { source: 'http', sender: 'tester' }],
    ['inv', 'inv quickbar'],
    ['changeSlot', 2],
    ['look', 90, 0],
    ['goto', 1, 2, 3, ['sprint']],
    ['shift'],
    ['circle'],
    ['stopCircle'],
    ['ride', 'ride player'],
    ['fish'],
    ['eat', 'bread'],
    ['attack'],
    ['interact'],
    ['useblock', 10, 64, 10],
    ['cuseblock', 10, 64, 11],
    ['stopplace'],
    ['stopplace'],
    ['dig', 1, 2, 3],
    ['areadig', 1, 2, 3, 4, 5, 6],
    ['stopdig'],
    ['cplace', 'cplace 1000'],
    ['stopcplace'],
    ['vault'],
    ['reloadwhitelist'],
    ['finishrecord'],
    ['abortrecord'],
    ['stopAllActions'],
    ['stopscript']
  ]);

  assert.ok(context.messages.some((entry) => entry.message.includes('broadcast inv <子命令>')));
  assert.ok(context.messages.some((entry) => entry.message.includes('broadcast eat <物品id>')));
  assert.ok(context.messages.some((entry) => entry.message.includes('当前能力: entityHandling=on terrainHandling=on')));
  assert.ok(context.messages.some((entry) => entry.message.includes('已广播执行: inv dropall')));
  assert.ok(context.messages.some((entry) => entry.message.includes('已广播执行: eat bread')));
  assert.ok(context.messages.some((entry) => entry.message.includes('快捷栏信息: 1:stone')));
  assert.ok(context.messages.some((entry) => entry.message.includes('当前共有 2 个玩家')));
  assert.ok(context.messages.some((entry) => entry.message === 'record'));
  assert.ok(context.messages.some((entry) => entry.message === 'entities'));
});

test('CommandDispatcher validates broadcast syntax', async () => {
  const calls = [];
  const dispatcher = createDispatcher(calls);
  const context = createContext();

  await dispatcher.dispatch('broadcast look 1 2', context);
  await dispatcher.dispatch('broadcast send', context);
  await dispatcher.dispatch('broadcast inv', context);
  await dispatcher.dispatch('broadcast eat', context);

  assert.deepEqual(calls, []);
  assert.equal(context.messages.length, 4);
  assert.equal(context.messages[0].type, 'error');
  assert.match(context.messages[0].message, /send/);
  assert.equal(context.messages[1].type, 'error');
  assert.equal(context.messages[2].type, 'error');
  assert.match(context.messages[2].message, /broadcast inv/);
  assert.equal(context.messages[3].type, 'error');
  assert.match(context.messages[3].message, /broadcast eat/);
});

test('CommandDispatcher respects whisper lock enforcement', async () => {
  const calls = [];
  const dispatcher = createDispatcher(calls, {
    lockFeature: {
      async handleLockCommand() { return false; },
      async handleUnlockCommand() { return false; },
      shouldEnforceWhisperLock() { return true; },
      isAllowedWhisperCommandDuringLock() { return false; },
      replyTeleportLockBlocked() {
        calls.push(['lockBlocked']);
      }
    }
  });

  await dispatcher.dispatch('goto 1 2 3', createContext({ source: 'whisper', sender: 'example_player' }));

  assert.deepEqual(calls, [['lockBlocked']]);
});

test('CommandDispatcher parses goto movement options and rejects invalid words', async () => {
  const calls = [];
  const dispatcher = createDispatcher(calls);

  const context = {
    replyInfo(message) {
      calls.push(['replyInfo', message]);
    },
    replyError(message) {
      calls.push(['replyError', message]);
    }
  };

  await dispatcher.dispatch('goto 1 2 3', context);
  await dispatcher.dispatch('goto 1 2 3 dig sprint', context);
  await dispatcher.dispatch('goto 1 2 3 true', context);
  await dispatcher.dispatch('goto 1 2 3 fly', context);

  assert.ok(calls.some((entry) => entry[0] === 'goto' && JSON.stringify(entry[4]) === '[]'));
  assert.ok(calls.some((entry) => entry[0] === 'goto' && JSON.stringify(entry[4]) === '["dig","sprint"]'));
  assert.ok(calls.some((entry) => entry[0] === 'goto' && JSON.stringify(entry[4]) === '["sprint"]'));
  assert.ok(calls.some((entry) => entry[0] === 'replyError' && String(entry[1]).includes('无效的移动选项')));
});

test('CommandDispatcher blocks entity-gated commands when entityHandling is disabled', async () => {
  const calls = [];
  const dispatcher = createDispatcher(calls, {
    capabilities: {
      entityHandling: false,
      terrainHandling: true
    }
  });
  const context = createContext();

  await dispatcher.dispatch('help', context);
  await dispatcher.dispatch('attack @n', context);
  await dispatcher.dispatch('interact @n', context);
  await dispatcher.dispatch('fish', context);
  await dispatcher.dispatch('ride player', context);
  await dispatcher.dispatch('entity list', context);
  await dispatcher.dispatch('dig 1 2 3', context);

  assert.deepEqual(calls, [['dig', 1, 2, 3]]);
  assert.ok(context.messages.some((entry) => entry.message.includes('attack @n [已禁用: entityHandling]')));
  assert.ok(context.messages.some((entry) => entry.message.includes('当前能力: entityHandling=off terrainHandling=on')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 attack @n')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 interact @n')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 fish')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 ride')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 entity list')));
});

test('CommandDispatcher blocks terrain-gated commands when terrainHandling is disabled', async () => {
  const calls = [];
  const dispatcher = createDispatcher(calls, {
    capabilities: {
      entityHandling: true,
      terrainHandling: false
    }
  });
  const context = createContext();

  await dispatcher.dispatch('help', context);
  await dispatcher.dispatch('goto 1 2 3', context);
  await dispatcher.dispatch('useblock 1 2 3', context);
  await dispatcher.dispatch('dig 1 2 3', context);
  await dispatcher.dispatch('cplace 500', context);
  await dispatcher.dispatch('vault', context);
  await dispatcher.dispatch('ride', context);
  await dispatcher.dispatch('look 90 0', context);
  await dispatcher.dispatch('shift', context);
  await dispatcher.dispatch('circle', context);
  await dispatcher.dispatch('attack @n', context);

  assert.deepEqual(calls, [
    ['look', 90, 0],
    ['shift'],
    ['circle'],
    ['attack']
  ]);
  assert.ok(context.messages.some((entry) => entry.message.includes('goto <x> <y> <z> [选项...] [已禁用: terrainHandling]')));
  assert.ok(context.messages.some((entry) => entry.message.includes('ride | ride player | ride w [a] [已禁用: terrainHandling]')));
  assert.ok(context.messages.some((entry) => entry.message.includes('当前能力: entityHandling=on terrainHandling=off')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 goto')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 useblock')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 dig')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 cplace')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 vault')));
  assert.ok(context.messages.some((entry) => entry.type === 'error' && entry.message.includes('无法执行 ride')));
});

test('CommandDispatcher returns false for unknown commands', async () => {
  const calls = [];
  const dispatcher = createDispatcher(calls);
  const context = createContext();

  const handled = await dispatcher.dispatch('unknown command', context);

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(context.messages, [{ type: 'info', message: '命令未迁移或未识别: unknown command' }]);
});
