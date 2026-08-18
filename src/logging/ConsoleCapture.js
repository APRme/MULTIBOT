const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');

const consoleContext = new AsyncLocalStorage();
const originalConsoleMethods = {};
const methodToLevel = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug'
};
const ignoredPrefixes = [
  '[MULTIBOT][',
  '[MULTIBOT] ',
  '[MULTIBOT_PANEL]'
];

let installed = false;

function shouldCaptureMessage(message) {
  const normalized = String(message || '').trim();
  if (!normalized) return false;
  return !ignoredPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function installGlobalConsoleCapture() {
  if (installed) {
    return;
  }

  for (const method of Object.keys(methodToLevel)) {
    originalConsoleMethods[method] = console[method].bind(console);
    console[method] = (...args) => {
      const store = consoleContext.getStore();
      if (store && store.logger && typeof store.logger.capture === 'function') {
        try {
          const message = util.format(...args);
          if (shouldCaptureMessage(message)) {
            store.logger.capture(methodToLevel[method], message);
          }
        } catch (error) {
        }
      }

      return originalConsoleMethods[method](...args);
    };
  }

  installed = true;
}

function runWithConsoleCapture(logger, fn) {
  installGlobalConsoleCapture();
  return consoleContext.run({ logger }, fn);
}

module.exports = {
  installGlobalConsoleCapture,
  runWithConsoleCapture,
  shouldCaptureMessage
};
