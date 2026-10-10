const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { resolve } = require('../web/sequence.js');

const entry = path => ({ path });
const entries = [
  entry('Welcome.tpl'), entry('Pool A/Welcome.tpl'), entry('Pool A/drafts/Welcome.tpl'),
];

test('Windows absolute paths prefer their longest loaded directory suffix', () => {
  const result = resolve(entries, { path: 'C:\\Library\\Templates\\POOL A\\Welcome.tpl' });
  assert.equal(result.entry, entries[1]);
});
test('relative paths resolve against the sequence folder', () => {
  assert.equal(resolve(entries, { path: 'Welcome.tpl' }, 'Pool A/Show.seq').entry, entries[1]);
  assert.equal(resolve(entries, { path: '../Welcome.tpl' }, 'Pool A/Show.seq').entry, entries[0]);
});
test('basename fallback works only for a unique match', () => {
  const result = resolve(entries, { path: 'D:\\Elsewhere\\Welcome.tpl' });
  assert.equal(result.entry, null);
  assert.match(result.error, /Ambiguous slide/);
  assert.equal(resolve([entries[1]], { path: 'D:\\Elsewhere\\Welcome.tpl' }).entry, entries[1]);
});
test('ambiguous directory suffixes are not resolved arbitrarily', () => {
  const result = resolve([
    entry('A/Pool A/Welcome.tpl'), entry('B/Pool A/Welcome.tpl'),
  ], { path: 'C:\\Templates\\Pool A\\Welcome.tpl' });
  assert.equal(result.entry, null);
  assert.match(result.error, /Ambiguous slide/);
});
test('missing files are reported', () => {
  assert.equal(resolve(entries, { path: 'missing.tpl' }).error, 'Not in loaded folder');
});

function clock() {
  const pending = new Map();
  let id = 0;
  const context = {
    setTimeout(fn, delay) { pending.set(++id, { fn, delay }); return id; },
    clearTimeout(key) { pending.delete(key); },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/sequence.js'), 'utf8'), context);
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  return {
    play: context.DLSequence.play, pending, flush,
    async tick() {
      assert.equal(pending.size, 1);
      const [key, timer] = pending.entries().next().value;
      pending.delete(key);
      timer.fn();
      await flush();
      return timer.delay;
    },
  };
}

test('finite playback stops after the final slide duration and configured cycles', async () => {
  const c = clock(), seen = [];
  c.play([{ seconds: 0.25 }, { seconds: 0.5 }], { loops: 2, loopForever: false },
    i => seen.push(i), assert.fail);
  await c.flush();
  assert.equal(await c.tick(), 250);
  assert.equal(await c.tick(), 500);
  assert.equal(await c.tick(), 250);
  assert.equal(await c.tick(), 500);
  assert.deepEqual(seen, [0, 1, 0, 1]);
  assert.equal(c.pending.size, 0);
});
test('forever playback continues, including single-slide sequences', async () => {
  const c = clock(), seen = [];
  const playback = c.play([{ seconds: 0.1 }], { loopForever: true }, i => seen.push(i), assert.fail);
  await c.flush();
  for (let i = 0; i < 3; i++) assert.equal(await c.tick(), 100);
  assert.equal(seen.length, 4);
  playback.stop();
  assert.equal(c.pending.size, 0);
});
test('stop during an asynchronous render cannot restart a timer', async () => {
  const c = clock();
  let done;
  const rendering = new Promise(resolve => { done = resolve; });
  const playback = c.play([{ seconds: 1 }], { loopForever: true }, () => rendering, assert.fail);
  playback.stop();
  done();
  await c.flush();
  assert.equal(c.pending.size, 0);
});
test('timing begins after the slide finishes rendering', async () => {
  const c = clock();
  let done;
  const rendering = new Promise(resolve => { done = resolve; });
  c.play([{ seconds: 0 }], { loops: 1 }, () => rendering, assert.fail);
  assert.equal(c.pending.size, 0);
  done();
  await c.flush();
  assert.equal(await c.tick(), 0);
  assert.equal(c.pending.size, 0);
});
test('invalid timing and render errors are surfaced without scheduling more slides', async () => {
  for (const seconds of [-1, NaN]) {
    const c = clock(), errors = [];
    c.play([{ seconds }], { loopForever: true }, () => {}, error => errors.push(error));
    await c.flush();
    assert.match(errors[0].message, /duration/);
    assert.equal(c.pending.size, 0);
  }
  const c = clock(), errors = [];
  c.play([{ seconds: 1 }], { loops: 1 }, () => { throw new Error('render failed'); }, error => errors.push(error));
  await c.flush();
  assert.equal(errors[0].message, 'render failed');
  assert.equal(c.pending.size, 0);
});
test('invalid finite loop counts are reported', () => {
  const c = clock(), errors = [];
  c.play([{ seconds: 1 }], { loops: 0 }, assert.fail, error => errors.push(error));
  assert.match(errors[0].message, /loop count/);
  assert.equal(c.pending.size, 0);
});
test('forever playback with only zero-length slides is refused instead of spinning', async () => {
  const c = clock(), errors = [];
  c.play([{ seconds: 0 }, { seconds: 0 }], { loopForever: true }, assert.fail, error => errors.push(error));
  await c.flush();
  assert.match(errors[0].message, /no slide durations/);
  assert.equal(c.pending.size, 0);
});
test('forever playback allows zero-length slides alongside timed ones', async () => {
  const c = clock(), seen = [];
  c.play([{ seconds: 0 }, { seconds: 1 }], { loopForever: true }, i => seen.push(i), assert.fail);
  await c.flush();
  assert.equal(await c.tick(), 0);
  assert.equal(await c.tick(), 1000);
  assert.deepEqual(seen, [0, 1, 0]);
});
test('playback reports when it is no longer active', async () => {
  const c = clock();
  const finite = c.play([{ seconds: 1 }], { loops: 1 }, () => {}, assert.fail);
  await c.flush();
  assert.equal(finite.active, true);
  await c.tick();
  assert.equal(finite.active, false);
  const refused = c.play([{ seconds: 1 }], { loops: 0 }, assert.fail, () => {});
  assert.equal(refused.active, false);
});
