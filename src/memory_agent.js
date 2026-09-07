#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
// ROOT: env > 就近 config.memory_root > __dirname。无硬编码盘符, 任意目录可运行。
function resolveRoot(){
  if(process.env.DSH_MEMORY_ROOT)return process.env.DSH_MEMORY_ROOT;
  for(const cand of [__dirname,path.resolve(__dirname,'..'),path.resolve(__dirname,'..','..')]){
    try{const c=JSON.parse(fs.readFileSync(path.join(cand,'memory.config.json'),'utf8')); if(c&&c.memory_root)return c.memory_root;}catch{}
  }
  return __dirname;
}
const ROOT=resolveRoot();
const HOT=path.join(ROOT,'hot_data'),COLD=path.join(ROOT,'cold_data'),LOGS=path.join(ROOT,'chat_logs'),ARCH=path.join(ROOT,'archive_data');
const INDEX=path.join(ROOT,'index.json'),SUMIDX=path.join(ROOT,'summary_index.json'),VAULT=path.join(ROOT,'vault.json');
// ===== 迁移/清理 热力值规则(替换原来的 3 天计时器) =====
const HOT_KEEP_MIN_ACCESS=3;      // access_count>=3 -> 永久驻留热区, 绝不降级
const HOT_TO_COLD_DAYS=7;         // last_access>7天 且 access<=1 -> 下沉冷区
const HOT_TO_COLD_MAX_ACCESS=1;
const GARBAGE_DAYS=30;            // last_access>30天 且 access==0 -> 标记待清理垃圾
const GARBAGE_MAX_ACCESS=0;
// ===== 清理默认值 =====
const TAG_CAP=8;                  // summary_index 每标签最多保留条数
const KEEP_PER_TAG=200;           // 冷区“分抽屉(按标签)”每标签保留条数上限
const MAX_AGE_DAYS=60;            // 超过多少天未访问且低访问视为过期
const CONFIG=path.join(ROOT,'memory.config.json');
function ensureDirs(){for(const d of [HOT,COLD,LOGS,ARCH])fs.mkdirSync(d,{recursive:true});}
function loadJson(p,d){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return d;}}
function saveJson(p,o){const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(o,null,2),'utf8');fs.renameSync(t,p);}
// ===== 跨进程文件锁 (主DSH与便携启动器双开也会并行写同一批 JSON) =====
// 用“独占创建 <文件>.lock”实现互斥, 把“读-改-写”整段串行化, 避免丢失更新/损坏。
// 6 秒超时兜底(防进程崩溃残留锁), 25ms 退避防忙等。
function sleepMs(ms){try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,(ms>0?ms:1));}catch{}}
function withFileLock(p,fn){
  const lock=p+'.lock';const deadline=Date.now()+6000;let fd;
  while(true){
    try{fd=fs.openSync(lock,'wx');break;}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      if(Date.now()>deadline){try{fs.unlinkSync(lock);}catch{}continue;}
      sleepMs(25);
    }
  }
  try{return fn();}
  finally{try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(lock);}catch{}}
}
function loadIndex(){return loadJson(INDEX,{version:'1.1',entries:[]});}
function loadSum(){return loadJson(SUMIDX,{version:'1.0',tags:{}});}
function loadVault(){return loadJson(VAULT,{version:'1.0',ids:[]});}
// 可选配置文件, 覆盖上面的热力值/清理默认值; 缺省用硬编码默认。
function loadConfig(){let c={};try{c=JSON.parse(fs.readFileSync(CONFIG,'utf8'));}catch{}return (c&&typeof c==='object')?c:{};}
function nowIso(){return new Date().toISOString();}
function safe(s){return String(s).replace(/[^\w\u4e00-\u9fff.-]/g,'_');}
// One in-memory index mutation, saved once. Passed into touchBatch.
function write(tag,keywords,summary,full,extraTags){
  ensureDirs();
  const id=crypto.randomBytes(6).toString('hex'),ts=nowIso(),tagS=safe(tag);
  const hotPath=path.join(HOT,tagS+'_'+id+'.json');
  const coldPath=full?path.join(COLD,tagS+'_'+id+'.json'):'';
  const tags=Array.isArray(extraTags)?extraTags.filter(Boolean):[];
  const entry={id,tag,tags,keywords,summary,created_at:ts,last_access:ts,access_count:0};
  fs.writeFileSync(hotPath,JSON.stringify(entry,null,2),'utf8');
  if(full){fs.writeFileSync(coldPath,JSON.stringify(Object.assign({},entry,{full_text:full}),null,2),'utf8');}
  // 索引(read-modify-write)加锁, 避免双开并发 push 丢条目; 全文/热文件按唯一 id 命名, 无需锁。
  withFileLock(INDEX,()=>{
    const idx=loadIndex();
    idx.entries.push({id,tag,tags,keywords,summary,hot_path:hotPath,cold_path:coldPath,location:'hot',created_at:ts,last_access:ts,access_count:0});
    saveJson(INDEX,idx);
  });
  withFileLock(SUMIDX,()=>{
    const sum=loadSum();const arr=sum.tags[tag]||[];arr.unshift({id,summary,ts});sum.tags[tag]=arr.slice(0,TAG_CAP);saveJson(SUMIDX,sum);
  });
  return id;
}
// Apply a list of {id} touch records as one locked index save (self-contained).
function touchBatch(touches){
  withFileLock(INDEX,()=>{
    const idx=loadIndex();let changed=false;
    const map=new Map(idx.entries.map((e,i)=>[e.id,i]));
    for(const t of touches){
      const i=map.get(t.id);if(i===undefined)continue;
      const e=idx.entries[i];
      e.last_access=nowIso();e.access_count=(e.access_count||0)+1;changed=true;
    }
    if(changed)saveJson(INDEX,idx);
  });
}
function migrate(){
  ensureDirs();const moved=[];const cfg=loadConfig();const now=Date.now();
  const keepMin=cfg.hot_keep_min_access??HOT_KEEP_MIN_ACCESS;
  const toColdDays=cfg.hot_to_cold_days??HOT_TO_COLD_DAYS;
  const toColdMax=cfg.hot_to_cold_max_access??HOT_TO_COLD_MAX_ACCESS;
  const garbageDays=cfg.garbage_days??GARBAGE_DAYS;
  const garbageMax=cfg.garbage_max_access??GARBAGE_MAX_ACCESS;
  withFileLock(INDEX,()=>{
    const idx=loadIndex();
    for(const e of idx.entries){
      if(e.location!=='hot')continue;
      if(isVaulted(e.id))continue;                         // 保险库条目永不迁移
      const acc=e.access_count||0;
      if(acc>=keepMin)continue;                            // 热力值达标 -> 永久驻留热区
      const ageDays=(now-new Date(e.last_access).getTime())/86400000;
      if(ageDays>toColdDays&&acc<=toColdMax){
        e.location='cold';
        if(ageDays>garbageDays&&acc<=garbageMax)e.garbage=true; // 标记待清理垃圾
        moved.push(e.id);
      }
    }
    saveJson(INDEX,idx);
  });
  return moved;
}
function blobOf(e){return ((e.tag||'')+' '+((e.tags||[]).join(' '))+' '+(e.keywords||[]).join(' ')+' '+(e.summary||'')).toLowerCase();}
function search(query,tag){
  const idx=loadIndex();const q=String(query==null?'':query).toLowerCase();
  const hits=idx.entries.map(e=>{
    const matchTag=!tag||e.tag===tag||e.tag.startsWith(tag)||(Array.isArray(e.tags)&&e.tags.some(t=>t===tag||t.startsWith(tag)));
    const blob=blobOf(e);
    return {e,matchTag,matchQ:(!q||blob.includes(q))};
  }).filter(x=>x.matchTag&&x.matchQ);
  touchBatch(hits.map(x=>({id:x.e.id})));
  return hits.map(x=>({id:x.e.id,tag:x.e.tag,keywords:x.e.keywords,summary:x.e.summary,location:x.e.location,access_count:x.e.access_count,last_access:x.e.last_access}));
}
function read(query,full){
  const idx=loadIndex();const q=String(query==null?'':query).toLowerCase();const result=[];
  const hits=[];
  for(const e of idx.entries){
    const blob=blobOf(e);
    if(!blob.includes(q))continue;
    hits.push({id:e.id});
    let p=fs.existsSync(e.hot_path)?e.hot_path:e.cold_path;
    if(full&&e.cold_path&&fs.existsSync(e.cold_path))p=e.cold_path;
    if(p&&fs.existsSync(p)){const d=JSON.parse(fs.readFileSync(p,'utf8'));result.push({id:e.id,tag:e.tag,summary:d.summary,full_text:d.full_text,location:e.location});}
  }
  touchBatch(hits);
  return result;
}
function summary(tag){const sum=loadSum();if(tag)return {version:sum.version,tags:(sum.tags[tag]||[])};return sum;}
function stats(){const idx=loadIndex();const hot=idx.entries.filter(e=>e.location==='hot').length;const sum=loadSum();return {total:idx.entries.length,hot,cold:idx.entries.length-hot,nav_tags:Object.keys(sum.tags).length};}
// Resolve an id or a keyword/tag query to concrete entry ids.
function resolveIds(q){
  const idx=loadIndex();const s=String(q==null?'':q).trim();if(!s)return [];
  const exact=idx.entries.filter(e=>e.id===s).map(e=>e.id);
  if(exact.length)return exact;
  const low=s.toLowerCase();
  return idx.entries.filter(e=>blobOf(e).includes(low)).map(e=>e.id);
}
function protect(q){
  const ids=resolveIds(q);
  const v=withFileLock(VAULT,()=>{const vv=loadVault();for(const id of ids){if(vv.ids.indexOf(id)<0)vv.ids.push(id);}saveJson(VAULT,vv);return vv;});
  return {protected:ids,vault:v.ids};
}
function unprotect(q){
  const ids=resolveIds(q);
  const v=withFileLock(VAULT,()=>{const vv=loadVault();vv.ids=vv.ids.filter(x=>ids.indexOf(x)<0);saveJson(VAULT,vv);return vv;});
  return {unprotected:ids,vault:v.ids};
}
function vaultList(){return loadVault().ids;}
function isVaulted(id){return loadVault().ids.indexOf(id)>=0;}
// 直接给“被当前对话提到”的条目累计热度(search/read 已经在命中时 +1, 这里给
// 标签被提到时补一次)。供将来的 message 钩子或显式调用使用: touch -q <标签/id>。
function touch(q){
  const idx=loadIndex();const s=String(q==null?'':q).trim();if(!s)return {touched:[]};
  const low=s.toLowerCase();let hits;
  const exact=idx.entries.filter(e=>e.id===s);
  if(exact.length)hits=exact;
  else hits=idx.entries.filter(e=>e.tag===s||(Array.isArray(e.tags)&&e.tags.includes(s))||blobOf(e).includes(low));
  touchBatch(hits.map(e=>({id:e.id})));
  return {touched:hits.map(e=>e.id)};
}
function prune(keepCold,maxAgeDays,doDelete){
  ensureDirs();const cfg=loadConfig();const removed=[];
  const now=Date.now();
  const keepPerTag=(Number.isFinite(+keepCold)&&+keepCold>0)?+keepCold:(cfg.keep_per_tag??KEEP_PER_TAG);
  const maxAge=(Number.isFinite(+maxAgeDays)&&+maxAgeDays>0)?+maxAgeDays:(cfg.max_age_days??MAX_AGE_DAYS);
  const cutoff=now-maxAge*24*3600*1000;
  let toRemove={};
  withFileLock(INDEX,()=>{
    const idx=loadIndex();
    const cold=idx.entries.filter(e=>e.location==='cold');
    // 分抽屉: 按标签分组, 各自独立清理, 避免把活跃标签的冷区条目误伤。
    const byTag={};
    for(const e of cold){const t=e.tag||'__none__';(byTag[t]=byTag[t]||[]).push(e);}
    toRemove={};
    for(const tag in byTag){
      const group=byTag[tag];                    // 该“抽屉”里的所有冷区条目
      // 1) 过期/垃圾: 优先清(保险库条目除外)
      for(const e of group){
        if(isVaulted(e.id))continue;
        const last=new Date(e.last_access).getTime();
        if(e.garbage||(last<cutoff&&(e.access_count||0)<2))toRemove[e.id]=e;
      }
      // 2) 超限: 该抽屉最多保留 keepPerTag 条“非保险库”条目, 低访问+最久未用者出局。
      //    保险库条目在任何情况下都保留, 不参与裁剪, 避免 vaulted 占掉裁剪槽位导致超额。
      const survivors=group.filter(e=>!toRemove[e.id]).sort((a,b)=>
        (((a.access_count||0)-(b.access_count||0))||(new Date(a.last_access)-new Date(b.last_access))));
      const removable=survivors.filter(e=>!isVaulted(e.id));
      for(const e of removable.slice(0,Math.max(0,removable.length-keepPerTag)))toRemove[e.id]=e;
    }
    const ids=Object.keys(toRemove);
    idx.entries=idx.entries.filter(e=>!toRemove[e.id]);
    for(const id of ids){removed.push(id);const e=toRemove[id];
      for(const p of [e.hot_path,e.cold_path]){if(p&&fs.existsSync(p)){if(doDelete){try{fs.unlinkSync(p);}catch{} }else{try{fs.copyFileSync(p,path.join(ARCH,path.basename(p)));fs.unlinkSync(p);}catch{}}}}}
    saveJson(INDEX,idx);
  });
  withFileLock(SUMIDX,()=>{
    const sum=loadSum();let changed=false;
    for(const tag in sum.tags){const before=sum.tags[tag].length;sum.tags[tag]=sum.tags[tag].filter(x=>!toRemove[x.id]);if(sum.tags[tag].length!==before)changed=true;}
    if(changed)saveJson(SUMIDX,sum);
  });
  return {removed,archived_to:(doDelete?'(deleted)':'archive_data/'),keep_per_tag:keepPerTag,max_age_days:maxAge};
}
function main(){
  const args=process.argv.slice(2);const cmd=args[0];
  const arg=(n)=>{const i=args.indexOf(n);return i>=0?args[i+1]:undefined;};
  try{
    let out;
    if(cmd==='write'){out=write(arg('-t')||arg('--tag')||'',(arg('-k')||arg('--keywords')||'').split(',').filter(Boolean),arg('-s')||arg('--summary')||'',arg('-f')||arg('--full')||'',(arg('-t2')||arg('--tags')||'').split(',').filter(Boolean));}
    else if(cmd==='summary'){out=summary(arg('-t')||arg('--tag')||'');}
    else if(cmd==='search'){out=search(arg('-q')||arg('--query')||'',arg('-t')||arg('--tag')||'');}
    else if(cmd==='read'){out=read(arg('-q')||arg('--query')||'',args.includes('--fulltext'));}
    else if(cmd==='migrate'){out={moved:migrate()};}
    else if(cmd==='touch'){out=touch(arg('-q')||arg('--query')||arg('-i')||arg('--id')||'');}
    else if(cmd==='prune'){out=prune(parseInt(arg('--max-cold')||'200',10),parseInt(arg('--max-age-days')||String(MAX_AGE_DAYS),10),args.includes('--delete'));}
    else if(cmd==='protect'){out=protect(arg('-i')||arg('--id')||arg('-q')||arg('--query')||'');}
    else if(cmd==='unprotect'){out=unprotect(arg('-i')||arg('--id')||arg('-q')||arg('--query')||'');}
    else if(cmd==='vault'){out={vault:vaultList()};}
    else if(cmd==='stats'){out=stats();}
    else if(!cmd||cmd==='help'||cmd==='--help'||cmd==='-h'){printHelp();return;}
    else{out={error:'未知命令: '+cmd};printHelp();return;}
    // Wrap scalar returns (e.g. write returns an id) as a JSON object so the tool never gets a bare value.
    if(out!==undefined&&(typeof out!=='object'||out===null))out={result:out};
    // --out <file>: 结果写文件而非 stdout(插件工具在沙箱下管道 spawn 被拒 EPERM, 改用文件回传)。
    const _op=args.indexOf('--out'), _of=_op>=0?args[_op+1]:undefined;
    if(_of){fs.writeFileSync(_of,JSON.stringify(out,null,2),'utf8');}else{console.log(JSON.stringify(out,null,2));}
  }catch(e){
    const _emsg=JSON.stringify({error:String(e&&e.message||e),stack:(e&&e.stack||'').toString().split('\n').slice(0,4)},null,2);
    const _op2=args.indexOf('--out'), _of2=_op2>=0?args[_op2+1]:undefined;
    if(_of2){try{fs.writeFileSync(_of2,_emsg,'utf8');}catch{}}else{console.log(_emsg);}
  }
}
function printHelp(){
  console.log([
    'AI Memory CLI  —  调用:  memory <命令> [参数]',
    '',
    '  write     -t 标签 -k "k1,k2" -s 摘要 [-f 全文] [-t2 "x,y"(副标签)]     写入一条记忆',
    '  summary   [-t 标签]                               读超小导航索引(便宜,常在调用前先读)',
    '  search    [-t 标签] [-q 关键词]                    检索,返回 标签+摘要(不开文件,先确认)',
    '  read      -q 关键词 [--fulltext]                   读该条详情/全文',
    '  touch     -q 标签 | -i <id>                        给“当前对话提到”的标签累计热度(+1)',
    '  migrate                                            热力值下沉: acc>=3 驻热; >7天且<=1 下沉; >30天且==0 标垃圾',
    '  prune     [--max-cold 200(每标签上限)] [--max-age-days 60] [--delete]   分抽屉按标签清理',
    '  protect   -i <id> | -q 关键词                      保险库加固该条,迁移/prune 永不删',
    '  unprotect -i <id> | -q 关键词                      解除保险库加固',
    '  vault                                               查看被加固(protected)的条目 id',
    '  stats                                              统计(hot/cold/总条数/导航标签数)',
    '',
    '示例:',
    '  memory write -t 技术-插件 -k "插件,配置" -s "改配置常量把插件版本调至10万"',
    '  memory write -t MC技术 -t2 "硬件,闲聊" -s "跨标签示例"',
    '  memory search -q 插件   |   memory read -q 插件 --fulltext   |   memory protect -q 插件',
  ].join('\n'));
}
main();
