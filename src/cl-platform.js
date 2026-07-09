// cl-platform: the OS touchpoints that aren't inline elsewhere. cl-kit is Windows 11
// only, so this is just the clipboard reader now — the POSIX keychain and notifier
// helpers were removed when cross-platform support was dropped (keys use DPAPI in
// cl-config.js; toasts use WinRT in cl-notify.js).
'use strict';

const { execFileSync } = require('child_process');

// Read the system clipboard as text (PowerShell Get-Clipboard), or null if it can't
// be read. Degrades to null rather than throwing, so a caller can fall back to
// --file / --stdin.
function readClipboard() {
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (out != null) return String(out);
  } catch { /* clipboard empty or PowerShell unavailable */ }
  return null;
}

// A short hint naming how to supply input when the clipboard isn't readable.
function clipboardHint() {
  return 'the clipboard may be empty — or pass --file <path> / --stdin';
}

module.exports = { readClipboard, clipboardHint };
