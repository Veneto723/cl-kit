#!/usr/bin/env node
// arc setup: interactive wizard that writes ~/.claude/arc-config.json.
// Lets anyone pick their style — single subscription, two subscriptions,
// subscription + API gateway (pool), gateway only, or any custom mix.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const C = require('./arc-config');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

async function askChoice(q, choices, def) {
  for (;;) {
    const a = (await ask(`${q} [${choices.join('/')}]${def ? ` (${def})` : ''}: `)) || def || '';
    if (choices.includes(a)) return a;
    console.log(`  please answer one of: ${choices.join(', ')}`);
  }
}

async function askId(q, taken, def) {
  for (;;) {
    const a = (await ask(`${q}${def ? ` (${def})` : ''}: `)) || def || '';
    if (!/^[a-z][a-z0-9_-]*$/i.test(a)) { console.log('  id must be alphanumeric (dash/underscore ok)'); continue; }
    if (taken.has(a)) { console.log('  that id is already used'); continue; }
    return a;
  }
}

async function buildOauth(taken, suggestedId, suggestedLabel) {
  const id = await askId('  account id (short, used in arc:switch)', taken, suggestedId);
  const label = (await ask(`  display label (${suggestedLabel || id.toUpperCase()}): `)) || suggestedLabel || id.toUpperCase();
  const color = (await ask('  statusline color hex (#D97757): ')) || '#D97757';
  console.log('  (if this is a SECOND subscription, run `arc capture ' + id + '` later while logged in as it)');
  return { id, label, color, type: 'oauth' };
}

async function buildApi(taken, suggestedId) {
  const id = await askId('  account id (short, used in arc:switch)', taken, suggestedId);
  const label = (await ask(`  display label (${id.toUpperCase()}): `)) || id.toUpperCase();
  const color = (await ask('  statusline color hex (#2DD4BF): ')) || '#2DD4BF';
  let baseUrl = '';
  while (!/^https?:\/\//.test(baseUrl)) baseUrl = await ask('  gateway base URL (https://...): ');
  console.log('  API key source: 1=env var  2=inline in config  3=extract from a file with a regex');
  const src = await askChoice('  key source', ['1', '2', '3'], '1');
  const acc = { id, label, color, type: 'api', baseUrl };
  if (src === '1') acc.apiKeyEnv = await ask('  env var name (e.g. MY_GATEWAY_KEY): ');
  else if (src === '2') acc.apiKey = await ask('  API key (stored in arc-config.json — keep that file private): ');
  else {
    acc.apiKeyFrom = {
      file: await ask('  file path: '),
      regex: await ask('  regex with ONE capture group for the key: '),
    };
  }
  const map = await ask('  model aliases as alias=model pairs, comma-separated (opus=opus,sonnet=sonnet,haiku=haiku,fable=fable — Enter for that default, "-" for none): ');
  if (map !== '-') {
    acc.modelMap = {};
    const spec = map || 'opus=opus,sonnet=sonnet,haiku=haiku,fable=fable';
    for (const pair of spec.split(',')) {
      const [k, v] = pair.split('=').map((s) => s && s.trim());
      if (k && v) acc.modelMap[k] = v;
    }
  }
  return acc;
}

async function main() {
  console.log('arc setup — configure your accounts (writes ~/.claude/arc-config.json)\n');
  console.log('Styles:');
  console.log('  1. single subscription        (one claude.ai login; arc adds session tools only)');
  console.log('  2. two subscriptions          (switch between two claude.ai logins)');
  console.log('  3. subscription + gateway     (claude.ai login + an API pool/proxy)');
  console.log('  4. gateway only               (API base URL + key, no claude.ai login)');
  console.log('  5. custom                     (build any list of accounts)\n');

  const style = await askChoice('choose a style', ['1', '2', '3', '4', '5'], '3');
  const taken = new Set();
  const accounts = [];

  const add = (a) => { taken.add(a.id); accounts.push(a); };

  if (style === '1') {
    console.log('\n[subscription]');
    add(await buildOauth(taken, 'main', 'MAX'));
  } else if (style === '2') {
    console.log('\n[first subscription — capture it later with `arc capture <id>` while logged in as it]');
    add(await buildOauth(taken, 'personal'));
    console.log('\n[second subscription]');
    add(await buildOauth(taken, 'work'));
  } else if (style === '3') {
    console.log('\n[subscription]');
    add(await buildOauth(taken, 'max', 'MAX'));
    console.log('\n[API gateway / pool]');
    add(await buildApi(taken, 'pool'));
  } else if (style === '4') {
    console.log('\n[API gateway]');
    add(await buildApi(taken, 'gateway'));
  } else {
    for (;;) {
      const t = await askChoice('\nadd an account — type', ['oauth', 'api', 'done'], accounts.length ? 'done' : 'oauth');
      if (t === 'done') { if (accounts.length) break; console.log('  need at least one account'); continue; }
      add(t === 'oauth' ? await buildOauth(taken) : await buildApi(taken));
    }
  }

  const def = accounts.length === 1
    ? accounts[0].id
    : await askChoice('\ndefault account at launch', accounts.map((a) => a.id), accounts[0].id);

  // Optional pool metrics DB (renders per-account utilization in the statusline
  // and powers the pool MCP server). Fully optional.
  let poolDb = null;
  if (accounts.some((a) => a.type === 'api')) {
    const want = await askChoice('\nconfigure a pool metrics DB (Neon Postgres pool_accounts/account_usage schema)?', ['y', 'n'], 'n');
    if (want === 'y') poolDb = { neonUrl: await ask('  Neon connection URL: ') };
  }

  const cfgOut = {
    version: 1,
    defaultAccount: def,
    accounts,
    switchOrder: accounts.map((a) => a.id),
    thresholds: { warnSessionPct: 85, warnWeekPct: 90, switchSessionPct: 92, switchWeekPct: 95 },
    features: {},
    ...(poolDb ? { poolDb } : {}),
  };

  if (fs.existsSync(C.CONFIG_PATH)) {
    const bak = C.CONFIG_PATH + '.bak-' + Date.now();
    fs.copyFileSync(C.CONFIG_PATH, bak);
    console.log(`\n(existing config backed up to ${bak})`);
  }
  fs.writeFileSync(C.CONFIG_PATH, JSON.stringify(cfgOut, null, 2));
  console.log(`\nwrote ${C.CONFIG_PATH}`);
  console.log('next steps:');
  console.log('  arc doctor            — verify everything resolves');
  for (const a of accounts) {
    if (a.type === 'oauth' && accounts.filter((x) => x.type === 'oauth').length > 1) {
      console.log(`  arc capture ${a.id}     — while logged in as that subscription`);
    }
  }
  console.log('  arc                   — launch');
  rl.close();
}

main().catch((e) => { console.error('setup failed:', e.message); process.exit(1); });
