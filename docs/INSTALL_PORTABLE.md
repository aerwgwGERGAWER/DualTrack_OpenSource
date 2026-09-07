# 便携版使用说明书（便携使用者安装）

> ## ⚠️【重要提示】
> 如果你在安装了便携版之后，发现**经验档的高风险审批功能失效**，请不要怀疑系统有 Bug。请立即检查你的数据根目录下，是否存在 `memory.config.json` 文件。如果没有，或者被清空了，系统会自动调用内置默认关键词兜底，但**务必恢复配置文件以保证最佳使用体验**（可从仓库的 `config/memory.config.template.json` 拷贝回数据根目录）。

本手册适合「不写代码、想直接用一个能自动装好的记忆库」的用户。核心思路：**把这个仓库丢给任意 AI 助手，让它按 `AI_INSTALL.md` 自动完成安装与自检**，你只需要准备一台装了 Node.js 的机器和一条能输入给 AI 的「一句话」。

## 一句话让 AI 帮你装好

> 请你读取本目录下的 `docs/AI_INSTALL.md`，按里面的「环境准备 / 配置指引 / 运行流程 / 自检指令」一步步帮我安装好 DualTrack Memory，并把 `stats` 的自检结果告诉我。

把这句话连同**整个仓库目录**一起发给你的 AI 助手（ChatGPT / DeepSeek / Claude 等），它即可完成：
1. 拷贝 `config/memory.config.template.json` → `memory.config.json`；
2. 创建 `.env`（`memory_root` 指向你想要的盘符）；
3. 运行 `node src/memory_dual.js stats` 自检并汇报。

## 手动（不想走 AI 也可以）

1. 安装 Node.js >= 18。
2. 把本仓库解压到任意目录（如 `D:\MyMemory`）。
3. 复制配置：
   - `config/memory.config.template.json` → `memory.config.json`
   - `config/.env.example` → `.env`（不改也能跑，默认零依赖哈希向量）
4. 打开命令行，进入仓库目录：
   ```bash
   node src/memory_dual.js stats
   ```
   看到返回 `{ version:"2.0", network:{...}, experience:{...} }` 即安装成功。

## 常见问题
- **`stats` 报 `EPERM`**：把 `memory.config.json` 的 `memory_root` 指到一个你有写权限的目录。
- **想换盘符存记忆**：改 `.env` 的 `DSH_MEMORY_ROOT`，或 `memory.config.json` 的 `memory_root`，填 `D:\my-data` 之类。
- **记忆丢了怎么办**：数据都在你指定的 `memory_root` 下的 `network_shards/`、`experience_cards/`、`memory_network.json`。删除节点是软删除（`garbage` 状态），不会物理清掉。

## 概念速览
- **记忆网**：日常/背景/模糊检索，节点 + 关联边。
- **经验档**：技术报错/排错，带环境校验。
- **管家**：自动判断一句话该进哪个库（相似度>0.85 才强行归类）。
- **积分**：`访问 + 使用*2 + 验证*5`，高频不衰减，验证≥3 次永存。
- **V1.1 边权/分层/事实单**：记忆网边带 `context_score`（命中 +0.5 / 忽略 -0.2 / 核心锁 5.0 / 休眠 ×0.5）；节点可分五级 `memory_level`（`.L5` 永存）；主模型可用 `facts` 报反馈、`--used`/`--ignored` 加粗/入待命池。
