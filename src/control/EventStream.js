const crypto = require('crypto');

function createSessionId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return crypto.randomBytes(16).toString('hex');
}

function createWriteQueue(res, options = {}) {
  const maxQueuedBytes = Number.parseInt(options.maxQueuedBytes, 10) > 0
    ? Number.parseInt(options.maxQueuedBytes, 10)
    : 1024 * 1024;
  const queue = [];
  let queuedBytes = 0;
  let writing = false;
  let closed = false;

  function pump() {
    if (writing || closed) {
      return;
    }

    writing = true;
    while (!closed && queue.length > 0) {
      const payload = queue.shift();
      queuedBytes -= Buffer.byteLength(String(payload));

      let ok = true;
      try {
        ok = res.write(payload);
      } catch (error) {
        ok = false;
        closed = true;
        break;
      }

      if (!ok) {
        res.once('drain', () => {
          writing = false;
          pump();
        });
        return;
      }
    }
    writing = false;
  }

  return {
    write(payload) {
      if (closed) {
        return false;
      }

      const payloadBytes = Buffer.byteLength(String(payload));
      if (queue.length > 0 && queuedBytes + payloadBytes > maxQueuedBytes) {
        return false;
      }

      queue.push(payload);
      queuedBytes += payloadBytes;
      pump();
      return true;
    },
    close() {
      closed = true;
    }
  };
}

class EventStream {
  constructor(options = {}) {
    this.clients = new Set();
    this.maxClients = Number.parseInt(options.maxClients, 10) > 0
      ? Number.parseInt(options.maxClients, 10)
      : 32;
    this.maxQueuedBytes = Number.parseInt(options.maxQueuedBytes, 10) > 0
      ? Number.parseInt(options.maxQueuedBytes, 10)
      : 1024 * 1024;
    this.sequence = 0;
    this.sessionId = createSessionId();
    this.startedAt = new Date().toISOString();
  }

  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt
    };
  }

  writeEvent(client, event, data) {
    const payload = [
      `id: ${++this.sequence}`,
      `event: ${event}`,
      `data: ${JSON.stringify(data)}`,
      '',
      ''
    ].join('\n');

    return client.queue.write(payload);
  }

  canAcceptClient() {
    return this.clients.size < this.maxClients;
  }

  removeClient(client) {
    if (!client) {
      return;
    }

    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = null;
    }

    if (client.queue && typeof client.queue.close === 'function') {
      client.queue.close();
    }

    this.clients.delete(client);
  }

  closeClient(client) {
    if (!client) return;
    this.removeClient(client);
    if (client.res && typeof client.res.end === 'function') {
      try {
        client.res.end();
      } catch (error) {
        // Socket close events will finish cleanup.
      }
    }
  }

  addClient(req, res, options = {}) {
    if (!this.canAcceptClient()) {
      return false;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });

    const client = {
      res,
      queue: createWriteQueue(res, {
        maxQueuedBytes: this.maxQueuedBytes
      }),
      eventFilter: typeof options.eventFilter === 'function'
        ? options.eventFilter
        : null,
      heartbeatTimer: null
    };
    this.clients.add(client);
    if (client.queue.write('retry: 1000\n\n') === false) {
      this.closeClient(client);
      return false;
    }

    const bootstrapEvents = Array.isArray(options.bootstrapEvents)
      ? options.bootstrapEvents
      : [];
    for (const entry of bootstrapEvents) {
      if (!entry || typeof entry.event !== 'string') {
        continue;
      }

      try {
        if (this.writeEvent(client, entry.event, entry.data) === false) {
          this.closeClient(client);
          return false;
        }
      } catch (error) {
        this.closeClient(client);
        return false;
      }
    }

    const heartbeatMs = Number.parseInt(options.heartbeatMs, 10);
    if (Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
      client.heartbeatTimer = setInterval(() => {
        if (client.queue.write(':\n\n') === false) {
          this.closeClient(client);
        }
      }, heartbeatMs);

      if (typeof client.heartbeatTimer.unref === 'function') {
        client.heartbeatTimer.unref();
      }
    }

    req.on('close', () => {
      this.removeClient(client);
    });
    res.on('close', () => {
      this.removeClient(client);
    });
    res.on('error', () => {
      this.removeClient(client);
    });

    return true;
  }

  publish(event, data) {
    for (const client of Array.from(this.clients)) {
      try {
        if (client.eventFilter && client.eventFilter(event, data) !== true) {
          continue;
        }

        if (this.writeEvent(client, event, data) === false) {
          this.closeClient(client);
        }
      } catch (error) {
        this.closeClient(client);
      }
    }
  }
}

module.exports = {
  EventStream
};
