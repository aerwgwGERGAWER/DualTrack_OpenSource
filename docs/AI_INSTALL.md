# AI 安装与排错手册（供 AI 智能体阅读）

> **本手册专供 AI 智能体阅读，请将本节内容连同项目源码一并输入给您的 AI 助手，让它为您完成环境配置与排错。**

后面所有推断只依赖本仓库代码与你的实际环境，不依赖作者人工支持。

---

## 一、环境准备

1. 确认已安装 **Node.js >= 18**：`node --version`。若无，请先安装。
2. 本仓库核心零依赖（默认哈希向量），无需 `npm install`（**基础仍需 Node.js ≥ 18**；"零依赖"指无需额外安装 npm 包/模型/联网，而非无需 Node）。
3. 若要用 bge-m3 语义向量，请准备模型文件或 HTTP 接入点，见「配置指引」。

## 二、配置指引

1. 拷贝配置模板到引擎可读位置（可放到仓库根或数据根）：
   ```bash
   cp config/memory.config.template.json memory.config.json
   ```
   或在 `config/.env.example` 基础上创建 `.env`，按需填写：
   `DEEPSEEK_API_KEY` / `DSH_MEMORY_ROOT`（数据根，任意盘符）/ `DSH_MEMORY_BGE_MODEL` / `DSH_MEMORY_BGE_ENDPOINT`。

2. `memory.config.json` 关键字段：
   - `memory_root`：记忆数据根目录（留空则用引擎所在目录）。
   - `dual_track.router.embedding_provider`：`"hash"`（默认零依赖）或 `"bge"`（需配模型/端点）。
   - `dual_track.router.sim_threshold`：管家强行分类的相似度阈值（默认 0.85）。
   - `scoring.*`：积分与衰减规则（`validated_lock>=3` 为核心记忆永存）。

3. **关键默认保障（无配置文件也能运行）**：
   - 即使没有 `memory.config.json`（或它丢失/被清空），引擎也会用内置默认参数运行。
   - **风险分级默认**：`experience_cards.risk_keywords_high/low` 缺省时用内置默认（高风险：改源码/底层/跨版本/重写/hook/注入/内核/系统级；低风险：调整/微调/改参数/调参/配置）。
   - **因此默认状态下「高风险→挂审批」永远生效**。若发现风险审批失效，请先检查 `memory.config.json` 是否存在、是否被清空（见「常见报错」）。

## 三、运行流程

```bash
# 1. 自检(会创建数据目录并统计，无数据也正常)
node src/memory_dual.js stats

# 2. 写入一条记忆网节点
node src/memory_dual.js net-add --tags 技术-插件 --content "完整原文" --summary "短摘要(≤20字)"

# 3. 检索记忆网
node src/memory_dual.js net-search --query "关键词"

# 4. 管家分诊(判断一条话进记忆网/经验档/交还主模型)
node src/memory_dual.js route --text "服务端崩了"

# 5. 经验档(技术排错)
node src/memory_dual.js exp-add --symptom s --cause c --solution s --env "MC1.20.1/A770/16G" --warning w
node src/memory_dual.js exp-get --id EXP-xxxx --env "当前环境"

# 6. 积分衰减扫描(验证永存/衰减规则)
node src/memory_dual.js decay

# 7. 任务事实单(V1.1: 主模型告诉管家这次干了啥, 更新边权/分层)
node src/memory_dual.js facts --op-level 5 --used <node_id,...> --ignored <node_id,...>
```

## V1.2 快速说明
- `facts --op-level 1-5`：主模型每会话结束输出《任务事实单》，`--used`(+0.5 真实有用)、`--ignored`(-0.2 待命池)；`--op-level` 缺省按 3，管家读 `dsh-web.log` 交叉验证（报 5 无码操作→降 3，日志高密度报 3→提 4）。
- `--level 1-5`：`net-add` 时设定记忆分级；`validated_count>=3` 强制 L5；节点<5000 且 max_level<5 时 L2 并入 L1、L4 并入 L3。
- `context_score`：边默认 0.1、命中 +0.5、忽略 -0.2、下限 0.1、`validated_count>=3` 锁 5.0、>30 天未唤醒 ×0.5。

## 四、常见报错处理逻辑

- **经验档风险审批失效（本应挂审批却直接写入）**：
  - 原因：`memory.config.json` 丢失或被清空，导致 `risk_keywords_high/low` 读不到；但引擎内置默认关键词仍应兜底。
  - 处理：**先检查 `memory.config.json` 是否存在、是否为空**。若确实被清空，重新从 `config/memory.config.template.json` 拷贝即可；即便不恢复，内置默认关键词也能维持「高风险→挂审批」。
- **`EPERM: operation not permitted, open '...memory.config.json.lock'`**（或任何 `.lock` 写入失败）：
  - 原因：沙箱/权限限制了在 `memory_root` 下新建 `.lock` 文件（多进程互斥锁）。
  - 处理：把 `memory_root` 指到你有写权限的目录；或在 sandbox 下改用 `--out <文件>` 回传、避免管道 spawn（插件工具已内置此逻辑）。
- **`Unknown frame descriptor` / 多帧 zstd 解压失败**：
  - 原因：Node 内建 zstd 只认单帧；会话日志用的是多帧 zstd 私有容器。
  - 处理：不要手工重写这类文件；依赖读取器自身的「回退到最后一个提交字节」策略。
- **`corrupt session log: seq gap in committed region ...`**：
  - 原因：会话事件日志 seq 不连续（多因进程中途崩溃）。
  - 处理：属会话数据问题，不属本库；建议由支持该格式的读取器恢复，或开新会话。
- **`module not found` / `node:xxx` 缺失**：
  - 原因：Node 版本过低或缺内建模块。
  - 处理：升级到 Node >= 18；本项目只用 `node:fs`/`node:path`/`node:crypto`/`node:zlib`/`node:child_process`/`node:os`，均为内建。
- **`unsupported JSON schema: schema must be a schema object`**：
  - 原因：工具 output schema 非法（插件注册时）。
  - 处理：把 `output.schema` 限制为 `{ type: 'object', additionalProperties: true }` 这类受支持子集。
- **`memory declares dsh.client but exports no './client' bundle`**：
  - 原因：插件声明了客户端 bundle 却无对应导出。
  - 处理：插件保持纯 host 端，删除 `dsh.client` 声明。

## 五、系统自检指令

```bash
node src/memory_dual.js stats                         # 统计(记忆网/经验档/积分规则)
node src/memory_dual.js net-list                      # 记忆网节点数
node src/memory_dual.js exp-list                      # 经验档卡片数
node src/memory_dual.js route --text "测试分诊"        # 管家是否正常返回 target/null
node src/memory_dual.js decay                         # 衰减扫描是否正常返回 locked/decayed/garbage
node --check src/memory_dual.js                       # 语法自检
```

自检要点：
- `stats` 能返回 JSON 即说明引擎可运行、数据根可写。
- `route` 对任意话应返回 `target`（`net`/`exp`/`null`）+ `reason`，若 `target=null` 且 `reason` 含「未达阈值」，属正常（交还主模型）。

## V1.2 进阶优化建议

当前默认使用**哈希向量**（`embedding_provider: "hash"`），**语义相似度偏低（约 0.2~0.5）**，因此管家「分诊阈值」`sim_threshold: 0.85` 在默认模式下**几乎不会触发**（多数话被交还主模型，属安全但主动分诊弱）。可按下述任一方式优化：

1. **安装 bge-m3 语义模型**（推荐，提升召回与主动分诊）：
   - 在 `memory.config.json` 设 `dual_track.router.embedding_provider: "bge"`，并填 `bge_model_path`（本地模型）或 `bge_endpoint`（HTTP 接入）。
   - 装好后 `stats` 的 `embedding_provider_used` 会变为 `bge`。
2. **调整分诊阈值**：若不装 bge，可把 `dual_track.router.sim_threshold` 从 0.85 调低（如 0.6）以让管家更主动分类，代价是误判率上升。
3. **按需改代码**：本系统为开源白盒，可按你的实际需求修改 `src/memory_dual.js`（如调整 `assessRisk` 风险词、`netSearch` 聚类 top 数、积分衰减参数等）。

> 提示：bge-m3 为可选增强项；默认零依赖哈希向量即可完整运行全部功能。

## 六、常见问题：杀毒软件拦截提醒

在安装或运行 `启动分诊脑.cmd / 停止分诊脑.cmd` 时，Windows Defender 或第三方杀毒软件（如火绒、360）可能会弹出"系统加固"或"发现程序试图操作"的警告。

**这是正常的误报现象，绝非病毒。** 因为脚本为了不让你看到黑框命令提示符，在后台使用了隐藏的 PowerShell 指令（`-WindowStyle Hidden`）来管理 Ollama 服务进程——出于安全考虑，杀毒软件会把"隐藏执行 PowerShell"识别为可疑行为并拦截。

**解决方法：**
1. 请在弹窗中勾选"记住本次操作"，并点击【允许】。
2. 如果不希望每次都收到提醒，请将整个数据根目录（即 `memory.config.json` 中的 `memory_root`，或项目安装根目录）添加到杀毒软件的"信任区"或"白名单"中。

## 七、可选：安装本地小模型管家（分诊脑）

> **重要：这一步是「可选」，不是必须，默认 `hash` 模式完全够用。请先询问用户是否要装，得到同意后再继续。**

### 0. 先问用户
```
「当前是纯本地哈希模式，零依赖、零开销，已能完整使用。
是否要额外安装『本地小模型管家』(Qwen 分诊脑, 让记忆分类更智能)?
  注意: 它需要在你自己电脑装 Ollama 并拉一个 ~1.4GB 的小模型(不花 API 钱, 但占本地资源)。
  装 / 不装?  (默认不装即可正常使用)」
```

### 1. 装了 vs 不装（整体效果对比）
| | 不装（默认 hash） | 装小模型管家（qwen） |
|---|---|---|
| 依赖 | 零依赖、纯本地 | 需本机 Ollama + 拉模型 |
| 分类方式 | 哈希相似度（弱主动分类） | 本地小模型三分类 `net/exp/skip` |
| 是否联网 | 否 | 否（本地推理，不花 API） |
| 分类主动性 | 低（多数交还主模型） | 高（本地模型主动硬判） |
| 生命周期 | 无 | EAC 运行时才拉起小模型，关闭即停 |
| 开销 | 0 | 本地 CPU/内存（不花 DeepSeek API 钱） |

### 2. 前置：管家需要哪些文件
主包是**干净核心**，不含管家脚本。管家文件（下列 4 个）要么来自**扩展包** `dsh-butler-extension-v1.2.zip`，要么来自**完整源码**（本仓库 `scripts/` 与 `src/`）：
- `butler-supervisor.mjs` — 生命周期守护（EAC 在→拉起 ollama；EAC 关→停；单实例/停止标记/宽限自救，绝不留僵尸）
- `启动分诊脑.cmd` / `停止分诊脑.cmd` — 双击启停（隐藏窗口，位置无关）
- `ollama_triage.cjs` — 引擎 `qwenTriageSync` 需要的分诊助手（须与引擎同目录）

> 若用扩展包：把上述文件解压到本仓库 `scripts/`（与 `src/`），或直接由 `install.mjs` 高级模式复制到数据根。

### 3. 若用户同意装：完整步骤
1. **设开关**：在 `memory.config.json` 设 `dual_track.router.triage_brain: "qwen"`（模型名可用 `triage_model` 指定，默认 `dualtrack-triage`）。
2. **装 Ollama**：<https://ollama.com> 下载安装；拉模型：`ollama pull qwen3:1.7b`（更省资源可 `qwen3:0.6b`）。
3. **建分诊模型**（一次性）：用 `config/triage.Modelfile` 生成无思考分诊模型：
   ```bash
   ollama create dualtrack-triage -f config/triage.Modelfile
   ```
4. **跑安装脚本**：`node scripts/install.mjs [数据根]`。此时 `triage_brain=qwen`，脚本会**按开关自动**把管家 4 文件复制到数据根，写入 `_butler_note` 使用说明，并生成 `README_BUTLER.txt`。
5. **开守护**：双击 `启动分诊脑.cmd`，或运行 `node butler-supervisor.mjs`（隐藏后台）。它会：持续监测 EAC 桌面端 → EAC 在自动拉起 `ollama serve`、EAC 关自动停掉，连续关闭超宽限期自动退出（不留僵尸）。
6. **关守护**：双击 `停止分诊脑.cmd`。
7. **校验**：`node src/memory_dual.js route --text "xxx"` 返回 `"brain":"qwen"` 即接入成功；`node butler-supervisor.mjs --check <配置>` 应输出 `qwen`。

> 注意：若主包不含管家模板，`install.mjs` 会提示「请安装 dsh-butler-extension-v1.2.zip」——此时先让用户装扩展包，或改用完整源码。

### 4. 安全与健壮性
- 守护只在 `triage_brain=qwen` 时激活；`hash` 双击启动脚本会提示「当前为哈希模式，无需启动」并退出。
- 单实例锁、停止标记、宽限自救，**不会变成僵尸进程**；杀毒软件对隐藏 PowerShell 的误报处理见「六、杀毒软件拦截提醒」。
