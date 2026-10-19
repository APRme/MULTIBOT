const test = require('node:test');
const assert = require('node:assert/strict');
const { installMsaRefreshRetry } = require('../src/session/msaRefreshRetry');

function createManagerClass(options = {}) {
  class FakeMsaTokenManager {
    constructor() {
      this.accessToken = options.accessToken === undefined ? { valid: false } : options.accessToken;
      this.refreshToken = options.refreshToken === undefined ? 'rt' : options.refreshToken;
      this.refreshResults = (options.refreshResults || []).slice();
      this.refreshCalls = 0;
    }

    // 占位: 真实类里有实现, 补丁会整体替换掉它
    async verifyTokens() { return false; }
    async getAccessToken() { return this.accessToken; }
    async getRefreshToken() { return this.refreshToken; }

    async refreshTokens() {
      this.refreshCalls += 1;
      const result = this.refreshResults.shift();
      if (result === 'ok') {
        this.accessToken = { valid: true };
        return;
      }
      throw new Error('refresh failed');
    }
  }

  return FakeMsaTokenManager;
}

test('有效令牌直接通过, 不触发刷新', async () => {
  const Manager = createManagerClass({ accessToken: { valid: true } });
  const result = installMsaRefreshRetry(Manager, { baseDelayMs: 1 });
  assert.equal(result.installed, true);

  const manager = new Manager();
  assert.equal(await manager.verifyTokens(), true);
  assert.equal(manager.refreshCalls, 0);
});

test('刷新瞬时失败会重试, 第二次成功后不再回退设备码', async () => {
  const Manager = createManagerClass({ refreshResults: ['fail', 'ok'] });
  installMsaRefreshRetry(Manager, { baseDelayMs: 1 });

  const manager = new Manager();
  assert.equal(await manager.verifyTokens(), true);
  assert.equal(manager.refreshCalls, 2);
});

test('一直失败时返回 false(交给上层), 且最多重试 attempts 次', async () => {
  const Manager = createManagerClass({ refreshResults: ['fail', 'fail', 'fail', 'fail', 'fail'] });
  installMsaRefreshRetry(Manager, { attempts: 3, baseDelayMs: 1 });

  const manager = new Manager();
  assert.equal(await manager.verifyTokens(), false);
  assert.equal(manager.refreshCalls, 3);
});

test('重复安装会被识别', () => {
  const Manager = createManagerClass();
  assert.equal(installMsaRefreshRetry(Manager).installed, true);
  assert.deepEqual(installMsaRefreshRetry(Manager), { installed: false, reason: 'already-installed' });
});

test('无效目标返回 invalid-target', () => {
  assert.deepEqual(installMsaRefreshRetry(null), { installed: false, reason: 'invalid-target' });
  assert.deepEqual(installMsaRefreshRetry({}), { installed: false, reason: 'invalid-target' });
});
