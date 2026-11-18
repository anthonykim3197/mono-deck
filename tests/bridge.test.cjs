const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { Bridge } = require('../src/main/bridge.cjs');
const executable = path.resolve(__dirname, '../native/bin/MacroBridge.exe');
const supported = process.platform === 'win32' && fs.existsSync(executable);

function nextEvent(emitter, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { emitter.off(event, receive); reject(new Error(`Timed out waiting for ${event}`)); }, 4000);
    const receive = (...args) => { clearTimeout(timeout); resolve(args); };
    emitter.once(event, receive);
  });
}

test('bridge reports a missing executable as disconnected and permits repeated stop', { timeout: 10000 }, async () => {
  const bridge = new Bridge(path.join(__dirname, '__missing-native-helper__', 'MacroBridge.exe'));
  const diagnostics = [];
  bridge.on('diagnostic', text => diagnostics.push(text));
  const disconnected = nextEvent(bridge, 'disconnected');
  bridge.start();
  await disconnected;
  assert.equal(bridge.ready, false);
  assert.equal(bridge.disconnected, true);
  assert.match(diagnostics.join('\n'), /ENOENT/);
  await assert.rejects(bridge.request('ping'), /준비되지/);
  assert.doesNotThrow(() => { bridge.stop(); bridge.stop(); });
});

test('bridge rejects an in-flight request promptly when the native process dies', { skip: !supported, timeout: 10000 }, async t => {
  const bridge = new Bridge(executable);
  t.after(() => bridge.stop());
  const ready = nextEvent(bridge, 'ready');
  bridge.start(); await ready;
  assert.deepEqual(await bridge.request('ping'), { pong: true, protocol: 1 });
  // Hold one request on the parent side to model a helper dying before replying.
  // Nothing is injected or sent to a user's application.
  const write = bridge.child.stdin.write;
  bridge.child.stdin.write = () => true;
  const pending = bridge.request('foreground');
  bridge.child.stdin.write = write;
  const rejected = assert.rejects(pending, /종료/);
  const disconnected = nextEvent(bridge, 'disconnected');
  bridge.child.kill();
  await disconnected; await rejected;
  assert.equal(bridge.pending.size, 0);
  assert.equal(bridge.ready, false);
  await assert.rejects(bridge.request('ping'), /준비되지/);
  bridge.stop(); bridge.stop();
});

test('bridge stop during startup cannot become ready again', { skip: !supported, timeout: 10000 }, async () => {
  const bridge = new Bridge(executable);
  let readyEvents = 0;
  bridge.on('ready', () => { readyEvents++; });
  const disconnected = nextEvent(bridge, 'disconnected');
  bridge.start(); bridge.stop();
  await disconnected;
  assert.equal(bridge.ready, false);
  assert.equal(readyEvents, 0);
});

test('bridge clears pending timers when serialization or stream writes throw', async () => {
  const bridge = new Bridge('unused');
  bridge.ready = true;
  bridge.child = { stdin: { destroyed: false, writable: true, writableEnded: false, write() { throw new Error('controlled write failure'); } } };
  await assert.rejects(bridge.request('ping'), /controlled write failure/);
  assert.equal(bridge.pending.size, 0);
  const circular = {}; circular.self = circular;
  await assert.rejects(bridge.request('ping', circular), /circular/i);
  assert.equal(bridge.pending.size, 0);
});
