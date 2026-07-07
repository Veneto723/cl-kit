#!/usr/bin/env node
// cl-notify: Claude Code hook that pops a Windows toast when a session finishes a
// (non-trivial) turn, labeled with the session's /rename NAME so you can jump to
// the right terminal. Wired in settings.json:
//   UserPromptSubmit -> `cl-notify.js start`  (records turn start time)
//   Stop             -> `cl-notify.js done`   (on finish, toast if turn was long)
//   StopFailure      -> `cl-notify.js fail`   (turn ended in an ERROR — always toast)
//   Notification     -> `cl-notify.js wait`   (permission prompt / idle — the session
//                        is WAITING for you mid-turn; Stop never fired, so without
//                        this it looks "done but silent")
// All receive the hook JSON on stdin ({ session_id, cwd, ... }). Always exit 0.
//
// The /rename name isn't in the hook input, but Claude Code writes it (plus the
// session id) to ~/.claude/sessions/<pid>.json — we match on sessionId to get it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
// Only toast when a turn took at least this long (ms) — avoids a toast after every
// quick reply. Override with the CL_NOTIFY_MIN_MS env var (0 = notify every turn).
const MIN_MS = process.env.CL_NOTIFY_MIN_MS != null ? parseInt(process.env.CL_NOTIFY_MIN_MS, 10) || 0 : 30_000;

function turnFile(sid) { return path.join(CACHE_DIR, `cl-turn-${sid}.json`); }

// One-line decision trace per 'done' — answers "why didn't a toast fire?" after
// the fact. Kept tiny: truncated whenever it grows past ~64KB.
const LOG_PATH = path.join(CACHE_DIR, 'cl-notify.log');
function trace(line) {
  try {
    try { if (fs.statSync(LOG_PATH).size > 64_000) fs.truncateSync(LOG_PATH, 0); } catch {}
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + line + '\n');
  } catch {}
}

// Find the session's /rename name (+ cwd) by matching sessionId in the per-pid
// session metadata files Claude Code maintains.
function sessionInfo(sid) {
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        if (s.sessionId === sid) return { name: s.name || null, cwd: s.cwd || null, pid: s.pid || null };
      } catch {}
    }
  } catch {}
  return { name: null, cwd: null, pid: null };
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}

// Fire a Windows 10/11 toast via the WinRT ToastNotification API under PowerShell's
// registered AppID (so it reliably surfaces in the Action Center — the old
// NotifyIcon balloon is dropped by Win11 for transient tray icons).
// SYNCHRONOUS (spawnSync): a detached fire-and-forget child raced the hook's
// process.exit — when claude reaped the hook, Windows sometimes tore the child
// down before Show() had handed the toast to the OS, so notifications were
// dropped SILENTLY (ps exit 0, nothing in Action Center). Waiting the ~1s for
// Show() to complete is invisible at turn boundaries and makes delivery reliable.
//
// `kind` picks a colored state icon (appLogoOverride, circle-cropped):
//   done = green check   wait = amber pause   fail = red cross
// Icons live in scripts/icons/ (regen: make-icons.ps1). Raw toast XML instead of
// the ToastText02 template because templates can't carry appLogoOverride.
const ICONS_DIR = path.join(__dirname, 'icons');
function toast(title, text, kind, focusPid) {
  // POSIX: no WinRT and no cl-focus: click-to-focus protocol — show a plain desktop
  // notification via the OS notifier (notify-send / osascript), degrading to a
  // silent no-op if none is available. (Icons + click-to-focus are Windows-only.)
  if (process.platform !== 'win32') {
    try { if (!require('./cl-platform').notify(title, text)) trace('toast-skip no notifier'); } catch (e) { trace(`toast-error ${String(e && e.message).slice(0, 120)}`); }
    return;
  }
  const q = (s) => String(s).replace(/'/g, "''"); // PowerShell single-quote escape
  const xe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); // XML escape
  const iconFile = path.join(ICONS_DIR, `${kind || 'done'}.png`);
  const icon = fs.existsSync(iconFile)
    ? `<image placement="appLogoOverride" hint-crop="circle" src="file:///${xe(iconFile.replace(/\\/g, '/'))}"/>`
    : '';
  // Clicking the toast launches the cl-focus: protocol (HKCU-registered →
  // cl-focus.vbs → cl-focus.ps1), which foregrounds the terminal window that
  // hosts this session's claude pid.
  const activate = focusPid ? ` activationType="protocol" launch="cl-focus:${focusPid}"` : '';
  const xml =
    `<toast duration="long"${activate}><visual><binding template="ToastGeneric">` + // long ≈ 25s banner
    icon +
    `<text>${xe(title)}</text><text>${xe(text)}</text>` +
    `</binding></visual></toast>`;
  const ps =
    "$ErrorActionPreference='Stop';" +
    "$AppId='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';" +
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;" +
    "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null;" +
    "$xml=[Windows.Data.Xml.Dom.XmlDocument]::new();" +
    `$xml.LoadXml('${q(xml)}');` +
    "$toast=[Windows.UI.Notifications.ToastNotification]::new($xml);" +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)";
  try {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 10_000, encoding: 'utf8' });
    if (r.status !== 0) trace(`toast-error status=${r.status} ${String(r.stderr || '').slice(0, 200).replace(/\s+/g, ' ')}`);
  } catch (e) { trace(`toast-error ${String(e && e.message).slice(0, 200)}`); }
}

let handled = false;
function run(raw) {
  if (handled) return;
  handled = true;
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch {}
  const sid = hook.session_id || '';
  const mode = process.argv[2];

  if (mode === 'start') {
    if (sid) { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(turnFile(sid), String(Date.now())); } catch {} }
    process.exit(0);
  }

  // 'wait': the session stopped mid-turn to ask YOU something (permission prompt)
  // or has sat idle >=60s. Stop won't fire here, so toast immediately — but only
  // for real attention asks, not routine notices.
  if (mode === 'wait') {
    const msg = String(hook.message || '');
    // Only genuine attention asks (permission/approval prompts) toast here — NOT
    // the routine "waiting for your input" idle notice, which re-fires ~60s after
    // a completed turn and just annoys (the Stop 'ready' toast already covered it).
    const isPerm = /permission|approval/i.test(msg);
    if (!isPerm) { trace(`wait-skip sid=${sid.slice(0, 8)} msg=${msg.slice(0, 60)}`); process.exit(0); }
    const info0 = sessionInfo(sid);
    const proj0 = info0.cwd ? String(info0.cwd).split(/[\\/]/).filter(Boolean).pop() : '';
    const name0 = info0.name || proj0 || (sid ? sid.slice(0, 8) : 'session');
    trace(`wait sid=${sid.slice(0, 8)} name=${name0} msg=${msg.slice(0, 60)}`);
    toast(`${name0} — needs you`, msg.slice(0, 100) || 'Waiting for permission', 'wait', info0.pid);
    process.exit(0);
  }

  // 'done' (normal Stop) or 'fail' (StopFailure — turn died on an error).
  let elapsed = null;
  if (sid) {
    try { elapsed = Date.now() - parseInt(fs.readFileSync(turnFile(sid), 'utf8'), 10); } catch {}
    try { fs.unlinkSync(turnFile(sid)); } catch {}
  }

  if (mode === 'fail') {
    // An errored turn is exactly when you'd wait forever for a toast that never
    // comes — always notify, regardless of duration.
    const infoF = sessionInfo(sid);
    const projF = infoF.cwd ? String(infoF.cwd).split(/[\\/]/).filter(Boolean).pop() : '';
    const nameF = infoF.name || projF || (sid ? sid.slice(0, 8) : 'session');
    trace(`fail sid=${sid.slice(0, 8)} name=${nameF} elapsed=${elapsed != null ? fmtDur(elapsed) : '?'}`);
    toast(`${nameF} — stopped on an error`, elapsed != null ? fmtDur(elapsed) : 'Needs a look', 'fail', infoF.pid);
    process.exit(0);
  }
  // Skip short turns (when we know the duration). Unknown duration → notify.
  if (elapsed != null && elapsed < MIN_MS) {
    trace(`skip sid=${sid.slice(0, 8)} elapsed=${fmtDur(elapsed)} < min=${fmtDur(MIN_MS)}`);
    process.exit(0);
  }

  const info = sessionInfo(sid);
  const proj = info.cwd ? String(info.cwd).split(/[\\/]/).filter(Boolean).pop() || info.cwd : (hook.cwd ? String(hook.cwd).split(/[\\/]/).filter(Boolean).pop() : '');
  const name = info.name || proj || (sid ? sid.slice(0, 8) : 'session');
  const bits = [];
  if (proj && proj !== name) bits.push(proj);
  if (elapsed != null) bits.push(fmtDur(elapsed));
  trace(`toast sid=${sid.slice(0, 8)} name=${name} elapsed=${elapsed != null ? fmtDur(elapsed) : '?'}`);
  toast(`${name} — ready`, bits.length ? bits.join('  ·  ') : 'Waiting for you', 'done', info.pid);
  process.exit(0);
}

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => run(input));
process.stdin.on('error', () => run(''));
setTimeout(() => run(''), 500).unref(); // safety net if stdin never closes
