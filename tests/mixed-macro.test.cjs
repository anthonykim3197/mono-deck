const test = require('node:test');
const assert = require('node:assert/strict');
const { MacroRunner } = require('../src/main/macro-engine.cjs');

// This fixture models the owned testpad only. It never starts the native helper,
// moves the real pointer, or emits input to any application.
function fixture(options = {}) {
  let time = 0;
  const calls = [], events = [], held = new Set();
  const target = { x: 800, y: 450, focused: false, selected: false, text: 'initial text', keys: [], foreground: '123456789' };
  const cursor = { x: 0, y: 0 };
  const monitors = [
    {id: 'primary', left: 0, top: 0, width: 3840, height: 2160, dpiX: 144, dpiY: 144},
    {id: 'left', left: -1920, top: -200, width: 1920, height: 1080, dpiX: 96, dpiY: 96},
  ];
  const insert = text => { target.text = target.selected ? text : target.text + text; target.selected = false; };
  const bridge = {
    ready: true,
    async request(command, data = {}) {
      calls.push({ command, data: JSON.parse(JSON.stringify(data)), at: time });
      if (command === 'releaseAll') { held.clear(); return {remaining: 0}; }
      if (command === 'resume') return {resumed: true};
      if (command === 'monitors') return {monitors};
      if (data.requiredForegroundWindow && data.requiredForegroundWindow !== target.foreground) throw new Error('Required test window lost focus');
      if (options.request) await options.request(command, data);
      if (command === 'mouse') {
        if (Number.isInteger(data.x) && Number.isInteger(data.y)) {
          cursor.x = data.relative ? cursor.x + data.x : data.x;
          cursor.y = data.relative ? cursor.y + data.y : data.y;
        }
        if (data.action === 'click') {
          target.focused = cursor.x === target.x && cursor.y === target.y;
          assert.ok(target.focused, 'A keyboard target is focused only by the planned coordinate click');
        }
      }
      if (['key', 'shortcut', 'text'].includes(command)) {
        assert.ok(target.focused, 'Keyboard output must follow the successful target click');
        if (command === 'key') {
          target.keys.push({key: data.key, state: data.state, at: time});
          if (data.state === 'down') held.add(data.key); else held.delete(data.key);
        }
        if (command === 'shortcut') {
          if (data.keys.join('+') === 'CTRL+A') target.selected = true;
        }
        if (command === 'text') insert(data.text);
      }
      return {};
    },
  };
  let runner;
  runner = new MacroRunner({
    bridge, blockedPid: 555, isEditorFocused: () => false,
    now: () => time, sleep: async ms => { time += ms; if (options.onSleep) await options.onSleep({ms, time, target, runner}); },
    onEvent: event => events.push(JSON.parse(JSON.stringify(event))),
  });
  const output = () => calls.filter(call => ['mouse', 'key', 'shortcut', 'text', 'media'].includes(call.command));
  return {runner, calls, events, target, cursor, held, output, time: () => time};
}

const sequence = steps => ({type: 'sequence', label: 'Owned mixed test', steps});
const move = (x, y, extra = {}) => ({type: 'mouse', mouseAction: 'move', x, y, ...extra});
const click = () => ({type: 'mouse', mouseAction: 'click', button: 'left'});
const delay = delayMs => ({type: 'delay', delayMs});
const key = (name, state) => ({type: 'key', key: name, state});

test('mixed macro executes coordinate move → click → delay → key pair → shortcut → Unicode text', async () => {
  const f = fixture();
  const result = await f.runner.run(sequence([
    move(800, 450), click(), delay(250), key('F8', 'down'), key('F8', 'up'),
    {type: 'shortcut', keys: ['CTRL', 'A']}, {type: 'text', text: 'MONO DECK 혼합 테스트 ✓'},
  ]));
  assert.equal(result.ok, true);
  assert.deepEqual(f.output().map(call => call.command + ':' + (call.data.action || call.data.state || '')), ['mouse:move', 'mouse:click', 'key:down', 'key:up', 'shortcut:', 'text:']);
  assert.deepEqual(f.target.keys, [{key: 'F8', state: 'down', at: 250}, {key: 'F8', state: 'up', at: 250}]);
  assert.equal(f.target.text, 'MONO DECK 혼합 테스트 ✓', 'Ctrl+A selects existing testpad text before Unicode replacement');
  assert.equal(f.time(), 250);
  assert.equal(f.held.size, 0);
  assert.equal(f.calls.at(-1).command, 'releaseAll');
  assert.ok(f.output().every(call => call.data.blockedForegroundPid === 555));
});

test('mixed monitor-local moves use physical coordinates without applying DPI a second time', async () => {
  const f = fixture();
  f.target.x = -1600; f.target.y = -100;
  const result = await f.runner.run(sequence([
    move(300, 100, {coordinateSpace: 'monitor', monitorId: 'left'}),
    move(20, 0, {relative: true}), click(), delay(100), key('F8', 'down'), key('F8', 'up'),
  ]));
  assert.equal(result.ok, true);
  const outputs = f.output();
  assert.deepEqual([outputs[0].data.x, outputs[0].data.y], [-1620, -100]);
  assert.deepEqual([f.cursor.x, f.cursor.y], [-1600, -100]);
  assert.equal(outputs[1].data.relative, true);
  assert.equal(f.target.keys[0].at, 100);
});

test('mouse failure prevents the rest of a mixed macro and still completes cleanup', async () => {
  const f = fixture({request: (command, data) => { if (command === 'mouse' && data.action === 'click') throw new Error('Controlled click rejection'); }});
  const result = await f.runner.run(sequence([move(800, 450), click(), delay(500), key('A', 'down'), key('A', 'up')]));
  assert.equal(result.ok, false);
  assert.match(result.error, /click rejection/);
  assert.equal(f.output().some(call => call.command === 'key'), false);
  assert.equal(f.time(), 0);
  assert.equal(f.calls.at(-1).command, 'releaseAll');
  assert.equal(f.events.at(-1).status, 'error');
});

test('stopping after the mixed macro click prevents delayed keyboard output', async () => {
  let stopped = false;
  const f = fixture({onSleep: async ({runner}) => { if (!stopped) { stopped = true; await runner.stop('Controlled stop after click'); } }});
  const result = await f.runner.run(sequence([move(800, 450), click(), delay(1000), key('A', 'down'), key('A', 'up')]));
  assert.equal(result.cancelled, true);
  assert.equal(f.target.focused, true);
  assert.equal(f.target.keys.length, 0);
  assert.equal(f.time(), 25);
  assert.equal(f.calls.at(-1).command, 'releaseAll');
});

test('owned testpad guard is propagated to every output even when editor output is allowed', async () => {
  const f = fixture();
  const result = await f.runner.run(sequence([
    move(800, 450), click(), delay(50), key('F8', 'down'), key('F8', 'up'),
    {type: 'shortcut', keys: ['CTRL', 'A']}, {type: 'text', text: 'OWNED'},
  ]), {allowEditor: true, outputGuard: {requiredForegroundWindow: '123456789'}});
  assert.equal(result.ok, true);
  assert.ok(f.output().every(call => call.data.requiredForegroundWindow === '123456789'));
  assert.ok(f.output().every(call => !('blockedForegroundPid' in call.data)));
});

test('testpad focus loss after click blocks late keyboard output at the native boundary', async () => {
  const f = fixture({onSleep: async ({target}) => { target.foreground = '987654321'; }});
  const result = await f.runner.run(sequence([move(800, 450), click(), delay(100), key('F8', 'down'), key('F8', 'up')]), {
    allowEditor: true, outputGuard: {requiredForegroundWindow: '123456789'},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /lost focus/);
  assert.equal(f.target.keys.length, 0, 'The boundary rejects the key before its target receives it');
  assert.equal(f.calls.at(-1).command, 'releaseAll');
});
