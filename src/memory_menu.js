#!/usr/bin/env node
'use strict';
/* memory_menu.js — 菜单选读模块 (V1.3) — CommonJS, 兼容 Node 18 与 require() */
const fs = require('fs');
const path = require('path');

const TOKEN_BUDGET = 270;
const SAFE_CHARS = Math.floor(TOKEN_BUDGET * 0.9); // 243
const PER_TAG = 3;
const PER_ENTRY = 46;
const PRIORITY_LABEL = { 1: '⚠', 0: '' };

function findConfig() {
  const c = [__dirname, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..'), process.cwd()];
  for (const d of c) { const p = path.join(d, 'memory.config.json'); try { if (fs.existsSync(p)) return p; } catch { } }
  return path.join(__dirname, 'memory.config.json');
}
function readConfig() { try { return JSON.parse(fs.readFileSync(findConfig(), 'utf8')); } catch { return {}; } }
function resolveRoot() {
  if (process.env.DSH_MEMORY_ROOT) return process.env.DSH_MEMORY_ROOT;
  const c = readConfig(); if (c && c.memory_root) return c.memory_root;
  return path.dirname(findConfig());
}
function renderMenu(root, cfgOverride) {
  const cfg = cfgOverride || readConfig();
  const mode = String((cfg.dual_track && cfg.dual_track.router && cfg.dual_track.router.menu_mode) || 'menu').toLowerCase() === 'full' ? 'full_injection' : 'menu';
  const payload = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'summary_index.json'), 'utf8')); } catch { return null; } })();
  if (!payload || !payload.tags) { const empty = '[memory-menu] 记忆库为空。'; return { text: empty, mode, count: 0, tokens: Math.ceil(empty.length * 0.6) }; }
  let items = [];
  for (const tag of Object.keys(payload.tags)) { const arr = Array.isArray(payload.tags[tag]) ? payload.tags[tag] : []; for (const it of arr) items.push({ tag, ts: String(it.ts || '').slice(0, 10), summary: String(it.summary || ''), menu_priority: Number(it.menu_priority) || 0 }); }
  if (mode === 'full_injection') {
    const all = items.slice().sort((a, b) => (b.menu_priority - a.menu_priority) || (b.ts > a.ts ? 1 : -1));
    const lines = ['[memory-menu] 记忆索引(全量注入):'];
    for (const it of all) lines.push(`- [${it.tag}] ${PRIORITY_LABEL[it.menu_priority] || ''}${it.ts} ${it.summary}`.trim());
    const text = lines.join('\n'); return { text, mode, count: all.length, tokens: Math.ceil(text.length * 0.6) };
  }
  const byPriority = items.slice().sort((a, b) => (b.menu_priority - a.menu_priority) || (b.ts > a.ts ? 1 : -1));
  const perTagCount = {}; const picked = []; let chars = 0;
  for (const it of byPriority) {
    const n = perTagCount[it.tag] || 0; if (n >= PER_TAG) continue;
    const shortSum = it.summary.length > PER_ENTRY ? it.summary.slice(0, PER_ENTRY) + '…' : it.summary;
    const line = `- [${it.tag}] ${PRIORITY_LABEL[it.menu_priority] || ''}${it.ts} ${shortSum}`.trim();
    if (chars + line.length > SAFE_CHARS && picked.length > 0) continue;
    picked.push(line); perTagCount[it.tag] = n + 1; chars += line.length + 1;
    if (chars >= SAFE_CHARS) break;
  }
  const text = ['[memory-menu] 记忆菜单(共' + picked.length + '条, 按痛点优先):', ...picked].join('\n');
  return { text, mode, count: picked.length, tokens: Math.ceil(text.length * 0.6), budget: TOKEN_BUDGET, safe_chars: SAFE_CHARS };
}
module.exports = { renderMenu, resolveRoot };

if (require.main === module) {
  const modeArg = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : null;
  var cfg = readConfig(); if (modeArg) { cfg.dual_track = cfg.dual_track || {}; cfg.dual_track.router = cfg.dual_track.router || {}; cfg.dual_track.router.menu_mode = (String(modeArg).toLowerCase() === 'full' ? 'full' : 'menu'); }
  const res = renderMenu(resolveRoot(), cfg);
  const outIdx = process.argv.indexOf('--out'); const out = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  if (out) fs.writeFileSync(out, res.text, 'utf8');
  else console.log(JSON.stringify({ mode: res.mode, count: res.count, tokens: res.tokens, budget: res.budget, text: res.text }, null, 2));
}
