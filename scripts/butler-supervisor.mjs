#!/usr/bin/env node
'use strict';
/*
 * butler-supervisor.mjs — 小模型管家生命周期守护 (防僵尸版)
 * 目标: 小模型(Ollama qwen3 分诊脑) 只在 EAC(DHS Desktop) 运行时启用; EAC 关闭则关闭。
 * 方式: 持续监测 EAC 壳进程 dsh-eac-shell.exe:
 *   EAC 在   -> 确保 `ollama serve` 在跑(不在则启动);
 *   EAC 不在 -> 停掉 ollama 并(超过宽限期后)本哨兵自动退出, 绝不留僵尸。
 *
 * 防僵尸保障:
 *   1) 单实例: 重复启动(重复双击)自动让新实例退出, 只保留一个;
 *   2) 停止标记: 在 BASE 目录放一个 .butler.stop 文件即干净退出;
 *   3) 宽限自救: EAC 连续关闭超过 BUTLER_QUIT_AFTER_EAC_DOWN_SEC(默认1800s) 哨兵自杀;
 *   4) 信号/退出清理: 重写并删除自己的 .butler.pid;
 *   5) 手动停止: 配套 停止分诊脑.cmd 通过 .butler.stop 优雅退出。
 *
 * 用法: node butler-supervisor.mjs [--poll-ms 5000] [--assume-down] [--dry-run]
 *       环境变量: BUTLER_QUIT_AFTER_EAC_DOWN_SEC / BUTLER_BASE / BUTLER_NODE
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BUTLER_BASE || __dirname;
const PID_FILE = path.join(BASE, '.butler.pid');
const STOP_FILE = path.join(BASE, '.butler.stop');

const POLL_MS = Number(process.argv.find(a => a === '--poll-ms') ? process.argv[process.argv.indexOf('--poll-ms') + 1] : 5000) || 5000;
const ASSUME_DOWN = process.argv.includes('--assume-down');
const DRY_RUN = process.argv.includes('--dry-run');
const QUIT_AFTER_SEC = Number(process.env.BUTLER_QUIT_AFTER_EAC_DOWN_SEC || 1800) || 1800;

// ---------- --check: 只输出 triage_brain (供 .cmd 门控探测, 批处理安全) ----------
if (process.argv.includes('--check')) {
  const cfgArg = process.argv[process.argv.indexOf('--check') + 1] || path.join(BASE, 'memory.config.json');
  let outVal = 'hash';
  try {
    const c = JSON.parse(fs.readFileSync(cfgArg, 'utf8'));
    const r = (c.dual_track && c.dual_track.router) || {};
    outVal = String(r.triage_brain || r.embedding_provider || 'hash').toLowerCase();
  } catch { }
  process.stdout.write(outVal);
  process.exit(0);
}

function sh(cmd) { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }); } catch { return ''; } }
function eacRunning() {
  // EAC 唯一权威信号 = 壳进程 dsh-eac-shell.exe; 只有它退出才算 EAC 未运行。
  try { const shell = sh("Get-Process 'dsh-eac-shell' -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"); return /[1-9]/.test(shell || ''); } catch { return false; }
}
function ollamaServing() {
  // 用 Count(纯数字)判断 11434 是否监听。
  try { const c = sh("Get-NetTCPConnection -State Listen -LocalPort 11434 -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"); return /[1-9]/.test(c || ''); } catch { return false; }
}
const ollamaBin = process.env.OLLAMA_BIN || path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe');

// ---------- triage_brain 门控: 仅 qwen 激活 ----------
// 管家只在 memory.config.json 的 dual_track.router.triage_brain=='qwen' 时被激活;
// hash(纯本地零依赖) 或 bge(语义嵌入) 时无需管家, 直接退出, 避免误启动。
function readButlerConfig() { try { return JSON.parse(fs.readFileSync(path.join(BASE, 'memory.config.json'), 'utf8')); } catch { return {}; } }
function butlerTriageBrain() {
  const c = readButlerConfig();
  const r = (c.dual_track && c.dual_track.router) || {};
  return String(r.triage_brain || r.embedding_provider || 'hash').toLowerCase();
}
function butlerGate() {
  const tb = butlerTriageBrain();
  if (tb === 'qwen') { console.log('[butler] triage_brain=qwen, 小模型管家激活'); return true; }
  const note = tb === 'bge' ? '当前为 bge 语义嵌入模式, 管家(小模型分诊)未启用' : '当前为哈希模式, 无需启动';
  console.log('[butler] ' + note + ' (memory.config.json triage_brain=' + tb + '), 退出。');
  return false;
}

// ---------- 单实例锁 + 库存清理 ----------
function pidAlive(pid) { try { const n = sh(`Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count`); return /[1-9]/.test(n || ''); } catch { return false; } }
function singleInstanceGuard() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = Number(String(fs.readFileSync(PID_FILE, 'utf8')).trim());
      if (pid && pid !== process.pid && pidAlive(pid)) {
        console.log(`[butler] 已有实例(PID ${pid}) 在运行, 本次退出(防重复/防僵尸)`);
        process.exit(0);
      }
      // 陈旧 pid(进程已不在) -> 接管
      try { fs.rmSync(PID_FILE, { force: true }); } catch { }
    }
  } catch { }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}
function cleanExit(code) { try { fs.rmSync(PID_FILE, { force: true }); } catch { } process.exit(code || 0); }
process.on('exit', () => { try { fs.rmSync(PID_FILE, { force: true }); } catch { } });
process.on('SIGINT', () => cleanExit(0));
process.on('SIGTERM', () => cleanExit(0));

// ---------- 主循环 ----------
let state = 'idle';
let eacDownSince = null;
function loop() {
  try {
    // 停止标记 -> 干净退出
    if (fs.existsSync(STOP_FILE)) { console.log('[butler] 检测到停止标记 .butler.stop, 干净退出'); return cleanExit(0); }
    const up = ASSUME_DOWN ? false : eacRunning();
    if (up) {
      eacDownSince = null;
      if (!ollamaServing()) {
        if (DRY_RUN) { console.log('[butler:dry] 将拉起 ollama serve'); }
        else { try { spawn(ollamaBin, ['serve'], { detached: true, stdio: 'ignore' }).unref(); } catch { } }
        console.log('[butler] EAC 运行中, 已拉起 ollama serve');
      }
      if (state !== 'on') { console.log('[butler] EAC 运行 -> 小模型启用'); state = 'on'; }
    } else {
      if (ollamaServing()) {
        if (DRY_RUN) { console.log('[butler:dry] 将停止 ollama.exe / ollama_llama_server.exe'); }
        else {
          try { spawnSync('taskkill', ['/F', '/T', '/IM', 'ollama.exe'], { stdio: 'ignore' }); } catch { }
          try { spawnSync('taskkill', ['/F', '/T', '/IM', 'ollama_llama_server.exe'], { stdio: 'ignore' }); } catch { }
        }
        console.log('[butler] EAC 未运行, 已停止小模型');
      }
      if (state !== 'off') { console.log('[butler] EAC 关闭 -> 小模型关闭'); state = 'off'; }
      // 宽限自救: EAC 连续关闭超时 -> 哨兵自动退出(不留僵尸)
      if (eacDownSince === null) eacDownSince = Date.now();
      const downSec = (Date.now() - eacDownSince) / 1000;
      if (downSec >= QUIT_AFTER_SEC) { console.log(`[butler] EAC 已关闭 ${Math.floor(downSec)}s >= ${QUIT_AFTER_SEC}s, 哨兵自动退出(不留僵尸)`); return cleanExit(0); }
    }
  } catch (e) { console.error('[butler] err ' + (e && e.message)); }
  setTimeout(loop, POLL_MS);
}
console.log(`[butler] 启动 poll=${POLL_MS}ms, quitAfterEacDown=${QUIT_AFTER_SEC}s, base=${BASE}`);
if (!butlerGate()) process.exit(0);   // 非 qwen -> 退出, 绝不注册/写 pid
singleInstanceGuard();
loop();
