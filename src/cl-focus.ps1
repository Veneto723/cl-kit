# cl-focus: bring the terminal window hosting a claude session to the foreground.
# Invoked by the cl-focus: protocol handler when a cl-notify toast is clicked.
# Arg: the claude process pid (possibly prefixed "cl-focus:" from the URI).
#
# Foregrounding from a background process is deliberately restricted by Windows —
# a plain SetForegroundWindow just flashes the taskbar button. The reliable recipe
# (used below) is: clear the foreground-lock timeout, synthesize an ALT keypress
# so our thread counts as "recently got input", attach to the current foreground
# thread's input queue, then BringWindowToTop + SetForegroundWindow +
# SwitchToThisWindow. One-line log at ~/.claude/cache/cl-focus.log for debugging.
param([string]$Target)

$logPath = Join-Path $env:USERPROFILE '.claude\cache\cl-focus.log'
function Log($m) { try { Add-Content -Path $logPath -Value ((Get-Date).ToString('s') + ' ' + $m) -ErrorAction SilentlyContinue } catch {} }

$clPid = [int]($Target -replace '^cl-focus:', '' -replace '[^\d]', '')
if (-not $clPid) { Log "no pid from '$Target'"; exit 0 }

# Climb the parent chain: the claude pid itself has no window — its terminal host
# (WindowsTerminal, studio64, conhost, ...) does.
$hwnd = [IntPtr]::Zero
$cur = $clPid
for ($i = 0; $i -lt 12 -and $cur; $i++) {
  $p = Get-Process -Id $cur -ErrorAction SilentlyContinue
  if (-not $p) { break }
  # Never climb into / raise the desktop shell — reaching it means the real
  # terminal window wasn't an ancestor (a ConPTY host); raising explorer is wrong.
  if ($p.ProcessName -eq 'explorer' -or $p.ProcessName -eq 'dwm') { break }
  if ($p.MainWindowHandle -ne 0) { $hwnd = $p.MainWindowHandle; break }
  $cur = (Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue).ParentProcessId
}
if ($hwnd -eq [IntPtr]::Zero) { Log "pid=$clPid : no window in ancestry"; exit 0 }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfoW(uint action, uint uiParam, IntPtr pvParam, uint winIni);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@

# 1. Drop the foreground-lock timeout so a foreground change is permitted at all
#    (SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001).
[FG]::SystemParametersInfoW(0x2001, 0, [IntPtr]::Zero, 0) | Out-Null
# 2. Un-minimize (SW_RESTORE = 9).
if ([FG]::IsIconic($hwnd)) { [FG]::ShowWindow($hwnd, 9) | Out-Null }
# 3. Synthetic ALT tap: makes THIS thread eligible to change the foreground
#    (VK_MENU = 0x12, KEYEVENTF_KEYUP = 0x2).
[FG]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
[FG]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
# 4. Attach to the foreground thread's input queue, then force the window up.
$fg = [FG]::GetForegroundWindow()
$fgThread = [FG]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$myThread = [FG]::GetCurrentThreadId()
$attached = $false
if ($fgThread -ne 0 -and $fgThread -ne $myThread) { $attached = [FG]::AttachThreadInput($myThread, $fgThread, $true) }
[FG]::BringWindowToTop($hwnd) | Out-Null
$ok = [FG]::SetForegroundWindow($hwnd)
[FG]::SwitchToThisWindow($hwnd, $true)
if ($attached) { [FG]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null }

# Fallback for the hard case (background caller with no foreground rights, where
# SetForegroundWindow is refused outright): a minimize->restore. ShowWindow on
# another process's window is NOT foreground-restricted, and restoring a minimized
# window legitimately raises it to the foreground. Costs a brief flicker, so only
# do it when the direct attempt didn't land. SW_MINIMIZE=6, SW_RESTORE=9.
$landed = ([FG]::GetForegroundWindow() -eq $hwnd)
if (-not $landed) {
  [FG]::ShowWindow($hwnd, 6) | Out-Null
  Start-Sleep -Milliseconds 60
  [FG]::ShowWindow($hwnd, 9) | Out-Null
  [FG]::SetForegroundWindow($hwnd) | Out-Null
}
Log "pid=$clPid hwnd=$hwnd sfw=$ok direct=$landed finalFg=$([FG]::GetForegroundWindow())"
