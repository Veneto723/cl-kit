# cl-focus: bring the terminal window hosting a claude session to the foreground.
# Invoked by the cl-focus: protocol handler when a cl-notify toast is clicked.
# Arg: the claude process pid (possibly prefixed "cl-focus:" from the URI).
param([string]$Target)

$clPid = [int]($Target -replace '^cl-focus:', '' -replace '[^\d]', '')
if (-not $clPid) { exit 0 }

# Climb the parent chain: the claude pid itself has no window — its terminal
# host (WindowsTerminal, studio64, conhost, ...) does.
$hwnd = [IntPtr]::Zero
$cur = $clPid
for ($i = 0; $i -lt 10 -and $cur; $i++) {
  $p = Get-Process -Id $cur -ErrorAction SilentlyContinue
  if (-not $p) { break }
  if ($p.MainWindowHandle -ne 0) { $hwnd = $p.MainWindowHandle; break }
  $cur = (Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue).ParentProcessId
}
if ($hwnd -eq [IntPtr]::Zero) { exit 0 }

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
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@

if ([FG]::IsIconic($hwnd)) { [FG]::ShowWindow($hwnd, 9) | Out-Null }  # SW_RESTORE
if (-not [FG]::SetForegroundWindow($hwnd)) {
  # Windows may refuse foreground steal — attach to the current FG thread's input
  # queue (the classic workaround), then retry.
  $fgThread = [FG]::GetWindowThreadProcessId([FG]::GetForegroundWindow(), [IntPtr]::Zero)
  $myThread = [FG]::GetCurrentThreadId()
  [FG]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
  [FG]::SetForegroundWindow($hwnd) | Out-Null
  [FG]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
}
