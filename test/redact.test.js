const test = require('node:test');
const assert = require('node:assert/strict');
const { redactText, summarizeError } = require('../src/util/redact');

test('redactText strips urls, emails and long tokens', () => {
  const output = redactText(
    'connect failed https://bark.example.com:62490/abcdefghijklmnopqrstuvwxyz/push user.name@example.com device_key=0123456789abcdefghijklmnop'
  );

  assert.equal(output.includes('http'), false);
  assert.equal(output.includes('@example.com'), false);
  assert.equal(output.includes('0123456789abcdefghijklmnop'), false);
  assert.match(output, /<url>/);
  assert.match(output, /<email>/);
  assert.match(output, /<redacted>/);
});

test('redactText truncates to the requested length with an ellipsis', () => {
  const output = redactText('connection failed while talking to the server '.repeat(20), 20);
  assert.equal(output.length, 21);
  assert.equal(output.endsWith('…'), true);
});

test('redactText handles empty and non-string input', () => {
  assert.equal(redactText(null), '');
  assert.equal(redactText(undefined), '');
  assert.equal(redactText('   '), '');
  assert.equal(redactText(42), '42');
});

test('summarizeError keeps the error name and redacts the message', () => {
  const error = new TypeError('bad value at https://secret.example.com/x?token=abcdefghijklmnopqrstuvwxyz');
  const summary = summarizeError(error);

  assert.match(summary, /^TypeError: /);
  assert.equal(summary.includes('secret.example.com'), false);
  assert.match(summary, /<url>/);
});

test('summarizeError falls back to unknown for missing errors', () => {
  assert.equal(summarizeError(null), 'unknown');
  assert.equal(summarizeError({ name: 'CustomError' }), 'CustomError');
});
