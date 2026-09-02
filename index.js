const path = require('path');
const readline = require('readline');
const { MultibotApp } = require('./src/app/MultibotApp');

async function main() {
  const configPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(__dirname, 'multibot.config.json');

  const app = new MultibotApp({
    appRoot: __dirname,
    repoRoot: __dirname,
    configPath
  });

  await app.start();

  const consoleInput = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });
  let shuttingDown = false;
  const waitForCpuProfile = app.masterConfig?.diagnostics?.cpuProfileOnExit === true;

  const finishShutdown = (code) => {
    if (!waitForCpuProfile) {
      process.exit(code);
      return;
    }

    // Give Node's --cpu-prof writer time to flush, then force-exit even if
    // stray handles (sockets, stdin) would otherwise keep the loop alive.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 10000);
  };

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    consoleInput.close();
    if (typeof process.stdin.destroy === 'function') {
      process.stdin.destroy();
    }

    // Safety net: never hang the process no matter what app.stop() does.
    const forceExit = setTimeout(() => process.exit(1), 30000);

    try {
      await app.stop(signal.toLowerCase());
      clearTimeout(forceExit);
      finishShutdown(0);
    } catch (error) {
      console.error('[MULTIBOT] shutdown failed:', error && error.stack ? error.stack : error);
      clearTimeout(forceExit);
      finishShutdown(1);
    }
  };

  console.log('[MULTIBOT] Console stop command: exit');
  consoleInput.on('line', (line) => {
    if (String(line || '').trim().toLowerCase() !== 'exit') return;
    console.log('[MULTIBOT] Console exit requested.');
    void shutdown('CONSOLE_EXIT');
  });

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((error) => {
  console.error('[MULTIBOT] fatal startup error:', error && error.stack ? error.stack : error);
  process.exit(1);
});
