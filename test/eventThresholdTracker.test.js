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

test('EventThresholdTracker keeps memory bounded under high request volume', () => {
  const tracker = new EventThresholdTracker({ threshold: 10, windowMs: 600000 });

  for (let i = 0; i < 20000; i += 1) {
    tracker.record(1000000 + i);
  }

  assert.equal(tracker.samples.length, 20, '样本数被 maxSamples(=threshold*2) 限制');
  assert.equal(tracker.getCount(1002000), 20000, '计数仍然准确(O(1) 内存)');
});

test('EventThresholdTracker honours an explicit maxSamples', () => {
  const tracker = new EventThresholdTracker({ threshold: 2, windowMs: 600000, maxSamples: 3 });
  for (let i = 0; i < 100; i += 1) {
    tracker.record(1000000 + i);
  }
  assert.equal(tracker.samples.length, 3);
  assert.equal(tracker.getCount(1000100), 100);
});

test('EventThresholdTracker starts a fresh window once the window elapses', () => {
  const tracker = new EventThresholdTracker({ threshold: 3, windowMs: 60000 });

  tracker.record(1000);
  tracker.record(2000);
  assert.equal(tracker.getCount(2000), 2);

  assert.equal(tracker.getCount(61000), 0, '窗口到期后计数归零');
  assert.deepEqual(tracker.record(61001), { count: 1, exceeded: false });
  assert.equal(tracker.record(62000).count, 2);
});
