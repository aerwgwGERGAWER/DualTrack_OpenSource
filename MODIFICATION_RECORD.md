# 修改记录（贡献声明 + AI 编成记录）

<!-- 贡献声明：创意归老板，代码归 AI，双方配合。 -->

## 贡献声明
- **本系统的核心架构思想**（双轨记忆机制、积分衰减逻辑、经验档“办案板”概念、软删除机制）、**功能需求**及**验收标准**，均由**项目所有者（用户/老板）提出并制定**。
- 本文件所述“AI 原创/编写”，**仅指** AI 助手（DeepSeek Harness）**根据项目所有者的设计蓝图、从零编写的源代码实现**，**不涉及“创意与灵感”的归属**。
- 即：**创意归老板，代码归 AI，双方配合，天衣无缝。**
- 本文件只是**技术层面的编成记录**（用了哪些模块、修了哪些 bug），**不改变上述归属**；任何“AI 原创”的表述都只限定在“按蓝图写代码”这一层。

---

## 一、AI 按蓝图实现的代码（仅代码实现层）
> 以下均为 AI 根据老板的架构设计**从零编写**的实现，属性为“代码”，创意归老板。
- `src/memory_dual.js`（双轨引擎，核心约 537 行逻辑）。含：
  - **记忆网**：`netAdd / netSearch / netRead / netSoftDelete / netList`（节点带 `tags/content/summary/warning/vector_embedding/edges/status/deleted_at/access_count/use_count/validated_count`；跨分片关联边拉取）。
  - **经验档**：`expAdd / expGet / expValidate / expList / expApprovals`（低风险自动写 / 高风险挂审批 / 环境校验锁死·旧档失效）。
  - **管家分诊**：`route`（意图 + 相似度 >0.85 才硬判，否则交还主模型）。
  - **积分衰减**：`decay`（`Total = access + use*2 + validated_count*5`；高频不衰减 / 超30天扣5% / `validated_count>=3` 永存 / 积分<=5 且 v=0 标垃圾）。
  - **标签级分布式锁**：`withTagLock` / `withFileLock`（按 tag 分区、多标签字典序取锁防死锁、超时+退避）。
  - **软删除**：`netSoftDelete`（标 `garbage` + `deleted_at`，永不物理删）。
  - **可插拔向量**：`embedHash`（零依赖哈希）+ `embedBge`（bge 插槽，无模型自动回退）。
  - 辅助：`buildNode / writeNode / migrateLegacy / assessRisk`。
- `src/memory_agent.js`（旧单轨保留）：`resolveRoot` 动态化（去硬编码）、`--out` 文件回传、帮助示例去私货。
- `src/plugin/tools.js` / `index.js`（DSH 插件）：`runFile`（`--out` 文件回传，绕开沙箱管道 EPERM）、`resolveMemRoot` 动态化、工具注册。

## 二、AI 深度调教 / 修复（代码层）
| 问题 | 内容 | 修复 |
|---|---|---|
| config 丢失 | `memory_root` 指向独立目录时配置设置被丢 | `findConfig`（引擎目录/仓库根/上级/cwd 搜索）+ `memory_root` 只控数据、不改配置读取位置 |
| 风险审批失效 | `risk_keywords` 只从配置读，无配置时默认 `[]` 致高风险检测失效 | `assessRisk` 增加内置默认风险关键词（高：改源码/底层/跨版本/重写/hook/注入/内核/系统级；低：调整/微调/改参数/调参/配置） |
| 记忆工具返回空 | 插件工具 `execFileSync` 管道 spawn 被沙箱拒（`EPERM`） | 后端加 `--out 文件`；插件 `run/run2` 改 `stdio:'ignore'` + `--out 临时文件` 回传 |
| 更新闪退 | `settings.json` 的 `pendingClientUpdate` 每次启动被安装→崩 | 清 `pendingClientUpdate` + `skipClientVersion` + 挪走 Setup |
| 退出码 boot | 配置文件带 UTF-8 BOM → JSON.parse 崩 | 改为无 BOM 写入 |

## 三、QA / 校准
- 功能校准两遍 26 项过（记忆网/经验档/管家/积分/软删/并发/边界）。
- 最终工作流校验 9/9；数据完整性扫描 8 项 0 异常（索引=分片=34、经验卡=6、无孤儿、无残留锁）。
- 配置效果：`memory_root` 独立→配置生效；`bge` 无模型→回退哈希；非法配置→用默认；非法 `memory_root`→优雅 `ENOTDIR` 不崩。

## 四、文档 / 元数据 / 发布（AI 协助成文，内容与命名由老板拍板）
- 中英双语文档 / Mermaid 架构图 / 实操效果示例。
- GitHub About（英文）、10 Topics、3 徽章、`GITHUB_REPO_METADATA.md`。
- `MIT` LICENSE（标准模板，无额外限制）；`install.cmd` + `scripts/install.mjs` 一键安装；`dsh-dual-track-memory-v1.2.zip` 主发布包（直装验证通过）+ `dsh-butler-extension-v1.2.zip` 小模型扩展包。

---

## 归属小结
**创意、架构、需求、验收标准 → 项目所有者（老板）。源代码实现、bug 修复、文档成文 → AI 助手（按蓝图执行）。** 二者配合，责任与名分清晰。

---

## V1.1 补充与修复记录（创意与需求仍归老板）

### 一、多轮校准结果
- 连续 3 遍全面校准（功能完整性 + V1.1 特性 + 边界），结果**一致稳定**。
- 每遍 **27 项通过 / 1 项假阴性**（假阴性为测试脚本把同一节点同时传给 `--used` 与 `--ignored` 所致，`used_mark` 被后者覆盖；**非代码 bug**，用/忽略各自独立时正确）。
- 覆盖：记忆网/经验档/管家/积分/软删/边界 + context_score + 五级弹性 + 待命池 + 优雅停机 + 旧数据兼容。

### 二、小 Bug 修复
- **`net-read` 未暴露 `used_mark` 字段**（任务事实单打上的「真实有用 / 待命池」标记无法读回）。已修复：`net-read` 返回新增 `used_mark`。修复后用/忽略各自独立验证通过（used→`real-useful`、ignored→`staging`+`task_irrelevant=true`）。

### 三、V1.1 新增关键算法
- **动态边权（context_score）**：边默认 0.1；主模型反馈有用（`facts --used`）→ +0.5，忽略（`--ignored`）→ -0.2；下限锁 0.1、上限 5.0；`validated_count>=3` 核心记忆 → 所有边强制 5.0；距上次激活 >30 天 → 边 ×0.5。
- **五级分层（memory_level）**：L1 极浅 / L2 普通 / L3 工作 / L4 重要 / L5 核心锁死（`validated_count>=3` 强制 L5）。`max_level`(默认3) + 节点<5000 时弹性压缩：L2 并入 L1、L4 并入 L3。
- **待命池（task_irrelevant）**：主模型反馈「没用」→ 打标记，**不减分/不降级/不删除**；下次匹配自动移除标记唤醒；池上限 2000，超出自动清最久未用前 10 条。
- **优雅停机与休眠保护**：捕获退出信号写 `state.json`（北京时间 ISO）；下次启动差值 **>15 天 → 该时间段内所有节点/连线冻结不衰减**，≤15 天 → 正常「30 天未用扣 5%」衰减。
- 另加：**任务事实单 `facts`**（`op_level` 默认 3，交叉验证读 `dsh-web.log`；`--used`/`--ignored`）与 **旧数据兼容**（无 `memory_level`→3、无 `context_score`→0.1、无 `task_irrelevant`→false）。

---

## V1.2 重构记录：外部小模型管家 + triage_brain 隔离（创意与需求仍归老板）
- **安装逻辑改造**（`scripts/install.mjs`）：读 `memory.config.json` 的 `dual_track.router.triage_brain`。
  - 基础模式（`hash`，默认）：**不生成、不复制、不注册**任何 `butler-supervisor.mjs` / `.cmd`，保持干净、零依赖、纯本地。
  - 高级模式（`qwen`/`bge`）：自动把管家三件套（`butler-supervisor.mjs` + `启动/停止分诊脑.cmd`）复制到数据根，写入使用说明，并生成 `README_BUTLER.txt`。
- **生命周期绑定**（`scripts/butler-supervisor.mjs`）：仅在 `triage_brain=qwen` 时激活监听；`hash` 打印「当前为哈希模式，无需启动」退出、`bge` 打印未启用退出。
  - 仅 EAC 桌面端（`dsh-eac-shell.exe`）运行时拉起 ollama；EAC 关闭则停掉；单实例锁/停止标记/宽限自救/信号清理，**绝不留僵尸**。
  - 新增 `--check` 模式（只输出 triage_brain）供 `.cmd` 批处理门控安全调用。
- **分诊脑三分类**：`route()` 在 `triage_brain=qwen` 时由小模型硬判 `net/exp/skip`；`skip` 返回 `null` 交还主模型。
- **`.cmd` 注意**：批处理必须**无 BOM + CRLF**，且用 `%~dp0`（脚本自身目录）定位，避免内联 PowerShell 引号问题——已改用 `node butler-supervisor.mjs --check` + 临时文件读写，批处理解析稳定。
- **新增文档**：`docs/BUTLER_INSTALL.md`；`docs/AI_INSTALL.md`/`en` 增《杀毒软件拦截提醒》。
- **版本**：全项目 v1.1 → v1.2；`package.json`/`index.js` → 1.2.0。


---

## V1.3 收官记录（创意与需求仍归老板）
- **版本升级**：全项目 v1.2 → v1.3；package.json/index.js → 1.3.0。
- **命名与术语规范化**：记忆网/经验档/软删除/validated_count 统一；缩写 DSH/EAC 首现即注；明确 memory=记忆(非内存 RAM)。
- **文档体系收官**：README 加版本/许可徽章 + 当前版本 + 变更入口；新增最小上手示例；FAQ 结构化(现象+步骤+验证)；术语表移至文末附录；包内容改为'文件名 — 说明'。
- **流程图规范**：架构A两级递进(第一级实线/第二级虚线)+字段图例；架构B补 qwen 判 exp；可选模块虚线外框【可选】；生命周期主体=EAC 桌面端。
- **导航注入上限**：nav_max_entries/nav_max_chars(默认120/4000)可配置，防'伪无限'挤爆窗口。