const readline = require('readline');
const { ConsoleConnectorClient } = require('./src/connector/ConsoleConnectorClient');

function getUsageText() {
  return [
    'Usage:',
    '  node .\\console-connector.js --bot-id <id> --api-base <url> --token <token> [--sender <name>]'
  ].join('\n');
}

function parseConnectorArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const output = {
    botId: '',
    apiBase: '',
    token: '',
    sender: 'panel_connector'
  };

  for (let index = 0; index < args.length; index += 1) {
    const part = args[index];
    const value = args[index + 1];

    if (part === '--bot-id') {
      output.botId = String(value || '').trim();
      index += 1;
      continue;
    }

    if (part === '--api-base') {
      output.apiBase = String(value || '').trim();
      index += 1;
      continue;
    }

    if (part === '--token') {
      output.token = String(value || '').trim();
      index += 1;
      continue;
    }

    if (part === '--sender') {
      output.sender = String(value || '').trim() || 'panel_connector';
      index += 1;
    }
  }

  return output;
}

function validateConnectorArgs(args) {
  const missing = [];
  if (!args.botId) missing.push('--bot-id');
  if (!args.apiBase) missing.push('--api-base');
  if (!args.token) missing.push('--token');
  return missing;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseConnectorArgs(argv);
  const missing = validateConnectorArgs(args);
  if (missing.length > 0) {
    console.error(getUsageText());
    console.error(`Missing required arguments: ${missing.join(', ')}`);
    process.exitCode = 1;
    return null;
  }

  const client = new ConsoleConnectorClient(args);
  await client.start();

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    void client.handleConsoleInput(line);
  });

  const shutdown = async () => {
    rl.close();
    await client.stop();
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  return client;
}

if (require.main === module) {
  void main();
}

module.exports = {
  getUsageText,
  main,
  parseConnectorArgs,
  validateConnectorArgs
};
