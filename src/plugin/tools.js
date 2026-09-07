import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Self-contained: locate the memory data root (no hardcoded paths).
// Priority: 1) env DSH_MEMORY_ROOT  2) <co-located root>/memory.config.json memory_root
//           3) co-located root (two levels up from src/plugin)  4) current dir.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLOCATED = path.resolve(__dirname, '..', '..'); // <root>/src/plugin -> <root>
function loadConfigAt(dir) {
  try { const p = path.join(dir, 'memory.config.json'); if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')); } catch { /* ignore */ }
  return {};
}
function resolveMemRoot() {
  if (process.env.DSH_MEMORY_ROOT) return process.env.DSH_MEMORY_ROOT;
  const colocated = path.resolve(__dirname, '..', '..'); // <root>/src/plugin -> <root>
  // 2) config.memory_root (user can place at co-located root)
  const cfg = loadConfigAt(colocated);
  if (cfg && cfg.memory_root && existsSync(path.join(cfg.memory_root, 'memory_dual.js'))) return cfg.memory_root;
  // 1) co-located
  if (existsSync(path.join(colocated, 'memory_dual.js'))) return colocated;
  // 3) current dir fallback
  return colocated;
}
const MEM = resolveMemRoot();
// Use the node that is already running DSH (never missing), with an override.
const NODE = process.env.DSH_NODE || process.execPath;
const AGENT = path.join(MEM, 'memory_agent.js');
// 双轨后端 (memory_dual.js): 记忆网 + 经验档 + 管家分诊。与记忆根同处。
const AGENT2 = path.join(MEM, 'memory_dual.js');

// Run the CLI and always coerce into a plain JSON object (never a bare value
// or a thrown stack trace). 沙箱下子进程默认管道 stdio 被拒(EPERM), 所以用
// `--out 临时文件` 让后端写文件回传, 宿主只读文件, 不经过管道。
function runFile(backend, cmd, args) {
  const tmp = path.join(os.tmpdir(), 'mem_' + process.pid + '_' + Date.now() + '.json');
  execFileSync(NODE, [backend, cmd, ...args, '--out', tmp], { stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
  let raw = '';
  try { raw = readFileSync(tmp, 'utf8'); } catch { /* ignore */ }
  try { unlinkSync(tmp); } catch { /* ignore */ }
  try {
    const parsed = JSON.parse(raw.trim());
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : { result: parsed };
  } catch {
    return { raw: raw.trim() };
  }
}
function run(cmd, args) { return runFile(AGENT, cmd, args); }
// Same coercion guard for the dual-track backend (memory_dual.js).
function run2(cmd, args) { return runFile(AGENT2, cmd, args); }

const txt = (o) => [{ type: 'text', text: JSON.stringify(o, null, 2) }];

// 极短/无意义输入(嗯/哦/好/ok/表情…)不写, 避免“穷举陷阱”用废话淹没关键记录。
function isTrivial(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return true; // 单字/空, 大概率是应付
  return /^(嗯|哦|额|嗯嗯|哦哦|好|好的|好的好的|收到|ok|OK|哈哈|呵呵|啊|哈|可以|好的吧|行|明白了)$/.test(t);
}
// 自动写入开关/阈值/触发词配置, 从记忆根 memory.config.json 读取(实时, 改完即生效)。
function loadAutoLogConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(MEM, 'memory.config.json'), 'utf8')); } catch {}
  return (c && typeof c === 'object') ? c : {};
}
// Auto-log a single conversation turn into memory as a summary entry. Called by
// the plugin's session/event hook on every user message (方案A: 每次对话写一条
// 摘要沉淀). Never throws — a logging failure must not break the turn.
//
// 写入判定顺序(cfg 来自 memory.config.json, 全部可选, 均有内置默认):
//   auto_log_enabled=false          -> 关闭自动写入
//   isTrivial(text)                 -> "嗯/哦/ok…"等敷衍输入不写(非闲聊)
//   auto_log_trigger_words=[...]    -> 设了触发词时, 只有命中才写("只有说'记住'才写")
//   否则                            -> 没设触发词时, 用 auto_log_min_length 长度阈值(默认10)
export function memoryLogTurn(userText, tag = '对话记录', cfg = loadAutoLogConfig()) {
  try {
    const text = String(userText || '').trim();
    if (!text) return { skipped: 'empty' };
    if (cfg.auto_log_enabled === false) return { skipped: 'disabled' };   // 开关
    if (isTrivial(text)) return { skipped: 'noise' };                      // 非闲聊
    const triggers = Array.isArray(cfg.auto_log_trigger_words) ? cfg.auto_log_trigger_words : [];
    if (triggers.length > 0) {
      if (!triggers.some(w => w && text.includes(w))) return { skipped: 'no-trigger' }; // 设了触发词但没命中
    } else {
      const minLen = Number.isFinite(+cfg.auto_log_min_length) ? +cfg.auto_log_min_length : 10;
      if (text.length < minLen) return { skipped: 'too-short' };           // 长度阈值
    }
    const summary = text.length > 200 ? text.slice(0, 200) + '…' : text;
    return run('write', ['-t', tag, '-k', '对话记录,自动记录', '-s', summary]);
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

function tool(name, description, params, required, fn) {
  return {
    name,
    description,
    parameters: { type: 'object', additionalProperties: true, properties: params, required },
    // DSH asserts output.schema with assertSupportedJsonSchema: a bare object
    // root is valid (single type, boolean additionalProperties, no type array).
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [txt(value)],
    },
    isConcurrencySafe: () => false,
    async execute(args) { return fn(args || {}); },
  };
}

export function createMemoryTools() {
  return [
    tool('memory_write', 'Write a memory entry (tag + summary + optional full text).',
      { tag: { type: 'string', description: '分类标签, 建议细分如 MC技术-附魔乘区' }, tags: { type: 'array', items: { type: 'string' }, description: '副标签数组, 便于跨标签检索, 可选' }, keywords: { type: 'array', items: { type: 'string' }, description: '关键词数组' }, summary: { type: 'string', description: '一句话摘要(会被纳入搜索/召回)' }, full_text: { type: 'string', description: '详见/全文(可选, 存冷层)' } },
      ['tag', 'summary'], (a) => run('write', ['-t', a.tag, '-k', (a.keywords || []).join(','), '-s', a.summary, '-f', a.full_text || '', '-t2', (a.tags || []).join(',')])),
    tool('memory_summary', 'Read the tiny navigation index (few KB). Pass tag to narrow.',
      { tag: { type: 'string' } }, [], (a) => run('summary', (a.tag ? ['-t', a.tag] : []))),
    tool('memory_search', 'Return matching entries (tag + keywords + one-line summary, no file open). Optional tag/query filter.',
      { tag: { type: 'string', description: '分类标签(前缀命中)' }, query: { type: 'string', description: '关键词/摘要文字' } }, [], (a) => run('search', (a.tag ? ['-t', a.tag] : []).concat(a.query ? ['-q', a.query] : []))),
    tool('memory_read', 'Read an entry detail (add fullText=true for full text).',
      { query: { type: 'string', description: '关键词/标签(必填)' }, fullText: { type: 'boolean', description: 'true=读冷层全文' } }, ['query'], (a) => run('read', ['-q', a.query].concat(a.fullText ? ['--fulltext'] : []))),
    tool('memory_touch', 'Bump access_count for entries matching a tag/query (used when the current conversation mentions a tag).',
      { query: { type: 'string', description: '标签或关键词(命中即+1)' }, id: { type: 'string', description: '条目 id(优先)' } }, [], (a) => run('touch', ['-q', a.query || a.id || ''])),
    tool('memory_prune', 'Forget cold entries (archive to archive_data by default). Per-tag (drawer) cap.',
      { maxCold: { type: 'integer', description: '每个标签抽屉的冷层保留上限(条数)' }, maxAgeDays: { type: 'integer', description: '超过多少天未访问视为过期' }, delete: { type: 'boolean', description: 'true=真删, false=归档到archive_data' } }, [],
      (a) => run('prune', ['--max-cold', String(a.maxCold || 200), '--max-age-days', String(a.maxAgeDays || 60)].concat(a.delete ? ['--delete'] : []))),
    tool('memory_protect', 'Vault an entry (id or keyword/query) so prune never deletes it.',
      { id: { type: 'string', description: '条目 id(优先)' }, query: { type: 'string', description: '关键词/摘要文字(命中即保护)' } }, [],
      (a) => run('protect', ['-i', a.id || a.query || ''])),
    tool('memory_unprotect', 'Un-vault an entry (id or keyword/query).',
      { id: { type: 'string', description: '条目 id' }, query: { type: 'string', description: '关键词/摘要文字' } }, [],
      (a) => run('unprotect', ['-i', a.id || a.query || ''])),
    tool('memory_vault', 'List vaulted (protected) entry ids.', {}, [], () => run('vault', [])),
    tool('memory_migrate', 'Demote by heat: acc>=3 stays hot; older than 7d & acc<=1 -> cold; older than 30d & acc==0 -> garbage.', {}, [], () => run('migrate', [])),
    tool('memory_stats', 'Memory stats.', {}, [], () => run('stats', [])),
    /* ================= 双轨: 记忆网 ================= */
    tool('memory_net_add', '记忆网: 新增记忆节点(关联边+向量+摘要). tags 用于分区锁和精准检索, summary 限20字, warning=防坑提醒.',
      { tags: { type: 'array', items: { type: 'string' }, description: '标签列表(用于分区锁/精准检索, 建议含高频关键词)' }, content: { type: 'string', description: '完整原文 full_text' }, summary: { type: 'string', description: '固定长度摘要, ≤20字' }, warning: { type: 'string', description: '两条铁律/防坑提醒, 写入 warning 字段' }, links: { type: 'array', items: { type: 'object' }, description: '关联边 [{target_node_id,relation_type,edge_weight}]' } },
      ['content', 'summary'], (a) => run2('net-add', ['--tags', (a.tags || []).join(','), '--content', a.content || '', '--summary', a.summary || '', '--warning', a.warning || '', '--link', (a.links || []).map(l => `${l.target_node_id},${l.relation_type || 'related'},${l.edge_weight || 0.5}`).join(';')])),
    tool('memory_net_search', '记忆网: 模糊检索. 相似度>=阈值自动激活节点并拉相邻2条关联节点摘要(注入≤500 token).',
      { query: { type: 'string' }, threshold: { type: 'number', description: '覆盖管家阈值(默认0.85)' } }, ['query'],
      (a) => run2('net-search', ['--query', a.query || ''].concat(a.threshold != null ? ['--threshold', String(a.threshold)] : []))),
    tool('memory_net_read', '记忆网: 按 node_id 读全文+关联边.', { node_id: { type: 'string' } }, ['node_id'], (a) => run2('net-read', ['--id', a.node_id || ''])),
    tool('memory_net_softdelete', '记忆网: 软删除节点(status=garbage, 永不物理删除).', { node_id: { type: 'string' } }, ['node_id'], (a) => run2('net-softdelete', ['--id', a.node_id || ''])),
    tool('memory_net_list', '记忆网: 列出所有节点.', {}, [], () => run2('net-list', [])),
    /* ================= 双轨: 经验档 ================= */
    tool('memory_exp_add', '经验档: 记录技术报错案卷(症状/原因/解法/环境). 低风险自动写, 高风险挂起审批报告.',
      { symptom: { type: 'string' }, cause: { type: 'string' }, solution: { type: 'string' }, env: { type: 'string', description: '环境版本 如 MC1.20.1/A770/16G' }, warning: { type: 'string' } },
      ['symptom', 'cause', 'solution'], (a) => run2('exp-add', ['--symptom', a.symptom || '', '--cause', a.cause || '', '--solution', a.solution || '', '--env', a.env || '', '--warning', a.warning || ''])),
    tool('memory_exp_get', '经验档: 读案卷. 当前环境与案卷不符 -> 锁死提示"旧档失效需重新验证".',
      { card_id: { type: 'string' }, env: { type: 'string', description: '当前环境' } }, ['card_id'],
      (a) => run2('exp-get', ['--id', a.card_id || ''].concat(a.env ? ['--env', a.env] : []))),
    tool('memory_exp_validate', '经验档: 验证+1. validated_count>=3 时积分永久锁死不衰减.', { card_id: { type: 'string' } }, ['card_id'], (a) => run2('exp-validate', ['--id', a.card_id || ''])),
    tool('memory_exp_list', '经验档: 列出所有案卷.', {}, [], () => run2('exp-list', [])),
    tool('memory_exp_approvals', '经验档: 列出挂起的高风险审批报告.', {}, [], () => run2('exp-approvals', [])),
    /* ================= 双轨: 管家 + 衰减 ================= */
    tool('memory_route', '管家分诊: 判断这句话该进记忆网/经验档, 还是交还主模型处理(相似度>0.85才强行分类).',
      { text: { type: 'string' } }, ['text'], (a) => run2('route', ['--text', a.text || ''])),
    tool('memory_decay', '积分衰减扫描: v>=3永锁, 高频不衰减, 超30天扣5%, 积分<=5且未验证才标垃圾.', {}, [], () => run2('decay', [])),
    tool('memory_dual_stats', '双轨统计: 记忆网/经验档/管家/积分规则.', {}, [], () => run2('stats', [])),
  ];
}
// Render the tiny navigation index (memory_summary) as a compact, readable
// prompt section. Used to auto-seed memory into every assembled prompt so the
// model always sees what it has stored without calling a tool first. Safe to
// call with an empty memory; returns a fixed "no entries yet" guidance line.
export function memoryNavText() {
  let res;
  try {
    res = run('summary', []);
  } catch {
    res = null;
  }
  if (!res || typeof res !== 'object') return '[memory-nav] 记忆库不可用或为空。';
  const tags = res.tags;
  const tagKeys = tags && typeof tags === 'object' ? Object.keys(tags) : [];
  if (tagKeys.length === 0) {
    return '[memory-nav] 记忆库目前为空。可用 memory_write 记录重要结论；之后每次会话都会在这里看到记忆索引。';
  }
  const header = '[memory-nav] 已存记忆索引(标签 → 最近摘要):';
  const footer = '如需详情用 memory_read -q 关键词；新信息用 memory_write 记录；重要条目用 memory_protect 加固。';
  const entries = [];
  for (const tag of tagKeys) {
    const arr = Array.isArray(tags[tag]) ? tags[tag] : [];
    for (const it of arr) {
      const sum = (it && it.summary) ? String(it.summary) : '';
      const ts = (it && it.ts) ? String(it.ts).slice(0, 10) : '';
      entries.push(`- [${tag}] ${ts} ${sum}`.trim());
    }
  }
  // 理论最低极限护栏(可配置): 导航注入每次提示词, 若规模过大(标签/条目极多)会挤占模型上下文窗口,
  // 故限制行数与字符数, 超出则截断并提示用精确检索。可在 memory.config.json 的
  // dual_track.memory_network.nav_max_entries / nav_max_chars 覆盖, 默认 120 / 4000。
  const _cfg = loadConfigAt(MEM);
  const _cfg2 = Object.keys(_cfg).length ? _cfg : loadConfigAt(COLOCATED);
  const _mn = (_cfg2 && _cfg2.dual_track && _cfg2.dual_track.memory_network) || {};
  const NAV_MAX_ENTRIES = Number(_mn.nav_max_entries) > 0 ? Number(_mn.nav_max_entries) : 120;
  const NAV_MAX_CHARS = Number(_mn.nav_max_chars) > 0 ? Number(_mn.nav_max_chars) : 4000;
  let body = entries;
  if (body.length > NAV_MAX_ENTRIES) body = body.slice(0, NAV_MAX_ENTRIES);
  let out = [header, ...body, footer].join('\n');
  if (entries.length > NAV_MAX_ENTRIES) {
    out += `\n[memory-nav] …(导航索引已达 ${NAV_MAX_ENTRIES} 条上限, 已截断; 精确检索用 memory_search -q 关键词)`;
  } else if (out.length > NAV_MAX_CHARS) {
    out = out.slice(0, NAV_MAX_CHARS) + '\n[memory-nav] …(超出字符上限, 已截断; 精确检索用 memory_search)';
  }
  return out;
}
export default createMemoryTools;
