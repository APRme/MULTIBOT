const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { EventStream } = require('../src/control/EventStream');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
    this.chunks = [];
    this.writeResult = true;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return this.writeResult;
  }

  emitDrain() {
    this.writeResult = true;
    this.emit('drain');
  }

  end(chunk = '') {
    if (chunk) {
      this.write(chunk);
    }
    this.emit('close');
  }

  getText() {
    return this.chunks.join('');
  }
}

function createClientOptions(overrides = {}) {
  return {
    eventFilter: overrides.eventFilter || null,
    bootstrapEvents: overrides.bootstrapEvents || [],
    heartbeatMs: overrides.heartbeatMs
  };
}

function createRequest() {
  return new EventEmitter();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('EventStream exposes session info and filters per client', () => {
  const stream = new EventStream();
  const req = createRequest();
  const res = new FakeResponse();

  const sessionInfo = stream.getSessionInfo();
  assert.equal(typeof sessionInfo.sessionId, 'string');
  assert.ok(sessionInfo.sessionId.length > 0);
  assert.equal(typeof sessionInfo.startedAt, 'string');

  stream.addClient(req, res, createClientOptions({
    eventFilter(event, data) {
      return event === 'log' && data && data.botId === 'alpha';
    },
    bootstrapEvents: [{
      event: 'bootstrap',
      data: {
        ok: true
      }
    }]
  }));

  assert.equal(res.statusCode, 200);
  assert.match(res.getText(), /retry: 1000/);
  assert.match(res.getText(), /event: bootstrap/);

  const beforePublish = res.getText();
  stream.publish('log', {
    botId: 'beta',
    message: 'ignored'
  });
  assert.equal(res.getText(), beforePublish);

  stream.publish('log', {
    botId: 'alpha',
    message: 'accepted'
  });
  assert.match(res.getText(), /"botId":"alpha"/);
  assert.match(res.getText(), /"message":"accepted"/);

  req.emit('close');
  assert.equal(stream.clients.size, 0);
});

test('EventStream sends heartbeats and cleans up closed clients', async () => {
  const stream = new EventStream();
  const req = createRequest();
  const res = new FakeResponse();

  stream.addClient(req, res, createClientOptions({
    heartbeatMs: 10
  }));

  await wait(25);
  assert.match(res.getText(), /:\n\n/);
  assert.equal(stream.clients.size, 1);

  res.emit('close');
  assert.equal(stream.clients.size, 0);
});

test('EventStream limits clients', () => {
  const stream = new EventStream({ maxClients: 1 });
  const firstReq = createRequest();
  const firstRes = new FakeResponse();
  const secondReq = createRequest();
  const secondRes = new FakeResponse();

  assert.equal(stream.addClient(firstReq, firstRes), true);
  assert.equal(stream.canAcceptClient(), false);
  assert.equal(stream.addClient(secondReq, secondRes), false);
  assert.equal(secondRes.statusCode, null);

  firstRes.emit('close');
  assert.equal(stream.clients.size, 0);
});

test('EventStream keeps a backpressured client and flushes queued events after drain', () => {
  const stream = new EventStream({ maxClients: 1 });
  const req = createRequest();
  const res = new FakeResponse();

  assert.equal(stream.addClient(req, res), true);
  res.writeResult = false;
  stream.publish('log', { botId: 'alpha', message: 'slow client' });

  assert.equal(stream.clients.size, 1);

  res.emitDrain();
  assert.match(res.getText(), /"slow client"/);
  assert.equal(stream.clients.size, 1);

  res.emit('close');
  assert.equal(stream.clients.size, 0);
});

test('EventStream keeps a client with a large bootstrap payload', () => {
  const stream = new EventStream();
  const req = createRequest();
  const res = new FakeResponse();
  res.writeResult = false;

  const added = stream.addClient(req, res, createClientOptions({
    bootstrapEvents: [{
      event: 'bootstrap',
      data: {
        marker: 'x'.repeat(256 * 1024)
      }
    }]
  }));

  assert.equal(added, true);
  assert.equal(stream.clients.size, 1);

  res.emitDrain();
  assert.match(res.getText(), /event: bootstrap/);
  assert.equal(stream.clients.size, 1);
});
