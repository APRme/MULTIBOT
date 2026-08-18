const test = require('node:test');
const assert = require('node:assert/strict');
const { RestartPolicy } = require('../src/runtime/RestartPolicy');

function createPolicyConfig(overrides = {}) {
  return {
    restartOnDisconnect: true,
    restartDelayMs: 60000,
    restartJitterMs: 120000,
    ...overrides
  };
}

function createPolicy(overrides = {}, policyOptions = {}) {
  return new RestartPolicy(createPolicyConfig(overrides), policyOptions);
}

test('RestartPolicy uses built-in reconnect defaults when values are omitted', () => {
  const policy = new RestartPolicy({ restartOnDisconnect: true }, {
    randomProvider: () => 0
  });
  const schedule = policy.buildRestartSchedule('disconnect', {
    useReconnectPolicy: true
  });

  assert.equal(schedule.baseDelayMs, 60000);
  assert.equal(policy.getDisconnectJitterMs(), 120000);
  assert.equal(schedule.jitterMs, 0);
  assert.equal(schedule.totalDelayMs, 60000);
  assert.equal(schedule.scheduleConfigured, false);
  assert.equal(schedule.scheduleIndex, null);
  assert.equal(schedule.exhausted, false);
});

test('RestartPolicy randomizes reconnect delays within the jitter window', () => {
  const policyLow = createPolicy({
    restartDelayMs: 60000,
    restartJitterMs: 120000
  }, {
    randomProvider: () => 0
  });
  const scheduleLow = policyLow.buildRestartSchedule('disconnect', {
    useReconnectPolicy: true
  });

  assert.equal(scheduleLow.baseDelayMs, 60000);
  assert.equal(scheduleLow.jitterMs, 0);
  assert.equal(scheduleLow.totalDelayMs, 60000);

  const policyMid = createPolicy({
    restartDelayMs: 60000,
    restartJitterMs: 120000
  }, {
    randomProvider: () => 0.5
  });
  const scheduleMid = policyMid.buildRestartSchedule('disconnect', {
    useReconnectPolicy: true
  });
  const expectedMidJitter = Math.floor(0.5 * (120000 + 1));

  assert.equal(scheduleMid.baseDelayMs, 60000);
  assert.equal(scheduleMid.jitterMs, expectedMidJitter);
  assert.equal(scheduleMid.totalDelayMs, 60000 + expectedMidJitter);

  const policyHigh = createPolicy({
    restartDelayMs: 60000,
    restartJitterMs: 120000
  }, {
    randomProvider: () => 0.999999
  });
  const scheduleHigh = policyHigh.buildRestartSchedule('disconnect', {
    useReconnectPolicy: true
  });

  assert.equal(scheduleHigh.baseDelayMs, 60000);
  assert.equal(scheduleHigh.jitterMs, 120000);
  assert.equal(scheduleHigh.totalDelayMs, 180000);
});

test('RestartPolicy does not apply jitter to non-reconnect restart reasons', () => {
  const policy = createPolicy({
    restartDelayMs: 60000,
    restartJitterMs: 120000
  }, {
    randomProvider: () => 0.999999
  });

  const invalidSessionSchedule = policy.buildRestartSchedule('invalid_session_retry', {
    overrideDelayMs: 1000,
    useReconnectPolicy: false
  });
  const retryableErrorSchedule = policy.buildRestartSchedule('retryable_error', {
    useReconnectPolicy: false
  });

  assert.equal(invalidSessionSchedule.baseDelayMs, 1000);
  assert.equal(invalidSessionSchedule.jitterMs, 0);
  assert.equal(invalidSessionSchedule.totalDelayMs, 1000);
  assert.equal(invalidSessionSchedule.scheduleConfigured, false);

  assert.equal(retryableErrorSchedule.baseDelayMs, 60000);
  assert.equal(retryableErrorSchedule.jitterMs, 0);
  assert.equal(retryableErrorSchedule.totalDelayMs, 60000);
  assert.equal(retryableErrorSchedule.scheduleConfigured, false);
});

test('RestartPolicy selects schedule levels by attempt index', () => {
  const policy = createPolicy({
    restartDelayScheduleMs: [60000, 300000, 600000]
  }, {
    randomProvider: () => 0
  });

  const first = policy.buildRestartSchedule('backend_unavailable', {
    attempt: 0,
    useReconnectPolicy: true
  });
  assert.equal(first.baseDelayMs, 60000);
  assert.equal(first.scheduleIndex, 0);
  assert.equal(first.scheduleConfigured, true);
  assert.equal(first.exhausted, false);

  const second = policy.buildRestartSchedule('backend_unavailable', {
    attempt: 1,
    useReconnectPolicy: true
  });
  assert.equal(second.baseDelayMs, 300000);
  assert.equal(second.scheduleIndex, 1);

  const last = policy.buildRestartSchedule('disconnect', {
    attempt: 2,
    useReconnectPolicy: true
  });
  assert.equal(last.baseDelayMs, 600000);
  assert.equal(last.scheduleIndex, 2);
});

test('RestartPolicy repeats the last schedule level when repeatLast is true', () => {
  const policy = createPolicy({
    restartDelayScheduleMs: [60000, 300000],
    restartDelayScheduleRepeatLast: true
  }, {
    randomProvider: () => 0
  });
  const schedule = policy.buildRestartSchedule('disconnect', {
    attempt: 5,
    useReconnectPolicy: true
  });

  assert.equal(schedule.baseDelayMs, 300000);
  assert.equal(schedule.scheduleIndex, 1);
  assert.equal(schedule.exhausted, false);
});

test('RestartPolicy reports exhausted when repeatLast is false', () => {
  const policy = createPolicy({
    restartDelayScheduleMs: [60000, 300000],
    restartDelayScheduleRepeatLast: false
  }, {
    randomProvider: () => 0
  });
  const schedule = policy.buildRestartSchedule('disconnect', {
    attempt: 2,
    useReconnectPolicy: true
  });

  assert.equal(schedule.exhausted, true);
  assert.equal(schedule.scheduleConfigured, true);
});

test('RestartPolicy applies per-level jitter when a schedule is configured', () => {
  const policy = createPolicy({
    restartDelayScheduleMs: [60000, 300000],
    restartJitterMs: 10000
  }, {
    randomProvider: () => 0.5
  });
  const schedule = policy.buildRestartSchedule('backend_unavailable', {
    attempt: 1,
    useReconnectPolicy: true
  });

  assert.equal(schedule.baseDelayMs, 300000);
  assert.equal(schedule.jitterMs, Math.floor(0.5 * (10000 + 1)));
  assert.equal(schedule.totalDelayMs, 300000 + Math.floor(0.5 * (10000 + 1)));
});

test('RestartPolicy applies no random jitter when restartJitterMs is zero', () => {
  const policy = createPolicy({
    restartDelayScheduleMs: [60000],
    restartJitterMs: 0
  }, {
    randomProvider: () => 0.999999
  });
  const schedule = policy.buildRestartSchedule('disconnect', {
    attempt: 0,
    useReconnectPolicy: true
  });

  assert.equal(schedule.baseDelayMs, 60000);
  assert.equal(schedule.jitterMs, 0);
  assert.equal(schedule.totalDelayMs, 60000);
});

test('RestartPolicy uses legacy delay and jitter when no schedule is configured', () => {
  const policy = createPolicy({
    restartDelayMs: 20000,
    restartJitterMs: 5000
  }, {
    randomProvider: () => 0.5
  });
  const schedule = policy.buildRestartSchedule('backend_unavailable', {
    useReconnectPolicy: true
  });

  assert.equal(schedule.baseDelayMs, 20000);
  assert.equal(schedule.scheduleConfigured, false);
  assert.equal(schedule.scheduleIndex, null);
  assert.equal(schedule.jitterMs, Math.floor(0.5 * (5000 + 1)));
  assert.equal(schedule.exhausted, false);
});

test('RestartPolicy explicit override ignores schedule and jitter', () => {
  const policy = createPolicy({
    restartDelayScheduleMs: [60000, 300000],
    restartJitterMs: 120000
  }, {
    randomProvider: () => 0.999999
  });
  const schedule = policy.buildRestartSchedule('invalid_session_retry', {
    overrideDelayMs: 1000,
    useReconnectPolicy: false
  });

  assert.equal(schedule.baseDelayMs, 1000);
  assert.equal(schedule.jitterMs, 0);
  assert.equal(schedule.totalDelayMs, 1000);
  assert.equal(schedule.scheduleConfigured, false);
  assert.equal(schedule.scheduleIndex, null);
  assert.equal(schedule.exhausted, false);
});
