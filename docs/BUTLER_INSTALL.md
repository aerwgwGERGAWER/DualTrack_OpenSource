# 外部小模型管家（分诊脑）安装与使用 — BUTLER_INSTALL

> 适用谁：想把「本地小模型 Qwen3 分诊脑」装进 DualTrack Memory 的用户。
> 默认的 `triage_brain: "hash"`（纯本地、零依赖，但需 **Node.js ≥ 18**）**完全不需要**本文件。
> 本文件只对想启用小模型分诊的高级用户提供步骤。

---

## 0. 它是什么

DualTrack Memory 内置一个「管家分诊」`route()`：把一句话判为 `net`（记忆网）/ `exp`（经验档）/ `skip`（不记录，交还主模型）。

- **`triage_brain: "hash"`（默认）**：纯向量法，零网络、零模型、零依赖（除 **Node.js ≥ 18** 外无需任何 npm 包/模型/联网），无需本扩展。
- **`triage_brain: "qwen"`**：启用本地小模型（Ollama Qwen3）做三分类硬判，需要安装 Ollama + 拉模型。
- **`triage_brain: "bge"`**：使用 bge-m3 语义嵌入（提升相似度/召回），同样属于「高级模式」。

当 `triage_brain` 为 `qwen`/`bge` 时，一键安装脚本 `scripts/install.mjs` 会自动把管家三件套复制到数据根目录，并由 `butler-supervisor.mjs` 守护小模型的生命周期。

## 1. 版本与文件

| 文件 | 位置 | 作用 |
|---|---|---|
| `butler-supervisor.mjs` | 数据根 | 生命周期守护：EAC 在→拉起 ollama；EAC 关→停 ollama |
| `启动分诊脑.cmd` | 数据根 | 双击开启守护（后台隐藏窗口） |
| `停止分诊脑.cmd` | 数据根 | 双击关闭守护（干净退出，不留僵尸） |
| `README_BUTLER.txt` | 数据根 | 安装后自动生成的使用提示 |

## 2. 安装步骤

### 方式 A：高级模式自动安装（推荐）

1. 设置配置：在 `memory.config.json` 中：
   ```json
   "dual_track": { "router": { "triage_brain": "qwen", "triage_model": "dualtrack-triage" } }
   ```
2. 运行安装脚本：
   ```bash
   node scripts/install.mjs [数据根目录]
   ```
   若 `scripts/` 下存在管家模板，脚本会自动把它们复制到数据根，写入使用说明，并生成 `README_BUTLER.txt`。
   若提示「未检测到管家模板」，请先用下面的「方式 B」解压扩展包到仓库。

### 方式 B：先解压扩展包

下载 `dsh-butler-extension-v1.2.zip`，把其中的 `butler-supervisor.mjs`、`启动分诊脑.cmd`、`停止分诊脑.cmd` 解压到本仓库 `scripts/` 下，再运行一次 `node scripts/install.mjs [数据根目录]`，即按 `triage_brain` 自动复制。

### 手动创建管家模型（一次性）

安装 Ollama：<https://ollama.com>。然后拉取分诊模型：

```bash
ollama pull qwen3:1.7b
```

> 提示：为降低 CPU 占用可在 `memory.config.json` 设 `triage_model` 指向更轻模型（如 `qwen3:0.6b`）。

## 3. 使用

- **开启守护**：双击 `启动分诊脑.cmd`。它会后台隐藏运行：
  - 持续监测 EAC 桌面客户端（`dsh-eac-shell.exe`）；
  - EAC 在运行 → 自动拉起 `ollama serve`（小模型可用）；
  - EAC 关闭 → 自动停掉 ollama；连续关闭超过宽限期（默认 1800s，可设 `BUTLER_QUIT_AFTER_EAC_DOWN_SEC`）守护自我退出，不留僵尸。
- **关闭守护**：双击 `停止分诊脑.cmd`。
- **开机自启（可选）**：把 `启动分诊脑.cmd` 的快捷方式（或隐藏版 `.vbs`）放进 Windows「启动」文件夹，登录即自动后台盯守。

## 4. 已启用门控（生命线）

- `butler-supervisor.mjs` **只在 `triage_brain: "qwen"` 时被激活**。若为 `hash` 或 `bge`，它会打印「当前为哈希模式/未启用」并直接退出，绝不误启动、绝不写 pid。
- `启动分诊脑.cmd` 会先读 `memory.config.json`：`hash` → 提示「当前为哈希模式，无需启动」并退出；`qwen` → 进入监听；否则提示不支持。
- 守护使用单实例锁（`.butler.pid`）、停止标记（`.butler.stop`）、宽限自救、信号清理，**绝对不会变成僵尸进程**。

## 5. 常见问题

- **杀毒软件拦截**：脚本用隐藏 PowerShell 管理 ollama，会被 Defender/火绒/360 误报。勾选「记住本次操作」并允许，或把数据根目录加入白名单。详见 `docs/AI_INSTALL.md` 的《杀毒软件拦截提醒》。
- **提示「当前为哈希模式，无需启动」**：说明配置仍是 `hash`。请把 `triage_brain` 改成 `qwen` 后再双击。
- **双击无效 / 无反应**：确认 `node` 在 PATH（`node --version`），且 `butler-supervisor.mjs` 与两个 `.cmd` 在**同一目录**。

---

## 第三方组件许可声明

> 本扩展包**自身**使用 MIT 许可证（与主包一致）。以下为管家运行时**协作/依赖的第三方组件**，由用户自行下载安装，**不含在本扩展包内**：

| 组件 | 用途 | 许可证 | 来源 |
|---|---|---|---|
| Ollama | 本地小模型运行服务（ollama serve） | MIT License | https://ollama.com |
| Qwen3（通义千问） | 分诊小模型（qwen3:1.7b / dualtrack-triage） | Apache-2.0 | 阿里云通义千问 |
| DeepSeek Harness（DSH/EAC） | 本记忆库运行的平台/插件宿主 | 见其仓库自身许可 | https://github.com/aerwgwGERGAWER |

> 各组件许可由对应项目提供；本扩展包仅做编排与调用，未修改/分发第三方组件的受许可代码。
