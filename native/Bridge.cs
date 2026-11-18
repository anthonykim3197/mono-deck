// Windows bridge for Macro Deck. .NET Framework 4.x.
// Default Raw Input is device-scoped; global recording hooks exist only between
// an explicit recordStart and recordStop (or emergency/shutdown).
// API references: https://learn.microsoft.com/windows/win32/inputdev/using-raw-input
// https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-input
// https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-keybdinput
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Bridge
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    private static readonly object OutputLock = new object();
    private static readonly object StateLock = new object();
    private static readonly object InjectionLock = new object();
    private static readonly Dictionary<IntPtr, string> DeviceNames = new Dictionary<IntPtr, string>();
    private static readonly Dictionary<IntPtr, HashSet<ushort>> Pressed = new Dictionary<IntPtr, HashSet<ushort>>();
    private static readonly UIntPtr InjectionTag = new UIntPtr(0x4D434452u);
    private static InputWindow Window;
    private static volatile bool Stopping;
    private static volatile bool EmergencyStopped;
    private static long EmergencyEpoch;
    private static readonly HashSet<ushort> InjectedKeys = new HashSet<ushort>();
    private static readonly HashSet<ushort> InjectedUnicode = new HashSet<ushort>();
    private static readonly HashSet<string> InjectedButtons = new HashSet<string>();
    private static readonly ConcurrentQueue<Action> UiJobs = new ConcurrentQueue<Action>();
    private static readonly ConcurrentQueue<object> RecordedOutput = new ConcurrentQueue<object>();
    private static readonly AutoResetEvent RecordedSignal = new AutoResetEvent(false);
    private static readonly HookProc KeyboardHookDelegate = KeyboardHook;
    private static readonly HookProc MouseHookDelegate = MouseHook;
    private static IntPtr KeyboardHookHandle, MouseHookHandle;
    private static volatile bool Recording;
    private static volatile bool RecordedWriterStopping;
    private static bool RecordMoves, HotkeyRegistered;
    private static uint RecordExcludedProcessId;
    private static readonly Stopwatch RecordClock = new Stopwatch();
    private static int RecordEventCount;
    private static long LastRecordedMove;
    private static readonly HashSet<ushort> RecordPhysicalKeys = new HashSet<ushort>();
    private static readonly HashSet<ushort> RecordEmittedKeys = new HashSet<ushort>();
    private static readonly HashSet<string> RecordEmittedButtons = new HashSet<string>();
    private static readonly List<PendingModifier> PendingRecordModifiers = new List<PendingModifier>();
    private const int EmergencyHotkeyId = 0x4D44;
    private const int UiWorkMessage = 0x8000 + 18;
    private const uint RID_INPUT = 0x10000003;
    private const uint RIDI_DEVICENAME = 0x20000007;
    private const uint KEYEVENTF_KEYUP = 2;
    private const uint KEYEVENTF_UNICODE = 4;
    private const uint KEYEVENTF_EXTENDEDKEY = 1;

    [STAThread]
    private static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e) { Emit(new { type = "error", error = e.Exception.Message }); };
        try
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
            Window = new InputWindow();
            var devices = new[] { new RAWINPUTDEVICE { usUsagePage = 1, usUsage = 6, dwFlags = 0x100 | 0x2000, hwndTarget = Window.Handle } };
            if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Raw keyboard registration failed");
            HotkeyRegistered = RegisterHotKey(Window.Handle, EmergencyHotkeyId, 0x4000 | 0x0001 | 0x0002, 0x1B);
            var recordedWriter = new Thread(WriteRecordedEvents) { IsBackground = true, Name = "Macro Deck recorded events" };
            recordedWriter.Start();
            Emit(new { type = "ready", protocol = 1, target = "1189:8840", inputSize = Marshal.SizeOf(typeof(INPUT)), rawHeaderSize = Marshal.SizeOf(typeof(RAWINPUTHEADER)), suppression = false, recording = false, emergencyHotkey = "CTRL+ALT+ESC", emergencyHotkeyRegistered = HotkeyRegistered, capabilities = new[] { "keyboard", "mouse", "monitors", "pixel", "recording", "emergencyStop" } });
            if (!HotkeyRegistered) Emit(new { type = "error", error = "Ctrl+Alt+Escape emergency hotkey is unavailable (possibly registered by another running instance)" });
            var commands = new Thread(ReadCommands) { IsBackground = true, Name = "Macro Deck commands" };
            commands.Start();
            Application.Run();
            Stopping = true;
            StopRecording();
            ReleaseAllOwned();
            if (HotkeyRegistered) UnregisterHotKey(Window.Handle, EmergencyHotkeyId);
            RecordedWriterStopping = true;
            RecordedSignal.Set();
            Window.DestroyHandle();
            return 0;
        }
        catch (Exception ex) { Emit(new { type = "error", error = ex.Message }); return 1; }
    }

    private static void Emit(object value)
    {
        lock (OutputLock)
        {
            try { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
            catch (System.IO.IOException) { Stopping = true; if (Window != null) PostMessage(Window.Handle, 0x10, IntPtr.Zero, IntPtr.Zero); }
        }
    }

    private static void ReadCommands()
    {
        string line;
        while (!Stopping && (line = Console.ReadLine()) != null)
        {
            object id = null;
            try
            {
                if (line.Length > 1048576) throw new ArgumentException("Command exceeds size limit");
                Dictionary<string, object> command;
                lock (OutputLock) { command = Json.Deserialize<Dictionary<string, object>>(line); }
                if (command == null) throw new ArgumentException("Expected JSON object");
                command.TryGetValue("id", out id);
                string name = ReadString(command, "command");
                object result = null;
                long commandEpoch = Interlocked.Read(ref EmergencyEpoch);
                if (name == "ping") result = new { pong = true, protocol = 1 };
                else if (name == "foreground") result = Foreground();
                else if (name == "cursor") result = CursorPosition();
                else if (name == "monitors") result = Monitors();
                else if (name == "pixel") result = Pixel(ReadInt(command, "x", -1000000, 1000000), ReadInt(command, "y", -1000000, 1000000));
                else if (name == "releaseAll") { Interlocked.Increment(ref EmergencyEpoch); result = ReleaseAllOwned(); }
                else if (name == "resume") { EmergencyStopped = false; result = new { resumed = true }; }
                else if (name == "emergencyStop") result = OnUi(delegate { EmergencyStop(); return new { stopped = true }; });
                else if (name == "recordStart")
                {
                    bool recordMoves = ReadBool(command, "mouseMove", true);
                    uint excludeProcessId = ReadOptionalProcessId(command, "excludeProcessId");
                    result = OnUi(delegate { return StartRecording(recordMoves, excludeProcessId); });
                }
                else if (name == "recordStop") { result = OnUi(StopRecording); FlushRecordedEvents(); }
                else if (name == "key")
                {
                    ushort code = ParseKey(ReadString(command, "key"));
                    string state = ReadString(command, "state");
                    if (state != "down" && state != "up") throw new ArgumentException("key state must be down or up");
                    WaitForTargetRelease();
                    CheckOutput(command, commandEpoch);
                    if (state == "down") KeyDown(code, command, commandEpoch); else KeyUp(code);
                }
                else if (name == "mouse") MouseCommand(command, commandEpoch);
                else if (name == "shortcut")
                {
                    object rawKeys;
                    if (!command.TryGetValue("keys", out rawKeys) || !(rawKeys is ArrayList)) throw new ArgumentException("keys must be an array");
                    var keys = (ArrayList)rawKeys;
                    if (keys.Count < 1 || keys.Count > 8) throw new ArgumentException("Shortcut requires 1 to 8 keys");
                    var codes = new List<ushort>();
                    foreach (object key in keys)
                    {
                        if (!(key is string)) throw new ArgumentException("Key names must be strings");
                        ushort code = ParseKey((string)key);
                        if (codes.Contains(code)) throw new ArgumentException("Duplicate shortcut key");
                        codes.Add(code);
                    }
                    WaitForTargetRelease();
                    CheckOutput(command, commandEpoch);
                    SendChord(codes, command, commandEpoch);
                }
                else if (name == "text")
                {
                    string value = ReadString(command, "text");
                    if (value.Length > 20000) throw new ArgumentException("Text exceeds 20,000 characters");
                    WaitForTargetRelease();
                    CheckOutput(command, commandEpoch);
                    SendText(value, command, commandEpoch);
                }
                else if (name == "media")
                {
                    string key = ReadString(command, "key");
                    var media = new Dictionary<string, ushort> { { "volumeUp", 0xAF }, { "volumeDown", 0xAE }, { "mute", 0xAD }, { "playPause", 0xB3 }, { "next", 0xB0 }, { "previous", 0xB1 }, { "stop", 0xB2 } };
                    if (!media.ContainsKey(key)) throw new ArgumentException("Unknown media key");
                    WaitForTargetRelease();
                    CheckOutput(command, commandEpoch);
                    SendChord(new List<ushort> { media[key] }, command, commandEpoch);
                }
                else if (name == "capture") throw new NotSupportedException("Device-specific key suppression is not enabled; Raw Input observes only the target device");
                else if (name == "exit")
                {
                    Interlocked.Increment(ref EmergencyEpoch);
                    ReleaseAllOwned();
                    Emit(new { type = "response", id = id, ok = true, data = new { exiting = true } });
                    Stopping = true;
                    PostMessage(Window.Handle, 0x10, IntPtr.Zero, IntPtr.Zero);
                    return;
                }
                else throw new ArgumentException("Unknown command: " + name);
                Emit(new { type = "response", id = id, ok = true, data = result });
            }
            catch (Exception ex) { Emit(new { type = "response", id = id, ok = false, error = ex.Message }); }
        }
        Stopping = true;
        Interlocked.Increment(ref EmergencyEpoch);
        ReleaseAllOwned();
        PostMessage(Window.Handle, 0x10, IntPtr.Zero, IntPtr.Zero);
    }

    private static string ReadString(Dictionary<string, object> command, string key)
    {
        object value;
        if (!command.TryGetValue(key, out value) || !(value is string)) throw new ArgumentException(key + " must be a string");
        return (string)value;
    }

    private static int ReadInt(Dictionary<string, object> command, string key, int minimum, int maximum)
    {
        object value;
        if (!command.TryGetValue(key, out value) || (!(value is int) && !(value is long))) throw new ArgumentException(key + " must be an integer");
        long number = Convert.ToInt64(value);
        if (number < minimum || number > maximum) throw new ArgumentException(key + " is outside the supported range");
        return (int)number;
    }

    private static bool ReadBool(Dictionary<string, object> command, string key, bool fallback)
    {
        object value;
        if (!command.TryGetValue(key, out value)) return fallback;
        if (!(value is bool)) throw new ArgumentException(key + " must be a boolean");
        return (bool)value;
    }

    private static uint ReadOptionalProcessId(Dictionary<string, object> command, string key)
    {
        object value;
        if (!command.TryGetValue(key, out value)) return 0;
        if (!(value is int) && !(value is long)) throw new ArgumentException(key + " must be a positive process ID");
        long number = Convert.ToInt64(value);
        if (number < 1 || number > UInt32.MaxValue) throw new ArgumentException(key + " must be a positive process ID");
        return (uint)number;
    }

    private static void WaitForTargetRelease()
    {
        // The macro device may emit Ctrl/Shift + Fn. Let its physical key-up arrive
        // before generating a different action so those modifiers do not leak.
        var timer = Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < 600)
        {
            bool held = false;
            lock (StateLock)
            {
                foreach (HashSet<ushort> keys in Pressed.Values)
                    foreach (ushort key in keys) if (Modifier(key) != null) { held = true; break; }
            }
            if (!held) return;
            Thread.Sleep(5);
        }
        throw new InvalidOperationException("Release the macro key before executing an action");
    }

    private static object Foreground()
    {
        IntPtr handle = GetForegroundWindow();
        uint processId;
        GetWindowThreadProcessId(handle, out processId);
        string process = "";
        try { using (Process current = Process.GetProcessById((int)processId)) process = current.ProcessName; } catch (ArgumentException) { } catch (Win32Exception) { }
        var title = new StringBuilder(2048);
        GetWindowText(handle, title, title.Capacity);
        return new { process = process, title = title.ToString(), pid = processId };
    }

    private static void EnsureForegroundAllowed(Dictionary<string, object> command)
    {
        object value;
        if (!command.TryGetValue("blockedForegroundPid", out value)) return;
        if (!(value is int) && !(value is long)) throw new ArgumentException("blockedForegroundPid must be a positive process ID");
        long blocked = Convert.ToInt64(value);
        if (blocked < 1 || blocked > UInt32.MaxValue) throw new ArgumentException("blockedForegroundPid must be a positive process ID");
        uint foregroundProcess;
        GetWindowThreadProcessId(GetForegroundWindow(), out foregroundProcess);
        if (foregroundProcess == (uint)blocked)
        {
            ReleaseAllOwned();
            throw new InvalidOperationException("The MONO DECK editor is focused; the hardware action was cancelled");
        }
    }

    private static void CheckOutput(Dictionary<string, object> command, long epoch)
    {
        if (EmergencyStopped || epoch != Interlocked.Read(ref EmergencyEpoch) || Stopping)
            throw new InvalidOperationException("Macro output is stopped; explicitly resume before starting a new macro");
        EnsureRequiredForegroundAllowed(command);
        EnsureForegroundAllowed(command);
    }

    private static IntPtr RequiredForegroundWindow(Dictionary<string, object> command)
    {
        object value;
        if (!command.TryGetValue("requiredForegroundWindow", out value)) return IntPtr.Zero;
        string text = value as string;
        ulong handle;
        if (String.IsNullOrEmpty(text) || text.Length > 20 || !UInt64.TryParse(text, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out handle) || handle == 0 || (IntPtr.Size == 4 && handle > UInt32.MaxValue))
            throw new ArgumentException("requiredForegroundWindow must be a nonzero decimal HWND string");
        return IntPtr.Size == 8 ? new IntPtr(unchecked((long)handle)) : new IntPtr(unchecked((int)handle));
    }

    private static void EnsureRequiredForegroundAllowed(Dictionary<string, object> command)
    {
        IntPtr required = RequiredForegroundWindow(command);
        if (required == IntPtr.Zero || GetForegroundWindow() == required) return;
        ReleaseAllOwned();
        throw new InvalidOperationException("The required test window is no longer focused; macro output was cancelled");
    }

    private static bool KeyDown(ushort key, Dictionary<string, object> command, long epoch)
    {
        key = CanonicalInjectedKey(key);
        lock (InjectionLock)
        {
            CheckOutput(command, epoch);
            // Never claim ownership of a key the user is already holding.
            if (InjectedKeys.Contains(key) || (GetAsyncKeyState(key) & 0x8000) != 0) return false;
            SendOne(KeyInput(key, 0, IsExtended(key) ? KEYEVENTF_EXTENDEDKEY : 0));
            InjectedKeys.Add(key);
            return true;
        }
    }

    private static void KeyUp(ushort key)
    {
        key = CanonicalInjectedKey(key);
        lock (InjectionLock)
        {
            if (!InjectedKeys.Contains(key)) return;
            SendOne(KeyInput(key, 0, KEYEVENTF_KEYUP | (IsExtended(key) ? KEYEVENTF_EXTENDEDKEY : 0)));
            InjectedKeys.Remove(key);
        }
    }

    private static ushort CanonicalInjectedKey(ushort key)
    {
        return key == 0x10 ? (ushort)0xA0 : key == 0x11 ? (ushort)0xA2 : key == 0x12 ? (ushort)0xA4 : key;
    }

    private static object ReleaseAllOwned()
    {
        lock (InjectionLock)
        {
            int releasedKeys = 0, releasedButtons = 0;
            var errors = new List<string>();
            foreach (ushort key in new List<ushort>(InjectedKeys))
                try { KeyUp(key); releasedKeys++; } catch (Exception ex) { errors.Add(ex.Message); }
            foreach (ushort unit in new List<ushort>(InjectedUnicode))
                try { SendOne(KeyInput(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)); InjectedUnicode.Remove(unit); releasedKeys++; } catch (Exception ex) { errors.Add(ex.Message); }
            foreach (string button in new List<string>(InjectedButtons))
                try { ButtonUp(button); releasedButtons++; } catch (Exception ex) { errors.Add(ex.Message); }
            return new { releasedKeys = releasedKeys, releasedButtons = releasedButtons, remaining = InjectedKeys.Count + InjectedUnicode.Count + InjectedButtons.Count, errors = errors.ToArray() };
        }
    }

    private static void SendChord(List<ushort> keys, Dictionary<string, object> command, long epoch)
    {
        var down = new List<ushort>();
        Exception failure = null;
        try
        {
            foreach (ushort key in keys)
            {
                if (KeyDown(key, command, epoch)) down.Add(key);
            }
        }
        catch (Exception ex) { failure = ex; }
        finally
        {
            for (int i = down.Count - 1; i >= 0; i--)
            {
                try { KeyUp(down[i]); }
                catch (Exception ex) { if (failure == null) failure = ex; }
            }
        }
        if (failure != null) throw failure;
    }

    private static void SendText(string value, Dictionary<string, object> command, long epoch)
    {
        foreach (char character in value)
        {
            // UTF-16 code units, including paired surrogate units, are sent intact.
            lock (InjectionLock)
            {
                CheckOutput(command, epoch);
                SendOne(KeyInput(0, character, KEYEVENTF_UNICODE));
                InjectedUnicode.Add(character);
                try { SendOne(KeyInput(0, character, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)); InjectedUnicode.Remove(character); }
                catch { ReleaseAllOwned(); throw; }
            }
        }
    }

    private static object CursorPosition()
    {
        POINT point;
        if (!GetCursorPos(out point)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read cursor position");
        return new { x = point.x, y = point.y };
    }

    private static object Monitors()
    {
        var monitors = new List<object>();
        MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr dc, ref RECT bounds, IntPtr parameter)
        {
            var info = new MONITORINFOEX { cbSize = Marshal.SizeOf(typeof(MONITORINFOEX)) };
            if (!GetMonitorInfo(monitor, ref info)) return true;
            uint dpiX = 96, dpiY = 96;
            try { GetDpiForMonitor(monitor, 0, out dpiX, out dpiY); } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
            monitors.Add(new { id = info.szDevice, device = info.szDevice, left = info.rcMonitor.left, top = info.rcMonitor.top, width = info.rcMonitor.right - info.rcMonitor.left, height = info.rcMonitor.bottom - info.rcMonitor.top, primary = (info.dwFlags & 1) != 0, dpiX = dpiX, dpiY = dpiY });
            return true;
        };
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to enumerate monitors");
        RECT desktop = VirtualDesktop();
        return new { monitors = monitors.ToArray(), virtualDesktop = new { left = desktop.left, top = desktop.top, width = desktop.right - desktop.left, height = desktop.bottom - desktop.top } };
    }

    private static RECT VirtualDesktop()
    {
        return new RECT { left = GetSystemMetrics(76), top = GetSystemMetrics(77), right = GetSystemMetrics(76) + GetSystemMetrics(78), bottom = GetSystemMetrics(77) + GetSystemMetrics(79) };
    }

    private static void ValidatePoint(int x, int y, RECT desktop)
    {
        if (desktop.right <= desktop.left || desktop.bottom <= desktop.top || x < desktop.left || x >= desktop.right || y < desktop.top || y >= desktop.bottom)
            throw new ArgumentException("Coordinates must be inside the virtual desktop in physical pixels");
    }

    private static object Pixel(int x, int y)
    {
        ValidatePoint(x, y, VirtualDesktop());
        IntPtr dc = GetDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to access desktop pixels");
        try
        {
            uint pixel = GetPixel(dc, x, y);
            if (pixel == UInt32.MaxValue) throw new InvalidOperationException("Pixel is unavailable at these desktop coordinates");
            int r = (int)(pixel & 255), g = (int)((pixel >> 8) & 255), b = (int)((pixel >> 16) & 255);
            return new { color = "#" + r.ToString("X2") + g.ToString("X2") + b.ToString("X2"), r = r, g = g, b = b };
        }
        finally { ReleaseDC(IntPtr.Zero, dc); }
    }

    private static int NormalizeCoordinate(int coordinate, int origin, int span)
    {
        if (span < 1) throw new ArgumentException("Invalid virtual desktop span");
        if (span == 1) return 0;
        long offset = (long)coordinate - origin;
        if (offset < 0 || offset >= span) throw new ArgumentException("Coordinate lies outside the desktop");
        if (offset == 0) return 0;
        if (offset == span - 1) return 65535;
        // Aim at the pixel center. Boundary-only scaling can land one physical
        // pixel short when Windows quantizes the 16-bit absolute coordinate.
        return (int)((offset * 65536L + 32768L) / span);
    }

    private static INPUT MouseInput(int x, int y, uint flags, uint data)
    {
        return new INPUT { type = 0, data = new INPUTUNION { mi = new MOUSEINPUT { dx = x, dy = y, mouseData = data, dwFlags = flags, time = 0, dwExtraInfo = InjectionTag } } };
    }

    private static uint ButtonFlags(string button, bool up)
    {
        if (button == "left") return up ? 0x0004u : 0x0002u;
        if (button == "right") return up ? 0x0010u : 0x0008u;
        if (button == "middle") return up ? 0x0040u : 0x0020u;
        throw new ArgumentException("Mouse button must be left, right or middle");
    }

    private static bool ButtonDown(string button, Dictionary<string, object> command, long epoch)
    {
        lock (InjectionLock)
        {
            CheckOutput(command, epoch);
            int virtualKey = button == "left" ? 1 : button == "right" ? 2 : 4;
            if (InjectedButtons.Contains(button) || (GetAsyncKeyState(virtualKey) & 0x8000) != 0) return false;
            SendOne(MouseInput(0, 0, ButtonFlags(button, false), 0));
            InjectedButtons.Add(button);
            return true;
        }
    }

    private static void ButtonUp(string button)
    {
        lock (InjectionLock)
        {
            if (!InjectedButtons.Contains(button)) return;
            SendOne(MouseInput(0, 0, ButtonFlags(button, true), 0));
            InjectedButtons.Remove(button);
        }
    }

    private static void MouseCommand(Dictionary<string, object> command, long epoch)
    {
        string action = ReadString(command, "action");
        if (action != "move" && action != "click" && action != "down" && action != "up" && action != "scroll") throw new ArgumentException("Unsupported mouse action");
        bool hasPoint = command.ContainsKey("x") || command.ContainsKey("y") || action == "move";
        bool relative = ReadBool(command, "relative", false);
        int x = 0, y = 0, delta = 0, clicks = 1;
        string button = command.ContainsKey("button") ? ReadString(command, "button") : "left";
        if (action == "click" || action == "down" || action == "up") ButtonFlags(button, false);
        if (command.ContainsKey("clicks")) clicks = ReadInt(command, "clicks", 1, 2);
        if (action == "scroll") delta = ReadInt(command, "delta", -120000, 120000);
        uint moveFlags = 0x0001;
        if (hasPoint)
        {
            x = ReadInt(command, "x", -1000000, 1000000); y = ReadInt(command, "y", -1000000, 1000000);
            if (!relative)
            {
                RECT desktop = VirtualDesktop(); ValidatePoint(x, y, desktop);
                x = NormalizeCoordinate(x, desktop.left, desktop.right - desktop.left);
                y = NormalizeCoordinate(y, desktop.top, desktop.bottom - desktop.top);
                moveFlags |= 0x8000 | 0x4000;
            }
        }
        WaitForTargetRelease();
        lock (InjectionLock)
        {
            CheckOutput(command, epoch);
            if (hasPoint) SendOne(MouseInput(x, y, moveFlags, 0));
        }
        if (action == "move") return;
        if (action == "scroll")
        {
            lock (InjectionLock) { CheckOutput(command, epoch); if (delta != 0) SendOne(MouseInput(0, 0, 0x0800, unchecked((uint)delta))); }
            return;
        }
        if (action == "up") { ButtonUp(button); return; }
        if (action == "down") { ButtonDown(button, command, epoch); return; }
        for (int i = 0; i < clicks; i++)
        {
            bool owned = ButtonDown(button, command, epoch);
            try { if (owned) Thread.Sleep(8); }
            finally { if (owned) ButtonUp(button); }
            if (i + 1 < clicks) Thread.Sleep(60);
        }
    }

    private sealed class PendingModifier { internal ushort Key; internal long Timestamp; }
    private sealed class RecordBarrier { internal readonly ManualResetEvent Done = new ManualResetEvent(false); }

    private static object OnUi(Func<object> callback)
    {
        object result = null;
        Exception failure = null;
        int state = 0;
        var complete = new ManualResetEvent(false);
        UiJobs.Enqueue(delegate
        {
            if (Interlocked.CompareExchange(ref state, 1, 0) != 0) { complete.Set(); return; }
            try { result = callback(); } catch (Exception ex) { failure = ex; }
            finally { complete.Set(); }
        });
        if (!PostMessage(Window.Handle, UiWorkMessage, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Input message loop is unavailable");
        if (!complete.WaitOne(5000))
        {
            if (Interlocked.CompareExchange(ref state, 2, 0) == 0) throw new TimeoutException("Input message loop did not accept the command");
            complete.WaitOne();
        }
        complete.Dispose();
        if (failure != null) throw failure;
        return result;
    }

    private static object StartRecording(bool mouseMove, uint excludeProcessId)
    {
        if (EmergencyStopped) throw new InvalidOperationException("Resume before starting a new recording");
        if (Recording) throw new InvalidOperationException("A recording is already active");
        RecordPhysicalKeys.Clear(); RecordEmittedKeys.Clear(); RecordEmittedButtons.Clear(); PendingRecordModifiers.Clear();
        RecordEventCount = 0; LastRecordedMove = -100; RecordMoves = mouseMove; RecordExcludedProcessId = excludeProcessId;
        IntPtr module = GetModuleHandle(null);
        KeyboardHookHandle = SetWindowsHookEx(13, KeyboardHookDelegate, module, 0);
        if (KeyboardHookHandle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to start keyboard recording");
        MouseHookHandle = SetWindowsHookEx(14, MouseHookDelegate, module, 0);
        if (MouseHookHandle == IntPtr.Zero)
        {
            UnhookWindowsHookEx(KeyboardHookHandle); KeyboardHookHandle = IntPtr.Zero;
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to start mouse recording");
        }
        RecordClock.Restart(); Recording = true;
        return new { recording = true, mouseMove = RecordMoves, coordinates = "physical-virtual-desktop", reservedFunctionKeysExcluded = true, excludeProcessId = RecordExcludedProcessId };
    }

    private static object StopRecording()
    {
        if (Recording)
        {
            BalanceRecordedHolds();
        }
        Recording = false; RecordClock.Stop();
        if (KeyboardHookHandle != IntPtr.Zero) { UnhookWindowsHookEx(KeyboardHookHandle); KeyboardHookHandle = IntPtr.Zero; }
        if (MouseHookHandle != IntPtr.Zero) { UnhookWindowsHookEx(MouseHookHandle); MouseHookHandle = IntPtr.Zero; }
        RecordPhysicalKeys.Clear(); RecordEmittedKeys.Clear(); RecordEmittedButtons.Clear(); PendingRecordModifiers.Clear(); RecordExcludedProcessId = 0;
        return new { recording = false, eventCount = RecordEventCount, durationMs = RecordClock.ElapsedMilliseconds };
    }

    private static void WriteRecordedEvents()
    {
        while (!RecordedWriterStopping || !RecordedOutput.IsEmpty)
        {
            object entry;
            while (RecordedOutput.TryDequeue(out entry))
            {
                var barrier = entry as RecordBarrier;
                if (barrier != null) barrier.Done.Set(); else Emit(entry);
            }
            if (!RecordedWriterStopping) RecordedSignal.WaitOne(250);
        }
    }

    private static void FlushRecordedEvents()
    {
        var barrier = new RecordBarrier();
        RecordedOutput.Enqueue(barrier); RecordedSignal.Set();
        if (!barrier.Done.WaitOne(4000)) throw new TimeoutException("Recorded event delivery did not finish");
        barrier.Done.Dispose();
    }

    private static void QueueRecord(object entry, long timestamp)
    {
        if (!Recording) return;
        // Never do pipe I/O inside a low-level hook: Windows may remove a slow hook.
        if (RecordedOutput.Count >= 2048 || RecordEventCount >= 50000)
        {
            Recording = false;
            RecordedOutput.Enqueue(new { type = "recordingError", error = "Recording event limit reached; recording stopped" });
            RecordedSignal.Set();
            UiJobs.Enqueue(delegate { StopRecording(); }); PostMessage(Window.Handle, UiWorkMessage, IntPtr.Zero, IntPtr.Zero);
            return;
        }
        RecordEventCount++;
        RecordedOutput.Enqueue(new { type = "record", timestamp = timestamp, @event = entry }); RecordedSignal.Set();
    }

    private static void FlushRecordedModifiers(bool includeHeld = false)
    {
        if (includeHeld)
            foreach (ushort key in RecordPhysicalKeys)
                if (Modifier(key) != null && !RecordEmittedKeys.Contains(key) && !PendingRecordModifiers.Exists(delegate(PendingModifier pending) { return pending.Key == key; }))
                    PendingRecordModifiers.Add(new PendingModifier { Key = key, Timestamp = RecordClock.ElapsedMilliseconds });
        foreach (PendingModifier modifier in PendingRecordModifiers)
            if (RecordEmittedKeys.Add(modifier.Key)) QueueRecord(new { type = "key", key = KeyName(modifier.Key), state = "down" }, modifier.Timestamp);
        PendingRecordModifiers.Clear();
    }

    private static void BalanceRecordedHolds()
    {
        // These are recorded releases, never real SendInput calls. Synthetic
        // mouse releases omit coordinates so replay cannot jump into the editor.
        foreach (ushort key in new List<ushort>(RecordEmittedKeys)) QueueRecord(new { type = "key", key = KeyName(key), state = "up" }, RecordClock.ElapsedMilliseconds);
        foreach (string button in new List<string>(RecordEmittedButtons)) QueueRecord(new { type = "mouse", action = "up", button = button }, RecordClock.ElapsedMilliseconds);
        RecordEmittedKeys.Clear(); RecordEmittedButtons.Clear(); PendingRecordModifiers.Clear();
    }

    private static bool IsRecordingWindowExcluded(IntPtr window)
    {
        if (RecordExcludedProcessId == 0 || window == IntPtr.Zero) return false;
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (owner == RecordExcludedProcessId) return true;
        // Chromium child HWNDs can belong to renderer processes; the root owner
        // is the native Electron window owned by the main process.
        IntPtr root = GetAncestor(window, 3);
        if (root == IntPtr.Zero) root = GetAncestor(window, 2);
        if (root == IntPtr.Zero) return false;
        GetWindowThreadProcessId(root, out owner);
        return owner == RecordExcludedProcessId;
    }

    private static void ExcludeRecordedKeyboardEvent(ushort value, bool down, bool up)
    {
        if (!Recording) return;
        if (down) RecordPhysicalKeys.Add(value); else if (up) RecordPhysicalKeys.Remove(value);
        BalanceRecordedHolds();
    }

    private static bool RecordModifierHeld(string modifier)
    {
        foreach (ushort key in RecordPhysicalKeys) if (Modifier(key) == modifier) return true;
        return false;
    }

    private static IntPtr KeyboardHook(int code, IntPtr message, IntPtr data)
    {
        try
        {
            if (code >= 0 && Recording)
            {
                var key = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(KBDLLHOOKSTRUCT));
                bool down = message.ToInt32() == 0x100 || message.ToInt32() == 0x104;
                bool up = message.ToInt32() == 0x101 || message.ToInt32() == 0x105;
                bool injected = (key.flags & 0x10) != 0 || key.dwExtraInfo == InjectionTag;
                if (!injected && IsRecordingWindowExcluded(GetForegroundWindow())) ExcludeRecordedKeyboardEvent((ushort)key.vkCode, down, up);
                else RecordKeyboardEvent((ushort)key.vkCode, down, up, injected);
            }
        }
        catch (Exception) { /* Hook callbacks must always return promptly to Windows. */ }
        return CallNextHookEx(KeyboardHookHandle, code, message, data);
    }

    private static void RecordKeyboardEvent(ushort value, bool down, bool up, bool injected)
    {
        if (!Recording || injected || value == 0 || value >= 255) return;
        bool changed = down ? RecordPhysicalKeys.Add(value) : up && RecordPhysicalKeys.Remove(value);
        if (!changed) return;
        long timestamp = RecordClock.ElapsedMilliseconds;
        if (value >= 0x7C && value <= 0x87) PendingRecordModifiers.Clear();
        else if (value == 0x1B && RecordModifierHeld("CTRL") && RecordModifierHeld("ALT")) PendingRecordModifiers.Clear();
        else if (Modifier(value) != null)
        {
            if (down) PendingRecordModifiers.Add(new PendingModifier { Key = value, Timestamp = timestamp });
            else
            {
                FlushRecordedModifiers();
                if (RecordEmittedKeys.Remove(value)) QueueRecord(new { type = "key", key = KeyName(value), state = "up" }, timestamp);
            }
        }
        else
        {
            FlushRecordedModifiers(true);
            if (down) { RecordEmittedKeys.Add(value); QueueRecord(new { type = "key", key = KeyName(value), state = "down" }, timestamp); }
            else if (RecordEmittedKeys.Remove(value)) QueueRecord(new { type = "key", key = KeyName(value), state = "up" }, timestamp);
        }
    }

    private static IntPtr MouseHook(int code, IntPtr message, IntPtr data)
    {
        try
        {
            if (code >= 0 && Recording)
            {
                var mouse = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(MSLLHOOKSTRUCT));
                bool injected = (mouse.flags & 1) != 0 || mouse.dwExtraInfo == InjectionTag;
                if (!injected && IsRecordingWindowExcluded(WindowFromPoint(mouse.pt))) BalanceRecordedHolds();
                else RecordMouseEvent(message.ToInt32(), mouse.pt.x, mouse.pt.y, (short)(mouse.mouseData >> 16), injected);
            }
        }
        catch (Exception) { }
        return CallNextHookEx(MouseHookHandle, code, message, data);
    }

    private static void RecordMouseEvent(int kind, int x, int y, int delta, bool injected)
    {
        if (!Recording || injected) return;
        long timestamp = RecordClock.ElapsedMilliseconds;
        string button = kind == 0x201 || kind == 0x202 ? "left" : kind == 0x204 || kind == 0x205 ? "right" : kind == 0x207 || kind == 0x208 ? "middle" : null;
        if (kind == 0x200 && RecordMoves && timestamp - LastRecordedMove >= 16)
        {
            FlushRecordedModifiers(true); LastRecordedMove = timestamp;
            QueueRecord(new { type = "mouse", action = "move", x = x, y = y }, timestamp);
        }
        else if (kind == 0x20A)
        {
            FlushRecordedModifiers(true);
            QueueRecord(new { type = "mouse", action = "scroll", x = x, y = y, delta = delta }, timestamp);
        }
        else if (button != null)
        {
            FlushRecordedModifiers(true); bool down = kind == 0x201 || kind == 0x204 || kind == 0x207;
            bool emit = down ? RecordEmittedButtons.Add(button) : RecordEmittedButtons.Remove(button);
            if (emit) QueueRecord(new { type = "mouse", action = down ? "down" : "up", button = button, x = x, y = y }, timestamp);
        }
    }

    private static void EmergencyStop()
    {
        EmergencyStopped = true; Interlocked.Increment(ref EmergencyEpoch);
        object released = ReleaseAllOwned();
        object recording = StopRecording();
        RecordedOutput.Enqueue(new { type = "emergencyStop", hotkey = "CTRL+ALT+ESC", released = released, recording = recording }); RecordedSignal.Set();
    }

    private static INPUT KeyInput(ushort key, ushort scan, uint flags)
    {
        return new INPUT { type = 1, data = new INPUTUNION { ki = new KEYBDINPUT { wVk = key, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = InjectionTag } } };
    }

    private static void SendOne(INPUT input)
    {
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows rejected generated input (a higher-integrity foreground app may block it)");
    }

    private static bool IsExtended(ushort key)
    {
        return key == 0xA3 || key == 0xA5 || key == 0x5B || key == 0x5C || key == 0x2D || key == 0x2E || (key >= 0x21 && key <= 0x28) || key == 0x6F || (key >= 0xAD && key <= 0xB3);
    }

    private static ushort ParseKey(string token)
    {
        string key = token.Trim().ToUpperInvariant();
        if (key.StartsWith("KEY") && key.Length == 4) key = key.Substring(3);
        if (key.StartsWith("DIGIT") && key.Length == 6) key = key.Substring(5);
        ushort rawCode;
        if (key.StartsWith("VK_") && UInt16.TryParse(key.Substring(3), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out rawCode) && rawCode >= 8 && rawCode < 255) return rawCode;
        if (key.Length == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9'))) return key[0];
        int function;
        if (key.StartsWith("F") && Int32.TryParse(key.Substring(1), out function) && function >= 1 && function <= 24) return (ushort)(0x6F + function);
        var names = new Dictionary<string, ushort> {
            { "CTRL", 0x11 }, { "CONTROL", 0x11 }, { "SHIFT", 0x10 }, { "ALT", 0x12 }, { "WIN", 0x5B }, { "META", 0x5B }, { "SUPER", 0x5B },
            { "LCTRL", 0xA2 }, { "RCTRL", 0xA3 }, { "LSHIFT", 0xA0 }, { "RSHIFT", 0xA1 }, { "LALT", 0xA4 }, { "RALT", 0xA5 }, { "LWIN", 0x5B }, { "RWIN", 0x5C },
            { "ENTER", 0x0D }, { "RETURN", 0x0D }, { "TAB", 9 }, { "ESC", 0x1B }, { "ESCAPE", 0x1B }, { "SPACE", 0x20 }, { "BACKSPACE", 8 },
            { "DELETE", 0x2E }, { "DEL", 0x2E }, { "INSERT", 0x2D }, { "HOME", 0x24 }, { "END", 0x23 }, { "PAGEUP", 0x21 }, { "PAGEDOWN", 0x22 },
            { "UP", 0x26 }, { "DOWN", 0x28 }, { "LEFT", 0x25 }, { "RIGHT", 0x27 }, { "ARROWUP", 0x26 }, { "ARROWDOWN", 0x28 }, { "ARROWLEFT", 0x25 }, { "ARROWRIGHT", 0x27 },
            { "CAPSLOCK", 0x14 }, { "NUMLOCK", 0x90 }, { "SCROLLLOCK", 0x91 }, { "PRINTSCREEN", 0x2C }, { "PAUSE", 0x13 }, { "APPS", 0x5D },
            { ";", 0xBA }, { "=", 0xBB }, { "+", 0xBB }, { ",", 0xBC }, { "-", 0xBD }, { ".", 0xBE }, { "/", 0xBF }, { "`", 0xC0 }, { "[", 0xDB }, { "\\", 0xDC }, { "]", 0xDD }, { "'", 0xDE },
            { "PLUS", 0xBB }, { "EQUAL", 0xBB }, { "MINUS", 0xBD }, { "COMMA", 0xBC }, { "PERIOD", 0xBE }, { "SLASH", 0xBF }, { "BACKSLASH", 0xDC },
            { "SEMICOLON", 0xBA }, { "QUOTE", 0xDE }, { "BACKQUOTE", 0xC0 }, { "BRACKETLEFT", 0xDB }, { "BRACKETRIGHT", 0xDD },
            { "NUMPADADD", 0x6B }, { "NUMPADSUBTRACT", 0x6D }, { "NUMPADMULTIPLY", 0x6A }, { "NUMPADDIVIDE", 0x6F }, { "NUMPADDECIMAL", 0x6E },
            { "VOLUMEUP", 0xAF }, { "VOLUMEDOWN", 0xAE }, { "MUTE", 0xAD }, { "PLAYPAUSE", 0xB3 }, { "MEDIANEXT", 0xB0 }, { "MEDIAPREVIOUS", 0xB1 }
        };
        ushort result;
        if (names.TryGetValue(key, out result)) return result;
        if (key.StartsWith("NUMPAD") && key.Length == 7 && key[6] >= '0' && key[6] <= '9') return (ushort)(0x60 + key[6] - '0');
        throw new ArgumentException("Unknown key: " + token);
    }

    private static string KeyName(ushort key)
    {
        if (key >= 0x70 && key <= 0x87) return "F" + (key - 0x6F);
        if ((key >= 0x30 && key <= 0x39) || (key >= 0x41 && key <= 0x5A)) return ((char)key).ToString();
        if (key >= 0x60 && key <= 0x69) return "NUMPAD" + (key - 0x60);
        switch (key)
        {
            case 0x10: return "SHIFT"; case 0x11: return "CTRL"; case 0x12: return "ALT";
            case 0xA0: return "LSHIFT"; case 0xA1: return "RSHIFT"; case 0xA2: return "LCTRL"; case 0xA3: return "RCTRL"; case 0xA4: return "LALT"; case 0xA5: return "RALT";
            case 0x5B: return "LWIN"; case 0x5C: return "RWIN";
            case 8: return "BACKSPACE"; case 9: return "TAB"; case 13: return "ENTER"; case 27: return "ESC"; case 32: return "SPACE";
            case 0x21: return "PAGEUP"; case 0x22: return "PAGEDOWN"; case 0x23: return "END"; case 0x24: return "HOME";
            case 0x25: return "LEFT"; case 0x26: return "UP"; case 0x27: return "RIGHT"; case 0x28: return "DOWN"; case 0x2D: return "INSERT"; case 0x2E: return "DELETE";
            case 0xAD: return "MUTE"; case 0xAE: return "VOLUMEDOWN"; case 0xAF: return "VOLUMEUP"; case 0xB0: return "MEDIANEXT"; case 0xB1: return "MEDIAPREVIOUS"; case 0xB3: return "PLAYPAUSE";
            default: return "VK_" + key.ToString("X2");
        }
    }

    private static string Modifier(ushort key)
    {
        if (key == 0x11 || key == 0xA2 || key == 0xA3) return "CTRL";
        if (key == 0x10 || key == 0xA0 || key == 0xA1) return "SHIFT";
        if (key == 0x12 || key == 0xA4 || key == 0xA5) return "ALT";
        if (key == 0x5B || key == 0x5C) return "WIN";
        return null;
    }

    private static string DeviceName(IntPtr device)
    {
        string name;
        if (DeviceNames.TryGetValue(device, out name)) return name;
        uint length = 0;
        if (GetRawInputDeviceInfo(device, RIDI_DEVICENAME, null, ref length) == UInt32.MaxValue || length == 0) return "";
        var text = new StringBuilder((int)length + 1);
        if (GetRawInputDeviceInfo(device, RIDI_DEVICENAME, text, ref length) == UInt32.MaxValue) return "";
        name = text.ToString();
        DeviceNames[device] = name;
        return name;
    }

    private static void ReadInput(IntPtr rawInput)
    {
        uint size = 0;
        uint headerSize = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
        if (GetRawInputData(rawInput, RID_INPUT, IntPtr.Zero, ref size, headerSize) != 0 || size < headerSize || size > 65536) return;
        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetRawInputData(rawInput, RID_INPUT, buffer, ref size, headerSize) != size) return;
            var header = (RAWINPUTHEADER)Marshal.PtrToStructure(buffer, typeof(RAWINPUTHEADER));
            if (header.dwType != 1 || header.hDevice == IntPtr.Zero) return;
            string device = DeviceName(header.hDevice);
            if (device.IndexOf("VID_1189&PID_8840", StringComparison.OrdinalIgnoreCase) < 0) return;
            if (size < headerSize + Marshal.SizeOf(typeof(RAWKEYBOARD))) return;
            var key = (RAWKEYBOARD)Marshal.PtrToStructure(IntPtr.Add(buffer, (int)headerSize), typeof(RAWKEYBOARD));
            if (key.VKey == 0xFF || key.MakeCode == 0xFF || key.ExtraInformation == InjectionTag.ToUInt32()) return;
            bool released = (key.Flags & 1) != 0;
            ushort keyCode = key.VKey;
            if (keyCode == 0x11) keyCode = (ushort)(((key.Flags & 2) != 0) ? 0xA3 : 0xA2);
            if (keyCode == 0x12) keyCode = (ushort)(((key.Flags & 2) != 0) ? 0xA5 : 0xA4);
            if (keyCode == 0x10) keyCode = (ushort)((key.MakeCode == 0x36) ? 0xA1 : 0xA0);
            string[] modifiers = TrackKey(header.hDevice, keyCode, released);
            if (modifiers == null) return;
            string name = KeyName(keyCode);
            string fingerprint = (modifiers.Length > 0 ? String.Join("+", modifiers) + "+" : "") + name;
            Emit(new { type = "input", code = name, modifiers = modifiers, fingerprint = fingerprint, device = device, scanCode = key.MakeCode, virtualKey = keyCode, extended = (key.Flags & 2) != 0, timestamp = DateTime.UtcNow.ToString("o") });
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static int ModifierOrder(string key) { return key == "CTRL" ? 0 : key == "SHIFT" ? 1 : key == "ALT" ? 2 : 3; }

    private static string[] TrackKey(IntPtr device, ushort keyCode, bool released)
    {
        var modifiers = new List<string>();
        lock (StateLock)
        {
            HashSet<ushort> held;
            if (!Pressed.TryGetValue(device, out held)) { held = new HashSet<ushort>(); Pressed[device] = held; }
            if (released) { held.Remove(keyCode); return null; }
            if (!held.Add(keyCode)) return null; // Auto-repeat is not a second physical press.
            if (Modifier(keyCode) != null) return null;
            // Different HID collections from the same target may carry modifiers.
            // Only the target's devices can enter this state; the main keyboard cannot.
            foreach (HashSet<ushort> deviceKeys in Pressed.Values)
                foreach (ushort code in deviceKeys) { string modifier = Modifier(code); if (modifier != null && !modifiers.Contains(modifier)) modifiers.Add(modifier); }
        }
        modifiers.Sort(delegate(string a, string b) { return ModifierOrder(a).CompareTo(ModifierOrder(b)); });
        return modifiers.ToArray();
    }

    private static void ForgetDevice(IntPtr device)
    {
        DeviceNames.Remove(device);
        lock (StateLock) { Pressed.Remove(device); }
    }

    private sealed class InputWindow : NativeWindow
    {
        internal InputWindow() { CreateHandle(new CreateParams { Caption = "Macro Deck Input", Parent = new IntPtr(-3) }); }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0xFF)
            {
                try { ReadInput(message.LParam); } catch (Exception ex) { Emit(new { type = "error", error = "Input: " + ex.Message }); }
            }
            else if (message.Msg == 0xFE) // WM_INPUT_DEVICE_CHANGE: release stale state after unplug.
            {
                ForgetDevice(message.LParam);
            }
            else if (message.Msg == 0x312 && message.WParam.ToInt32() == EmergencyHotkeyId) { EmergencyStop(); }
            else if (message.Msg == UiWorkMessage) { Action job; while (UiJobs.TryDequeue(out job)) job(); }
            else if (message.Msg == 0x10) { Application.ExitThread(); return; }
            base.WndProc(ref message);
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct RAWINPUTDEVICE { public ushort usUsagePage; public ushort usUsage; public uint dwFlags; public IntPtr hwndTarget; }
    [StructLayout(LayoutKind.Sequential)] private struct RAWINPUTHEADER { public uint dwType; public uint dwSize; public IntPtr hDevice; public IntPtr wParam; }
    [StructLayout(LayoutKind.Sequential)] private struct RAWKEYBOARD { public ushort MakeCode; public ushort Flags; public ushort Reserved; public ushort VKey; public uint Message; public uint ExtraInformation; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public INPUTUNION data; }
    [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int left; public int top; public int right; public int bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
    [StructLayout(LayoutKind.Sequential)] private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public UIntPtr dwExtraInfo; }
    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr dc, ref RECT bounds, IntPtr parameter);
    private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint GetRawInputData(IntPtr rawInput, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, StringBuilder data, ref uint size);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern uint GetPixel(IntPtr dc, int x, int y);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
    [DllImport("Shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int type, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
}
