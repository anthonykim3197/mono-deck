const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture(options = {}) {
  const handlers = new Map(), files = new Map(), windows = [], points = [], runs = [], stops = [];
  const hwnd = 0x1000000000000123n;
  class Window extends EventEmitter {
    constructor(configuration) {
      super(); this.configuration = configuration; this.focused = true; this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {mainFrame: {}, setWindowOpenHandler() {}, setZoomFactor() {}});
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isFocused() { return this.focused; }
    focus() { this.focused = true; }
    show() {}
    getContentBounds() { return {x: -1200, y: 60, width: 900, height: 720}; }
    getNativeWindowHandle() { const value = Buffer.alloc(8); value.writeBigUInt64LE(hwnd); return value; }
    loadFile() { return Promise.resolve(); }
    close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }
  const module = {exports: {}};
  const runner = {
    async run(action, settings) { runs.push({action, settings}); return options.run ? options.run(action, settings) : {ok: true}; },
    async stop(message) { stops.push(message); },
  };
  const electron = {
    BrowserWindow: Window,
    ipcMain: {handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel)},
    screen: {dipToScreenPoint: point => { points.push({...point}); return {x: point.x * 2, y: point.y * 2}; }},
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/main/testpad.cjs'), 'utf8'), {
    module, __dirname: path.resolve(__dirname, '../src/main'), Buffer, console,
    require: name => {
      if (name === 'electron') return electron;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return {randomUUID: () => 'owned-test-id'};
      if (name === 'node:fs') return {mkdirSync() {}, writeFileSync: (file, contents) => files.set(file, contents)};
      throw new Error(`Unexpected test module: ${name}`);
    },
  });
  module.exports.openTestPad({parent: {}, runner, bridge: {request: async () => ({x: -1960, y: 400})}, directory: '/test/data', stopEverything: options.stopEverything || (async () => {}), log() {}});
  const window = windows[0];
  const invoke = (channel, value, event = {sender: window.webContents, senderFrame: window.webContents.mainFrame}) => handlers.get(channel)(event, value);
  return {window, handlers, files, points, runs, stops, invoke, hwnd};
}

const rect = {x: 20, y: 80, width: 400, height: 120};
const expected = 'MONO DECK 복합 매크로 테스트 성공 ✓';
const evidence = {id: 'owned-test-id', value: expected, moved: true, clicked: true, ctrlA: true, f8Down: true, f8Up: true, delayMs: 501};

test('owned testpad rejects another renderer and invalid target geometry before running input', async () => {
  const f = fixture();
  await assert.rejects(f.invoke('testpad:start', rect, {sender: {}, senderFrame: {}}), /Untrusted/);
  await assert.rejects(f.invoke('testpad:start', {...rect, x: -1}), /위치/);
  await assert.rejects(f.invoke('testpad:start', {...rect, width: 1000}), /위치/);
  await assert.rejects(f.invoke('testpad:start', {...rect, y: NaN}), /위치/);
  assert.equal(f.runs.length, 0);
  assert.equal(f.files.size, 0);
});

test('owned testpad maps the content center from DIP once and freezes an exact HWND guard', async () => {
  const f = fixture();
  const run = await f.invoke('testpad:start', rect);
  assert.equal(run.ok, true);
  assert.equal(f.window.configuration.movable, false);
  assert.equal(f.window.configuration.resizable, false);
  assert.deepEqual(f.points, [{x: -980, y: 200}]);
  assert.deepEqual(JSON.parse(JSON.stringify(run.point)), {x: -1960, y: 400});
  const {action, settings} = f.runs[0];
  assert.equal(settings.allowEditor, true);
  assert.equal(settings.outputGuard.requiredForegroundWindow, f.hwnd.toString(), 'Never round HWND through a JavaScript Number');
  assert.equal(settings.targetAllowed(), true);
  f.window.focused = false;
  assert.equal(settings.targetAllowed(), false);
  assert.deepEqual(Array.from(action.steps, step => step.type), ['mouse', 'mouse', 'delay', 'shortcut', 'text', 'key', 'key']);
  assert.equal(action.steps[2].delayMs, 500);
  assert.equal(action.steps[5].key, 'F8');
});

test('testpad success requires every observed mouse, shortcut, text and key transition', async () => {
  const f = fixture();
  await f.invoke('testpad:start', rect);
  const good = await f.invoke('testpad:finish', evidence);
  assert.equal(good.ok, true);
  const report = JSON.parse([...f.files.values()][0]);
  assert.equal(report.ok, true);
  assert.equal(report.observed.value, expected);
  for (const change of [{value: 'wrong'}, {moved: false}, {clicked: false}, {ctrlA: false}, {f8Down: false}, {f8Up: false}, {delayMs: 449}]) {
    assert.equal((await f.invoke('testpad:finish', {...evidence, ...change})).ok, false);
  }
  await assert.rejects(f.invoke('testpad:finish', {...evidence, id: 'other-run'}), /Invalid test/);
});

test('closing an active owned testpad cancels its macro and removes its IPC handlers', async () => {
  let complete;
  const pendingResult = new Promise(resolve => { complete = resolve; });
  const f = fixture({run: () => pendingResult});
  const starting = f.invoke('testpad:start', rect);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  f.window.close();
  assert.equal(f.stops.length, 1);
  assert.equal(f.handlers.size, 0);
  complete({ok: false, cancelled: true});
  assert.equal((await starting).ok, false);
});

test('testpad rejects a concurrent start while its preparation is still awaiting cleanup', async () => {
  let release;
  const cleanup = new Promise(resolve => { release = resolve; });
  const f = fixture({stopEverything: () => cleanup});
  const starting = f.invoke('testpad:start', rect);
  await assert.rejects(f.invoke('testpad:start', rect), /진행 중/);
  assert.equal(f.runs.length, 0);
  release();
  assert.equal((await starting).ok, true);
  assert.equal(f.runs.length, 1);
});

test('testpad setup failure clears its active guard for a later deliberate retry', async () => {
  let first = true;
  const f = fixture({stopEverything: async () => { if (first) { first = false; throw new Error('Controlled cleanup failure'); } }});
  await assert.rejects(f.invoke('testpad:start', rect), /cleanup failure/);
  assert.equal(f.runs.length, 0);
  assert.equal((await f.invoke('testpad:start', rect)).ok, true);
  assert.equal(f.runs.length, 1);
});
