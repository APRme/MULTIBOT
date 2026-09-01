const path = require('path');
const minecraftFolderPath = require('minecraft-folder-path');

function resolveBotPaths(options = {}) {
  const { repoRoot, appRoot, accountDirName, serverDirName, botDirName } = options;

  if (!repoRoot) {
    throw new Error('repoRoot is required');
  }

  const resolvedAppRoot = appRoot || path.join(repoRoot, 'tests', 'MULTIBOT');
  const sharedAssnDir = path.join(repoRoot, 'ASSN');
  const botsRoot = path.join(resolvedAppRoot, 'BOTS');
  const legacyModulesDir = path.join(resolvedAppRoot, 'src', 'legacy', 'assn');
  const scriptsDir = path.join(resolvedAppRoot, 'scripts');
  const authCacheDir = path.join(resolvedAppRoot, 'auth-cache');
  const fallbackAuthCacheDir = path.join(minecraftFolderPath, 'nmp-cache');

  if (accountDirName && typeof accountDirName === 'string') {
    const accountDir = path.join(sharedAssnDir, accountDirName);

    return {
      repoRoot,
      appRoot: resolvedAppRoot,
      sharedAssnDir,
      botsRoot,
      legacyModulesDir,
      scriptsDir,
      authCacheDir,
      fallbackAuthCacheDir,
      sourceType: 'legacy_assn',
      accountDirName,
      accountDir,
      botDir: accountDir,
      legacyConfigPath: path.join(accountDir, 'config.json'),
      defaultLegacyConfigPath: null,
      serverConfigPath: null,
      lockHistoryPath: path.join(accountDir, 'lock_history.txt'),
      foundEntitiesPath: path.join(accountDir, 'found.txt'),
      whitelistPath: path.join(accountDir, 'whitelist.txt'),
      sessionsDir: path.join(resolvedAppRoot, 'sessions')
    };
  }

  if (!serverDirName || typeof serverDirName !== 'string') {
    throw new Error('serverDirName is required');
  }

  if (!botDirName || typeof botDirName !== 'string') {
    throw new Error('botDirName is required');
  }

  const serverDir = path.join(botsRoot, serverDirName);
  const botDir = path.join(serverDir, botDirName);

  return {
    repoRoot,
      appRoot: resolvedAppRoot,
      sharedAssnDir,
      botsRoot,
      legacyModulesDir,
      scriptsDir,
      authCacheDir,
      fallbackAuthCacheDir,
      sourceType: 'multibot_bots',
    serverDirName,
    serverDir,
    botDirName,
    accountDirName: botDirName,
    accountDir: botDir,
    botDir,
    legacyConfigPath: path.join(botDir, 'config.json'),
    defaultLegacyConfigPath: path.join(serverDir, 'default.config.json'),
    serverConfigPath: path.join(serverDir, 'server.json'),
    lockHistoryPath: path.join(botDir, 'lock_history.txt'),
    foundEntitiesPath: path.join(botDir, 'found.txt'),
    whitelistPath: path.join(botDir, 'whitelist.txt'),
    sessionsDir: path.join(resolvedAppRoot, 'sessions')
  };
}

module.exports = {
  resolveBotPaths
};
