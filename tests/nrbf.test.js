const assert = require('node:assert/strict');
const test = require('node:test');
const { parse } = require('../web/nrbf.js');

function header(root = 1) {
  const bytes = Buffer.alloc(17);
  bytes.writeInt32LE(root, 1);
  bytes.writeInt32LE(-1, 5);
  bytes.writeInt32LE(1, 9);
  return bytes;
}

function string(id, text) {
  const prefix = Buffer.alloc(6);
  prefix[0] = 6;
  prefix.writeInt32LE(id, 1);
  prefix[5] = Buffer.byteLength(text);
  return Buffer.concat([prefix, Buffer.from(text)]);
}

const valid = Buffer.concat([header(), string(1, 'hello'), Buffer.from([11])]);

test('reads a complete stream', () => assert.equal(parse(valid), 'hello'));
test('respects the root ID rather than record order', () => {
  assert.equal(parse(Buffer.concat([
    header(2), string(1, 'first'), string(2, 'root'), Buffer.from([11]),
  ])), 'root');
});
test('rejects every premature EOF in a valid stream', () => {
  for (let length = 0; length < valid.length; length++) {
    assert.throws(() => parse(valid.subarray(0, length)), `length ${length}`);
  }
});
test('requires a serialization header and supported version', () => {
  assert.throws(() => parse(valid.subarray(17)), /header/);
  const bytes = Buffer.from(valid);
  bytes.writeInt32LE(2, 9);
  assert.throws(() => parse(bytes), /version/);
});
test('rejects a missing root', () => {
  assert.throws(() => parse(Buffer.concat([header(2), string(1, 'first'), Buffer.from([11])])), /root/);
});
test('preserves first-stream behavior for stale cache tails', () => {
  assert.equal(parse(Buffer.concat([valid, Buffer.from([0, 0, 0, 11])])), 'hello');
});
test('rejects premature MessageEnd in a member value', () => {
  const object = Buffer.from([4, 1, 0, 0, 0, 1, 84, 1, 0, 0, 0, 1, 120, 2, 11]);
  assert.throws(() => parse(Buffer.concat([header(), object])), /inside a value/);
});
test('rejects a truncated byte array', () => {
  const array = Buffer.from([15, 1, 0, 0, 0, 10, 0, 0, 0, 2, 1, 2, 11]);
  assert.throws(() => parse(Buffer.concat([header(), array])), /truncated/);
});
test('rejects an oversized length prefix', () => {
  const prefix = Buffer.from([6, 1, 0, 0, 0, 128, 128, 128, 128, 128, 0]);
  assert.throws(() => parse(Buffer.concat([header(), prefix])), /length prefix/);
});
test('rejects an unresolved member reference', () => {
  const array = Buffer.from([16, 1, 0, 0, 0, 1, 0, 0, 0, 9, 2, 0, 0, 0, 11]);
  assert.throws(() => parse(Buffer.concat([header(), array])), /reference 2/);
});
