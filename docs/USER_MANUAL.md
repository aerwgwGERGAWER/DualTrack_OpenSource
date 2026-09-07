# DualTrack Memory 使用说明书（中文版）

> 面向使用者。本篇讲「怎么用、怎么理解、遇到问题怎么办」。AI 助手自动安装请看 [`AI_INSTALL.md`](./AI_INSTALL.md)，便携版请看 [`INSTALL_PORTABLE.md`](./INSTALL_PORTABLE.md)。

---

## 一、这是什么

**DualTrack Memory** 是一个给 AI Agent 用的**开源白盒记忆系统**。它让 AI 能跨会话、跨窗口持久保存并随时取回记忆，且**存储无限、上下文有限**——通过「小导航 + 按需读详情 + 遗忘」来管理。

它把记忆分成**两条独立轨道**，互不干扰：

| 轨道 | 存什么 | 负责 | 一句话 |
|---|---|---|---|
| **记忆网**（memory_network.json） | 节点 + 关联边 + 标签 | **模糊联想** | 日常闲聊 / 背景 / 模糊检索：「上次那个包」 |
| **经验档**（experience_cards） | 病例/原因/解法/环境/警告 | **精准排错** | 技术报错 / 故障 / 修复 |

## 二、核心概念

- **管家（router）**：每来一句话，先分诊该进哪个轨道。先做「技术报错 / 排错」**关键词匹配**（命中则先入经验档）；未命中再**用语义相似度判断**：**相似度 > 0.85 才强行归类进记忆网**，否则**交还主模型**处理。默认用零依赖哈希向量，`embedding_provider: "bge"` + 模型路径即可切换到 bge-m3。
- **积分制（scoring）**：`Total_Score = 访问次数 + 使用次数×2 + 验证次数×5`。
  - **高频不衰减**（近 7 天被用）；
  - **低频衰减**（>30 天未用扣 5%）；
  - **核心记忆永存**：`validated_count >= 3` 锁死，永不衰减、永不清理。
- **标签级分布式锁**：按标签分区加锁，双开/多开不互杀、不写穿、不丢数据。
- **软删除**：删除只标 `garbage` + `deleted_at`，**永不物理删除**，可回溯。
- **语义向量可插拔**：默认哈希（零依赖），bge 预留插槽。

## 三、安装

要求 **Node.js >= 18**。核心零依赖。

```bash
# 1. 生成配置(可省, 默认零依赖即可跑)
cp config/memory.config.template.json memory.config.json
# 2. 自检(会创建数据目录并统计)
node src/memory_dual.js stats
```
看到返回 `{ "version": "2.0", "network": {...}, "experience": {...} }` 即安装成功。

## 四、配置说明（memory.config.json）

| 字段 | 作用 | 默认 |
|---|---|---|
| `memory_root` | 记忆数据根目录（任意盘符），留空则用配置所在目录 | 配置目录 |
| `dual_track.router.embedding_provider` | 语义向量：`"hash"` 或 `"bge"` | `"hash"` |
| `dual_track.router.sim_threshold` | 管家强行分类的相似度阈值 | `0.85` |
| `dual_track.router.tech_keywords` | 技术词偏置（经验档） | 内置 |
| `dual_track.memory_network.summary_max_len` | 记忆网摘要字数上限 | 20 |
| `dual_track.experience_cards.risk_keywords_high/low` | 高风险/低风险自动判定关键词 | **内置默认**（见下） |
| `scoring.*` | 积分/衰减/永存规则 | `access*1 + use*2 + validated_count*5` 等 |
| `lock.strategy` | 并发锁策略（标签分区） | `tag-partition` |

> **关键默认保障**：即使 `memory.config.json` 丢失或被清空，引擎也用内置默认参数运行。其中**风险分级关键词**用内置默认（高风险：改源码/底层/跨版本/重写/hook/注入/内核/系统级；低风险：调整/微调/改参数/调参/配置），**保证默认状态下「高风险→挂审批」永远生效**。

## 五、数据存储布局

```
memory_root/
├─ memory_network.json        记忆网全局索引
├─ network_shards/<tag>.json  按标签分片的节点+边
├─ experience_cards/EXP-*.json 经验档文件
├─ experience_index.json      经验档索引
├─ approvals/                 高风险「挂审批」报告
├─ .locks/                    标签级分布式锁(临时)
└─ memory.config.json         配置(若放在数据根)
```

## 六、命令速查

引擎是 CLI：`node src/memory_dual.js <命令> [参数]`。用 `node src/memory_dual.js --help` 看帮助。

### 记忆网（模糊联想）
```bash
node src/memory_dual.js net-add --tags 技术-插件 --content "完整原文全文本" --summary "短摘要(≤20字)" --warning "防坑提醒" [--link 目标node_id,related,0.6]
node src/memory_dual.js net-search --query "关键词" [--threshold 0.4]   # 相似度排序; ≥阈值自动激活+拉相邻2条摘要
node src/memory_dual.js net-read --id <node_id>                          # 读全文+边+warning
node src/memory_dual.js net-softdelete --id <node_id>                    # 软删除(标garbage, 不物理删)
node src/memory_dual.js net-list                                         # 列节点
```

### 经验档（精准排错）
```bash
node src/memory_dual.js exp-add --symptom s --cause c --solution s --env "MC1.20.1/A770/16G" --warning w [--force]
node src/memory_dual.js exp-get --id EXP-xxxx --env "当前环境"    # 环境不符 → 锁死"旧档失效需重新验证"
node src/memory_dual.js exp-validate --id EXP-xxxx               # 验证+1, v>=3 永锁
node src/memory_dual.js exp-list
node src/memory_dual.js exp-approvals                            # 待审批的高风险经验档
```

### 管家 / 衰减 / 统计
```bash
node src/memory_dual.js route --text "这句话"     # 分诊: net | exp | null(交还主模型)
node src/memory_dual.js decay                     # 积分衰减扫描
node src/memory_dual.js stats                     # 双轨统计
```

**风险分级**：`exp-add` 会按 `风险关键词` 自动判定——**低风险**（仅方案调整）**自动写入**；**高风险**（改源码/跨版本/底层）**生成审批报告挂起**，等人工确认。

## V1.2 新增功能详解

### facts（任务事实单）
让主模型把「这次干了啥」告诉管家，据此更新边权/分层。

- 命令：`facts --op-level <1-5> --used <id,...> --ignored <id,...>`
- 参数含义：
  - `--op-level`：本次操作等级（1-5），缺省按 3（工作）。管家读 `dsh-web.log` 交叉验证：报 5 但无码操作→降 3；日志高密度但报 3→提 4。
  - `--used`：主模型反馈「此记忆帮我解决了问题」的节点，其边 +0.5，打「真实有用」。
  - `--ignored`：主模型反馈「此记忆看了但没用」的节点，其边 -0.2，打「待命池」标记。
- 标准示例（3 个）：
  1. 高密度修改（op=5）：`node src/memory_dual.js facts --op-level 5 --used aaa123,bbb456 --ignored ccc789`
  2. 普通查询（op=3）：`node src/memory_dual.js facts --op-level 3 --used ddd000`
  3. 纯闲聊（op=1）：`node src/memory_dual.js facts --op-level 1 --ignored eee111`

### --level（分层设定）
节点写入时设定 `memory_level`（1-5）；`validated_count>=3` 强制 L5；节点<5000 且 `max_level<5` 时 L2 并入 L1、L4 并入 L3。

| 级别 | 名称 | 含义 | 衰减规则 |
|---|---|---|---|
| L1 | 极浅 | 纯日常闲聊，无工具调用 | 最易衰减 |
| L2 | 普通 | 有工具调用，未涉核心代码 | 常规衰减（<5000 并入 L1） |
| L3 | 工作 | 常规技术修改、正常排错 | 正常衰减 |
| L4 | 重要 | 核心架构修改、高危修复(BOM/EPERM) | 慢衰减（<5000 并入 L3） |
| L5 | 核心锁死 | validated_count>=3 | 永锁不衰减 |

命令：`node src/memory_dual.js net-add --tags 技术-插件 --content "全文" --summary "短摘要(≤20字)" --level 4`

### context_score（动态边权）
边上的权重，决定检索时关联线索的取值排序。

| 规则 | 值 | 场景 |
|---|---|---|
| 默认 | 0.1 | 新边初始值 |
| 命中 | +0.5 | 「这次真帮我解决了问题」→ 加粗 |
| 忽略 | -0.2 | 「看了但没用」→ 变细，锁底 |
| 下限 | 0.1 | 减到 0.1 后锁死，严禁删边 |
| 核心锁 | 5.0 | validated_count>=3 → 该节点所有边强制 5.0，无视加减 |
| 休眠 | ×0.5 | 距上次激活 >30 天 → 该边权减半 |

场景：主模型 `facts --used` 命中一条，其相关边 +0.5；`net-search` 激活后按边权从高到低取前 5（少则前 3）作关联线索簇。

## 七、常见操作场景

1. **记一段知识**：`net-add`（tags 建议含高频关键词，summary 简短，内容写全文，warning 写防坑）。
2. **回忆一段记忆**：`net-search` 模糊检索；`net-read` 读全文。
3. **记录一个 bug**：`exp-add`（症状/原因/解法/环境）。
4. **查一个经验档**：`exp-get`；环境变过就用 `--env` 传当前环境，会提示「旧档失效」。
5. **让系统自己分类**：`route` 一句话 → 判断进网/进档/交还主模型。

## 八、DSH 插件集成（可选）

本仓库含一个 DSH 插件（`src/plugin/`）。安装到 DSH 后提供 `memory_net_*`、`memory_exp_*`、`memory_route`、`memory_decay`、`memory_dual_stats` 等工具，AI 可直接调用。插件调用引擎时，若在沙箱内子进程管道被拒（`EPERM`），会自动用 `--out 临时文件` 回传，无需人工干预。

## 九、FAQ / 报错

- **经验档风险审批失效**：先检查 `memory.config.json` 是否存在或被清空（见 INSTALL_PORTABLE 开头的【重要提示】）。系统会内置默认关键词兜底，但建议恢复配置。
- **`EPERM ... .lock`**：数据根不可写，把 `memory_root` 指到有写权限的目录。
- **`corrupt session log: seq gap`**：属会话数据问题（非本库），由会话读取器恢复或开新会话。
- **`module not found` / `Unknown frame descriptor`**：Node 版本过低或格式私有，升级 Node / 勿手工重写多帧 zstd 文件。

## 十、声明

本项目为满足个人开发需求发布，作者精力有限，**不提供人工技术支持与安装指导**。遇到问题请使用你的 AI 助手自行解决。
