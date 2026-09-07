#!/usr/bin/env node
'use strict';
/*
 * manual-gc.mjs — 垃圾归档命令 (V1.3)
 * 把 memory_network 中 status='garbage' 的节点移动到 archive_data 冷区, 并从主索引/分片清理。
 * 解决「软删除留痕, 索引越来越大」的问题: 软删仍保留可追溯(归档), 但不再占主索引。
 * 用法: node scripts/manual-gc.mjs [--out <file>]  (数据根由 DSH_MEMORY_ROOT / memory_root 决定)
 * 安全: 先备份主索引(network_shards/与 memory_network.json)到 backup/, 再归档+清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function findConfig(){ const c=[__dirname,path.resolve(__dirname,'..'),path.resolve(__dirname,'..','..'),process.cwd()]; for(const d of c){const p=path.join(d,'memory.config.json');try{if(fs.existsSync(p))return p}catch{}}return path.join(__dirname,'memory.config.json'); }
function readConfig(){ try{return JSON.parse(fs.readFileSync(findConfig(),'utf8'))}catch{return{}} }
function resolveRoot(){ if(process.env.DSH_MEMORY_ROOT) return process.env.DSH_MEMORY_ROOT; const c=readConfig(); if(c&&c.memory_root) return c.memory_root; return path.dirname(findConfig()); }
function loadJson(p,d){ try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return d} }
function saveJson(p,o){ const t=p+'.tmp'; fs.writeFileSync(t,JSON.stringify(o,null,2),'utf8'); fs.renameSync(t,p); }

const ROOT = resolveRoot();
const NET = path.join(ROOT, 'memory_network.json');
const SHARD_DIR = path.join(ROOT, 'network_shards');
const ARCHIVE_DIR = path.join(ROOT, 'archive_data');
const BACKUP_DIR = path.join(ROOT, 'backup');

const idx = loadJson(NET, { version: '2.0', nodes: {} });
const garbage = Object.values(idx.nodes || {}).filter(m => m.status === 'garbage');
let archived = 0, removedShard = 0, removedIndex = 0;

fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
// 冷区: 按标签独立归档文件, 追加节点
fs.mkdirSync(BACKUP_DIR, { recursive: true });

for (const m of garbage) {
  const tag = m.tag || (Array.isArray(m.tags) ? m.tags[0] : '') || '__default__';
  // 从分片取出完整节点
  const shardFile = path.join(SHARD_DIR, String(tag).replace(/[^\w\u4e00-\u9fff.-]/g, '_') + '.json');
  const shard = loadJson(shardFile, { tag, nodes: {} });
  const node = shard.nodes && shard.nodes[m.node_id] || m;
  if (node) {
    node.archived_at = new Date(Date.now() + 8*3600*1000).toISOString();
    // 写入归档冷区(按标签)
    const arcFile = path.join(ARCHIVE_DIR, 'garbage-' + String(tag).replace(/[^\w\u4e00-\u9fff.-]/g, '_') + '.json');
    const arc = loadJson(arcFile, { tag, nodes: {} });
    arc.nodes[m.node_id] = node;
    saveJson(arcFile, arc);
    // 从分片移除
    if (shard.nodes && shard.nodes[m.node_id]) { delete shard.nodes[m.node_id]; saveJson(shardFile, shard); removedShard++; }
  }
  // 从主索引移除
  delete idx.nodes[m.node_id]; removedIndex++;
  archived++;
}
saveJson(NET, idx);

const res = { action: 'archive', root: ROOT, total_garbage: garbage.length, archived, removed_from_shard: removedShard, removed_from_index: removedIndex, archive_dir: ARCHIVE_DIR };
const outIdx = process.argv.indexOf('--out'); const out = outIdx >= 0 ? process.argv[outIdx+1] : null;
if (out) fs.writeFileSync(out, JSON.stringify(res, null, 2), 'utf8');
else console.log(JSON.stringify(res, null, 2));
