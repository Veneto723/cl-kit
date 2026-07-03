' cl-focus.vbs: flash-free launcher for the cl-focus: protocol — runs the
' PowerShell focus script fully hidden (a direct powershell.exe protocol
' command would flash a console window on every toast click).
If WScript.Arguments.Count < 1 Then WScript.Quit
Dim sh, arg
Set sh = CreateObject("WScript.Shell")
arg = WScript.Arguments(0)
sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & _
  sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude\scripts\cl-focus.ps1"" """ & arg & """", 0, False
