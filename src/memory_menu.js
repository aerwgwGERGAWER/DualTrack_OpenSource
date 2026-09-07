#!/usr/bin/env node
'use strict';
/*
 * memory_menu.js — 菜单选读模块 (V1.3)
 * 生成供每次提示词注入的「记忆菜单」，替代旧的"全量导航注入"，压缩上下文占用。
 * - 读取 <数据根>/summary_index.json 的 tags -> 最近摘要；
 * - 按 menu_priority(痛点优先级, 0/1) 降序排列 + 每标签只取最近 3 条；
 * - Token 上限严格控制在 270 以内(按 CJK≈1字/token 保守估算，预留 10% 安全余量 -> 实际按 ~243 字截断，留 27 余量)；
 * - menu_mode: menu(默认) | full_injection(紧急回滚，老式全量注入，不截断)。
 * 用法: node src/memory_menu.js [--mode menu|full] [--out <file>]
 *       也可 require 调用 renderMenu(cfg)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 理论最低极限: token 预算。270 上限, 预留 10% -> 实际字符预算约 243。
const TOKEN_BUDGET = 270;
const SAFE_CHARS = Math.floor(TOKEN_BUDGET * 0.9); // 243
const PER_TAG = 3;                                 // 每标签最多取 3 条
const PER_ENTRY = 46;                              // 单条摘要最长(容纳更多条, 保总预算)
const PRIORITY_LABEL = { 1: '⚠', 0: '' };          // menu_priority=1 -> 重点待办标记

function findConfig() {
  const cands = [__dirname, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..'), process.cwd()];
  for (const d of cands) { const p = path.join(d, 'memory.config.json'); try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return path.join(__dirname, 'memory.config.json');
}
function readConfig() { try { return JSON.parse(fs.readFileSync(findConfig(), 'utf8')); } catch { return {}; } }
function resolveRoot() {
  if (process.env.DSH_MEMORY_ROOT) return process.env.DSH_MEMORY_ROOT;
  const c = readConfig(); if (c && c.memory_root) return c.memory_root;
  return path.dirname(findConfig());
}

// 生成菜单字符串
export function renderMenu(root, cfgOverride) {
  const cfg = cfgOverride || readConfig();
  const mode = String((cfg.dual_track && cfg.dual_track.router && cfg.dual_track.router.menu_mode) || 'menu').toLowerCase() === 'full' ? 'full_injection' : 'menu';
  const sumPath = path.join(root, 'summary_index.json');
  const payload = (() => { try { return JSON.parse(fs.readFileSync(sumPath, 'utf8')); } catch { return null; } })();
  if (!payload || !payload.tags) { const empty = '[memory-menu] 记忆库为空。'; return { text: empty, mode, count: 0, tokens: Math.ceil(empty.length * 0.6) }; }
  // 收集所有条目: {tag, ts, summary, menu_priority}
  let items = [];
  for (const tag of Object.keys(payload.tags)) {
    const arr = Array.isArray(payload.tags[tag]) ? payload.tags[tag] : [];
    for (const it of arr) items.push({ tag, ts: String(it.ts || '').slice(0, 10), summary: String(it.summary || ''), menu_priority: Number(it.menu_priority) || 0 });
  }
  if (mode === 'full_injection') {
    // 老式全量注入: 不截断、不限制条数(仍按优先级+时间排序)
    const all = items.slice().sort((a, b) => (b.menu_priority - a.menu_priority) || (b.ts > a.ts ? 1 : -1));
    const lines = ['[memory-menu] 记忆索引(全量注入):'];
    for (const it of all) lines.push(`- [${it.tag}] ${PRIORITY_LABEL[it.menu_priority] || ''}${it.ts} ${it.summary}`.trim());
    const text = lines.join('\n');
    return { text, mode, count: all.length, tokens: Math.ceil(text.length * 0.6) };
  }
  // menu 模式: 按优先级降序, 每标签限 PER_TAG 条, 字符预算 SAFE_CHARS。
  const byPriority = items.slice().sort((a, b) => (b.menu_priority - a.menu_priority) || (b.ts > a.ts ? 1 : -1));
  const perTagCount = {};
  const picked = [];
  let chars = 0;
  for (const it of byPriority) {
    const n = perTagCount[it.tag] || 0;
    if (n >= PER_TAG) continue;
    const shortSum = it.summary.length > PER_ENTRY ? it.summary.slice(0, PER_ENTRY) + '…' : it.summary;
    const line = `- [${it.tag}] ${PRIORITY_LABEL[it.menu_priority] || ''}${it.ts} ${shortSum}`.trim();
    if (chars + line.length > SAFE_CHARS && picked.length > 0) continue; // 超出预算则不再加(至少保留首条)
    picked.push(line); perTagCount[it.tag] = n + 1; chars += line.length + 1;
    if (chars >= SAFE_CHARS) break;
  }
  const header = `[memory-menu] 记忆菜单(共${picked.length}条, 按痛点优先):`;
  const text = [header, ...picked].join('\n');
  return { text, mode, count: picked.length, tokens: Math.ceil(text.length * 0.6), budget: TOKEN_BUDGET, safe_chars: SAFE_CHARS };
}

// CLI
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const modeArg = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : null;
  var cfg = readConfig(); if (modeArg) { cfg.dual_track = cfg.dual_track || {}; cfg.dual_track.router = cfg.dual_track.router || {}; cfg.dual_track.router.menu_mode = (String(modeArg).toLowerCase() === 'full' ? 'full' : 'menu'); }
  const res = renderMenu(resolveRoot(), cfg);
  const outIdx = process.argv.indexOf('--out'); const out = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  if (out) { fs.writeFileSync(out, res.text, 'utf8'); }
  else { console.log(JSON.stringify({ mode: res.mode, count: res.count, tokens: res.tokens, budget: res.budget, text: res.text }, null, 2)); }
}
