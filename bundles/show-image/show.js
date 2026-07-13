#!/usr/bin/env node
// show-image/show.js — open an image in the human's default viewer.
//
// Reading an image shows it to the MODEL only; the user never sees it, and Claude
// Code cannot render images inline (graphics escape sequences are rejected). This
// is the only way to actually put an image in front of the person.
//
// Usage:  node show.js <path-to-image> [--dry]
//   --dry   print the command that WOULD run, without opening anything.
//
// Windows 11, zero dependencies. Opens with `start` via cmd.exe.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.tif', '.tiff', '.ico', '.pdf']);

function fail(msg, code = 1) { process.stderr.write(`[show-image] ${msg}\n`); process.exit(code); }

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const target = args.filter((a) => a !== '--dry')[0];

if (!target) fail('usage: node show.js <path-to-image> [--dry]');

const file = path.resolve(target);
if (!fs.existsSync(file)) fail(`no such file: ${file}`);
let st; try { st = fs.statSync(file); } catch (e) { fail(`cannot stat ${file}: ${e.message}`); }
if (st.isDirectory()) fail(`that's a directory, not an image: ${file}`);
if (st.size === 0) fail(`file is empty (0 bytes): ${file}`);

const ext = path.extname(file).toLowerCase();
if (!IMAGE_EXT.has(ext)) {
  process.stderr.write(`[show-image] warning: "${ext || '(no extension)'}" isn't a known image type — opening anyway.\n`);
}

// "Open with default app": `start` through cmd.exe.
const cmd = process.env.ComSpec || 'cmd.exe';
const cmdArgs = ['/d', '/s', '/c', 'start', '', file];

// Send a desktop toast, reusing arc's WinRT notifier if installed. Returns how it
// was sent, or null. PNG dimensions straight from the IHDR header (no decode, no deps).
function pngSize(p) {
  try {
    const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0); fs.closeSync(fd);
    if (b.toString('ascii', 1, 4) !== 'PNG') return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch { return null; }
}

// `launchUri` makes the toast CLICKABLE — a file:/// URI opens the image in its
// default app, so nothing steals focus until the human actually clicks.
// Placement matters: a WIDE image (screenshot) squashes badly into the square logo
// slot, so it goes in the 2:1 `hero` banner; a square-ish image (QR, diagram) stays
// a crisp uncropped square logo.
function desktopNotify(title, body, launchUri, wide) {
  const scripts = path.join(os.homedir(), '.claude', 'scripts');
  // kind 'image' has no state icon on purpose — the toast shows the ACTUAL image,
  // which says far more than any generic glyph.
  try {
    require(path.join(scripts, 'arc-notify.js'))
      .toast(title, body, 'image', undefined, launchUri, wide ? { heroUri: launchUri } : { logoUri: launchUri });
    return `arc-notify toast (${wide ? 'wide banner' : 'square thumbnail'} · click it to open)`;
  } catch {}
  return null;
}

// Mode resolution: an explicit env var wins (a deliberate per-invocation choice),
// else arc's config (features.showImage), else 'open'. Reading the config means
// a standing preference applies immediately — no session restart needed.
function configuredMode() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'cl-config.json'), 'utf8'));
    const v = cfg && cfg.features && cfg.features.showImage;
    return typeof v === 'string' ? v.toLowerCase() : null;
  } catch { return null; }
}

// ARC_SHOW_IMAGE modes — the human decides how intrusive this is allowed to be:
//   open   (default) pop the image in the OS viewer      — steals focus
//   notify           desktop toast + print the path      — NO window, no focus steal
//   off              print the path only                 — never opens anything
const MODE = (process.env.ARC_SHOW_IMAGE || configuredMode() || 'open').toLowerCase();

if (MODE === 'off') {
  process.stdout.write(
    `[show-image] ARC_SHOW_IMAGE=off — not opening a window.\n` +
    `[show-image] image is at: ${file}\n` +
    `[show-image] Give the user this path so they can open it themselves.\n`);
  process.exit(0);
}

if (MODE === 'notify') {
  const kb0 = Math.max(1, Math.round(st.size / 1024));
  const fileUri = require('url').pathToFileURL(file).href; // file:///C:/... (properly encoded)
  const dim = pngSize(file);
  const wide = !!(dim && dim.h > 0 && dim.w / dim.h >= 1.6); // 2:1 hero suits wide; square logo suits QRs
  const how = dry
    ? `(dry: would toast as ${wide ? 'wide hero banner' : 'square thumbnail'}${dim ? ` [${dim.w}x${dim.h}]` : ''}, click-target ${fileUri})`
    : desktopNotify('Claude has an image for you', `${path.basename(file)} · ${kb0} KB — click to open`, fileUri, wide);
  process.stdout.write(
    `[show-image] ARC_SHOW_IMAGE=notify — no window opened (focus not stolen).\n` +
    `[show-image] ${how ? `alerted via ${how}` : 'no notifier available — tell the user directly'}\n` +
    `[show-image] image is at: ${file}\n` +
    `[show-image] Tell the user the image is ready and give them this path.\n`);
  process.exit(0);
}

if (dry) { process.stdout.write(`[show-image] DRY RUN — would run: ${cmd} ${cmdArgs.join(' ')}\n`); process.exit(0); }

const r = spawnSync(cmd, cmdArgs, { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
if (r.error) fail(`failed to launch viewer (${cmd}): ${r.error.message}`);

const kb = Math.max(1, Math.round(st.size / 1024));
process.stdout.write(`[show-image] opened ${path.basename(file)} (${kb} KB) in the default viewer — the user can see it now.\n`);
