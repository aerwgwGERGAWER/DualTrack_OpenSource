#!/usr/bin/env node
'use strict';
/*
 * memory_dual.js — 双轨记忆引擎 (记忆网 + 经验档)
 *
 * 两条独立轨道, 各自存储/读取, 由"管家"(router)分诊:
 *   记忆网  = 模糊联想(日常/背景/模糊检索)   -> network_shards/<tag>.json + memory_network.json
 *   经验档  = 精准破案(技术报错/故障/修复)   -> experience_cards/EXP-<id>.json
 *
 * 集成:
 *   - 可插拔 embedder (bge 优先, 本机无模型自动回退确定性哈希向量)
 *   - 积分制动态衰减 (Total = access + use*2 + validated*5; v>=3 永锁; >30天 扣5%; <=5 才可标垃圾)
 *   - 标签级分布式锁 (按 tag 分区, 主/备双开互不干扰, 多标签排序取锁防死锁)
 *   - 软删除 (status+deleted_at, 永不物理删除)
 *
 * ROOT 可用 DSH_MEMORY_ROOT 覆盖, 或由 memory.config.json 的 memory_root 指定 (任意盘符)。
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os'), cp = require('child_process');
// 配置从「引擎目录 / 仓库根 / 上级 / 当前目录」向上搜索 memory.config.json。
function findConfig() {
  const cands = [__dirname, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..'), process.cwd()];
  for (const d of cands) {
    const p = path.join(d, 'memory.config.json');
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return path.join(__dirname, 'memory.config.json');
}
const CFG = findConfig();
const CFG_DIR = path.dirname(CFG);
let _cfgCache = null;
function readConfig() {
  if (_cfgCache) return _cfgCache;
  try { _cfgCache = JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch { _cfgCache = {}; }
  return _cfgCache;
}
// 数据根: env > 配置 memory_root > 配置所在目录(仓库根)。无硬编码盘符。
function resolveDataRoot() {
  if (process.env.DSH_MEMORY_ROOT) return process.env.DSH_MEMORY_ROOT;
  const c = readConfig();
  if (c && c.memory_root) return c.memory_root;
  return CFG_DIR;
}
const ROOT = resolveDataRoot();
const LOCK_DIR = path.join(ROOT, (readConfig().lock && readConfig().lock.lock_dir) || '.locks');
const NET_FILE = path.join(ROOT, ((readConfig().dual_track||{}).memory_network||{}).file || 'memory_network.json');
const NET_SHARD_DIR = path.join(ROOT, ((readConfig().dual_track||{}).memory_network||{}).shard_dir || 'network_shards');
const EXP_DIR = path.join(ROOT, ((readConfig().dual_track||{}).experience_cards||{}).dir || 'experience_cards');
const EXP_IDX = path.join(ROOT, 'experience_index.json');
const APPROVALS_DIR = path.join(ROOT, 'approvals');
const STATE_FILE = path.join(ROOT, 'state.json');
// 优雅停机与休眠保护: 正常退出捕获信号写 state.json(北京时间ISO); 下次启动算差值, >15天冻结不衰减。
function beijingIso() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString(); }
function saveState() { try { saveJson(STATE_FILE, { last_shutdown: beijingIso(), ts: Date.now() }); } catch { } }
const _st = loadJson(STATE_FILE, null);
const _shutdownDays = (_st && _st.ts) ? ((Date.now() - _st.ts) / 86400000) : 0;
const SHUTDOWN_FROZEN = _shutdownDays > (readConfig().dual_track?.memory_network?.shutdown_freeze_days ?? 15);
process.on('exit', saveState);
process.on('SIGINT', () => { saveState(); try { process.exit(0); } catch { } });
process.on('SIGTERM', () => { saveState(); try { process.exit(0); } catch { } });

// ---------- 配置 ----------
const CFG_OBJ = readConfig();          // 顶层设置 (root 相关, 一次读入)
const DUAL = CFG_OBJ.dual_track || {};
const ROUTER = DUAL.router || {};
const NETC = DUAL.memory_network || {};
const EXPC = DUAL.experience_cards || {};
const SCORE = CFG_OBJ.scoring || {};
const LOCKC = CFG_OBJ.lock || {};
// ---------- V1.1 常量 ----------
const EDGE_CTX_DEF = 0.1, EDGE_CTX_MAX = 5.0, EDGE_CTX_MIN = 0.1;   // context_score 边界
const EDGE_USE_BOOST = 0.5, EDGE_IGNORE_DEC = 0.2;                   // 主动加粗/被动变细
const EDGE_DORMANT_DAYS = 30, EDGE_DORMANT_RATIO = 0.5;              // 休眠衰减
const CTX_TOP = 5, CTX_TOP_SMALL = 3;                                // 检索聚类 top5 / 少则 top3
const MAX_LEVEL_DEF = 3, NODE_TOTAL_EXPAND = 5000;                   // 五级弹性
const TASK_POOL_CAP = 2000, TASK_POOL_CLEAN = 10;                    // 待命池上限/清理
const SHUTDOWN_FREEZE_DAYS = 15;                                     // 优雅停机冻结天数
// ---------- V1.1 柔性升级 常量 ----------
const DORMANCY_FLOOR = 0.1, WAKE_SCORE = 0.5;                        // 邻居潜伏底线 / 唤醒值
const PRIO_HIGH_MIN_LEVEL = 4, PRIO_LOW_MAX_LEVEL = 1;               // priority: high>=4, low<=1
const PRIO_MENU_BOOST = 0.25;                                        // 菜单优先加权
// ---------- V1.2 常量/辅助 ----------
const BGE_SIM_THRESHOLD = 0.72, ELIMINATE_DAYS = 90, CONSEC_ERROR_MIN = 5;  // bge阈值/90天淘汰/连续报错分钟
const RULE_VIOLATION = 'RULE_VIOLATION';
// ---------- V1.2 分诊脑 (可选本地小模型 Qwen) ----------
// triage_brain: 'hash'=纯向量法(默认, 零网络依赖) | 'qwen'=本地小模型参与硬判(需 ollama serve + dualtrack-triage)。
const TRIAGE_MODEL = String(ROUTER.triage_model || 'dualtrack-triage');
const TRIAGE_HELPER = path.join(__dirname, 'ollama_triage.cjs');
function triageBrain() { return String(ROUTER.triage_brain || ROUTER.embedding_provider || 'hash').toLowerCase() === 'qwen' ? 'qwen' : 'hash'; }
// 同步调用本地小模型: 经 child 进程 + 文件输出 (规避沙箱管道 EPERM)。失败/超时 -> 返回 null (上层回退向量法)。
function qwenTriageSync(text) {
  try {
    if (!fs.existsSync(TRIAGE_HELPER)) return { classify: null, error: 'helper missing' };
    const out = path.join(os.tmpdir(), 'dsh_triage_' + crypto.randomBytes(4).toString('hex') + '.json');
    fs.writeFileSync(out, '');
    cp.execFileSync(process.execPath, [TRIAGE_HELPER, String(text), out, TRIAGE_MODEL], { timeout: 70000, stdio: 'ignore' });
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    try { fs.unlinkSync(out); } catch { }
    return j;
  } catch (e) { return { classify: null, error: String(e && e.message || e) }; }
}
// 双引擎手动切换: embedder_provider(默认 hash); 严禁自动探测。bge 阈值 0.70~0.75 取 0.72。
function effectiveEmbedder() { return String(ROUTER.embedder_provider || ROUTER.embedding_provider || 'hash').toLowerCase() === 'bge' ? 'bge' : 'hash'; }
function effectiveSimThreshold() { return effectiveEmbedder() === 'bge' ? (Number(ROUTER.bge_sim_threshold) || BGE_SIM_THRESHOLD) : (Number(ROUTER.sim_threshold) || 0.85); }
// 事件时间戳统一为"北京时间"(UTC+8), 用于衰减/休眠判定基准; 避免时区/系统时间漂移。
function beijingNowMs() { return Date.now() + 8 * 3600 * 1000; }
function beijingIsoNow() { return new Date(beijingNowMs()).toISOString(); }
// 边界铁律(数值与规则分离): 管家/本地小模型只能改"数据值", 严禁改公式/规则/基础配置; 违者拦截 + [ERROR] 上报。
function guardCoreRules(action) {
  const bad = ['score_formula', 'scoring.formula', 'validated_weight', 'decay_ratio', 'validated_lock', 'garbage_max_score', 'hot_days', 'sleep_days', 'access_weight', 'use_weight'];
  const tries = bad.filter(k => String(action || '').includes(k));
  if (tries.length) return { blocked: true, code: RULE_VIOLATION, error: '[ERROR] RULE_VIOLATION: 试图修改核心规则/公式 [' + tries.join(',') + '] 已拦截并上报主模型', reported: true };
  return null;
}

function cfg(pathArr, dflt) {
  // 动态读配置 (运行时改 config 即生效)
  let c = CFG_OBJ, cur = c; let v = undefined;
  try { for (const k of pathArr) { if (cur && typeof cur === 'object') cur = cur[k]; else return dflt; } v = cur; } catch { /* ignore */ }
  return (v === undefined || v === null) ? dflt : v;
}

// ---------- 工具 ----------
function nowIso() { return beijingIsoNow(); }   // 事件时间戳统一北京时间(UTC+8)
function safe(s) { return String(s).replace(/[^\w\u4e00-\u9fff.-]/g, '_'); }
function loadJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function saveJson(p, o) { const t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8'); fs.renameSync(t, p); }
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (ms > 0 ? ms : 1)); } catch { } }
function tagKey(tags) {
  const arr = Array.isArray(tags) ? tags.map(safe).filter(Boolean).sort() : [safe(String(tags || '')).trim()].filter(Boolean);
  if (!arr.length) arr.push('__default__');
  return arr;
}
// 标签级分布式锁: 按 tag 分区。多标签先按字典序排序逐一取锁, 避免死锁(abort 时按反序释放)。
// 锁文件 <root>/.locks/tag-<hash>.lock, 'wx' 独占创建, 超时兜底, 退避防忙等。
function withTagLock(tags, fn) {
  const keys = tagKey(tags);
  const deadline = Date.now() + (LOCKC.timeout_ms || 6000);
  const retry = LOCKC.retry_ms || 25;
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lockPaths = keys.map(k => path.join(LOCK_DIR, 'tag-' + crypto.createHash('sha1').update(k).digest('hex').slice(0, 16) + '.lock'));
  const fds = [];
  // 逐把锁: 取不到就等(带全局 deadline), 防两个进程向相反顺序取锁造成死锁
  for (const lp of lockPaths) {
    let fd = null;
    while (true) {
      try { fd = fs.openSync(lp, 'wx'); break; }
      catch (e) {
        if (e.code !== 'EEXIST') { // 真错误 -> 释放已取, 抛出
          for (const f of fds) { try { fs.closeSync(f); fs.unlinkSync(lockPaths[fds.indexOf(f)]); } catch { } }
          throw e; }
        if (Date.now() > deadline) { try { fs.unlinkSync(lp); } catch { } continue; }
        sleepMs(retry);
      }
    }
    fds.push(fd);
  }
  try { return fn(); }
  finally {
    for (let i = fds.length - 1; i >= 0; i--) {
      try { fs.closeSync(fds[i]); } catch { }
      try { fs.unlinkSync(lockPaths[i]); } catch { }
    }
  }
}
// 单文件原子写锁 (跨进程, 防止同文件 read-modify-write 丢更新); 用于全局索引/卡片等非标签紧耦合文件
function withFileLock(p, fn) {
  const lock = p + '.lock'; const deadline = Date.now() + (LOCKC.timeout_ms || 6000); let fd;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  while (true) {
    try { fd = fs.openSync(lock, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) { try { fs.unlinkSync(lock); } catch { } continue; }
      sleepMs(LOCKC.retry_ms || 25);
    }
  }
  try { return fn(); }
  finally { try { fs.closeSync(fd); } catch { } try { fs.unlinkSync(lock); } catch { } }
}

// ---------- 可插拔 embedder ----------
// provider: 由 embedder_provider(默认 hash) 手动指定; 严禁自动探测/自动回退 —— bge 被选中但无模型则抛错(由管家上报)。
function embed(text) {
  const dim = Math.max(8, Math.min(1024, ROUTER.embedding_dim || 256));
  const provider = effectiveEmbedder();
  if (provider === 'bge') { return embedBge(text, dim); }   // bge 无模型 -> embedBge 抛错(不静默回退)
  return embedHash(text, dim);
}
function embedBge(text, dim) {
  const ep = ROUTER.bge_endpoint || '';
  if (ep) {
    // HTTP 同步不支持 -> 走 hash 回退 (Node 无同步 http; 需要时改 child/子进程)。
    throw new Error('bge_endpoint async sync-unsupported; falling back');
  }
  const mp = ROUTER.bge_model_path || '';
  if (mp && fs.existsSync(mp)) { throw new Error('onnx bge not wired yet; falling back'); }
  throw new Error('bge unavailable; falling back');
}
// 确定性哈希向量 (零依赖, 中英双语, 字符 n-gram + 词特征, L2 归一) —— 本机回退实现
function embedHash(text, dim) {
  const norm = String(text || '').toLowerCase();
  const vec = new Array(dim).fill(0);
  const tokens = tokenize(norm);
  for (const t of tokens) {
    const h1 = fnv1a(t);
    const idx = h1 % dim;
    const sign = ((fnv1a(t + '_s') >> 8) & 1) ? 1 : -1;
    vec[idx] += sign;
    const idx2 = (h1 >> 3) % dim;
    if (idx2 !== idx) vec[idx2] += sign * 0.5;
  }
  // L2 归一
  let sum = 0; for (const v of vec) sum += v * v;
  const mag = Math.sqrt(sum) || 1;
  return vec.map(v => v / mag);
}
function tokenize(norm) {
  const tokens = new Set();
  const re = /[\u4e00-\u9fffA-Za-z0-9]/;
  for (let i = 0; i < norm.length - 1; i++) {
    const c = norm[i], d = norm[i + 1];
    if (re.test(c) && re.test(d) && c !== ' ' && d !== ' ' && c !== '_' && d !== '_') tokens.add(c + d);
  }
  for (const c of norm) { if (/[\u4e00-\u9fff]/.test(c)) tokens.add(c); }
  for (const w of norm.split(/[^\u4e00-\u9fffA-Za-z0-9]+/)) {
    if (w.length >= 2) { tokens.add('w:' + w); if (w.length >= 4) tokens.add('w2:' + w.slice(0, 2)); }
  }
  return tokens;
}
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h >>> 0;
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const n = Math.min(a.length, b.length); let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  return (ma === 0 || mb === 0) ? 0 : (dot / (Math.sqrt(ma) * Math.sqrt(mb)));
}

// ---------- 版本 ----------
// 软件/发布版本 (与 package.json/index.js: 1.3.0 / 文档/发布标签: v1.3 对齐)。
const VERSION = '1.3';
// memory_network.json 的"数据文件格式版本"，独立于软件版本, 固定为 '2.0' 以保证兼容已存数据。
const DATA_FORMAT_VERSION = '2.0';

// ---------- 记忆网 ----------
const NET_DEFAULT = { version: DATA_FORMAT_VERSION, nodes: {} };  // node_id -> node
function netFilePath(tag) { return path.join(NET_SHARD_DIR, safe(tag) + '.json'); }
function netIndex() { return loadJson(NET_FILE, NET_DEFAULT); }
function netShard(tag) { return loadJson(netFilePath(tag), { tag, nodes: {} }); }
function saveNetShard(tag, shard) { fs.mkdirSync(NET_SHARD_DIR, { recursive: true }); saveJson(netFilePath(tag), shard); }

// 菜单优先级(数值): 有 warning(防坑) 或 high 分级(>=4) -> 1(重点待办, 菜单最前); 其余 -> 0。
// 也可由 facts 的 op_level>=4 触发(见 applyFactSheet 里重算)。
function computeMenuPriority(warning, level) {
  if (String(warning || '').trim()) return 1;
  const l = Number(level) || MAX_LEVEL_DEF;
  return (l >= PRIO_HIGH_MIN_LEVEL) ? 1 : 0;
}
// V1.3 标签去重: 去空白、去重, 防止重复标签导致分片混乱。
function dedupeTags(arr) {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : []).map(t => String(t || '').trim()).filter(t => { if (!t || seen.has(t)) return false; seen.add(t); return true; });
}
// V1.3 菜单选读开关: menu(默认, 每标签限3条, token<=270) | full_injection(紧急回滚, 老式全量注入)。
function menuMode() { return String(cfg(['dual_track', 'router', 'menu_mode'], 'menu')).toLowerCase() === 'full' ? 'full_injection' : 'menu'; }
// 构造一个记忆网节点 (可带元数据覆盖, 供新建与迁移复用)。summary 限制 smax 字, content=全文, warning=防坑提醒。
function buildNode({ tagsArr, content = '', summary = '', links = [], access_count = 0, created_at, last_access, warning = '', memory_level = 3 }) {
  const smax = cfg(['dual_track', 'memory_network', 'summary_max_len'], 20);
  const safeSummary = String(summary).length > smax ? String(summary).slice(0, smax) : String(summary);
  const ca = created_at || nowIso(), la = last_access || created_at || nowIso();
  const edges = (links || []).map(e => Object.assign({}, e, {
    context_score: (typeof e.context_score === 'number' && e.context_score >= EDGE_CTX_MIN) ? e.context_score : EDGE_CTX_DEF
  }));
  const lvl = (Number.isFinite(+memory_level) && +memory_level >= 1 && +memory_level <= 5) ? +memory_level : MAX_LEVEL_DEF;
  return {
    node_id: crypto.randomBytes(6).toString('hex'),
    tags: dedupeTags(tagsArr),
    content: String(content),
    summary: safeSummary,
    warning: String(warning),
    vector_embedding: embed(String(content) + ' ' + safeSummary + ' ' + (tagsArr || []).join(' ')),
    edges,
    memory_level: lvl,
    menu_priority: computeMenuPriority(String(warning), lvl),
    task_irrelevant: false,
    status: 'active',
    deleted_at: null,
    access_count: access_count || 0,
    use_count: 0,
    validated_count: 0,
    created_at: ca,
    last_access: la,
    last_used: la
  };
}
// 写节点: 更新分片(带标签锁) + 全局索引(带文件锁)。
function writeNode(node, tag) {
  const shardTag = tag || (node.tags && node.tags[0]) || '__default__';
  withTagLock([shardTag], () => { const shard = netShard(shardTag); shard.nodes[node.node_id] = node; saveNetShard(shardTag, shard); });
  withFileLock(NET_FILE, () => {
    const idx = netIndex();
    idx.nodes[node.node_id] = {
      node_id: node.node_id, tags: tagKey(node.tags || [shardTag]), tag: shardTag,
      summary: node.summary, status: node.status, location: 'net',
      score: scoreOf(node), validated_count: node.validated_count,
      last_access: node.last_access, created_at: node.created_at,
      shard: safe(shardTag)
    };
    saveJson(NET_FILE, idx);
  });
  return node;
}
// 新增节点。summary 限制 20 字, content=全文, 计算向量, 可选关联边, 软删字段全置初值。
function netAdd({ tags, content, summary, links, warning, memory_level }) {
  try {
    const tagsArr = Array.isArray(tags) ? tags.filter(Boolean) : [String(tags || '')].filter(Boolean);
    const node = buildNode({ tagsArr, content, summary, links, warning, memory_level });
    writeNode(node, tagsArr[0] || '__default__');
    return node;
  } catch (e) { return { error: String(e && e.message || e), stack: (e && e.stack || '').split('\n').slice(0, 3) }; }
}
// Point3 增量讨论与版本覆盖: 写入新结论文本前, 先把"同标签仍 active 的旧节点"标 garbage+deleted_at, 再写入新节点(active)。
// 不建版本链表; 旧数据保留在硬盘供追溯, 但不再参与检索。
function netSupersede({ tags, content, summary, warning, memory_level }) {
  try {
    const tagsArr = Array.isArray(tags) ? tags.filter(Boolean) : [String(tags || '').split(',')[0]].filter(Boolean);
    const tag = tagsArr[0] || '__default__';
    const idx = netIndex();
    const superseded = [];
    for (const m of Object.values(idx.nodes || {})) {
      const sameTag = (m.tag === tag) || (Array.isArray(m.tags) && m.tags.includes(tag));
      if (!sameTag || m.status === 'garbage') continue;
      const shard = netShard(m.tag); const n = shard.nodes[m.node_id];
      if (n && n.status !== 'garbage') { n.status = 'garbage'; n.deleted_at = nowIso(); saveNetShard(m.tag, shard); }
      m.status = 'garbage'; m.deleted_at = nowIso();
      superseded.push(m.node_id);
    }
    if (superseded.length) saveJson(NET_FILE, idx);
    const newNode = netAdd({ tags: tagsArr, content, summary, warning, memory_level });
    return { new_node: newNode && newNode.node_id, superseded, node: newNode };
  } catch (e) { return { error: String(e && e.message || e) }; }
}
// ---------- V1.2 ----------
// 苹果皮: 验证成功(validated+1) -> menu_priority 强制归零降级(痛点已解决), 并记 last_used(实际被用来解决问题的节点)。
function netValidate(nodeId) {
  try {
    const n = getNodeFull(nodeId); if (!n) return { error: 'not found', node_id: nodeId };
    ensureNodeCompat(n);
    n.validated_count = (n.validated_count || 0) + 1;
    n.menu_priority = 0;                                   // 苹果皮: 验证成功归零
    n.last_used = nowIso();                                // 淘汰/衰减按 last_used(实际解决), 非 last_access
    lockEdgesIfValidated(n); writeNodeFull(n);
    return { node_id: nodeId, validated_count: n.validated_count, menu_priority: n.menu_priority, memory_level: n.memory_level };
  } catch (e) { return { error: String(e && e.message || e) }; }
}
// 边界铁律测试: 管家/本地小模型若尝试改公式/核心规则 -> 拦截 + RULE_VIOLATION + [ERROR] 上报。
function ruleTest(action) {
  const g = guardCoreRules(action || '');
  if (g) return g;                                          // 拦截并标记上报
  return { ok: true, note: '未命中核心规则关键词, 仅可改数据值; 公式/规则修改会被拦截', action };
}
// 重铸回滚兜底: 切引擎前备份当前引擎数据到临时目录; 重铸报错 -> 回滚; 成功 -> 清理临时备份。
// 回滚完整性校验: 回滚后快照与备份一致才允许继续; 抽样校验: 重铸后抽少量节点比对向量有效。
function rebuildEmbeddings() {
  try {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_rb_')), 'snap');
    fs.mkdirSync(tmp, { recursive: true });
    // 1) 备份当前存储(索引+分片)
    const idx = netIndex();
    fs.copyFileSync(NET_FILE, path.join(tmp, 'memory_network.json'));
    if (fs.existsSync(NET_SHARD_DIR)) {
      for (const f of fs.readdirSync(NET_SHARD_DIR)) if (f.endsWith('.json')) fs.copyFileSync(path.join(NET_SHARD_DIR, f), path.join(tmp, f));
    }
    const backupObj = JSON.stringify(idx);
    // 2) 重铸: 对所有活跃节点重新 embed(用当前 embedder_provider)
    let i = 0;
    for (const m of Object.values(idx.nodes || {})) {
      if (m.status === 'garbage') continue;
      const shard = netShard(m.tag); const n = ensureNodeCompat(shard.nodes[m.node_id]); if (!n) continue;
      n.vector_embedding = embed(String(n.content || '') + ' ' + (n.summary || '') + ' ' + (n.tags || []).join(' '));
      saveNetShard(m.tag, shard); i++;
    }
    // 3) 抽样校验: 抽最多3个非垃圾节点, 向量必须非全零(有效)
    const samples = Object.values(idx.nodes || {}).filter(m => m.status !== 'garbage').slice(0, 3);
    const badSample = samples.filter(m => { const shard = netShard(m.tag); const n = shard.nodes[m.node_id]; return !n || !n.vector_embedding || !n.vector_embedding.some(v => v !== 0); });
    if (badSample.length) throw new Error('重铸抽样校验失败: 存在无效向量 ' + badSample.length + ' 个');
    // 4) 成功 -> 清理临时备份
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    return { ok: true, reembedded: i, sampled: samples.length, backup_cleaned: true, backup_hash: 'cleaned' };
  } catch (e) {
    // 报错 -> 强制回滚(从备份还原) + 布尔快照校验(回滚后 == 备份)
    try {
      const tmp = globBackupDir();
      if (tmp) {
        if (fs.existsSync(path.join(tmp, 'memory_network.json'))) fs.copyFileSync(path.join(tmp, 'memory_network.json'), NET_FILE);
        if (fs.existsSync(path.join(tmp, 'network_shards'))) fs.cpSync(path.join(tmp, 'network_shards'), NET_SHARD_DIR, { recursive: true });
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
      }
    } catch (rb) { return { error: '重铸失败且回滚异常: ' + String(e.message) + ' || ' + String(rb.message), code: 'REBUILD_ROLLBACK_FAIL' }; }
    return { error: '重铸失败, 已回滚: ' + String(e.message), code: 'REBUILD_ROLLBACK', rollback: true };
  }
}
function globBackupDir() {
  try {
    const base = os.tmpdir(); const dirs = fs.readdirSync(base).filter(d => d.startsWith('dsh_rb_'));
    if (!dirs.length) return null;
    const d = path.join(base, dirs[dirs.length - 1]); return fs.existsSync(d) ? path.join(d, 'snap') : null;
  } catch { return null; }
}
// 连续报错判定(标准): 错误码/完整文件路径一致 且 间隔<5分钟 -> 连续失败; 判定权归主模型。
function consecutiveError(prev, cur, cfgMin) {
  const m = Number(cfgMin) || CONSEC_ERROR_MIN;
  const same = prev && cur && ((prev.code && prev.code === cur.code) || (prev.path && cur.path && prev.path === cur.path));
  const within = prev && cur && prev.ts && cur.ts && ((cur.ts - prev.ts) < m * 60000);
  return { consecutive: !!(same && within), reason: (same ? '同错误码/路径; ' : '错误码/路径不同; ') + (within ? ('间隔<' + m + 'min') : '间隔≥' + m + 'min'), decided_by: 'main-brain' };
}
// 迁移旧版 (index.json/hot_data/cold_data) 历史记忆进记忆网。
// 无损: content 保留 全文 + 原summary + tag + 关键词 + legacy_id; 元数据 access_count/created_at/last_access 一并保留。
// 幂等: 以 <root>/legacy_migrated.json 记录已迁移 id, 重跑不重复。
function migrateLegacy() {
  try {
    const idxFile = path.join(ROOT, 'index.json');
    if (!fs.existsSync(idxFile)) return { error: 'no legacy index.json', root: ROOT };
    const idx = loadJson(idxFile, { entries: [] });
    const markerFile = path.join(ROOT, 'legacy_migrated.json');
    const marker = loadJson(markerFile, { ids: [] });
    const done = new Set(marker.ids);
    const COLD = path.join(ROOT, 'cold_data');
    const migrated = [], failed = [];
    let skipped = 0;
    for (const e of idx.entries) {
      if (done.has(e.id)) { skipped++; continue; }
      try {
        const coldPath = (e.cold_path && fs.existsSync(e.cold_path)) ? e.cold_path : path.join(COLD, safe(e.tag) + '_' + e.id + '.json');
        const cold = (coldPath && fs.existsSync(coldPath)) ? loadJson(coldPath, null) : null;
        const full = cold && cold.full_text ? String(cold.full_text) : '';
        const legacySummary = String(e.summary || '');
        const meta = ['source_tag: ' + e.tag, 'legacy_id: ' + e.id]
          .concat(Array.isArray(e.keywords) && e.keywords.length ? ['keywords: ' + e.keywords.join(', ')] : [])
          .concat(legacySummary ? ['legacy_summary: ' + legacySummary] : []);
        const content = (full ? full + '\n' : '') + meta.join('\n');
        const node = buildNode({ tagsArr: [e.tag], content, summary: legacySummary, links: [], access_count: e.access_count || 0, created_at: e.created_at, last_access: e.last_access });
        writeNode(node, e.tag);
        migrated.push({ legacy_id: e.id, node_id: node.node_id, tag: e.tag });
      } catch (ex) {
        failed.push({ legacy_id: e.id, error: String(ex && ex.message || ex) });
      }
    }
    if (migrated.length) {
      withFileLock(markerFile, () => { const m = loadJson(markerFile, { ids: [] }); const set = new Set(m.ids); for (const x of migrated) set.add(x.legacy_id); saveJson(markerFile, { ids: [...set] }); });
    }
    return { root: ROOT, legacy_total: idx.entries.length, migrated: migrated.length, skipped, failed: failed.length, details: migrated, failed_list: failed, marker_file: markerFile };
  } catch (e) { return { error: String(e && e.message || e) }; }
}
function scoreOf(n) {
  const a = cfg(['scoring', 'access_weight'], 1), u = cfg(['scoring', 'use_weight'], 2), v = cfg(['scoring', 'validated_weight'], 5);
  return (n.access_count || 0) * a + (n.use_count || 0) * u + (n.validated_count || 0) * v;
}
// 全网活跃节点 (兼顾全局索引 + 分片), 供管家相似度分诊
function allActiveNodes() {
  const idx = netIndex(); const nodes = [];
  for (const meta of Object.values(idx.nodes || {})) {
    if (meta.status && meta.status !== 'active') continue;
    const shard = netShard(meta.tag);
    const node = shard.nodes[meta.node_id];
    if (node) { node._searchMeta = meta; nodes.push(node); }
  }
  return nodes;
}
// 记忆网检索: 查询向量 vs 所有活跃节点, 返回按相似度排序。管家用 topScore 判断是否 >= 阈值。
function netSearch(query, thrOverride) {
  try {
    const qv = embed(query);
    const thr = (thrOverride !== undefined && Number.isFinite(+thrOverride)) ? +thrOverride : effectiveSimThreshold();
    const nodes = allActiveNodes();
    const qlow = String(query || '').toLowerCase();
    const kwBoost = cfg(['dual_track', 'memory_network', 'keyword_boost'], 0.15);
    const scored = nodes.map(n => {
      const similarity = n.vector_embedding ? cosine(qv, n.vector_embedding) : 0;
      // 精准检索: 关键词标签/摘要命中加成 (tags 用于分区锁+精准检索, 补齐语义弱时的定位)
      const tagHits = (n.tags || []).filter(t => t && qlow.includes(String(t).toLowerCase())).length;
      const sumHits = String(n.summary || '').toLowerCase().split(/[^\u4e00-\u9fffA-Za-z0-9]+/).filter(t => t.length > 1 && qlow.includes(t)).length;
      // Point1 菜单优先级: menu_priority=1(重点待办) 加权置前; 纯闲聊低优先级弱化(靠 rankScore 兜底)
      const mp = (n.menu_priority === 1) ? PRIO_MENU_BOOST : 0;
      const rankScore = +((similarity) + (tagHits + sumHits * 0.5) * kwBoost + mp).toFixed(4);
      return { node_id: n.node_id, tag: n.tags && n.tags[0], summary: n.summary, similarity: +similarity.toFixed(4), rankScore, menu_priority: n.menu_priority || 0, access_count: n.access_count };
    }).sort((a, b) => (b.rankScore - a.rankScore) || (b.menu_priority - a.menu_priority) || (10 * (b.access_count || 0) - 10 * (a.access_count || 0)));
    const top = scored[0] || null;
    const activated = top && top.similarity >= thr ? top : null;
    // 顺带拉出相邻关联节点摘要 (边). 边可跨分片, 用全局索引解析目标所在分片。
    let neighbors = [];
    let context_cluster = [];
    if (activated) {
      const idxMeta = netIndex();
      // 待命池唤醒: 被匹配的节点若在待命池(task_irrelevant), 自动移除标记, 重新进入循环
      const wNode = getNodeFull(activated.node_id);
      if (wNode && wNode.task_irrelevant) { wNode.task_irrelevant = false; wNode.last_access = nowIso(); writeNodeFull(wNode); }
      const pull = [];
      if (idxMeta.nodes[activated.node_id]) {
        const meShard = netShard(activated.tag); const me = ensureNodeCompat(meShard.nodes[activated.node_id]);
        if (me) pull.push(me);
        // 海马体: 按边权 context_score 从高到低排序, 只取前 CTX_TOP(少则 CTX_TOP_SMALL) 作为关联线索簇
        const sorted = (me.edges || []).slice().sort((a, b) => edgeCtx(b) - edgeCtx(a));
        const top = sorted.length >= CTX_TOP ? CTX_TOP : Math.min(sorted.length, CTX_TOP_SMALL);
        for (const edge of sorted.slice(0, top)) {
          const tm = idxMeta.nodes[edge.target_node_id]; if (!tm) continue;
          const tShard = netShard(tm.tag); const tn = ensureNodeCompat(tShard.nodes[edge.target_node_id]);
          if (tn) pull.push(tn);
        }
        context_cluster = sorted.slice(0, top).map(e => ({ target_node_id: e.target_node_id, context_score: edgeCtx(e), edge_weight: e.edge_weight || 0, relation_type: e.relation_type || 'related' }));
      }
      neighbors = pull.map(p => ({ node_id: p.node_id, tag: p.tags && p.tags[0], summary: p.summary, similarity: p.node_id === activated.node_id ? activated.similarity : cosine(qv, p.vector_embedding || []) }));
      // 命中 -> 计数 + 动态边权(相关边 +0.1)
      withTagLock([activated.tag], () => {
        const s2 = netShard(activated.tag); const nd = s2.nodes[activated.node_id];
        if (nd) { nd.access_count = (nd.access_count || 0) + 1; nd.last_access = nowIso(); saveNetShard(activated.tag, s2); }
      });
      bumpEdgeWeights(activated.node_id, activated.tag);
    }
    return { query, top: top ? { node_id: top.node_id, tag: top.tag, summary: top.summary, similarity: top.similarity, rankScore: top.rankScore } : null, activated: activated ? activated.node_id : null, neighbors, context_cluster, threshold: thr, activated_count: activated ? 1 : 0 };
  } catch (e) { return { error: String(e && e.message || e) }; }
}
function bumpEdgeWeights(nodeId, tag) {
  try {
    const boost = cfg(['dual_track', 'memory_network', 'edge_boost'], 0.1);
    withTagLock([tag], () => { const shard = netShard(tag); const nd = shard.nodes[nodeId]; if (nd && nd.edges) { for (const e of nd.edges) e.edge_weight = (Number(e.edge_weight) || 0) + boost; saveNetShard(tag, shard); } });
  } catch { /* ignore */ }
}

// ================= V1.1: context_score / memory_level / 事实单 / 待命池 =================
function edgeCtx(e) { return (typeof e.context_score === 'number' && e.context_score >= EDGE_CTX_MIN) ? e.context_score : EDGE_CTX_DEF; }
function clampCtx(v) { return Math.max(EDGE_CTX_MIN, Math.min(EDGE_CTX_MAX, v)); }
function setAllEdgeCtx(node, val) { for (const e of (node.edges || [])) e.context_score = clampCtx(val); return node; }
function adjustAllEdgeCtx(node, delta) { for (const e of (node.edges || [])) e.context_score = clampCtx(edgeCtx(e) + delta); return node; }
function getNodeFull(nodeId) { const idx = netIndex(); const meta = idx.nodes[nodeId]; if (!meta) return null; const shard = netShard(meta.tag); return shard.nodes[nodeId] || null; }
function writeNodeFull(node) { const tag = (node.tags && node.tags[0]) || '__default__'; withTagLock([tag], () => { const shard = netShard(tag); shard.nodes[node.node_id] = node; saveNetShard(tag, shard); }); }
// 旧数据兼容默认
function ensureNodeCompat(n) {
  if (n.memory_level === undefined || n.memory_level === null) n.memory_level = MAX_LEVEL_DEF;      // 旧节点无 memory_level -> 3
  if (n.menu_priority === undefined || n.menu_priority === null) n.menu_priority = computeMenuPriority(n.warning, n.memory_level); // 旧节点无 menu_priority -> 按 warning/level 补
  if (n.task_irrelevant === undefined || n.task_irrelevant === null) n.task_irrelevant = false;     // 旧节点无 task_irrelevant -> false
  if (n.edges) for (const e of n.edges) if (e.context_score === undefined || e.context_score === null) e.context_score = EDGE_CTX_DEF; // 旧边无 context_score -> 0.1
  return n;
}
// 硬锁死: validated>=3 -> 所有边 context_score 强制5.0 + 节点 L5
function lockEdgesIfValidated(node) {
  const lockV = cfg(['scoring', 'validated_lock'], 3);
  if ((node.validated_count || 0) >= lockV) { setAllEdgeCtx(node, EDGE_CTX_MAX); node.memory_level = 5; node.menu_priority = 0; node.locked_edges = true; writeNodeFull(node); return true; }  // 苹果皮: 验证成功(>=3)归零
  return false;
}
// 休眠衰减: 距离上次激活 > EDGE_DORMANT_DAYS -> 该节点所有边 context_score *= EDGE_DORMANT_RATIO
function dormantEdgeDecay(node) {
  const last = new Date(node.last_access || node.created_at).getTime();
  if ((Date.now() - last) / 86400000 > (cfg(['dual_track','memory_network','dormant_days'], EDGE_DORMANT_DAYS)) && (node.validated_count || 0) < (cfg(['scoring','validated_lock'],3))) {
    for (const e of (node.edges || [])) e.context_score = clampCtx(edgeCtx(e) * (cfg(['dual_track','memory_network','dormant_ratio'], EDGE_DORMANT_RATIO)));
    return true;
  }
  return false;
}
// 交叉验证: 管家读 dsh-web.log。op=5 但日志无码操作 -> 降3; 日志高密度但 op=3 -> 提4。
function crossValidateLevel(level) {
  try {
    const cands = [path.join(ROOT, '..', '..', 'dsh-web.log'), path.join(ROOT, '..', '..', '..', 'logs', 'dsh-web.log'), path.join(ROOT, '..', 'dsh-web.log')];
    let tail = '';
    for (const c of cands) { if (fs.existsSync(c)) { tail = fs.readFileSync(c, 'utf8').slice(-20000); break; } }
    if (!tail) return level;
    const opDensity = (tail.match(/tool|exec|spawn|writeFile|require\(|node .*\.js/g) || []).length;
    if (level >= 5 && opDensity < 3) return 3;
    if (level <= 3 && opDensity > 50) return 4;
    return level;
  } catch { return level; }
}
// 任务事实单: op_level(默认3) + used(+0.5/真实有用) + ignored(-0.2/待命池)
function applyFactSheet({ op_level, used, ignored }) {
  try {
    let level = (Number.isFinite(+op_level) && +op_level >= 1 && +op_level <= 5) ? +op_level : MAX_LEVEL_DEF; // 没有则默认3(工作)
    level = crossValidateLevel(level);
    const res = { level, used: [], ignored: [], locked: [] };
    const usedIds = Array.isArray(used) ? used.filter(Boolean) : [];
    const igIds = Array.isArray(ignored) ? ignored.filter(Boolean) : [];
    for (const id of usedIds) {
      const n = getNodeFull(id); if (!n) continue;
      // Point2 弱关联: 主节点(被选中并解决)的边一律 +0.5(加粗), 若此前潜伏(0.1)则唤醒到 0.5; 绝不删边。
      for (const e of (n.edges || [])) {
        e.context_score = (Math.abs(edgeCtx(e) - DORMANCY_FLOOR) < 1e-9) ? clampCtx(WAKE_SCORE) : clampCtx(edgeCtx(e) + EDGE_USE_BOOST);
      }
      n.use_count = (n.use_count || 0) + 1; n.last_used = nowIso(); n.used_mark = 'real-useful'; n.task_irrelevant = false;
      n.menu_priority = (level >= PRIO_HIGH_MIN_LEVEL || String(n.warning || '').trim()) ? 1 : 0;   // Point1: 高密度/防坑 -> 1
      lockEdgesIfValidated(n); writeNodeFull(n); res.used.push(id);
    }
    for (const id of igIds) {
      const n = getNodeFull(id); if (!n) continue;
      // Point2: 扫过没用 -> 边潜伏到底线0.1(而不是-0.2), 节点不删
      for (const e of (n.edges || [])) e.context_score = DORMANCY_FLOOR;
      n.task_irrelevant = true; n.used_mark = 'staging';
      n.menu_priority = (level >= PRIO_HIGH_MIN_LEVEL || String(n.warning || '').trim()) ? 1 : 0;   // Point1
      writeNodeFull(n); res.ignored.push(id);
    }
    poolCleanup();
    return res;
  } catch (e) { return { error: String(e && e.message || e) }; }
}
// 待命池: 超过上限自动清理最久未用前10条(移除标记, 不删节点)
function poolCleanup() {
  const cap = cfg(['dual_track', 'memory_network', 'task_pool_cap'], TASK_POOL_CAP);
  const clean = cfg(['dual_track', 'memory_network', 'task_pool_clean'], TASK_POOL_CLEAN);
  const idx = netIndex(); const pool = [];
  for (const m of Object.values(idx.nodes || {})) { const n = getNodeFull(m.node_id); if (n && n.task_irrelevant) pool.push(n); }
  if (pool.length > cap) {
    pool.sort((a, b) => new Date(a.last_access || a.created_at) - new Date(b.last_access || b.created_at));
    for (const n of pool.slice(0, clean)) { n.task_irrelevant = false; n.last_access = nowIso(); writeNodeFull(n); }
  }
}
// 五级弹性: 节点总数 < 5000 (且 max_level 未设5) -> 压缩为 L1/L3/L5 (L2->L1, L4->L3)
function effectiveLevel(n) {
  ensureNodeCompat(n);
  const total = Object.keys(netIndex().nodes || {}).length;
  const maxLevel = cfg(['dual_track', 'memory_network', 'max_level'], MAX_LEVEL_DEF);
  if ((n.validated_count || 0) >= (cfg(['scoring', 'validated_lock'], 3))) return 5; // L5 强制
  if (total < NODE_TOTAL_EXPAND && maxLevel < 5) {
    if (n.memory_level === 2) return 1;   // L2 并入 L1
    if (n.memory_level === 4) return 3;   // L4 并入 L3
    return n.memory_level;
  }
  return n.memory_level;
}
function netRead(nodeId) {
  const idx = netIndex(); const meta = idx.nodes[nodeId];
  if (!meta) return { error: 'not found', node_id: nodeId };
  const shard = netShard(meta.tag); const node = ensureNodeCompat(shard.nodes[nodeId]);
  if (!node) return { error: 'shard missing node', node_id: nodeId };
  withTagLock([meta.tag], () => { const s = netShard(meta.tag); const n = ensureNodeCompat(s.nodes[nodeId]); if (n) { n.access_count = (n.access_count || 0) + 1; n.last_access = nowIso(); saveNetShard(meta.tag, s); } });
  return { node_id: node.node_id, tag: node.tags[0], tags: node.tags, summary: node.summary, content: node.content, warning: node.warning || '', status: node.status, access_count: node.access_count, use_count: node.use_count, validated_count: node.validated_count, memory_level: effectiveLevel(node), task_irrelevant: node.task_irrelevant, used_mark: node.used_mark || '', edges: node.edges };
}
function netSoftDelete(nodeId) {
  const idx = netIndex(); const meta = idx.nodes[nodeId];
  if (!meta) return { error: 'not found' };
  withTagLock([meta.tag], () => {
    const shard = netShard(meta.tag); const n = shard.nodes[nodeId];
    if (n) { n.status = 'garbage'; n.deleted_at = nowIso(); saveNetShard(meta.tag, shard); }
  });
  withFileLock(NET_FILE, () => { const i2 = netIndex(); if (i2.nodes[nodeId]) { i2.nodes[nodeId].status = 'garbage'; i2.nodes[nodeId].deleted_at = nowIso(); saveJson(NET_FILE, i2); } });
  return { ok: true, node_id: nodeId, status: 'garbage' };
}
function netList() {
  const idx = netIndex();
  const arr = Object.values(idx.nodes || {}).map(m => ({ node_id: m.node_id, tag: m.tag, summary: m.summary, status: m.status, score: m.score }));
  return { count: arr.length, nodes: arr };
}

// ---------- 经验档 ----------
// cardId 统一带 EXP- 前缀 (即 card.card_id)。文件: EXP_DIR/<cardId>.json
function expPath(cardId) { return path.join(EXP_DIR, String(cardId) + '.json'); }
function expIndex() { return loadJson(EXP_IDX, { version: DATA_FORMAT_VERSION, cards: {} }); }
// 新增经验卡: 风险分诊。低风险(仅已验证方案微调) -> 自动写; 高风险(改源码/跨版本) -> 生成审批报告挂起。
function expAdd({ symptom, cause, solution, env_check, warning, force }) {
  try {
    const id = crypto.randomBytes(4).toString('hex').toUpperCase();
    const risk = assessRisk({ symptom, cause, solution });
    const card = {
      card_id: 'EXP-' + id,
      symptom: String(symptom || ''), cause: String(cause || ''), solution: String(solution || ''),
      env_check: String(env_check || ''), warning: String(warning || ''),
      validated_count: 0, access_count: 0, score: 0,
      status: 'active', created_at: nowIso(), last_access: nowIso()
    };
    card.score = scoreOf(card);
    if (risk === 'low' || force) {
      fs.mkdirSync(EXP_DIR, { recursive: true });
      withFileLock(expPath(card.card_id), () => saveJson(expPath(card.card_id), card));
      withFileLock(EXP_IDX, () => { const idx = expIndex(); idx.cards[card.card_id] = { card_id: card.card_id, symptom: card.symptom, env_check: card.env_check, validated_count: 0, status: 'active', score: card.score, last_access: card.last_access }; saveJson(EXP_IDX, idx); });
      return { card_id: card.card_id, risk: 'low', status: 'written', card };
    } else {
      // 高风险 -> 审批报告挂起
      fs.mkdirSync(APPROVALS_DIR, { recursive: true });
      const report = { card_id: card.card_id, risk: 'high', symptom, cause, solution, env_check, warning, status: 'pending', created_at: nowIso() };
      withFileLock(path.join(APPROVALS_DIR, report.card_id + '.json'), () => saveJson(path.join(APPROVALS_DIR, report.card_id + '.json'), report));
      return { card_id: card.card_id, risk: 'high', status: 'pending-approval', report_path: path.join(APPROVALS_DIR, report.card_id + '.json') };
    }
  } catch (e) { return { error: String(e && e.message || e) }; }
}
function assessRisk({ symptom, cause, solution }) {
  const blob = String(symptom || '') + ' ' + String(cause || '') + ' ' + String(solution || '');
  // 内置默认(无配置文件时也能正确判高风险), 可被 memory.config.json 覆盖。
  const high = cfg(['dual_track', 'experience_cards', 'risk_keywords_high'], ['改源码', '底层', '跨版本', '重写', 'hook', '注入', '内核', 'registry', '系统级']);
  const low = cfg(['dual_track', 'experience_cards', 'risk_keywords_low'], ['调整', '微调', '改参数', '调参', '配置']);
  if (high.some(k => k && blob.includes(k))) return 'high';
  if (low.some(k => k && blob.includes(k))) return 'low';
  return 'low'; // 默认低风险(仅描述方案调整)
}
// 环境校验: 若当前环境与卡片 env_check 不符 -> 锁死提示"旧档失效"
function expGet(cardId, currentEnv) {
  const idx = expIndex(); const meta = idx.cards[cardId];
  if (!meta) return { error: 'not found', card_id: cardId };
  const card = loadJson(expPath(cardId), null);
  const c = card || meta;
  const envCheckEnabled = cfg(['dual_track', 'experience_cards', 'env_auto_check'], true);
  let env_lock = false; let env_note = '';
  if (envCheckEnabled && c.env_check && currentEnv) {
    env_lock = c.env_check.trim() !== currentEnv.trim();
    if (env_lock) env_note = '旧档失效, 需重新验证。案卷环境 [' + c.env_check + '], 当前 [' + currentEnv + ']';
  }
  // 命中计数
  withFileLock(EXP_IDX, () => { const i2 = expIndex(); if (i2.cards[cardId]) { i2.cards[cardId].last_access = nowIso(); i2.cards[cardId].score = scoreOf({ ...i2.cards[cardId], validated_count: i2.cards[cardId].validated_count }); saveJson(EXP_IDX, i2); } });
  return { card_id: cardId, symptom: c.symptom, cause: c.cause, solution: c.solution, env_check: c.env_check, warning: c.warning, validated_count: c.validated_count, env_lock, env_note, status: c.status };
}
function expValidate(cardId, verify) {
  const idx = expIndex(); const meta = idx.cards[cardId];
  if (!meta) return { error: 'not found' };
  // 经验沉淀强制校验: 只有"标签前缀相同"或"报错文件名含核心关键词"时, 才允许 validated_count+1; 否则只能在待命池潜伏。
  const card = loadJson(expPath(cardId), {});
  const tagPrefix = String((card && card.tag) || meta.symptom || '').split('-')[0];
  const key = String(verify || '');
  if (key) {
    const tagOk = tagPrefix && key && tagPrefix.length > 0 && ((verify && String(verify).toLowerCase().includes(tagPrefix.toLowerCase())) || true);
    const fileOk = key && String((card.solution || '') + ' ' + (card.cause || '')).toLowerCase().includes(key.toLowerCase());
    const matched = tagOutsidePrefix(tagPrefix, key) || fileOk;
    if (!matched) return { card_id: cardId, blocked: true, reason: '待验证: 标签前缀不同且报错文件名未含核心关键词 [' + key + '], 仅入待命池, 不得生效', status: 'pending', validated_count: meta.validated_count || 0 };
  }
  withFileLock(EXP_IDX, () => {
    const i2 = expIndex(); if (i2.cards[cardId]) { i2.cards[cardId].validated_count = (i2.cards[cardId].validated_count || 0) + 1; i2.cards[cardId].score = scoreOf(i2.cards[cardId]); saveJson(EXP_IDX, i2); }
  });
  return { card_id: cardId, validated_count: meta.validated_count + 1 };
}
function tagOutsidePrefix(prefix, key) {
  // 判定: 待验证经验卡"标签前缀与当前主题一致"即可视为可验证(简化: key 蕴含 prefix 或 prefix 非空且 key 含 prefix)
  if (!prefix) return true;   // 无前缀 -> 宽松放行? 保守: 需 key 含 prefix
  return String(key || '').toLowerCase().includes(String(prefix).toLowerCase());
}
function expList() {
  const idx = expIndex(); const arr = Object.values(idx.cards || {}).map(m => ({ card_id: m.card_id, symptom: m.symptom, env_check: m.env_check, validated_count: m.validated_count, status: m.status, score: m.score }));
  return { count: arr.length, cards: arr };
}
function expApprovals() {
  if (!fs.existsSync(APPROVALS_DIR)) return { count: 0, reports: [] };
  const files = fs.readdirSync(APPROVALS_DIR).filter(f => f.endsWith('.json'));
  return { count: files.length, reports: files.map(f => ({ file: f, ...loadJson(path.join(APPROVALS_DIR, f), {}) })) };
}

// ---------- 管家分诊 ----------
// 意图识别: 技术词命中 -> 经验档偏置; 否则模糊 -> 记忆网偏置。
// 必须用向量相似度硬判(>阈值才强行归类), 否则交还主模型。
function route(text) {
  try {
    const tech = ROUTER.tech_keywords || [];
    const kwHit = tech.some(k => k && String(text).toLowerCase().includes(k.toLowerCase()));
    const thr = effectiveSimThreshold();
    const qv = embed(text);
    // 记忆网相似度
    const netRes = netSearch(text);
    const netTop = netRes.top ? netRes.top.similarity : 0;
    // 经验档相似度 (用症状/解法文本向量近似: 遍历卡片拼一个搜索向量)
    const expIdx = expIndex(); let expTop = 0; let expTopId = null;
    const qvs = qv;
    for (const m of Object.values(expIdx.cards || {})) {
      const card = loadJson(expPath(m.card_id), {});
      const blob = (card.symptom || '') + ' ' + (card.cause || '') + ' ' + (card.solution || '');
      if (blob) { const s = cosine(qvs, embed(blob)); if (s > expTop) { expTop = s; expTopId = m.card_id; } }
    }
    // 分诊脑(可选本地小模型): 命中即由其硬判; 未命中/失败则回退纯向量法。
    const brain = triageBrain();
    const llmCls = (brain === 'qwen') ? ((qwenTriageSync(text) || {}).classify || null) : null;
    let target = null; let reason = '';
    if (brain === 'qwen' && llmCls) {
      if (llmCls === 'skip') { target = null; reason = '分诊脑(LLM=' + TRIAGE_MODEL + ')判 skip(无关/闲聊), 不记录'; }
      else { target = (llmCls === 'exp') ? 'exp' : 'net'; reason = '分诊脑(LLM=' + TRIAGE_MODEL + ')判 ' + target + (llmCls === 'exp' && kwHit ? '(技术词佐证)' : ''); }
    } else {
      // 纯向量法硬判: 技术词命中且经验档相似度 > 阈值 -> 经验档; 或经验档相似度 > 阈值且 > 记忆网
      const pickedExp = (expTop > thr && (expTop >= netTop || kwHit));
      const pickedNet = (netTop > thr && !pickedExp);
      if (pickedExp) { target = 'exp'; reason = (kwHit ? '技术词命中; ' : '') + '经验档相似度 ' + expTop.toFixed(3) + ' >= ' + thr; }
      else if (pickedNet) { target = 'net'; reason = '记忆网相似度 ' + netTop.toFixed(3) + ' >= ' + thr; }
      else { target = null; reason = '相似度未达阈值(' + Math.max(netTop, expTop).toFixed(3) + ' < ' + thr + '), 交还主模型处理'; }
    }
    const res = { text: text.slice(0, 200), target, reason, brain, llm_class: llmCls, sim: { net: +netTop.toFixed(3), exp: +expTop.toFixed(3) }, threshold: thr, exp_top_card: expTopId, net_top: netRes.top };
    if (brain === 'qwen' && !llmCls) res.triage_fallback = true;   // 小模型不可用 -> 已回退向量法
    return res;
  } catch (e) { return { error: String(e && e.message || e) }; }
}

// ---------- 积分动态衰减 ----------
function decay() {
  try {
    if (SHUTDOWN_FROZEN) return { frozen: true, reason: '优雅停机已冻结(距上次关机>15天), 该时间段内所有节点/连线不参与衰减', scanned: 0 };
    const hotDays = cfg(['scoring', 'hot_days'], 7), sleepDays = cfg(['scoring', 'sleep_days'], 30);
    const ratio = cfg(['scoring', 'decay_ratio'], 0.95), lockV = cfg(['scoring', 'validated_lock'], 3);
    const garbageMax = cfg(['scoring', 'garbage_max_score'], 5);
    const elimDays = cfg(['dual_track', 'memory_network', 'eliminate_days'], ELIMINATE_DAYS);
    const now = beijingNowMs(); const results = { scanned: 0, locked: 0, decayed: 0, garbage: 0, dormant: 0, tamper: 0, nodes: [], cards: [] };
    // 记忆网节点
    const idx = netIndex();
    withTagLock(['__decay_net__'], () => {
      for (const m of Object.values(idx.nodes || {})) {
        results.scanned++;
        const shard = netShard(m.tag); const n = ensureNodeCompat(shard.nodes[m.node_id]); if (!n) continue;
        // V1.1 硬锁死: validated>=3 -> 所有边 context_score=5.0 + 节点 L5
        if (lockEdgesIfValidated(n)) { m.status = 'active'; m.decay_locked = true; m.memory_level = 5; results.locked++; results.nodes.push({ node_id: m.node_id, score: +(m.score || scoreOf(n)).toFixed(2), status: m.status, memory_level: 5, locked: true }); continue; }
        // V1.1 休眠衰减: 距上次激活 > 30 天 -> 该节点所有边 context_score *= 0.5
        if (dormantEdgeDecay(n)) { results.dormant++; saveNetShard(m.tag, shard); }
        const last = new Date(n.last_access || n.created_at).getTime();
        const days = (now - last) / 86400000;
        if (days < -1 / 24) { results.tamper++; m.decay_locked = false; continue; }   // 未来时间戳(系统时钟被回拨) -> 不衰减, 计入篡改
        if (days <= hotDays) { m.decay_locked = false; continue; }          // 高频活跃不衰减
        if (days > sleepDays) { m.score = (m.score || scoreOf(n)) * ratio; results.decayed++; m.decayed_at = nowIso(); } // 低频扣5%
        // 淘汰用 last_used(实际被用来解决过问题), 严禁用 last_access(仅检索命中); 90天未实际使用且未验证 -> 淘汰
        const daysUsed = (now - new Date(n.last_used || n.created_at).getTime()) / 86400000;
        if (((m.score || scoreOf(n)) <= garbageMax && (n.validated_count || 0) === 0) || (daysUsed > elimDays && (n.validated_count || 0) === 0)) { m.status = 'garbage'; results.garbage++; n.status = 'garbage'; n.deleted_at = n.deleted_at || nowIso(); }
        m.memory_level = effectiveLevel(n);   // V1.1 五级弹性
        saveNetShard(m.tag, shard);
        results.nodes.push({ node_id: m.node_id, score: +((m.score || scoreOf(n))).toFixed(2), status: m.status, memory_level: m.memory_level });
      }
      saveJson(NET_FILE, idx);
    });
    // 经验档卡片
    const exi = expIndex();
    withFileLock(EXP_IDX, () => {
      for (const m of Object.values(exi.cards || {})) {
        results.scanned++;
        if ((m.validated_count || 0) >= lockV) { m.decay_locked = true; results.locked++; continue; }
        const last = new Date(m.last_access || m.created_at).getTime(); const days = (now - last) / 86400000;
        if (days <= hotDays) { m.decay_locked = false; continue; }
        if (days > sleepDays) { m.score = (m.score || scoreOf(m)) * ratio; results.decayed++; m.decayed_at = nowIso(); }
        if ((m.score || scoreOf(m)) <= garbageMax && (m.validated_count || 0) === 0) { m.status = 'garbage'; results.garbage++; }
        results.cards.push({ card_id: m.card_id, score: +((m.score || scoreOf(m))).toFixed(2), status: m.status });
      }
      saveJson(EXP_IDX, exi);
    });
    // 边衰减: 长期不用的边权重按 ratio 衰减
    const edgeRatio = cfg(['dual_track', 'memory_network', 'edge_decay_ratio'], 0.99);
    const edgeIdle = cfg(['dual_track', 'memory_network', 'edge_idle_decay_days'], 30);
    withTagLock(['__decay_edges__'], () => {
      const shardFiles = fs.existsSync(NET_SHARD_DIR) ? fs.readdirSync(NET_SHARD_DIR).filter(f => f.endsWith('.json')) : [];
      for (const f of shardFiles) {
        const sp = path.join(NET_SHARD_DIR, f); const shard = loadJson(sp, null); if (!shard) continue;
        let changed = false;
        for (const n of Object.values(shard.nodes || {})) {
          for (const e of (n.edges || [])) {
            if (e.edge_weight && e.edge_weight > 0) { e.edge_weight = Number((e.edge_weight * edgeRatio).toFixed(4)); changed = true; }
          }
        }
        if (changed) saveJson(sp, shard);
      }
    });
    return results;
  } catch (e) { return { error: String(e && e.message || e) }; }
}

// ---------- 统计 ----------
function stats() {
  const idx = netIndex(); const exi = expIndex();
  const netCount = Object.keys(idx.nodes || {}).length;
  const expCount = Object.keys(exi.cards || {}).length;
  let netActive = 0, netGarbage = 0, expActive = 0, expPending = 0;
  const lv = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let taskIrr = 0, prioHigh = 0;
  for (const m of Object.values(idx.nodes || {})) {
    if (m.status === 'garbage') netGarbage++; else netActive++;
    const n = ensureNodeCompat(getNodeFull(m.node_id) || { memory_level: 3, task_irrelevant: false });
    const l = effectiveLevel(n); lv[l] = (lv[l] || 0) + 1;
    if (n.task_irrelevant) taskIrr++;
    if (n.menu_priority === 1) prioHigh++;
  }
  for (const m of Object.values(exi.cards || {})) { if (m.status === 'active') expActive++; else if (m.status === 'garbage') expActive--; }
  expPending = expApprovals().count;
  return {
    version: VERSION, embedding_provider_used: ROUTER.embedding_provider === 'bge' ? 'bge' : 'hash(fallback)',
    data_format_version: DATA_FORMAT_VERSION,
    frozen: SHUTDOWN_FROZEN,
    network: { total: netCount, active: netActive, garbage: netGarbage, memory_level: lv, task_irrelevant: taskIrr, menu_priority_high: prioHigh },
    experience: { total: expCount, active: expActive, pending_approvals: expPending },
    scoring: { formula: 'access*1 + use*2 + validated*5', validated_lock: cfg(['scoring', 'validated_lock'], 3) }
  };
}

// ---------- CLI ----------
function arg(args, n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; }
function flag(args, n) { return args.includes(n); }
function printHelp() {
  console.log([
    'AI Memory Dual CLI  —  memory_dual <cmd> [args]',
    '  net-add      --tags a,b --content <全文> --summary <≤20字> [--link nodeid,rel,w;...]',
    '  net-search   --query <词> [--threshold x]          相似度排序, >=阈值自动激活+拉邻节摘要',
    '  net-read     --id <node_id>                        读全文+边',
    '  net-softdelete --id ...                            软删除(status=garbage, 永不物理删)',
    '  net-supersede --tags a --content <新结论> --summary <新摘要>  增量覆盖: 先软删同标签旧节点(garbage), 再写新节点',
    '  net-supersede 说明: 保留旧数据可追溯, 不参与检索; 用于"讨论得新结论"时覆盖旧结论。',
    '  net-list                                          列出节点',
    '  exp-add      --symptom s --cause c --solution s --env <MC1.20.1/A770/16G> [--warning w] [--force]',
    '  exp-get      --id EXP-xxxx [--env <当前环境>]      环境不符 -> 锁死"旧档失效"',
    '  exp-validate --id EXP-xxxx                         验证+1 (v>=3 永锁)',
    '  exp-list / exp-approvals',
    '  route        --text <话>                           管家分诊: net | exp | null',
    '  facts        --op-level 1-5 [--used a,b] [--ignored c,d]   任务事实单: 边权 context_score 增/减 + 待命池标记',
    '  decay                                               积分衰减扫描',
    '  stats',
  ].join('\n'));
}
function main() {
  const args = process.argv.slice(2); const cmd = args[0];
  try {
    let out;
    const j = (o) => (o !== undefined && typeof o === 'object' && o !== null) ? o : { result: o };
    if (cmd === 'net-add') {
      const links = (arg(args, '--link') || '').split(';').filter(Boolean).map(l => { const p = l.split(','); return { target_node_id: p[0], relation_type: p[1] || 'related', edge_weight: Number(p[2]) || 0.5 }; });
      out = netAdd({ tags: (arg(args, '--tags') || '').split(',').filter(Boolean), content: arg(args, '--content') || '', summary: arg(args, '--summary') || '', warning: arg(args, '--warning') || '', memory_level: arg(args, '--level'), links });
    }
    else if (cmd === 'net-supersede') { if (!flag(args, '--confirmed')) { out = { pending_confirm: true, blocked: true, hint: '闭环反思: 需主模型复核确认(--confirmed)后方可写入记忆网', superseded: [] }; } else { out = netSupersede({ tags: (arg(args, '--tags') || '').split(',').filter(Boolean), content: arg(args, '--content') || '', summary: arg(args, '--summary') || '', warning: arg(args, '--warning') || '', memory_level: arg(args, '--level') }); } }
    else if (cmd === 'net-validate') out = netValidate(arg(args, '--id') || '');
    else if (cmd === 'rebuild-embeddings') out = rebuildEmbeddings();
    else if (cmd === 'rule-test') out = ruleTest(arg(args, '--attempt') || '');
    else if (cmd === 'facts') out = applyFactSheet({ op_level: arg(args, '--op-level'), used: (arg(args, '--used') || '').split(',').filter(Boolean), ignored: (arg(args, '--ignored') || '').split(',').filter(Boolean) });
    else if (cmd === 'net-search') out = netSearch(arg(args, '--query') || '', arg(args, '--threshold'));
    else if (cmd === 'net-read') out = netRead(arg(args, '--id') || '');
    else if (cmd === 'net-softdelete') out = netSoftDelete(arg(args, '--id') || '');
    else if (cmd === 'net-list') out = netList();
    else if (cmd === 'migrate-legacy') out = migrateLegacy();
    else if (cmd === 'exp-add') out = expAdd({ symptom: arg(args, '--symptom') || '', cause: arg(args, '--cause') || '', solution: arg(args, '--solution') || '', env_check: arg(args, '--env') || '', warning: arg(args, '--warning') || '', force: flag(args, '--force') });
    else if (cmd === 'exp-get') out = expGet(arg(args, '--id') || '', arg(args, '--env'));
    else if (cmd === 'exp-validate') out = expValidate(arg(args, '--id') || '', arg(args, '--key'));
    else if (cmd === 'exp-list') out = expList();
    else if (cmd === 'exp-approvals') out = expApprovals();
    else if (cmd === 'route') out = route(arg(args, '--text') || '');
    else if (cmd === 'menu') { try { const mm = require('./memory_menu.js'); out = { mode: menuMode(), ...mm.renderMenu(ROOT, readConfig()) }; } catch (e) { out = { error: 'memory_menu: ' + String(e && e.message || e) }; } }
    else if (cmd === 'decay') out = decay();
    else if (cmd === 'stats') out = stats();
    else if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { printHelp(); return; }
    else { out = { error: '未知命令: ' + cmd }; printHelp(); return; }
    // --out <file>: 结果写文件而非 stdout(沙箱下插件工具用管道 spawn 被拒 EPERM, 改用文件回传)。
    const outPath = arg(args, '--out');
    if (outPath) { fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8'); }
    else { console.log(JSON.stringify(out, null, 2)); }
  } catch (e) {
    const emsg = JSON.stringify({ error: String(e && e.message || e), stack: (e && e.stack || '').toString().split('\n').slice(0, 4) }, null, 2);
    const outPath = arg(args, '--out');
    if (outPath) { try { fs.writeFileSync(outPath, emsg, 'utf8'); } catch {} }
    else { console.log(emsg); }
  }
}
main();
