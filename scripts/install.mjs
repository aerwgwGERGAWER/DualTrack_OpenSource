#!/usr/bin/env node
'use strict';
/*
 * scripts/install.mjs — 一键自动安装 DualTrack Memory (V1.2, triage_brain 隔离版)
 * 用法: node scripts/install.mjs [数据根目录]
 *   不传参 -> 数据根 = 仓库根; 传参 -> 数据根 = 你指定的目录。
 * 会: 生成/更新 <数据根>/memory.config.json -> 校验 Node>=18 -> 跑 stats 自检。
 *
 * 外部小模型管家(分诊脑) 严格按 triage_brain 隔离:
 *   基础模式 (triage_brain=hash, 默认):
 *     完全干净、零依赖、纯本地——不生成、不复制、不注册任何 butler-supervisor.mjs / .cmd。
 *   高级模式 (triage_brain=qwen 或 bge):
 *     自动把 butler-supervisor.mjs + 启动分诊脑.cmd + 停止分诊脑.cmd 复制到数据根,
 *     在配置中写入使用说明(需先装 Ollama 并拉模型), 并生成 README_BUTLER.txt。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function log(m) { console.log('[install] ' + m); }
function err(m) { console.error('[install][ERR] ' + m); }

// ---------- 1) Node 版本 ----------
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) { err('Node.js >= 18 required, current ' + process.version); process.exit(1); }
log('Node ' + process.version + ' OK');

// ---------- 2) 数据根 ----------
const dataRoot = process.argv[2] || ROOT;
log('memory_root = ' + dataRoot);
fs.mkdirSync(dataRoot, { recursive: true });

// ---------- 3) 配置(位于数据根, 扁平部署) ----------
const cfgPath = path.join(dataRoot, 'memory.config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* 缺失/损坏 -> 用默认 */ }
cfg = Object.assign({}, cfg, { memory_root: dataRoot });
if (!cfg.dual_track) cfg.dual_track = {};
if (!cfg.dual_track.router) cfg.dual_track.router = {};
if (!cfg.scoring) cfg.scoring = {};
const triage = String(cfg.dual_track.router.triage_brain || 'hash').toLowerCase();
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
log('配置就绪: ' + cfgPath + '  (memory_root=' + dataRoot + ', triage_brain=' + triage + ')');

// ---------- 4) 外部小模型管家: 按 triage_brain 隔离 ----------
// 复制清单: 指向仓库各处的管家模板, 复制到数据根(数据根=引擎/配置/管家同目录, 引擎才能在 __dirname 找到 ollama_triage.cjs)。
const BUTLER_FILES = [
  { rel: 'scripts/butler-supervisor.mjs', dest: 'butler-supervisor.mjs' },
  { rel: 'scripts/启动分诊脑.cmd', dest: '启动分诊脑.cmd' },
  { rel: 'scripts/停止分诊脑.cmd', dest: '停止分诊脑.cmd' },
  { rel: 'src/ollama_triage.cjs', dest: 'ollama_triage.cjs' },       // 引擎 qwenTriageSync 需要的 HTTP 分诊助手
];
const butlerSrcAll = BUTLER_FILES.every(f => fs.existsSync(path.join(ROOT, f.rel)));

if (triage === 'qwen' || triage === 'bge') {
  if (!butlerSrcAll) {
    log('triage_brain=' + triage + ' 为高级模式, 但未检测到管家模板(scripts/src 缺失)。');
    log('请先安装 dsh-butler-extension-v1.2.zip, 其内含 butler-supervisor.mjs / 启动分诊脑.cmd / 停止分诊脑.cmd / ollama_triage.cjs 与详细说明 BUTLER_INSTALL.md, 按说明放位后重试。');
  } else {
    for (const f of BUTLER_FILES) fs.copyFileSync(path.join(ROOT, f.rel), path.join(dataRoot, f.dest));
    log('已复制管家文件到 ' + dataRoot + ': ' + BUTLER_FILES.map(f => f.dest).join(', '));
    // 写入使用说明到配置(告知需先装 Ollama + 拉模型, 并说明如何开启/关闭守护)
    cfg.dual_track.router._butler_note =
      '高级模型模式(triage_brain=' + triage + '): 需先安装 Ollama(https://ollama.com) 并以 `ollama pull` 拉取模型(如 qwen3:1.7b)。' +
      '然后双击 ' + dataRoot + '\\启动分诊脑.cmd 开启守护(仅 EAC 运行时启用小模型); 关闭请双击 停止分诊脑.cmd。详见 README_BUTLER.txt。';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    // 生成 README_BUTLER.txt
    const readme = [
      'DualTrack Memory 外部小模型管家(分诊脑) — 使用说明',
      '==================================================',
      '',
      '本扩展包为你提供了"仅 EAC 运行时才启用小模型"的生命周期守护。',
      '',
      '前置条件(必须手动完成一次):',
      '  1) 安装 Ollama: https://ollama.com 下载安装即可。',
      '  2) 拉取分诊模型: ollama pull qwen3:1.7b  (可在 memory.config.json 的',
      '     dual_track.router.triage_model 改模型名)。',
      '  3) 在 memory.config.json 设 dual_track.router.triage_brain = "qwen"。',
      '',
      '启用(开启守护):',
      '  双击 启动分诊脑.cmd —— 若无窗口(隐藏)后台运行, 它会:',
      '     · 持续监测 EAC 桌面客户端(dsh-eac-shell.exe);',
      '     · EAC 在运行 -> 自动拉起 ollama serve(小模型可用);',
      '     · EAC 关闭   -> 自动停掉 ollama; 连续关闭超过宽限期则守护自我退出(不留僵尸)。',
      '',
      '关闭(手动停止守护):',
      '  双击 停止分诊脑.cmd —— 干净退出并清理进程。',
      '',
      '注意事项:',
      '  · 若 config 里 triage_brain 为 hash(默认), 双击启动脚本会提示"当前为哈希模式, 无需启动"并退出。',
      '  · 守护采用单实例锁, 重复双击只保留一个进程, 不会堆积。',
      '  · 开机自启可选: 把 启动分诊脑.cmd 的快捷方式(或隐藏版 .vbs)放入"启动"文件夹, 登录即自动后台盯守。',
      '',
      '版本: v1.2  ·  若你的杀毒软件对隐藏 PowerShell 误报, 见 docs/AI_INSTALL.md 的《杀毒软件拦截提醒》。',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(dataRoot, 'README_BUTLER.txt'), readme, 'utf8');
    log('已生成 README_BUTLER.txt 并写入配置使用说明。');
  }
} else if (triage === 'hash') {
  log('triage_brain=hash 基础模式: 未生成任何 Ollama/管家文件, 保持干净、零依赖、纯本地。');
} else {
  log('未知 triage_brain=' + triage + ', 按基础模式处理(干净, 未生成管家文件)。');
}

// ---------- 5) 自检 stats ----------
const engine = fs.existsSync(path.join(dataRoot, 'memory_dual.js'))
  ? path.join(dataRoot, 'memory_dual.js')                       // 扁平运行时(引擎/配置在同一目录)
  : path.join(ROOT, 'src', 'memory_dual.js');                   // 仓库结构
if (!fs.existsSync(engine)) { err('找不到引擎 memory_dual.js'); process.exit(1); }
try {
  const out = execFileSync(process.execPath, [engine, 'stats'], { encoding: 'utf8', env: { ...process.env, DSH_MEMORY_ROOT: dataRoot } });
  log('自检 stats:');
  console.log(out.trim());
} catch (e) {
  err('自检失败: ' + (e && e.message || e));
  process.exit(1);
}
log('安装完成。请把本仓库连同 docs/AI_INSTALL.md 交给你的 AI 助手做进一步排错/接入。');
