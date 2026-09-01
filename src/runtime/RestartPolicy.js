class RestartPolicy {
  constructor(botConfig = {}, options = {}) {
    this.botConfig = botConfig;
    this.randomProvider = typeof options.randomProvider === 'function'
      ? options.randomProvider
      : Math.random;
  }

  shouldRestart() {
    return this.botConfig.restartOnDisconnect !== false;
  }

  getScheduleMs() {
    const schedule = this.botConfig.restartDelayScheduleMs;
    return Array.isArray(schedule) && schedule.length > 0 ? schedule : null;
  }

  getScheduleRepeatLast() {
    return this.botConfig.restartDelayScheduleRepeatLast !== false;
  }

  getBaseDelayMs(overrideDelayMs) {
    if (Number.isFinite(overrideDelayMs) && overrideDelayMs >= 0) {
      return overrideDelayMs;
    }

    const configuredDelay = Number.parseInt(this.botConfig.restartDelayMs, 10);
    return Number.isFinite(configuredDelay) && configuredDelay >= 0
      ? configuredDelay
      : 60000;
  }

  getDelayMs(overrideDelayMs) {
    return this.getBaseDelayMs(overrideDelayMs);
  }

  getDisconnectJitterMs() {
    const configuredJitter = Number.parseInt(this.botConfig.restartJitterMs, 10);
    return Number.isFinite(configuredJitter) && configuredJitter >= 0
      ? configuredJitter
      : 120000;
  }

  buildRestartSchedule(reason, options = {}) {
    const attempt = Number.isFinite(Number(options.attempt))
      ? Math.max(0, Math.floor(Number(options.attempt)))
      : 0;
    const overrideDelayMs = options.overrideDelayMs;
    const useReconnectPolicy = options.useReconnectPolicy === true;
    const schedule = this.getScheduleMs();
    const scheduleConfigured = useReconnectPolicy && Array.isArray(schedule) && schedule.length > 0;

    if (Number.isFinite(overrideDelayMs) && overrideDelayMs >= 0) {
      return {
        reason: String(reason || ''),
        baseDelayMs: overrideDelayMs,
        jitterMs: 0,
        totalDelayMs: overrideDelayMs,
        scheduleConfigured: false,
        scheduleIndex: null,
        exhausted: false
      };
    }

    let baseDelayMs;
    let scheduleIndex = null;
    let exhausted = false;

    if (scheduleConfigured) {
      if (attempt < schedule.length) {
        baseDelayMs = schedule[attempt];
        scheduleIndex = attempt;
      } else if (this.getScheduleRepeatLast()) {
        baseDelayMs = schedule[schedule.length - 1];
        scheduleIndex = schedule.length - 1;
      } else {
        baseDelayMs = schedule[schedule.length - 1];
        scheduleIndex = schedule.length - 1;
        exhausted = true;
      }
    } else {
      baseDelayMs = this.getBaseDelayMs();
    }

    const maxJitterMs = useReconnectPolicy && !exhausted
      ? this.getDisconnectJitterMs()
      : 0;
    const randomValue = this.randomProvider();
    const normalizedRandom = Number.isFinite(randomValue)
      ? Math.min(Math.max(randomValue, 0), 0.999999999999)
      : 0;
    const jitterMs = maxJitterMs > 0
      ? Math.floor(normalizedRandom * (maxJitterMs + 1))
      : 0;

    return {
      reason: String(reason || ''),
      baseDelayMs,
      jitterMs,
      totalDelayMs: exhausted ? baseDelayMs : baseDelayMs + jitterMs,
      scheduleConfigured,
      scheduleIndex,
      exhausted
    };
  }
}

module.exports = {
  RestartPolicy
};
