# 最终上传清单（GitHub）

## 一、仓库设置（GitHub 网页/API 即可，不在仓库文件内）
- **About 描述（英文）**：
  ```
  Dual-track memory system plugin for DeepSeek Harness
  ```
- **Topics（10 个，全小写）**：
  `ai-memory` `llm` `dsh` `deepseek` `memory-management` `dual-track` `knowledge-graph` `agent-framework` `rag` `white-box`

## 二、上传到仓库根的文件
| 文件/目录 | 说明 |
|---|---|
| `src/` | 核心代码（memory_dual.js / memory_agent.js / plugin/） |
| `config/` | memory.config.template.json · .env.example |
| `scripts/install.mjs` | 一键安装+自检 |
| `install.cmd` | Windows 双击安装入口 |
| `docs/` | 中英双语 README/USER_MANUAL/AI_INSTALL/INSTALL_PORTABLE · diagram.mmd · 效果示例.md |
| `README.md` / `README.en.md` | 门面（徽章+架构图+FAQs） |
| `LICENSE` | MIT |
| `.gitignore` | 忽略锁/环境/数据 |
| `GITHUB_REPO_METADATA.md` | About/Topics 备份 |
| `RELEASE_NOTES.md` | v1.3 Release 草稿 |

## 三、上传附件（Releases 页）
- **`dsh-dual-track-memory-v1.3.zip`** —— 主源码包，下载解压后 `双击 install.cmd` 或 `node scripts/install.mjs` 即可安装执行（默认 `triage_brain:hash`，零依赖）。
- **`dsh-butler-extension-v1.3.zip`** —— 高级扩展包（`butler-supervisor.mjs` + `启动/停止分诊脑.cmd` + `BUTLER_INSTALL.md`），供选用小模型分诊的人下载解压后配合 `install.mjs` 开关使用。

## 四、发布动作
1. 建仓库 → 填 About + Topics。
2. 上传 二 节所有文件到 `main`。
3. 新建 **Release v1.3**，标题「DualTrack Memory v1.3」，内容用 `RELEASE_NOTES.md`，上传「主包 + 扩展包」两个 zip 附件。
4. 勾选「Set as latest release」。

> 提示：GitHub 自动识别 `docs/` 里的 Mermaid 与 `README.md`；Topics/About 需手动或 API 设置。
