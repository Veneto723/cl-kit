' cl-focus.vbs: bring the terminal window hosting a claude session to the
' foreground when a cl-notify toast is clicked. Registered as the cl-focus:
' protocol handler, so the Windows shell launches THIS script DIRECTLY on the
' click and grants IT the right to change the foreground. That grant does NOT
' survive being handed to a spawned child, so we activate the window HERE, in the
' granted process, via WshShell.AppActivate (which honors the grant).
'
' Primary path: cl-runner snapshots the PID that owned the FOREGROUND window when
' the session launched (the user's terminal) into ~/.claude/cache/cl-win-<pid>.json.
' That's authoritative even under a ConPTY host (Windows Terminal), where the
' terminal window process is NOT in the shell's process tree at all. We read it and
' AppActivate that PID.
'
' Fallback (no sidecar, e.g. a session predating this): climb the parent chain from
' the claude pid and AppActivate the first ancestor (or its conhost child) that owns
' a window — skipping the desktop shell (explorer) so we never raise it by mistake.
' Windowless (wscript //B) → no console flash.
Option Explicit
Dim sh, wmi, fso, home, logPath, arg, re, pid, startPid, ok
If WScript.Arguments.Count < 1 Then WScript.Quit
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
home = sh.ExpandEnvironmentStrings("%USERPROFILE%")
logPath = home & "\.claude\cache\cl-focus.log"

Sub Log(m)
  On Error Resume Next
  ' Match the other cl logs: keep it tiny — reset once past ~64KB.
  If fso.FileExists(logPath) Then
    If fso.GetFile(logPath).Size > 65536 Then fso.DeleteFile(logPath)
  End If
  Dim f : Set f = fso.OpenTextFile(logPath, 8, True)   ' 8 = append, create if absent
  f.WriteLine Now & " " & m
  f.Close
End Sub

' First integer owning a window, activated. Returns True on success.
Function TryActivate(p)
  TryActivate = False
  If p = 0 Then Exit Function
  On Error Resume Next
  TryActivate = sh.AppActivate(p)
  On Error GoTo 0
End Function

' Digits-only child of `parentPid` whose name is conhost.exe (a classic console's
' window lives in conhost, a CHILD of the shell — not in the ancestry).
Function ConhostChild(parentPid)
  ConhostChild = 0
  On Error Resume Next
  Dim q, p
  Set q = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ParentProcessId=" & parentPid & " AND Name='conhost.exe'")
  For Each p In q : ConhostChild = p.ProcessId : Next
  On Error GoTo 0
End Function

arg = WScript.Arguments(0)
Set re = New RegExp : re.Global = True : re.Pattern = "[^\d]"
pid = CLng("0" & re.Replace(arg, ""))                  ' strip "cl-focus:" and non-digits
If pid = 0 Then Log "no pid from '" & arg & "'" : WScript.Quit
startPid = pid

' --- primary: the window PID cl-runner captured at launch ---
Dim winFile : winFile = home & "\.claude\cache\cl-win-" & pid & ".json"
If fso.FileExists(winFile) Then
  On Error Resume Next
  Dim t, wpid : t = fso.OpenTextFile(winFile, 1).ReadAll
  wpid = CLng("0" & re.Replace(t, ""))
  On Error GoTo 0
  If TryActivate(wpid) Then Log "focus start=" & startPid & " via=sidecar win=" & wpid : WScript.Quit
End If

' --- fallback: climb ancestors, skipping the desktop shell ---
Dim i, q, p, ppid, name
ok = False
For i = 0 To 11
  If pid = 0 Then Exit For
  name = "" : ppid = 0
  Set q = wmi.ExecQuery("SELECT Name,ParentProcessId FROM Win32_Process WHERE ProcessId=" & pid)
  For Each p In q : name = LCase(p.Name) : ppid = p.ParentProcessId : Next
  If name = "" Then Exit For
  ' Never raise the desktop/shell itself.
  If name = "explorer.exe" Or name = "dwm.exe" Then Exit For
  If TryActivate(pid) Then ok = True : Exit For
  If TryActivate(ConhostChild(pid)) Then ok = True : Exit For
  pid = ppid
Next
Log "focus start=" & startPid & " via=climb host=" & pid & " ok=" & ok

If Not ok Then
  ' Last resort: the win32 helper (SetForegroundWindow + minimize/restore).
  On Error Resume Next
  sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & _
    home & "\.claude\scripts\cl-focus.ps1"" """ & arg & """", 0, False
  On Error GoTo 0
End If
