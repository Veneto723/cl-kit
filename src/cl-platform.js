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
// (On Linux the read can fail because no tool is installed OR the clipboard is
// empty / the session is headless — so the hint covers both, not just "install".)
function clipboardHint() {
  if (process.platform === 'linux') return 'install xclip or wl-clipboard if missing (or the clipboard may be empty), or pass --file <path> / --stdin';
  return 'the clipboard may be empty — or pass --file <path> / --stdin';
}

// ---- OS keychain (macOS Keychain / Linux libsecret) -------------------------
// Store/read an api key in the OS secret store so it's not a plaintext file.
// keychainStore returns true on success; keychainGet returns the secret or null.
// Both DEGRADE to false/null (never throw) when the tool or a secret service
// isn't available, so callers can fall back to the 0600 file. Windows uses DPAPI
// elsewhere, so these are POSIX-only.
const KEYCHAIN_SERVICE = 'cl-kit';

function keychainStore(id, key) {
  try {
    if (process.platform === 'darwin') {
      // -U updates an existing item. (macOS has no stdin path for the value, so it
      // rides argv — briefly visible to `ps`; acceptable vs a plaintext file.)
      execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', String(id), '-w', key],
        { stdio: 'ignore', timeout: 15000 });
      return true;
    }
    if (process.platform === 'linux') {
      // secret-tool reads the secret from stdin — never on the command line.
      execFileSync('secret-tool', ['store', '--label', `cl-kit ${id}`, 'service', KEYCHAIN_SERVICE, 'account', String(id)],
        { input: key, stdio: ['pipe', 'ignore', 'ignore'], timeout: 15000 });
      return true;
    }
  } catch { /* no tool / no secret service / locked keychain */ }
  return false;
}

function keychainGet(id) {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', String(id), '-w'],
        { encoding: 'utf8', timeout: 15000 });
      return out.replace(/\r?\n$/, '');
    }
    if (process.platform === 'linux') {
      const out = execFileSync('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', String(id)],
        { encoding: 'utf8', timeout: 15000 });
      return out; // secret-tool lookup emits the secret with no trailing newline
    }
  } catch { /* not found / unavailable */ }
  return null;
}

function keychainDelete(id) {
  try {
    if (process.platform === 'darwin') {
      execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', String(id)], { stdio: 'ignore', timeout: 15000 });
      return true;
    }
    if (process.platform === 'linux') {
      execFileSync('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', String(id)], { stdio: 'ignore', timeout: 15000 });
      return true;
    }
  } catch { /* not present / unavailable */ }
  return false;
}

// ---- desktop notifications (Linux/macOS) ------------------------------------
// Show a plain desktop notification. macOS → osascript; Linux → notify-send.
// Windows toasts are richer (WinRT + click-to-focus) and handled in cl-notify.js,
// so this is POSIX-only and returns false on win32. Returns true if shown, false
// if no notifier is available; never throws. Title/body are passed as ARGV (no
// shell / no AppleScript string interpolation), so quotes in them can't break out.
function notify(title, body) {
  const t = String(title == null ? '' : title);
  const b = String(body == null ? '' : body);
  try {
    if (process.platform === 'darwin') {
      execFileSync('osascript',
        ['-e', 'on run {t, b}', '-e', 'display notification b with title t', '-e', 'end run', t, b],
        { stdio: 'ignore', timeout: 10000 });
      return true;
    }
    if (process.platform === 'linux') {
      execFileSync('notify-send', [t, b], { stdio: 'ignore', timeout: 10000 });
      return true;
    }
  } catch { /* no notifier / headless — caller degrades to silence */ }
  return false;
}

module.exports = { readClipboard, clipboardHint, keychainStore, keychainGet, keychainDelete, notify };
