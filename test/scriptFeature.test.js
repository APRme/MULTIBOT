const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScriptFeature } = require('../src/features/script/ScriptFeature');

function createContext() {
  const infoMessages = [];
  const errorMessages = [];
  return {
    replyInfo(message) {
      infoMessages.push(message);
    },
    replyError(message) {
      errorMessages.push(message);
    },
    get infoMessages() {
      return infoMessages;
    },
    get errorMessages() {
      return errorMessages;
    }
  };
}

test('ScriptFeature resolves only account and MULTIBOT script roots', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-script-feature-'));
  const accountDir = path.join(tempRoot, 'account');
  const scriptsDir = path.join(tempRoot, 'scripts');
  const repoRoot = path.join(tempRoot, 'repo');
  fs.mkdirSync(accountDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });

  const accountScriptPath = path.join(accountDir, 'account-script.txt');
  const sharedScriptPath = path.join(scriptsDir, 'shared-script.txt');
  const repoScriptPath = path.join(repoRoot, 'repo-script.txt');
  fs.writeFileSync(accountScriptPath, 'send hi', 'utf8');
  fs.writeFileSync(sharedScriptPath, 'send hi', 'utf8');
  fs.writeFileSync(repoScriptPath, 'send hi', 'utf8');

  const feature = new ScriptFeature({
    paths: {
      accountDir,
      scriptsDir,
      repoRoot
    }
  });

  assert.equal(feature.resolveScriptPath('account-script.txt'), accountScriptPath);
  assert.equal(feature.resolveScriptPath('shared-script.txt'), sharedScriptPath);
  assert.equal(feature.resolveScriptPath(repoScriptPath), null);
  assert.equal(feature.resolveScriptPath('../repo/repo-script.txt'), null);
});

test('ScriptFeature stopActiveScript cancels running script state', () => {
  const messages = [];
  const feature = new ScriptFeature();
  feature.activeScriptState = {
    cancelled: false,
    scriptPath: 'demo.txt'
  };

  const stopped = feature.stopActiveScript({
    context: {
      replyInfo(message) {
        messages.push(message);
      }
    }
  });

  assert.equal(stopped, true);
  assert.equal(feature.activeScriptState.cancelled, true);
  assert.match(messages[0], /正在停止脚本/);
});

test('ScriptFeature starts the new script and cancels the old one automatically', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-script-feature-'));
  const accountDir = path.join(tempRoot, 'account');
  fs.mkdirSync(accountDir, { recursive: true });

  const oldScriptPath = path.join(accountDir, 'old.txt');
  const newScriptPath = path.join(accountDir, 'new.txt');
  fs.writeFileSync(oldScriptPath, 'wait 1000\nsend old', 'utf8');
  fs.writeFileSync(newScriptPath, 'wait 80\nsend new', 'utf8');

  const executedCommands = [];
  const feature = new ScriptFeature({
    paths: {
      accountDir
    }
  });

  feature.setExecuteCommand(async (content) => {
    executedCommands.push(content);
  });

  const oldContext = createContext();
  const newContext = createContext();

  const oldPromise = feature.tryHandleScriptControlCommand(oldContext, 'script old.txt');
  let oldSettled = false;
  oldPromise.finally(() => {
    oldSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newPromise = feature.tryHandleScriptControlCommand(newContext, 'script new.txt');

  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(oldSettled, true);
  assert.equal(feature.getState().isRunning, true);
  assert.equal(feature.getState().scriptPath, path.normalize(newScriptPath));
  assert.deepEqual(executedCommands, []);

  await Promise.all([oldPromise, newPromise]);

  assert.deepEqual(executedCommands, ['send new']);
  assert.ok(oldContext.infoMessages.some((message) => String(message).includes('脚本已停止')));
  assert.ok(newContext.infoMessages.some((message) => String(message).includes('开始执行脚本')));
});

test('ScriptFeature supports self-recursive script loops', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-script-feature-'));
  const accountDir = path.join(tempRoot, 'account');
  fs.mkdirSync(accountDir, { recursive: true });

  const loopScriptPath = path.join(accountDir, 'loop.txt');
  fs.writeFileSync(loopScriptPath, 'send loop\nwait 10\nscript loop.txt', 'utf8');

  const executedCommands = [];
  const feature = new ScriptFeature({
    paths: {
      accountDir
    }
  });

  feature.setExecuteCommand(async (content) => {
    executedCommands.push(content);
  });

  const context = createContext();
  const runningPromise = feature.tryHandleScriptControlCommand(context, 'script loop.txt');

  await new Promise((resolve) => setTimeout(resolve, 35));
  feature.stopActiveScript({
    silentIfNotRunning: true,
    silentRequesterAck: true
  });

  await runningPromise;

  assert.ok(executedCommands.length >= 2);
  assert.ok(executedCommands.every((entry) => entry === 'send loop'));
  assert.ok(context.infoMessages.some((message) => String(message).includes('开始执行脚本')));
  assert.ok(context.infoMessages.some((message) => String(message).includes('脚本已停止')));
});
