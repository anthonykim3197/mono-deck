const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..');
const executable = path.join(root, 'native', 'bin', 'MacroBridge.exe');
const supported = process.platform === 'win32' && process.arch === 'x64';

before(() => {
  if (!supported) return;
  const build = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'build-native.ps1')], { encoding: 'utf8', windowsHide: true });
  assert.equal(build.status, 0, build.stdout + build.stderr);
});

function startBridge(t) {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const messages = [];
  const waiters = new Set();
  let errorText = '';
  let sequence = 0;
  child.stderr.on('data', chunk => { errorText += chunk; });
  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', line => {
    const message = JSON.parse(line);
    messages.push(message);
    for (const waiter of waiters) waiter(message);
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(() => { reader.close(); if (child.exitCode === null) child.kill(); });
  function waitFor(predicate) {
    const prior = messages.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(receive); reject(new Error(`Bridge response timed out. stderr: ${errorText}`)); }, 4000);
      function receive(message) { if (predicate(message)) { clearTimeout(timer); waiters.delete(receive); resolve(message); } }
      waiters.add(receive);
    });
  }
  async function request(command) {
    const id = `native-test-${++sequence}`;
    const response = waitFor(message => message.type === 'response' && message.id === id);
    child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    return response;
  }
  return { child, messages, waitFor, request, exited };
}

test('native bridge registers Raw Input and honors JSONL response IDs', { skip: !supported, timeout: 10000 }, async t => {
  const bridge = startBridge(t);
  const ready = await bridge.waitFor(message => message.type === 'ready');
  assert.equal(ready.target, '1189:8840');
  assert.equal(ready.inputSize, 40, 'x64 INPUT union must include MOUSEINPUT alignment');
  assert.equal(ready.rawHeaderSize, 24);
  assert.equal(ready.suppression, false);
  assert.equal(ready.recording, false, 'Global recording is opt-in and initially inactive');
  assert.equal(ready.emergencyHotkey, 'CTRL+ALT+ESC');
  assert.equal(typeof ready.emergencyHotkeyRegistered, 'boolean');
  assert.ok(ready.capabilities.includes('monitors'));
  const ping = await bridge.request({ command: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.data.pong, true);
  const foreground = await bridge.request({ command: 'foreground' });
  assert.equal(foreground.ok, true);
  assert.equal(typeof foreground.data.process, 'string');
  assert.equal(typeof foreground.data.title, 'string');
  assert.equal(typeof foreground.data.pid, 'number');
  const response = await bridge.request({ command: 'exit' });
  assert.equal(response.ok, true);
  assert.equal(response.data.exiting, true);
  assert.deepEqual(await bridge.exited, { code: 0, signal: null });
});

test('native bridge rejects invalid commands before generating any input, then remains usable', { skip: !supported, timeout: 10000 }, async t => {
  const bridge = startBridge(t);
  await bridge.waitFor(message => message.type === 'ready');
  for (const [command, expected] of [
    [{ command: 'shortcut', keys: [] }, /1 to 8/],
    [{ command: 'shortcut', keys: ['CTRL', 'NOT_A_KEY'] }, /Unknown key/],
    [{ command: 'shortcut', keys: ['CTRL', 'CONTROL'] }, /Duplicate/],
    [{ command: 'shortcut', keys: [45] }, /strings/],
    [{ command: 'shortcut', keys: 'CTRL+C' }, /array/],
    [{ command: 'media', key: 'invalid' }, /Unknown media/],
    [{ command: 'text', text: 'a'.repeat(20001) }, /20,000/],
    [{ command: 'text', text: null }, /string/],
    [{ command: 'text', text: '', requiredForegroundWindow: 'not-a-handle' }, /decimal HWND/],
    [{ command: 'text', text: '', requiredForegroundWindow: '-1' }, /decimal HWND/],
    [{ command: 'text', text: '', requiredForegroundWindow: '0' }, /decimal HWND/],
    [{ command: 'text', text: '', requiredForegroundWindow: ' 123' }, /decimal HWND/],
    [{ command: 'text', text: '', requiredForegroundWindow: '18446744073709551616' }, /decimal HWND/],
    [{ command: 'text', text: '', requiredForegroundWindow: 123 }, /decimal HWND/],
    [{ command: 'text', text: '', requiredForegroundWindow: '18446744073709551615' }, /no longer focused/],
    [{ command: 'key', key: 'A', state: 'invalid' }, /state/],
    [{ command: 'key', key: 'NOT_A_KEY', state: 'down' }, /Unknown key/],
    [{ command: 'mouse', action: 'move', x: 10 }, /y must/],
    [{ command: 'mouse', action: 'click', button: 'invalid' }, /button/],
    [{ command: 'mouse', action: 'click', clicks: 3 }, /range/],
    [{ command: 'mouse', action: 'scroll', delta: 1.5 }, /integer/],
    [{ command: 'mouse', action: 'move', relative: 'yes', x: 1, y: 1 }, /boolean/],
    [{ command: 'pixel', x: 1000000, y: 1000000 }, /virtual desktop/],
    [{ command: 'recordStart', mouseMove: 'yes' }, /boolean/],
    [{ command: 'recordStart', excludeProcessId: 'editor' }, /process ID/],
    [{ command: 'recordStart', excludeProcessId: 0 }, /process ID/],
    [{ command: 'capture', enabled: true }, /not enabled/],
    [{ command: 'not-a-command' }, /Unknown command/],
  ]) {
    const response = await bridge.request(command);
    assert.equal(response.ok, false, JSON.stringify(command));
    assert.match(response.error, expected);
  }
  bridge.child.stdin.write('{malformed\n');
  const malformed = await bridge.waitFor(message => message.type === 'response' && message.id === null && message.ok === false);
  assert.equal(typeof malformed.error, 'string');
  assert.equal((await bridge.request({ command: 'ping' })).ok, true);
  assert.equal((await bridge.request({ command: 'text', text: '' })).ok, true, 'Empty text is a side-effect-free no-op');
  await bridge.request({ command: 'exit' });
  assert.equal((await bridge.exited).code, 0);
});

test('native bridge exits when its parent closes stdin', { skip: !supported, timeout: 10000 }, async t => {
  const bridge = startBridge(t);
  await bridge.waitFor(message => message.type === 'ready');
  bridge.child.stdin.end();
  assert.equal((await bridge.exited).code, 0);
});

test('native read-only coordinates use physical virtual-desktop bounds', { skip: !supported, timeout: 10000 }, async t => {
  const bridge = startBridge(t);
  await bridge.waitFor(message => message.type === 'ready');
  const monitors = await bridge.request({ command: 'monitors' });
  assert.equal(monitors.ok, true);
  assert.ok(monitors.data.monitors.length >= 1);
  const desktop = monitors.data.virtualDesktop;
  assert.ok(desktop.width > 0 && desktop.height > 0);
  for (const monitor of monitors.data.monitors) {
    assert.equal(typeof monitor.id, 'string');
    assert.ok(monitor.width > 0 && monitor.height > 0);
    assert.ok(monitor.left >= desktop.left && monitor.top >= desktop.top);
    assert.ok(monitor.left + monitor.width <= desktop.left + desktop.width);
    assert.ok(monitor.top + monitor.height <= desktop.top + desktop.height);
  }
  const cursor = await bridge.request({ command: 'cursor' });
  assert.equal(cursor.ok, true);
  assert.ok(Number.isInteger(cursor.data.x) && Number.isInteger(cursor.data.y));
  const primary = monitors.data.monitors.find(monitor => monitor.primary) || monitors.data.monitors[0];
  const pixel = await bridge.request({ command: 'pixel', x: primary.left, y: primary.top });
  assert.equal(pixel.ok, true);
  assert.match(pixel.data.color, /^#[0-9A-F]{6}$/);
  assert.equal(pixel.data.color, '#' + [pixel.data.r, pixel.data.g, pixel.data.b].map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase());
  const release = await bridge.request({ command: 'releaseAll' });
  assert.deepEqual(release.data, { releasedKeys: 0, releasedButtons: 0, remaining: 0, errors: [] });
  const stopped = await bridge.request({ command: 'recordStop' });
  assert.equal(stopped.data.recording, false);
  assert.equal(stopped.data.eventCount, 0, 'No hook events are collected without explicit recording');
  await bridge.request({ command: 'exit' });
  await bridge.exited;
});

test('native emergency stop latches output until explicit resume without injecting input', { skip: !supported, timeout: 10000 }, async t => {
  const bridge = startBridge(t);
  await bridge.waitFor(message => message.type === 'ready');
  assert.equal((await bridge.request({ command: 'emergencyStop' })).ok, true);
  const event = await bridge.waitFor(message => message.type === 'emergencyStop');
  assert.equal(event.released.remaining, 0);
  assert.equal(event.recording.recording, false);
  const blocked = await bridge.request({ command: 'text', text: '' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /resume/i);
  await bridge.request({ command: 'releaseAll' });
  assert.equal((await bridge.request({ command: 'text', text: '' })).ok, false, 'releaseAll does not clear the emergency latch');
  assert.equal((await bridge.request({ command: 'resume' })).data.resumed, true);
  assert.equal((await bridge.request({ command: 'text', text: '' })).ok, true);
  assert.equal((await bridge.request({ command: 'key', key: 'A', state: 'up' })).ok, true, 'Unowned key-up is a no-op');
  await bridge.request({ command: 'exit' });
  await bridge.exited;
});

test('native key parsing and per-device modifier tracking retain key-up and repeat semantics', { skip: !supported, timeout: 10000 }, () => {
  // Load the assembly without executing its entry point. These are deterministic
  // state tests, not a claim that a real key was physically pressed.
  const source = String.raw`
using System;
using System.Reflection;
using System.Diagnostics;
using System.Collections.Generic;
class NativeHarness {
    static Type bridge;
    static object Invoke(string name, params object[] args) {
        return bridge.GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, args);
    }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static string[] Key(IntPtr device, ushort code, bool up) { return (string[])Invoke("TrackKey", device, code, up); }
    static object Field(string name) { return bridge.GetField(name, BindingFlags.Static | BindingFlags.NonPublic).GetValue(null); }
    static void SetField(string name, object value) { bridge.GetField(name, BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, value); }
    static object Property(object value, string name) { return value.GetType().GetProperty(name).GetValue(value, null); }
    static object[] Recorded() { object queue = Field("RecordedOutput"); return (object[])queue.GetType().GetMethod("ToArray").Invoke(queue, null); }
    static int Main(string[] args) {
        try {
            bridge = Assembly.LoadFrom(args[0]).GetType("Bridge", true);
            Check((ushort)Invoke("ParseKey", "F13") == 0x7C, "F13 virtual key");
            Check((ushort)Invoke("ParseKey", "F24") == 0x87, "F24 virtual key");
            Check((ushort)Invoke("ParseKey", "+") == 0xBB, "Literal plus alias");
            Check((ushort)Invoke("ParseKey", "Equal") == 0xBB, "Equal alias");
            Check((ushort)Invoke("ParseKey", "BracketLeft") == 0xDB, "Punctuation alias");
            Check((ushort)Invoke("ParseKey", "Digit7") == 0x37, "DOM digit alias");
            Check((ushort)Invoke("ParseKey", "KeyC") == 0x43, "DOM letter alias");
            Check((ushort)Invoke("ParseKey", "LCTRL") == 0xA2, "Recorded left modifier alias");
            Check((ushort)Invoke("ParseKey", "VK_BA") == 0xBA, "Recorded OEM virtual key alias");
            Check((string)Invoke("KeyName", (ushort)0x7C) == "F13", "F13 event name");
            Check((string)Invoke("KeyName", (ushort)0xA2) == "LCTRL", "Recording retains left Ctrl identity");
            Check((int)Invoke("NormalizeCoordinate", -1920, -1920, 5760) == 0, "Negative virtual origin normalizes to zero");
            Check((int)Invoke("NormalizeCoordinate", 3839, -1920, 5760) == 65535, "Last physical pixel normalizes to 65535");
            Check((int)Invoke("NormalizeCoordinate", 0, -1920, 5760) > 21000, "Primary monitor offset is preserved");
            Check((int)Invoke("NormalizeCoordinate", -1080, -1080, 3240) == 0, "Monitor above primary has negative Y origin");
            Check((int)Invoke("NormalizeCoordinate", 2159, -1080, 3240) == 65535, "Mixed-size monitor desktop height endpoint");
            foreach (int offset in new[] { 0, 1, 123, 1920, 5758, 5759 }) {
                int normalized = (int)Invoke("NormalizeCoordinate", offset - 1920, -1920, 5760);
                Check((long)normalized * 5760 / 65536 == offset, "Normalized coordinate maps into the intended physical pixel");
            }
            Check((uint)Invoke("ButtonFlags", "left", false) == 2u && (uint)Invoke("ButtonFlags", "left", true) == 4u, "Left button down/up flags");
            Check((ushort)Invoke("CanonicalInjectedKey", (ushort)0x11) == 0xA2, "Ctrl aliases share ownership identity");
            IntPtr a = new IntPtr(1), b = new IntPtr(2);
            Check(Key(a, 0xA0, false) == null, "Modifier alone should not emit");
            Check(Key(b, 0xA2, false) == null, "Second collection modifier");
            Check(String.Join("+", Key(a, 0x7C, false)) == "CTRL+SHIFT", "Modifier order and cross-collection state");
            Check(Key(a, 0x7C, false) == null, "Auto-repeat suppressed");
            Check(Key(a, 0x7C, true) == null, "Key-up should not emit");
            Key(a, 0xA0, true);
            Check(String.Join("+", Key(a, 0x7C, false)) == "CTRL", "Modifier key-up applied");
            Key(a, 0x7C, true);
            Invoke("ForgetDevice", b);
            Check(Key(a, 0x7C, false).Length == 0, "Unplug clears held modifier");
            var watch = Stopwatch.StartNew();
            Invoke("WaitForTargetRelease");
            Check(watch.ElapsedMilliseconds < 250, "Ordinary held key should not delay action");
            Key(a, 0x7C, true);
            Key(a, 0xA2, false); Key(a, 0xA3, false); Key(a, 0xA2, true);
            Check(String.Join("+", Key(a, 0x7D, false)) == "CTRL", "Right Ctrl survives left Ctrl release");
            Invoke("ForgetDevice", a);
            Invoke("WaitForTargetRelease");
            object foreground = Invoke("Foreground");
            uint foregroundPid = (uint)foreground.GetType().GetProperty("pid").GetValue(foreground, null);
            var guard = new Dictionary<string, object>();
            Invoke("EnsureForegroundAllowed", guard); // Optional for explicit test actions.
            guard["blockedForegroundPid"] = (long)(foregroundPid == UInt32.MaxValue ? 1 : foregroundPid + 1);
            Invoke("EnsureForegroundAllowed", guard);
            if (foregroundPid != 0) {
                guard["blockedForegroundPid"] = (long)foregroundPid;
                bool rejected = false;
                try { Invoke("EnsureForegroundAllowed", guard); }
                catch (TargetInvocationException ex) { rejected = ex.InnerException is InvalidOperationException; }
                Check(rejected, "Matching foreground PID should block hardware output");
            }
            guard["blockedForegroundPid"] = "not-a-pid";
            bool invalidGuardRejected = false;
            try { Invoke("EnsureForegroundAllowed", guard); }
            catch (TargetInvocationException ex) { invalidGuardRejected = ex.InnerException is ArgumentException; }
            Check(invalidGuardRejected, "Invalid PID guard should be rejected");
            var requiredWindow = new Dictionary<string, object>();
            IntPtr currentWindow = (IntPtr)Invoke("GetForegroundWindow");
            if (currentWindow != IntPtr.Zero) {
                requiredWindow["requiredForegroundWindow"] = unchecked((ulong)currentWindow.ToInt64()).ToString();
                Invoke("EnsureRequiredForegroundAllowed", requiredWindow);
                Check((IntPtr)Invoke("RequiredForegroundWindow", requiredWindow) == currentWindow, "Decimal HWND round-trips without precision loss");
            }
            requiredWindow["requiredForegroundWindow"] = "18446744073709551615";
            bool otherWindowRejected = false;
            try { Invoke("EnsureRequiredForegroundAllowed", requiredWindow); }
            catch (TargetInvocationException ex) { otherWindowRejected = ex.InnerException is InvalidOperationException; }
            Check(otherWindowRejected, "Nonmatching HWND blocks output without injection");
            requiredWindow["requiredForegroundWindow"] = "0x123";
            bool malformedWindowRejected = false;
            try { Invoke("RequiredForegroundWindow", requiredWindow); }
            catch (TargetInvocationException ex) { malformedWindowRejected = ex.InnerException is ArgumentException; }
            Check(malformedWindowRejected, "Hex HWND is rejected by decimal-only contract");
            if (foregroundPid != 0) {
                SetField("RecordExcludedProcessId", foregroundPid);
                Check((bool)Invoke("IsRecordingWindowExcluded", (IntPtr)Invoke("GetForegroundWindow")), "Foreground owner PID is excluded");
                SetField("RecordExcludedProcessId", (uint)0);
                Check(!(bool)Invoke("IsRecordingWindowExcluded", (IntPtr)Invoke("GetForegroundWindow")), "Absent exclusion does not drop unrelated windows");
            }
            // Exercise recorder filtering directly, without installing global hooks.
            Check((IntPtr)Field("KeyboardHookHandle") == IntPtr.Zero && (IntPtr)Field("MouseHookHandle") == IntPtr.Zero, "No recording hooks installed in state tests");
            SetField("Recording", true);
            ((Stopwatch)Field("RecordClock")).Restart();
            Invoke("RecordKeyboardEvent", (ushort)0xA0, true, false, false);
            Invoke("RecordKeyboardEvent", (ushort)0x7C, true, false, false);
            Invoke("RecordKeyboardEvent", (ushort)0x7C, false, true, false);
            Invoke("RecordKeyboardEvent", (ushort)0xA0, false, true, false);
            Check(Recorded().Length == 0, "Reserved macro triggers and their Shift modifier are excluded");
            Invoke("RecordKeyboardEvent", (ushort)0xA2, true, false, false);
            Invoke("RecordKeyboardEvent", (ushort)0xA4, true, false, false);
            Invoke("RecordKeyboardEvent", (ushort)0x1B, true, false, false);
            Invoke("RecordKeyboardEvent", (ushort)0x1B, false, true, false);
            Invoke("RecordKeyboardEvent", (ushort)0xA4, false, true, false);
            Invoke("RecordKeyboardEvent", (ushort)0xA2, false, true, false);
            Check(Recorded().Length == 0, "Emergency chord is excluded");
            Invoke("RecordKeyboardEvent", (ushort)0x41, true, false, false);
            Invoke("RecordKeyboardEvent", (ushort)0x41, true, false, false);
            Invoke("RecordKeyboardEvent", (ushort)0x41, false, true, false);
            Invoke("RecordKeyboardEvent", (ushort)0x42, true, false, true);
            Check(Recorded().Length == 2, "Recorder captures transitions but excludes auto-repeat and injected input");
            Check((string)Property(Property(Recorded()[0], "event"), "key") == "A", "Recorded key contract");
            Invoke("RecordMouseEvent", 0x201, -1800, 20, 0, true);
            Invoke("RecordMouseEvent", 0x201, -1800, 20, 0, false);
            Invoke("RecordMouseEvent", 0x202, -1800, 20, 0, false);
            Check(Recorded().Length == 4, "Recorder ignores injected mouse events");
            Check((int)Property(Property(Recorded()[2], "event"), "x") == -1800, "Recording preserves negative virtual-desktop pixels");
            Invoke("RecordKeyboardEvent", (ushort)0x43, true, false, false);
            object stoppedRecording = Invoke("StopRecording");
            Check((bool)Property(stoppedRecording, "recording") == false, "Recorder stops");
            Check(Recorded().Length == 6 && (string)Property(Property(Recorded()[5], "event"), "state") == "up", "Stop balances only recorded key-downs");
            Invoke("RecordKeyboardEvent", (ushort)0x44, true, false, false);
            Check(Recorded().Length == 6, "No events after explicit recording stop");
            SetField("Recording", true);
            Invoke("RecordKeyboardEvent", (ushort)0x41, true, false, false);
            Invoke("RecordMouseEvent", 0x201, -1800, 20, 0, false);
            Invoke("ExcludeRecordedKeyboardEvent", (ushort)0x42, true, false);
            Check(Recorded().Length == 10, "Entering excluded editor balances only the already-recorded key and mouse holds");
            object releasedMouse = Property(Recorded()[9], "event");
            Check((string)Property(releasedMouse, "action") == "up", "Excluded editor transition produces a balanced button-up");
            Check(releasedMouse.GetType().GetProperty("x") == null && releasedMouse.GetType().GetProperty("y") == null, "Balanced release does not move playback cursor into editor");
            Invoke("RecordKeyboardEvent", (ushort)0x41, false, true, false);
            Invoke("RecordMouseEvent", 0x202, -1800, 20, 0, false);
            Invoke("ExcludeRecordedKeyboardEvent", (ushort)0x42, false, true);
            Check(Recorded().Length == 10, "Later releases do not create orphan or duplicate recorded ups");
            Invoke("ExcludeRecordedKeyboardEvent", (ushort)0xA2, true, false);
            Invoke("RecordKeyboardEvent", (ushort)0x43, true, false, false);
            Check(Recorded().Length == 12 && (string)Property(Property(Recorded()[10], "event"), "key") == "LCTRL", "Returning to target preserves an actually held modifier for the next action");
            Invoke("RecordKeyboardEvent", (ushort)0x43, false, true, false);
            Invoke("RecordKeyboardEvent", (ushort)0xA2, false, true, false);
            Invoke("StopRecording");
            Console.WriteLine("Native state assertions passed");
            return 0;
        } catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-deck-native-test-'));
  const sourcePath = path.join(directory, 'NativeHarness.cs');
  const harnessPath = path.join(directory, 'NativeHarness.exe');
  try {
    fs.writeFileSync(sourcePath, source);
    const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${harnessPath}`, sourcePath], { encoding: 'utf8', windowsHide: true });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const executed = spawnSync(harnessPath, [executable], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(executed.status, 0, executed.stdout + executed.stderr);
    assert.match(executed.stdout, /assertions passed/);
  } finally {
    // Delete only exact files created by this test, never a computed recursive tree.
    for (const file of [sourcePath, harnessPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});
