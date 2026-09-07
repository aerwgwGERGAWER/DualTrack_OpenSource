#!/usr/bin/env node
'use strict';
/*
 * ollama_triage.cjs — 分诊脑 HTTP 调用助手 (Qwen/dualtrack-triage)
 *
 * 用法: node ollama_triage.cjs <text> <outFile> [model]
 *   - 向本机 Ollama HTTP API (/api/generate, stream:false) 发请求
 *   - 只输出一个词 (net / exp), 写入 outFile; 全程 stdout 干净 (适配沙箱 stdio:'ignore')
 *   - 失败/超时写 {"error": ...}  到 outFile, exit 0 (上层自行兜底)
 *
 * 设计原因: execFileSync 捕获子进程 stdout 在 DSH 沙箱下会 EPERM, 故用文件输出。
 */
const fs = require('fs');
const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.OLLAMA_PORT || 11434);

const text = String(process.argv[2] || '');
const outFile = process.argv[3] || '';
const model = String(process.argv[4] || 'dualtrack-triage');

function fail(code, err) {
  try { fs.writeFileSync(outFile, JSON.stringify({ error: String(err), code }), 'utf8'); } catch { }
  process.exit(0);
}

if (outFile) { try { fs.writeFileSync(outFile, ''); } catch { } }

const body = JSON.stringify({
  model,
  prompt: text.slice(0, 800),
  stream: false,
  options: { temperature: 0 },
  keep_alive: '2m',
});

const req = http.request({
  host: HOST, port: PORT, path: '/api/generate', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  timeout: 60000,
}, (res) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    try {
      const j = JSON.parse(data);
      const r = String(j.response || '').trim().toLowerCase();
      // 取第一个 net/exp/skip 词, 避免解释噪声
      const m = r.match(/\b(net|exp|skip)\b/);
      const cls = m ? m[1] : (r.includes('skip') ? 'skip' : (r.includes('exp') ? 'exp' : (r.includes('net') ? 'net' : '')));
      if (!cls) return fail('EMPTY', 'no net/exp/skip in response: ' + r.slice(0, 60));
      try { fs.writeFileSync(outFile, JSON.stringify({ classify: cls, raw: r.slice(0, 40) }), 'utf8'); } catch { }
      process.exit(0);
    } catch (e) { return fail('PARSE', e.message); }
  });
});
req.on('timeout', () => { req.destroy(); fail('TIMEOUT', 'ollama HTTP timeout'); });
req.on('error', (e) => { fail('HTTP', e.message); });
req.write(body);
req.end();
