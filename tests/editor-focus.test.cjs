const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const protocol=require('../src/main/protocol.cjs');

const mainPath = path.resolve(__dirname, '../src/main/main.cjs');
const controls = [...Array.from({ length: 15 }, (_, i) => `key${i + 1}`), ...[1, 2, 3].flatMap(n => [`knob${n}.ccw`, `knob${n}.press`, `knob${n}.cw`])];
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function loadApplication(options={}) {
  // Run the real main process code with in-memory Electron, filesystem, bridge,
  // device and timers. This test never opens a window or connects to hardware.
  const hotkeys=new Map(),hotkeyRegistrations=[];
  const ipc = new Map(), files = new Map(), sent = [], requests = [], timers = new Map(), intervals = [];
  const instances = { windows: [], bridges: [], keyboards: [] };
  let now = 1_700_000_000_000, timerId = 0;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const setTimeoutFake = (callback, ms) => { const id = ++timerId; timers.set(id, { callback, at: now + ms }); return id; };
  async function advance(ms) {
    const target = now + ms;
    for (let count = 0; count < 10000; count++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { now = target; await flush(); return; }
      timers.delete(next[0]); now = next[1].at; next[1].callback(); await flush();
    }
    throw new Error('Fake timer loop exceeded its bound');
  }
  const app = new EventEmitter();
  const appPaths = { appData: '/test/appdata', userData: '/test/appdata/mono-deck' };
  Object.assign(app, {
    isPackaged: true, getPath: name => appPaths[name], setPath: (name, value) => { appPaths[name] = value; },
    setAppUserModelId() {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getAppPath: () => '/test/application', setLoginItemSettings() {}, quit() { app.emit('before-quit'); },
  });
  class Window extends EventEmitter {
    constructor() {
      super(); this.focused = true; this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: {}, send: (channel, event) => sent.push({ channel, event: clone(event) }),
        setWindowOpenHandler() {}, setZoomFactor() {},
      });
      instances.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isFocused() { return this.focused; }
    isMinimized() { return false; }
    show() {} hide() { this.focused = false; } focus() { this.focused = true; } restore() {}
    loadFile() { return Promise.resolve(); }
  }
  class Tray extends EventEmitter { setContextMenu() {} setToolTip() {} displayBalloon() {} }
  class Bridge extends EventEmitter {
    constructor() { super(); this.ready = false; instances.bridges.push(this); }
    start() { this.ready = true; this.emit('ready', { emergencyHotkeyRegistered: true }); }
    stop() { this.ready = false; }
    async request(command, data = {}) {
      requests.push({ command, data: clone(data) });
      if (this.requestHandler) return this.requestHandler(command, data);
      return command === 'foreground' ? { process: 'test-editor', title: 'Test target' } : {};
    }
  }
  class Keyboard {
    constructor() {
      this.status = { connected: true, mappedControls: 24,serial:'SIMULATED-DEVICE' }; this.busy = false;
      this.lastReports=[1,2,3].flatMap(layer=>controls.map((_,i)=>{const r=[...protocol.mappingPacket(i+1,layer)];r[1]=0xfa;return r;}));
      this.inputMap=new Map(this.lastReports.map(r=>[protocol.fingerprint(r),{control:controls[r[2]-1],layer:r[3]}]));
      this.writes=[];
      instances.keyboards.push(this);
    }
    async refresh() { return this.status; }
    async writeSelectedMappings(reports,mode,hooks){
      hooks.onProgress?.({phase:'reading',done:0,total:reports.length});
      await hooks.beforeWrite?.({before:this.lastReports,serial:this.status.serial,backupPath:'simulated-backup'});
      this.writes.push({reports:clone(reports),mode});
      this.lastReports=this.lastReports.map(r=>{const changed=reports.find(a=>a[2]===r[2]&&a[3]===r[3]);if(!changed)return r;const next=[...changed];next[1]=0xfa;return next;});
      hooks.onProgress?.({phase:'verifying',done:reports.length,total:reports.length});
      return {ok:true};
    }
  }
  const fakeFs = {
    mkdirSync() {}, existsSync: name => files.has(name),
    readFileSync(name) { if (!files.has(name)) throw new Error('ENOENT'); return files.get(name); },
    writeFileSync: (name, value) => files.set(name, value),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    copyFileSync: (from, to) => files.set(to, files.get(from)),
  };
  // Preserve the real config/default validation while replacing its HID import.
  const configModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(path.dirname(mainPath), 'config.cjs'), 'utf8'), {
    module: configModule, require: name => name==='./pages.cjs'?require('../src/main/pages.cjs'):{controls},
  });
  const fakeProcess = { argv: [], pid: 43210, resourcesPath: '/test/resources', execPath: '/test/MONO DECK.exe' };
  const modeModule={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(path.dirname(mainPath),'mode-manager.cjs'),'utf8'),{
    module:modeModule,exports:modeModule.exports,Buffer,
    require:name=>name==='node:fs'?fakeFs:name==='./protocol.cjs'?protocol:name==='./onboard.cjs'?require('../src/main/onboard.cjs'):name==='./pages.cjs'?require('../src/main/pages.cjs'):require(name),
  });
  const runnerModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(path.dirname(mainPath), 'macro-engine.cjs'), 'utf8'), {
    module: runnerModule, require: name => { assert.equal(name, './config.cjs'); return configModule.exports; },
    Date: ClockDate, setTimeout: setTimeoutFake, process: fakeProcess,
  });
  const modules = {
    electron: {
      app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: template => template },
      nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, ipcMain: { handle: (name, callback) => ipc.set(name, callback) },
      dialog: { showErrorBox: (_title, error) => { throw new Error(error); } },
      shell: { openExternal: async () => {}, openPath: async () => '' },
      globalShortcut: { unregisterAll() {hotkeys.clear();}, register: (key,callback) => {hotkeyRegistrations.push(key);hotkeys.set(key,callback);return true;} },
    },
    'node:fs': fakeFs, 'node:path': path, 'node:url': require('node:url'),
    'node:child_process': { spawn() { throw new Error('Unexpected real process execution in focus regression test'); } },
    './pages.cjs':require('../src/main/pages.cjs'), './page-hud.cjs':{show(){},hide(){}}, './mode-manager.cjs':modeModule.exports,'./onboard.cjs':require('../src/main/onboard.cjs'),
    './protocol.cjs': { Keyboard, lightingModes: [], lightingColors: [] }, './bridge.cjs': { Bridge }, './config.cjs': configModule.exports, './macro-engine.cjs': runnerModule.exports,
    'node-hid': { devicesAsync: async () => [] },
  };
  const context = vm.createContext({
    require: name => { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; },
    __dirname: path.dirname(mainPath), process: fakeProcess,
    URL, console, Date: ClockDate, setTimeout: setTimeoutFake, clearTimeout: id => timers.delete(id),
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return { unref() {} }; },
  });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
  await flush();
  assert.equal(instances.windows.length, 1, 'Application startup creates one stub window');
  assert.equal(intervals.length, 2, 'Application startup completes both polling registrations');
  const window = instances.windows[0], bridge = instances.bridges[0];
  const invoke = (name, ...args) => ipc.get(`deck:${name}`)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  const input = (fingerprint = options.pages?'SHIFT+F21':'SHIFT+F18') => bridge.emit('message', { type: 'input', fingerprint });
  const inputEvents = () => sent.filter(item => item.event.type === 'input').map(item => item.event);
  const outputRequests = () => requests.filter(request => ['shortcut', 'text', 'key', 'mouse', 'media'].includes(request.command));
  if(!options.pages){const {config}=await invoke('getState');config.profiles[0].layers[3]['knob1.cw']={type:'shortcut',keys:['CTRL','+']};await invoke('saveConfig',config);}
  return { window, bridge, keyboard:instances.keyboards[0],hotkeys,hotkeyRegistrations,requests, outputRequests, sent, invoke, input, inputEvents, advance, flush };
}

test('focused editor highlights a physical knob without executing its zoom shortcut', async () => {
  const app = await loadApplication();
  app.window.focused = true;
  app.input(); await app.flush();
  assert.equal(app.inputEvents().at(-1).control, 'knob1.cw');
  assert.equal(app.requests.length, 0);
});

test('background editor executes mapped input while paused input remains monitor-only', async () => {
  const app = await loadApplication();
  app.window.focused = false;
  app.input(); await app.flush();
  assert.deepEqual(app.outputRequests(), [{ command: 'shortcut', data: { keys: ['CTRL', '+'], blockedForegroundPid: 43210 } }]);
  assert.ok(app.requests.some(request => request.command === 'resume'));
  assert.ok(app.requests.some(request => request.command === 'releaseAll'));
  const { config } = await app.invoke('getState');
  await app.invoke('saveConfig', { ...clone(config), enabled: false });
  app.input(); await app.flush();
  assert.equal(app.outputRequests().length, 1);
  assert.equal(app.inputEvents().length, 2, 'Pausing does not disable the physical input monitor');
});

test('focus gained after dispatch but before queue execution cancels the queued shortcut', async () => {
  const app = await loadApplication();
  app.window.focused = false;
  app.input();
  app.window.focused = true;
  await app.flush();
  assert.equal(app.inputEvents().length, 1);
  assert.equal(app.outputRequests().length, 0);
});

test('focus gained during an action delay prevents its output', async () => {
  const app = await loadApplication();
  const { config } = await app.invoke('getState');
  const next = clone(config);
  next.profiles[0].layers[3]['knob1.cw'].delayMs = 200;
  await app.invoke('saveConfig', next);
  app.window.focused = false; app.input(); await app.flush();
  await app.advance(80);
  app.window.focused = true;
  await app.advance(120);
  assert.equal(app.outputRequests().length, 0);
});

test('explicit testAction still runs in the focused editor after its two-second countdown', async () => {
  const app = await loadApplication();
  app.window.focused = true;
  const pending = app.invoke('testAction', { type: 'text', label: 'Own scratch field', text: 'MONO DECK 입력 테스트 ✓' });
  await app.flush(); await app.advance(1999);
  assert.equal(app.outputRequests().length, 0);
  await app.advance(1);
  assert.equal((await pending).ok, true);
  assert.deepEqual(app.outputRequests(), [{ command: 'text', data: { text: 'MONO DECK 입력 테스트 ✓' } }]);
});

test('pausing during an explicit test countdown cancels the pending output', async () => {
  const app = await loadApplication();
  const pending = app.invoke('testAction', { type: 'shortcut', keys: ['CTRL', 'W'] });
  await app.flush();
  const { config } = await app.invoke('getState');
  await app.invoke('saveConfig', { ...clone(config), enabled: false });
  await app.advance(2000);
  assert.equal((await pending).ok, false);
  assert.equal(app.outputRequests().length, 0);
});

test('recordStop accepts native balanced releases before its response', async () => {
  const app = await loadApplication();
  const starting = app.invoke('startRecording');
  await app.flush(); await app.advance(2000);
  assert.equal((await starting).ok, true);
  const startRequest = app.requests.find(request => request.command === 'recordStart');
  assert.equal(startRequest.data.excludeProcessId, 43210);
  app.bridge.emit('message', {type: 'record', timestamp: 0, event: {type: 'key', key: 'A', state: 'down'}});
  app.bridge.requestHandler = async command => {
    if (command === 'recordStop') app.bridge.emit('message', {type: 'record', timestamp: 10, event: {type: 'key', key: 'A', state: 'up'}});
    return {};
  };
  const steps = await app.invoke('stopRecording');
  assert.deepEqual(clone(steps.filter(step => step.type === 'key').map(step => ({key: step.key, state: step.state}))), [{key: 'A', state: 'down'}, {key: 'A', state: 'up'}]);
  const state = await app.invoke('getState');
  assert.equal(state.recording.recording, false);
  assert.equal(state.recording.starting, false);
});

test('cancelling the recording countdown never installs native recording hooks', async () => {
  const app = await loadApplication();
  const starting = app.invoke('startRecording');
  await app.flush(); await app.advance(500);
  await app.invoke('stopMacro');
  await app.advance(1500);
  assert.equal((await starting).ok, false);
  assert.equal(app.requests.some(request => request.command === 'recordStart'), false);
  const state = await app.invoke('getState');
  assert.equal(state.recording.recording, false);
  assert.equal(state.recording.starting, false);
});

test('native recording failure clears UI starting and active flags', async () => {
  const app = await loadApplication();
  app.bridge.requestHandler = async command => {
    if (command === 'recordStart') throw new Error('controlled native recording failure');
    return {};
  };
  const starting = app.invoke('startRecording');
  const settled = starting.then(value => ({value}), error => ({error}));
  await app.flush(); await app.advance(2000);
  const result = await settled;
  assert.ok(result.error || result.value?.ok === false);
  const state = await app.invoke('getState');
  assert.equal(state.recording.recording, false);
  assert.equal(state.recording.starting, false);
});


test('hardware page preview works while editor is focused and commits only on confirm',async()=>{
  const app=await loadApplication({pages:true});
  app.input();await app.flush();
  let state=await app.invoke('getState');
  assert.equal(state.config.activeProfile,'everyday');assert.equal(state.page.candidateId,'creative');
  assert.equal(app.outputRequests().length,0);
  await app.invoke('navigatePage','confirm');state=await app.invoke('getState');
  assert.equal(state.config.activeProfile,'creative');assert.equal(state.page.candidateId,null);
});
test('preview expiry cancels; previous reaches onboard zero and page overrides cannot disable navigation',async()=>{
  const app=await loadApplication({pages:true});
  app.input();await app.flush();await app.advance(8000);
  let state=await app.invoke('getState');assert.equal(state.page.candidateId,null);assert.equal(state.config.activeProfile,'everyday');
  await app.invoke('navigatePage','previous');state=await app.invoke('getState');assert.equal(state.page.activeId,'@onboard');assert.equal(state.page.mode,'onboard');
  const next=clone(state.config);next.profiles[0].layers[3]['knob2.cw']={type:'none'};await app.invoke('saveConfig',next);
  app.input();await app.flush();assert.equal((await app.invoke('getState')).page.candidateId,'everyday');
});

test('Ctrl+Alt+0 selects onboard, 1-9 select PC, and the common knob reaches page ten without a write',async()=>{
  const app=await loadApplication({pages:true});let {config}=await app.invoke('getState');config=clone(config);
  for(let i=3;i<=10;i++)config.profiles.push({id:`page${i}`,name:`Page ${i}`,bindings:{},layers:{1:{},2:{},3:{}}});
  await app.invoke('saveConfig',config);
  app.input('F13');await app.flush();
  assert.ok(app.hotkeys.has('Ctrl+Alt+0'));app.hotkeys.get('Ctrl+Alt+0')();await app.flush();
  assert.equal((await app.invoke('getState')).page.activeId,'@onboard');
  app.hotkeys.get('Ctrl+Alt+9')();await app.flush();assert.equal((await app.invoke('getState')).config.activeProfile,'page9');
  const writes=app.keyboard.writes.length;
  app.input();await app.flush();assert.equal((await app.invoke('getState')).page.candidateId,'page10');
  app.input('SHIFT+F20');await app.flush();assert.equal((await app.invoke('getState')).config.activeProfile,'page10');
  assert.equal(app.keyboard.writes.length,writes);
  app.hotkeys.get('Ctrl+Alt+1')();await app.flush();assert.equal((await app.invoke('getState')).config.activeProfile,'everyday');
  assert.equal(app.keyboard.writes.length,0,'zero/PC and later-page navigation never write hardware');
  const current=clone((await app.invoke('getState')).config);current.pageHotkeys=false;await app.invoke('saveConfig',current);
  assert.equal(app.hotkeys.has('Ctrl+Alt+0'),false);assert.equal(app.outputRequests().length,0);
});

test('zero can be selected immediately before input without guessing a physical group or writing',async()=>{
  const app=await loadApplication({pages:true});let {config}=await app.invoke('getState');
  await app.invoke('saveConfig',{...clone(config),selectedLayer:1});
  await app.invoke('navigatePage','onboard');
  let state=await app.invoke('getState');assert.equal(state.page.activeId,'@onboard');assert.equal(state.page.layer,null);
  assert.equal(app.keyboard.writes.length,0);
  app.input('F13');await app.flush();await app.invoke('navigatePage','onboard');
  assert.equal(app.keyboard.writes.length,0);
  state=await app.invoke('getState');assert.equal(state.page.layer,3);assert.ok(state.page.lastConfirmedAt);
});

test('repeated zero shortcut events do not register the held global hotkey again',async()=>{
  const app=await loadApplication({pages:true});
  app.hotkeys.get('Ctrl+Alt+0')();await app.flush();
  const registrations=app.hotkeyRegistrations.length,configs=app.sent.filter(e=>e.event.type==='config').length;
  for(let i=0;i<8;i++){app.hotkeys.get('Ctrl+Alt+0')();await app.flush();}
  assert.equal(app.hotkeyRegistrations.length,registrations);
  assert.equal(app.sent.filter(e=>e.event.type==='config').length,configs);
  assert.equal(app.keyboard.writes.length,0);
});

test('onboard mode suppresses PC action hotkeys while leaving the common knob available',async()=>{
  const app=await loadApplication({pages:true});app.window.focused=false;
  app.input('SHIFT+F20');await app.flush();await app.invoke('navigatePage','onboard');
  const before=app.outputRequests().length;app.input('F13');await app.flush();
  assert.equal(app.outputRequests().length,before);
  app.input();await app.flush();assert.equal((await app.invoke('getState')).page.candidateId,'everyday');
});

test('page zero executes each physical group portable preset and restores PC actions without HID writes',async()=>{
  const app=await loadApplication({pages:true});
  const before=JSON.stringify((await app.invoke('getState')).config.profiles);
  for(const [layer,key] of [[3,'X'],[1,'V']]){
    const entries=[{layer,control:'key1',action:{type:'shortcut',keys:['CTRL',key]}}];
    const plan=await app.invoke('planOnboard',entries);
    await app.invoke('saveZeroPreset',entries,{expectedHash:plan.hash});
  }
  await app.invoke('navigatePage','onboard');app.window.focused=false;
  app.input('F13');await app.flush();assert.deepEqual(app.outputRequests().at(-1).data.keys,['CTRL','X']);
  app.input('CTRL+F13');await app.flush();assert.deepEqual(app.outputRequests().at(-1).data.keys,['CTRL','V']);
  await app.invoke('navigatePage','select','everyday');app.input('F13');await app.flush();
  assert.deepEqual(app.outputRequests().at(-1).data.keys,['CTRL','C']);
  assert.equal(app.keyboard.writes.length,0);
  assert.equal(JSON.stringify((await app.invoke('getState')).config.profiles),before);
});

test('zero removes custom PC action hotkeys and excludes advanced actions at the IPC boundary',async()=>{
  const app=await loadApplication({pages:true});const {config}=await app.invoke('getState');
  config.profiles[0].layers[3].key1.hotkey='Ctrl+Alt+K';await app.invoke('saveConfig',config);
  assert.ok(app.hotkeys.has('Ctrl+Alt+K'));
  await app.invoke('navigatePage','onboard');assert.equal(app.hotkeys.has('Ctrl+Alt+K'),false);
  const before=(await app.invoke('readOnboardBank',3)).hash;
  const entries=[{layer:3,control:'key1',action:{type:'app',path:'C:\\demo.exe'}}];
  const plan=await app.invoke('planOnboard',entries);assert.equal(plan.ok,false);
  await assert.rejects(app.invoke('saveZeroPreset',entries,{expectedHash:plan.hash}),/0번/);
  assert.equal((await app.invoke('readOnboardBank',3)).hash,before);
  await app.invoke('navigatePage','select','everyday');assert.ok(app.hotkeys.has('Ctrl+Alt+K'));
  assert.equal(app.keyboard.writes.length,0);
});

test('an existing zero bank remains readable during a device refresh without invoking a writer',async()=>{
  const app=await loadApplication({pages:true});app.keyboard.busy=true;
  const bank=await app.invoke('readOnboardBank',3);assert.equal(bank.entries.length,24);assert.ok(bank.hash);
  assert.equal(app.keyboard.writes.length,0);
});
