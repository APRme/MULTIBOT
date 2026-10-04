const test = require('node:test');
require('./helpers/tempDir'); // 测试临时目录统一重定向到工作区 .temp/test-run/
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { FullPacketParser } = require('protodef');
const {
  applyProtocolGuardHotfix,
  isIgnorableMalformedNbtArrayError
} = require('../src/legacy/assn/protocol-guard-hotfix');

const MALFORMED_MESSAGE = 'Read error for undefined : array size is abnormally large, not reading: 591808068';
const MALFORMED_STACK = [
  `Error: ${MALFORMED_MESSAGE}`,
  '    at Object.byteArray (eval at compile (/proto/compiler.js:262:12), <anonymous>:5420:60)',
  '    at Object.nbtSwitch (eval at compile (/proto/compiler.js:262:12), <anonymous>:5483:49)',
  '    at Object.anonymousNbt (eval at compile (/proto/compiler.js:262:12), <anonymous>:83:64)',
  '    at Object.SlotComponent (eval at compile (/proto/compiler.js:262:12), <anonymous>:1090:9)',
  '    at Object.Slot (eval at compile (/proto/compiler.js:262:12), <anonymous>:1493:9)'
].join('\n');

function malformedError({ partial = false } = {}) {
  const error = new Error(MALFORMED_MESSAGE);
  error.stack = MALFORMED_STACK;
  error.field = 'play.toClient';
  if (partial) {
    error.partialReadError = true;
  }
  return error;
}

// 构造一个"够 _transform 用"的假解析器: 只需 parsePacketBuffer / emit / push / noErrorLogging
function createFakeParser(error) {
  const parser = new EventEmitter();
  parser.noErrorLogging = true;
  parser.pushed = [];
  parser.parsePacketBuffer = () => {
    throw error;
  };
  parser.push = (value) => {
    parser.pushed.push(value);
  };
  parser.run = (chunk) => new Promise((resolve) => {
    const result = { callbackError: undefined, called: false };
    FullPacketParser.prototype._transform.call(parser, chunk, null, (callbackError) => {
      result.called = true;
      result.callbackError = callbackError;
      resolve(result);
    });
  });
  return parser;
}

const CHUNK = Buffer.from([0x10, 0x00, 0x01, 0x02, 0x03]);

test('isIgnorableMalformedNbtArrayError 命中 Slot/组件 NBT 解析异常', () => {
  assert.equal(isIgnorableMalformedNbtArrayError(malformedError()), true);

  const unrelated = new Error('some unrelated failure');
  unrelated.stack = 'Error: some unrelated failure\n    at foo (/app/foo.js:1:1)';
  assert.equal(isIgnorableMalformedNbtArrayError(unrelated), false);
});

test('协议保护吞包时仍只发 malformed_packet_ignored', async () => {
  applyProtocolGuardHotfix({
    enabled: true,
    ignoreMalformedNbtArrayPackets: true,
    burstLimit: 5,
    burstWindowMs: 60000,
    logParseErrors: false
  });

  const parser = createFakeParser(malformedError());
  const ignored = [];
  const unswallowed = [];
  parser.on('malformed_packet_ignored', (info) => ignored.push(info));
  parser.on('packet_parse_error', (info) => unswallowed.push(info));

  const result = await parser.run(CHUNK);

  assert.equal(result.callbackError, undefined, '吞包时不向上抛错');
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].reason, 'ignored');
  assert.equal(ignored[0].chunkLength, CHUNK.length);
  assert.equal(unswallowed.length, 0);
});

test('突发超限时发 packet_parse_error(reason=burst_limit) 且错误照旧上抛', async () => {
  applyProtocolGuardHotfix({
    enabled: true,
    ignoreMalformedNbtArrayPackets: true,
    burstLimit: 1,
    burstWindowMs: 60000,
    logParseErrors: false
  });

  const parser = createFakeParser(malformedError());
  const ignored = [];
  const unswallowed = [];
  parser.on('malformed_packet_ignored', (info) => ignored.push(info));
  parser.on('packet_parse_error', (info) => unswallowed.push(info));

  const first = await parser.run(CHUNK);
  const second = await parser.run(CHUNK);

  assert.equal(first.callbackError, undefined);
  assert.equal(second.callbackError instanceof Error, true, '超限后错误必须上抛(不再吞包)');
  assert.equal(ignored.length, 1);
  assert.equal(unswallowed.length, 1);
  assert.equal(unswallowed[0].reason, 'burst_limit');
  assert.equal(unswallowed[0].ignoredCount, 1);
  assert.match(unswallowed[0].errorMessage, /array size is abnormally large/);
});

test('不可归类的解析异常发 packet_parse_error(reason=unclassified)', async () => {
  applyProtocolGuardHotfix({
    enabled: true,
    ignoreMalformedNbtArrayPackets: true,
    burstLimit: 20,
    burstWindowMs: 60000,
    logParseErrors: false
  });

  const broken = new Error('totally unexpected parse failure');
  broken.stack = 'Error: totally unexpected parse failure\n    at bar (/app/bar.js:2:2)';
  const parser = createFakeParser(broken);
  const unswallowed = [];
  parser.on('packet_parse_error', (info) => unswallowed.push(info));

  const result = await parser.run(CHUNK);

  assert.equal(result.callbackError instanceof Error, true);
  assert.equal(unswallowed.length, 1);
  assert.equal(unswallowed[0].reason, 'unclassified');
});

test('半包(partialReadError)发 packet_parse_error(reason=partial_read) 且静默丢弃', async () => {
  applyProtocolGuardHotfix({
    enabled: true,
    ignoreMalformedNbtArrayPackets: true,
    burstLimit: 20,
    burstWindowMs: 60000,
    logParseErrors: false
  });

  const parser = createFakeParser(malformedError({ partial: true }));
  const unswallowed = [];
  parser.on('packet_parse_error', (info) => unswallowed.push(info));

  const result = await parser.run(CHUNK);

  assert.equal(result.callbackError, undefined, '半包保持原有静默丢弃行为');
  assert.equal(unswallowed.length, 1);
  assert.equal(unswallowed[0].reason, 'partial_read');
});
