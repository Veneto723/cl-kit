// cl-platform: the OS-specific touchpoints, abstracted so the rest of cl stays
// platform-neutral. Windows / macOS / Linux. Each helper degrades gracefully
// (returns null / a hint) rather than throwing, so a missing tool never breaks a
// flow that has a fallback (--file / --stdin / env var).
'use strict';

const { execFileSync } = require('child_process');

// Read the system clipboard as text, or null if no clipboard tool is available.
//   Windows → PowerShell Get-Clipboard   macOS → pbpaste
//   Linux   → wl-paste (Wayland) | xclip | xsel (first that works)
function readClipboard() {
  const attempts = process.platform === 'win32'
    ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']]]
    : process.platform === 'darwin'
      ? [['pbpaste', []]]
      : [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]];
  for (const [cmd, args] of attempts) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (out != null) return String(out);
    } catch { /* tool absent or failed — try the next */ }
  }
  return null;
}

// A short hint naming how to supply input when the clipboard isn't readable.
function clipboardHint() {
  if (process.platform === 'linux') return 'install xclip or wl-clipboard, or pass --file <path> / --stdin';
  return 'pass --file <path> or --stdin';
}

module.exports = { readClipboard, clipboardHint };
