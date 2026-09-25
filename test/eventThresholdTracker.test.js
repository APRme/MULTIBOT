const test = require('node:test');
const assert = require('node:assert/strict');
const { EventThresholdTracker } = require('../src/notifications/EventThresholdTracker');

test('EventThresholdTracker reports exceeded only once the threshold is reached', () => {
  const tracker = new EventThresholdTracker({ threshold: 3, windowMs: 60000 });

  assert.deepEqual(tracker.record(1000), { count: 1, exceeded: false });
  assert.deepEqual(tracker.record(2000), { count: 2, exceeded: false });
  assert.deepEqual(tracker.record(3000), { count: 3, exceeded: true });
  assert.deepEqual(tracker.record(4000), { count: 4, exceeded: true });
});

test('EventThresholdTracker drops timestamps outside the window', () => {
  const tracker = new EventThresholdTracker({ threshold: 2, windowMs: 1000 });

  tracker.record(1000);
  assert.deepEqual(tracker.record(2500), { count: 1, exceeded: false });
  assert.equal(tracker.getCount(2500), 1);
});

test('EventThresholdTracker defaults to threshold 1 and a one hour window', () => {
  const tracker = new EventThresholdTracker();
  assert.equal(tracker.threshold, 1);
  assert.equal(tracker.windowMs, 3600000);
  assert.equal(tracker.record(0).exceeded, true);
});

test('EventThresholdTracker reset clears recorded timestamps', () => {
  const tracker = new EventThresholdTracker({ threshold: 2, windowMs: 60000 });
  tracker.record(1000);
  tracker.record(2000);
  tracker.reset();
  assert.equal(tracker.getCount(), 0);
});
