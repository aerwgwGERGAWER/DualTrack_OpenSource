# DualTrack Memory - 双轨记忆库

一个用于 AI Agent 的**开源白盒记忆系统**。支持模糊联想与精准排错，采用积分制管理，跨会话持久。

## 简介

DualTrack Memory 把「记忆」分成两条独立轨道，互不干扰：

- **记忆网（memory_network.json）**：负责**模糊联想**，像神经突触一样由节点和关联边相连。用于日常闲聊、背景提取、模糊检索；相似度达到阈值会自动激活节点并拉取相邻关联记忆。
- **经验档（experience_cards）**：负责**精准排错**，像侦探排错一样记录因果。只用于技术报错、故障排查、程序修复；带环境校验与「旧档失效」提示。

两条轨道由**管家（router）**分诊：先做「技术报错 / 排错」**关键词匹配**（命中则先入经验档）；未命中再计算语义相似度——**> 0.85 才强行归类进记忆网**，否则交还主模型处理。默认使用零依赖哈希向量（bge-m3 语义模型预留插槽，装好即切）。

## 快速开始

### 环境要求
- **Node.js >= 18**（含 node:zlib / node:child_process）
- 无其他运行时依赖（默认哈希向量零依赖）

### 依赖安装
本仓库无第三方运行时依赖。若需接入 bge-m3 语义向量，请按 `docs/AI_INSTALL.md` 配置。

### 启动 / 自检
```bash
# 1. 拷贝配置模板
cp config/memory.config.template.json memory.config.json

# 2. 自检(会创建数据目录并统计)
node src/memory_dual.js stats          # 双轨统计
node src/memory_dual.js route --text "服务端崩了"   # 管家分诊示例
```

### 常用命令
```bash
node src/memory_dual.js net-add --tags 技术-插件 --content "完整原文" --summary "短摘要" --warning "防坑提醒"
node src/memory_dual.js net-search --query "关键词"      # 记忆网检索
node src/memory_dual.js net-read --id <node_id>          # 读全文
node src/memory_dual.js exp-add --symptom s --cause c --solution s --env "MC1.20.1/A770/16G" --warning w
node src/memory_dual.js exp-get --id EXP-xxxx --env "当前环境"   # 经验档(环境校验)
node src/memory_dual.js route --text "这句话"             # 管家分诊: net | exp | null
node src/memory_dual.js decay                           # 积分衰减扫描
node src/memory_dual.js facts --op-level 5 --used <id> --ignored <id>   # 任务事实单(V1.1)
```

## V1.2 新特性
- **context_score 动态边权**：边默认 0.1，命中 +0.5、忽略 -0.2、下限 0.1，`validated_count>=3` 锁 5.0，>30 天未唤醒 ×0.5；检索按边权降序取前 5（少则前 3）作关联线索簇。
- **五级分层（--level / memory_level）**：L1 极浅 / L2 普通 / L3 工作 / L4 重要 / L5 核心锁死（`validated_count>=3` 强制 L5）；节点<5000 且 max_level<5 时 L2 并入 L1、L4 并入 L3。
- **任务事实单（facts）**：主模型每会话结束输出《任务事实单》，`--used`(+0.5 真实有用)、`--ignored`(-0.2 待命池)；`--op-level` 缺省按 3，管家读 `dsh-web.log` 交叉验证。
- **待命池（task_irrelevant）**：反馈「没用」→ 打标记，不减分/不降级/不删；下次匹配自动移除唤醒；池上限 2000，超出清最久未用 10 条。
- **优雅停机**：正常退出写 `state.json`（北京时间 ISO）；下次启动差值 >15 天 → 该时段所有节点/连线冻结不衰减。

## 核心特性
- **积分制动态权重**：`Total_Score = 访问次数 + 使用次数*2 + 验证次数*5`；高频不衰减、超30天未用扣5%、`validated_count>=3` 核心记忆永存（锁死不清理）。
- **标签级分布式锁**：按标签分区加锁，双开/多开不互杀、不写穿、不丢数据。
- **软删除**：删除仅标记 `garbage` + `deleted_at`，永不物理删除，便于回溯。
- **可插拔语义向量**：默认哈希（零依赖），`embedding_provider: "bge"` + 模型路径即切。

## 重要声明
> 本项目为满足个人开发需求发布，作者精力有限，**不提供任何人工技术支持与安装指导**。遇到问题请使用自己的 AI 助手（如 ChatGPT、DeepSeek、Claude 等）自行解决。

给 AI 助手的完整安装/排错手册见 [`AI_INSTALL.md`](./AI_INSTALL.md)。
