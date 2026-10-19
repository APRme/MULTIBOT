// prismarine-auth 的 MSA 令牌刷新只要失败一次就返回 false, 于是立刻回退到设备码流程;
// 而 MCSM 等非交互环境根本无法完成设备码, 结果就是一直打印
//   [msa] Error getting device code...
// 并让本次认证失败(靠下一次重连的重试才能进去)。
//
// 这里给 MsaTokenManager.verifyTokens 加带退避的重试: 令牌有效就直接用, 过期就多刷几次再放弃。

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1200;
const INSTALLED_KEY = Symbol.for('multibot.msaRefreshRetry');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installMsaRefreshRetry(managerClass, options = {}) {
  const attempts = Number.isFinite(options.attempts) ? Math.max(1, Math.trunc(options.attempts)) : DEFAULT_ATTEMPTS;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? Math.max(0, options.baseDelayMs) : DEFAULT_BASE_DELAY_MS;

  const prototype = managerClass && managerClass.prototype;
  if (!prototype || typeof prototype.verifyTokens !== 'function' || typeof prototype.refreshTokens !== 'function') {
    return { installed: false, reason: 'invalid-target' };
  }

  if (prototype[INSTALLED_KEY]) {
    return { installed: false, reason: 'already-installed' };
  }

  prototype.verifyTokens = async function patchedVerifyTokens() {
    const accessToken = typeof this.getAccessToken === 'function' ? await this.getAccessToken() : null;
    const refreshToken = typeof this.getRefreshToken === 'function' ? await this.getRefreshToken() : null;
    if (accessToken && accessToken.valid && refreshToken) return true;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.refreshTokens();
        return true;
      } catch (error) {
        // 瞬时失败继续重试; 不在控制台打印库自带的大段 warn
      }
      if (attempt < attempts - 1) await sleep(baseDelayMs * (attempt + 1));
    }

    // 全部失败才交给上层(它可能仍回退设备码), 但已经尽力重试过
    return false;
  };

  prototype[INSTALLED_KEY] = { attempts, baseDelayMs };
  return { installed: true, attempts, baseDelayMs };
}

function installFromNodeModules(options = {}) {
  try {
    const managerClass = require('prismarine-auth/src/TokenManagers/MsaTokenManager');
    return installMsaRefreshRetry(managerClass, options);
  } catch (error) {
    return { installed: false, reason: `module-not-found: ${error.message}` };
  }
}

module.exports = {
  installMsaRefreshRetry,
  installFromNodeModules,
  DEFAULT_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS
};
