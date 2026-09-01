const fs = require('fs');
const path = require('path');

class ScriptFeature {
  constructor(options = {}) {
    this.paths = options.paths || {};
    this.logger = options.logger;
    this.schedulerConfig = options.schedulerConfig || { Enabled: false, TaskList: [] };
    this.createAutoContext = options.createAutoContext || (() => null);
    this.executeCommand = options.executeCommand || null;
    this.activeScriptState = null;
    this.schedulerTimers = [];
    this.recurringInitialized = false;
    this.firstSpawnHandled = false;
  }

  setExecuteCommand(fn) {
    this.executeCommand = fn;
  }

  stop() {
    this.stopActiveScript({
      silentIfNotRunning: true,
      silentRequesterAck: true
    });
    this.activeScriptState = null;
    this.clearSchedulerTimers();
  }

  stopActiveScript(options = {}) {
    const {
      context = null,
      silentIfNotRunning = false,
      silentRequesterAck = false
    } = options;

    const state = this.activeScriptState;
    if (!state) {
      if (!silentIfNotRunning && context && typeof context.replyInfo === 'function') {
        context.replyInfo('当前没有脚本在运行');
      }
      return false;
    }

    if (!state.cancelled) {
      state.cancelled = true;
      this.releasePendingWait(state);
      if (context && !silentRequesterAck && typeof context.replyInfo === 'function') {
        const scriptLabel = state.scriptPath ? path.basename(state.scriptPath) : '当前脚本';
        context.replyInfo(`正在停止脚本: ${scriptLabel}`);
      }
    }

    return true;
  }

  releasePendingWait(state) {
    if (!state) {
      return;
    }

    if (state.pendingWaitTimer) {
      clearTimeout(state.pendingWaitTimer);
      state.pendingWaitTimer = null;
    }

    if (typeof state.pendingWaitResolve === 'function') {
      const resolve = state.pendingWaitResolve;
      state.pendingWaitResolve = null;
      resolve();
    }
  }

  clearSchedulerTimers() {
    for (const timer of this.schedulerTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.schedulerTimers = [];
    this.recurringInitialized = false;
  }

  resolveScriptPath(rawPath, baseDir = null) {
    const normalized = String(rawPath || '').trim().replace(/^["']|["']$/g, '');
    if (!normalized) return null;

    const allowedRoots = [
      this.paths.accountDir,
      this.paths.scriptsDir
    ].filter(Boolean).map((entry) => path.resolve(entry));

    const isWithinAllowedRoots = (candidatePath) => {
      const resolvedCandidate = path.resolve(candidatePath);
      return allowedRoots.some((rootPath) => {
        const relativePath = path.relative(rootPath, resolvedCandidate);
        return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
      });
    };

    const candidates = [];
    if (path.isAbsolute(normalized)) {
      if (isWithinAllowedRoots(normalized)) {
        candidates.push(normalized);
      }
    } else {
      if (baseDir) {
        const baseCandidate = path.resolve(baseDir, normalized);
        if (isWithinAllowedRoots(baseCandidate)) {
          candidates.push(baseCandidate);
        }
      }
      if (this.paths.accountDir) {
        const accountCandidate = path.resolve(this.paths.accountDir, normalized);
        if (isWithinAllowedRoots(accountCandidate)) {
          candidates.push(accountCandidate);
        }
      }
      if (this.paths.scriptsDir) {
        const scriptsCandidate = path.resolve(this.paths.scriptsDir, normalized);
        if (isWithinAllowedRoots(scriptsCandidate)) {
          candidates.push(scriptsCandidate);
        }
      }
    }

    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }

  async tryHandleScriptControlCommand(context, trimmedCommand) {
    const trimmed = String(trimmedCommand || '').trim();
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const command = (parts[0] || '').toLowerCase();

    if (command === 'stopscript') {
      const stopped = this.stopActiveScript({
        context,
        silentIfNotRunning: false,
        silentRequesterAck: true
      });
      if (stopped && context && typeof context.replyInfo === 'function') {
        context.replyInfo('已请求停止脚本');
      }
      return true;
    }

    if (command !== 'script') {
      return false;
    }

    const rawPath = trimmed.slice(command.length).trim();
    if (!rawPath) {
      if (context && typeof context.replyError === 'function') {
        context.replyError('用法: script <文件路径>');
      }
      return true;
    }

    if (!this.executeCommand) {
      if (context && typeof context.replyError === 'function') {
        context.replyError('script 执行器未初始化');
      }
      return true;
    }

    if (this.activeScriptState && !this.activeScriptState.internal) {
      this.stopActiveScript({
        silentIfNotRunning: true,
        silentRequesterAck: true
      });
      this.activeScriptState = null;
    }

    const resolvedPath = this.resolveScriptPath(rawPath);
    if (!resolvedPath) {
      if (context && typeof context.replyError === 'function') {
        context.replyError(`脚本不存在: ${rawPath}`);
      }
      return true;
    }

    await this.runScriptFile(resolvedPath, context, new Set());
    return true;
  }

  async sleepWithCancellation(state, delayMs) {
    const normalizedDelay = Number.parseInt(delayMs, 10);
    if (!Number.isFinite(normalizedDelay) || normalizedDelay <= 0) {
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        state.pendingWaitResolve = null;
        state.pendingWaitTimer = null;
        resolve();
      };

      state.pendingWaitResolve = finish;
      state.pendingWaitTimer = setTimeout(finish, normalizedDelay);

      if (state.cancelled) {
        finish();
      }
    });
  }

  async runScriptFile(filePath, context, visitedPaths) {
    const normalizedPath = path.normalize(filePath);
    if (visitedPaths.has(normalizedPath)) {
      throw new Error(`检测到递归脚本调用: ${normalizedPath}`);
    }

    const previousState = this.activeScriptState;
    const rootCall = !previousState;
    const state = previousState || {
      cancelled: false,
      internal: false,
      scriptPath: normalizedPath
    };

    if (rootCall) {
      state.scriptPath = normalizedPath;
      state.cancelled = false;
    }

    this.activeScriptState = state;
    visitedPaths.add(normalizedPath);

    try {
      if (rootCall) {
        if (this.logger) {
          this.logger.info(`[SCRIPT] start ${normalizedPath}`);
        }
        if (context && typeof context.replyInfo === 'function') {
          context.replyInfo(`开始执行脚本: ${path.basename(normalizedPath)}`);
        }
      }

      let restartCurrentScript = false;
      do {
        restartCurrentScript = false;
        const content = fs.readFileSync(normalizedPath, 'utf8');
        const lines = content.split(/\r?\n/);

        for (const rawLine of lines) {
          if (state.cancelled) break;

          const line = rawLine.trim();
          if (!line || line.startsWith('#') || line.startsWith('//')) {
            continue;
          }

          const waitMatch = line.match(/^wait\s+(\d+)$/i);
          if (waitMatch) {
            await this.sleepWithCancellation(state, Number.parseInt(waitMatch[1], 10));
            continue;
          }

          if (/^script\s+/i.test(line)) {
            const nestedPath = line.replace(/^script\s+/i, '').trim();
            const resolvedNestedPath = this.resolveScriptPath(nestedPath, path.dirname(normalizedPath));
            if (!resolvedNestedPath) {
              throw new Error(`嵌套脚本不存在: ${nestedPath}`);
            }

            if (path.normalize(resolvedNestedPath) === normalizedPath) {
              restartCurrentScript = true;
              break;
            }

            await this.runScriptFile(resolvedNestedPath, context, visitedPaths);
            continue;
          }

          await this.executeCommand(line, context);
        }
      } while (restartCurrentScript && !state.cancelled);

      if (rootCall && context && typeof context.replyInfo === 'function') {
        if (state.cancelled) {
          context.replyInfo('脚本已停止');
        } else {
          context.replyInfo(`脚本执行完成: ${path.basename(normalizedPath)}`);
        }
      }
    } finally {
      this.releasePendingWait(state);
      visitedPaths.delete(normalizedPath);
      if (rootCall) {
        if (this.activeScriptState === state) {
          this.activeScriptState = null;
        }
      } else if (this.activeScriptState === state) {
        this.activeScriptState = previousState;
      }
    }
  }

  onSpawn() {
    const config = this.schedulerConfig || {};
    const taskList = Array.isArray(config.TaskList) ? config.TaskList : [];
    const enabled = config.Enabled === true;
    if (!enabled) return;

    if (!this.recurringInitialized) {
      this.initializeRecurringTasks(taskList);
      this.recurringInitialized = true;
    }

    for (const task of taskList) {
      if (task.Trigger_On_Login === true) {
        this.scheduleLoginTask(task);
      }
      if (!this.firstSpawnHandled && task.Trigger_On_First_Login === true) {
        this.scheduleLoginTask(task);
      }
    }

    this.firstSpawnHandled = true;
  }

  scheduleLoginTask(task) {
    const delaySeconds = Number(task.Trigger_On_Login_Delay_Seconds) || 0;
    const timer = setTimeout(() => {
      void this.executeTaskAction(task, 'login');
    }, delaySeconds * 1000);
    this.schedulerTimers.push(timer);
  }

  initializeRecurringTasks(taskList) {
    for (const task of taskList) {
      if (task.Trigger_On_Interval && task.Trigger_On_Interval.Enable === true) {
        this.scheduleNextIntervalTask(task);
      }

      if (task.Trigger_On_Times && task.Trigger_On_Times.Enable === true) {
        const times = Array.isArray(task.Trigger_On_Times.Times) ? task.Trigger_On_Times.Times : [];
        for (const time of times) {
          this.scheduleDailyTask(task, time);
        }
      }
    }
  }

  scheduleNextIntervalTask(task) {
    const intervalConfig = task.Trigger_On_Interval || {};
    const multiplier = intervalConfig.Unit === 'hours' ? 60 * 60 * 1000 : 1000;
    const min = Math.max(0, Number(intervalConfig.MinTime) || 0) * multiplier;
    const max = Math.max(min, Number(intervalConfig.MaxTime) || min) * multiplier;
    const delay = min + Math.floor(Math.random() * Math.max(1, max - min + 1));

    const timer = setTimeout(async () => {
      try {
        await this.executeTaskAction(task, 'interval');
      } finally {
        this.scheduleNextIntervalTask(task);
      }
    }, delay);

    this.schedulerTimers.push(timer);
  }

  scheduleDailyTask(task, timeText) {
    const scheduleNext = () => {
      const now = new Date();
      const [hour, minute, second] = String(timeText).split(':').map((part) => Number.parseInt(part, 10));
      const next = new Date(now);
      next.setHours(hour, minute, second, 0);

      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }

      const timer = setTimeout(async () => {
        try {
          await this.executeTaskAction(task, 'time');
        } finally {
          scheduleNext();
        }
      }, next.getTime() - now.getTime());

      this.schedulerTimers.push(timer);
    };

    scheduleNext();
  }

  async executeTaskAction(task, reason) {
    if (!this.executeCommand || !task || !task.Action) return;

    const context = this.createAutoContext();
    if (this.logger) {
      this.logger.info(`[SCRIPT] scheduler task=${task.Task_Name || 'unnamed'} reason=${reason} action=${task.Action}`);
    }
    await this.executeCommand(task.Action, context);
  }

  getState() {
    return {
      isRunning: Boolean(this.activeScriptState),
      scriptPath: this.activeScriptState ? this.activeScriptState.scriptPath || null : null
    };
  }
}

module.exports = {
  ScriptFeature
};
