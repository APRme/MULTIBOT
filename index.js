const path = require('path');
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

  const shutdown = async (signal) => {
    try {
      await app.stop(signal.toLowerCase());
      process.exit(0);
    } catch (error) {
      console.error('[MULTIBOT] shutdown failed:', error && error.stack ? error.stack : error);
      process.exit(1);
    }
  };

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
