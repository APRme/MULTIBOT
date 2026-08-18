const fs = require('fs');
const path = require('path');

function normalizePlayerName(value) {
  return String(value || '').trim();
}

function mergePlayerLists(...lists) {
  const output = [];
  const seen = new Set();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;

    for (const value of list) {
      const name = normalizePlayerName(value);
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      output.push(name);
    }
  }

  return output;
}

class TrustedPlayersStore {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.config = options.config || {};
    this.paths = options.paths || {};
    this.mergeParentTrustedPlayers = this.config.trustedPlayersMergeParent === true;
    this.staticTrustedPlayers = Array.isArray(this.config.trustedPlayers)
      ? this.config.trustedPlayers
      : [];
    this.fileTrustedPlayers = [];
    this.entries = mergePlayerLists(this.staticTrustedPlayers);
    this.loadedAt = null;
    this.watcher = null;
    this.watchTarget = null;
    this.refreshDebounceTimer = null;
  }

  getTrustedPlayersFilePath() {
    const trustedPlayersFile = typeof this.config.trustedPlayersFile === 'string'
      ? this.config.trustedPlayersFile.trim()
      : '';
    if (!trustedPlayersFile) return null;

    return path.resolve(this.paths.accountDir || process.cwd(), trustedPlayersFile);
  }

  readTrustedPlayersFile() {
    const filePath = this.getTrustedPlayersFilePath();
    if (!filePath || !fs.existsSync(filePath)) {
      return [];
    }

    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }

  refresh() {
    this.fileTrustedPlayers = this.mergeParentTrustedPlayers ? this.readTrustedPlayersFile() : [];
    this.entries = this.mergeParentTrustedPlayers
      ? mergePlayerLists(this.staticTrustedPlayers, this.fileTrustedPlayers)
      : mergePlayerLists(this.staticTrustedPlayers);
    this.loadedAt = new Date().toISOString();

    if (this.logger && this.getTrustedPlayersFilePath()) {
      this.logger.info(
        `[TRUSTED] players refreshed total=${this.entries.length} static=${mergePlayerLists(this.staticTrustedPlayers).length} file=${mergePlayerLists(this.fileTrustedPlayers).length} mergeParent=${this.mergeParentTrustedPlayers ? 'true' : 'false'}`
      );
    }

    return this.getInfo();
  }

  scheduleRefresh(reason = 'watch') {
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }

    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = null;
      try {
        this.refresh();
      } catch (error) {
        if (this.logger) {
          this.logger.warn(`[TRUSTED] players ${reason} refresh failed: ${error.message}`);
        }
      }
    }, 100);
  }

  startWatcher() {
    if (!this.mergeParentTrustedPlayers) return;

    const filePath = this.getTrustedPlayersFilePath();
    if (!filePath) return;

    const watchTarget = path.dirname(filePath);
    if (!fs.existsSync(watchTarget)) {
      if (this.logger) {
        this.logger.warn(`[TRUSTED] players watch target missing: ${watchTarget}`);
      }
      return;
    }

    const baseName = path.basename(filePath).toLowerCase();
    try {
      this.watchTarget = watchTarget;
      this.watcher = fs.watch(watchTarget, (eventType, filename) => {
        const normalizedFileName = typeof filename === 'string' ? filename.trim().toLowerCase() : '';
        if (normalizedFileName && normalizedFileName !== baseName) {
          return;
        }

        if (eventType === 'rename' || eventType === 'change' || !eventType) {
          this.scheduleRefresh('watch');
        }
      });

      if (this.watcher && typeof this.watcher.unref === 'function') {
        this.watcher.unref();
      }
    } catch (error) {
      if (this.logger) {
        this.logger.warn(`[TRUSTED] players watcher failed: ${error.message}`);
      }
    }
  }

  start() {
    this.stop();
    this.refresh();
    this.startWatcher();
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = null;
    }

    this.watchTarget = null;
  }

  getEntries() {
    return this.entries.slice();
  }

  getInfo() {
    return {
      entries: this.getEntries(),
      count: this.entries.length,
      filePath: this.getTrustedPlayersFilePath(),
      loadedAt: this.loadedAt
    };
  }

  isTrustedPlayer(sender) {
    const name = normalizePlayerName(sender).toLowerCase();
    if (!name) return false;
    return this.entries.some((player) => player.toLowerCase() === name);
  }
}

module.exports = {
  TrustedPlayersStore,
  mergePlayerLists
};
