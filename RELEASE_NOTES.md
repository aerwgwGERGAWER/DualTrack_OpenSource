# Release 草稿 — v1.3

**DualTrack Memory - 双轨记忆库**（GitHub 包名：`dsh-dual-track-memory`）

## 简介
一个用于 AI Agent 的开源白盒记忆系统：模糊联想（记忆网）+ 精准排错（经验档）+ 积分制管理 + 跨会话持久。零外部依赖，AI 可自动安装。

## 新特性（v1.3）
- **项目命名与术语规范化**：全仓统一「记忆网 / 经验档 / 软删除 / validated_count」，缩写首现即注全称（DSH / EAC），并明确 **memory = 记忆（非内存 RAM）**。
- **文档体系收官**：
  - README 加**版本 / 许可徽章** + 「当前版本 v1.3」+ 变更记录入口；
  - 新增**最小上手示例**（"记住：这是测试记忆" → 重启 → 问它，验证跨会话召回）；
  - **FAQ 结构化**为"现象 + 步骤 + 验证"（BGE 回退 / 经验档验证 / 哈希模式提示），含**回滚与数据安全**说明；
  - **术语表移至文末附录**；包内容改为"文件名 — 说明"清晰层级；文档链接独立成行。
- **流程图规范**：架构 A 改**两级递进**（第一级实线 / 第二级虚线）+ **就近字段图例**；架构 B 补全「qwen 判 exp」；完整执行图的**可选模块加虚线外框**【可选】；生命周期主体明确为「EAC 桌面端」。
- **导航注入上限可配置**：`nav_max_entries` / `nav_max_chars`（默认 120 / 4000，防"伪无限"挤爆窗口）。

## 新特性（v1.2 既有）
- 外部小模型管家（分诊脑），`triage_brain` 严格隔离：`hash` 干净零依赖 / `qwen` 本地小模型三分类 + 生命周期门控。
- 双发布包：主包（27 核心，无启动脚本）+ 扩展包（管家 6 文件）。

## 新特性（v1.1 既有）
- 双轨架构 / 管家分诊 / 积分制动态衰减 / 标签级分布式锁 / 软删除 / 中英双语 / AI 一键安装。
- 动态边权 `context_score`、五级分层 `memory_level`、任务事实单 `facts`、优雅停机冻结。

## 资源
- 主包：`dsh-dual-track-memory-v1.3.zip`
- 扩展包：`dsh-butler-extension-v1.3.zip`

## 安装
```bash
# Windows: 双击 install.cmd   (或)
node scripts/install.mjs
# 默认 hash 自检
node src/memory_dual.js stats
# 需小模型分诊: 在 memory.config.json 设 dual_track.router.triage_brain=qwen, 再装 Ollama 并拉模型(见 docs/BUTLER_INSTALL.md)
```

## 附注
- 本项目为个人开发需求发布，作者精力有限，**不提供人工技术支持与安装指导**；遇到问题请用你的 AI 助手解决（见 `docs/AI_INSTALL.md`）。
- 杀毒软件对隐藏 PowerShell 误报时的处理，见 `docs/AI_INSTALL.md` 的《杀毒软件拦截提醒》。
