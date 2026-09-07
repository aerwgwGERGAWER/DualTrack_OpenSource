# AI Installation & Troubleshooting Manual (for AI Agents)

> **This manual is for AI agents only. Please paste this section together with the project source code into your AI assistant so it can complete environment setup and troubleshooting for you.**

All reasoning below relies only on this repository's code and your actual environment, not on human author support.

---

## 1. Environment preparation

1. Confirm **Node.js >= 18** is installed: `node --version`. If not, install it first.
2. The core of this repo is zero-dependency (default hash embedding); no `npm install` needed (still requires **Node.js ≥ 18**; "zero-dependency" means no extra npm packages/models/network, not "no Node").
3. If you want to use the bge-m3 semantic embedding, prepare a model file or an HTTP endpoint — see "Configuration".

## 2. Configuration

1. Copy the config template to a location the engine can read (repo root or data root):
   ```bash
   cp config/memory.config.template.json memory.config.json
   ```
   Or create `.env` from `config/.env.example` and fill in as needed:
   `DEEPSEEK_API_KEY` / `DSH_MEMORY_ROOT` (data root, any drive) / `DSH_MEMORY_BGE_MODEL` / `DSH_MEMORY_BGE_ENDPOINT`.

2. `memory.config.json` key fields:
   - `memory_root`: memory data root (leave empty to use the engine's directory).
   - `dual_track.router.embedding_provider`: `"hash"` (default, zero-dep) or `"bge"` (needs model/endpoint).
   - `dual_track.router.sim_threshold`: the similarity threshold for the butler to force-classify (default 0.85).
   - `scoring.*`: score & decay rules (`validated_lock>=3` = core memory locked forever).

3. **Key default guarantee (runs even without a config file)**:
   - Even without `memory.config.json` (or if it is lost/cleared), the engine runs with built-in defaults.
   - **Default risk classification**: `experience_cards.risk_keywords_high/low` fall back to built-in defaults when absent (high-risk: source change / low-level / cross-version / rewrite / hook / inject / kernel / system-level; low-risk: adjust / tune / change-params / config).
   - **Therefore "high-risk → approval" always works in the default state.** If you find risk approval is broken, first check whether `memory.config.json` exists and is not cleared (see "Common errors").

## 3. Run flow

```bash
# 1. Self-check (creates data dirs + stats; empty data is fine)
node src/memory_dual.js stats

# 2. Write a memory-net node
node src/memory_dual.js net-add --tags tech-plugin --content "full text" --summary "short summary (≤20 chars)"

# 3. Search the memory net
node src/memory_dual.js net-search --query "keyword"

# 4. Butler routing (decide which track/back to main model)
node src/memory_dual.js route --text "server crashed"

# 5. Experience cards (technical case)
node src/memory_dual.js exp-add --symptom s --cause c --solution s --env "MC1.20.1/A770/16G" --warning w
node src/memory_dual.js exp-get --id EXP-xxxx --env "current-env"

# 6. Score-decay scan (verify lock/decay rules)
node src/memory_dual.js decay

# 7. Task fact sheet (V1.1: main model tells the butler what it did; updates edge weights/levels)
node src/memory_dual.js facts --op-level 5 --used <node_id,...> --ignored <node_id,...>
```

## V1.2 quick notes
- `facts --op-level 1-5`: the main model emits a task fact sheet each session; `--used`(+0.5 real-useful), `--ignored`(-0.2 staging pool); `--op-level` defaults to 3, and the butler cross-checks `dsh-web.log` (claims 5 but no code ops → downgrade to 3; high log density but reports 3 → upgrade to 4).
- `--level 1-5`: set memory level on `net-add`; `validated>=3` forces L5; with nodes<5000 and max_level<5, L2 merges into L1, L4 into L3.
- `context_score`: edge default 0.1, hit +0.5, ignore -0.2, lower bound 0.1, `validated>=3` locks 5.0, >30 days inactive ×0.5.

## 4. Common errors

- **Experience-card risk approval seems broken (should be pending but was written directly)**:
  - Cause: `memory.config.json` lost/cleared, so `risk_keywords_high/low` cannot be read; but the engine's built-in default keywords should still back-stop it.
  - Fix: **first check whether `memory.config.json` exists and is not empty.** If it was cleared, just copy from `config/memory.config.template.json`; even if you don't restore it, the built-in default keywords keep "high-risk → approval" working.
- **`EPERM: operation not permitted, open '...memory.config.json.lock'`** (or any `.lock` write failure):
  - Cause: sandbox/permissions block creating `.lock` under `memory_root` (multi-process mutex).
  - Fix: point `memory_root` to a directory you can write; or in a sandbox use `--out <file>` to return output and avoid pipe-spawn (the plugin tools already do this).
- **`Unknown frame descriptor` / multi-frame zstd decompress failure**:
  - Cause: Node's built-in zstd only handles a single frame; session logs use a multi-frame zstd private container.
  - Fix: never hand-rewrite such files; rely on the reader's "rollback to the last committed byte" strategy.
- **`corrupt session log: seq gap in committed region ...`**:
  - Cause: session event log seq is not contiguous (often from a mid-process crash).
  - Fix: this is a session-data issue, not this library; recover with the reader that supports the format, or start a new session.
- **`module not found` / `node:xxx` missing**:
  - Cause: Node version too low or a missing built-in module.
  - Fix: upgrade to Node >= 18; this project only uses `node:fs`/`node:path`/`node:crypto`/`node:zlib`/`node:child_process`/`node:os`, all built-in.
- **`unsupported JSON schema: schema must be a schema object`**:
  - Cause: tool output schema is invalid (during plugin registration).
  - Fix: restrict `output.schema` to a supported subset like `{ type: 'object', additionalProperties: true }`.
- **`memory declares dsh.client but exports no './client' bundle`**:
  - Cause: the plugin declares a client bundle but has no matching export.
  - Fix: keep the plugin host-only and remove the `dsh.client` declaration.

## 5. Self-check command list

```bash
node src/memory_dual.js stats                         # stats (memory net / experience / score rules)
node src/memory_dual.js net-list                      # memory-net node count
node src/memory_dual.js exp-list                      # experience-card count
node src/memory_dual.js route --text "test"           # butler returns target/null normally
node src/memory_dual.js decay                         # decay returns locked/decayed/garbage normally
node --check src/memory_dual.js                       # syntax check
```

Self-check notes:
- `stats` returning JSON means the engine runs and the data root is writable.
- `route` should return `target` (`net`/`exp`/`null`) + `reason` for any input; `target=null` with «below threshold» in `reason` is normal (handed back to the main model).

## V1.2 optimization suggestions

The default embedding is **hash-based** (`embedding_provider: "hash"`), whose **semantic similarity is low (about 0.2–0.5)**. As a result the butler's **triage threshold** `sim_threshold: 0.85` **rarely triggers** in default mode (most utterances are handed back to the main model — safe, but proactive triage is weak). You can optimize in any of these ways:

1. **Install the bge-m3 semantic model** (recommended; improves recall and proactive triage):
   - Set `dual_track.router.embedding_provider: "bge"` in `memory.config.json`, then fill `bge_model_path` (local model) or `bge_endpoint` (HTTP endpoint).
   - After install, `stats` reports `embedding_provider_used: "bge"`.
2. **Adjust the triage threshold**: if you don't install bge, lower `dual_track.router.sim_threshold` from 0.85 (e.g. 0.6) to make the butler more proactive — at the cost of more misclassification.
3. **Modify the code as needed**: this is an open-source white-box system; adjust `src/memory_dual.js` to your needs (e.g. `assessRisk` keywords, `netSearch` cluster top-N, decay params).

> Note: bge-m3 is an optional enhancement; the default zero-dependency hash embedding runs all features end to end.

## 6. FAQ: Antivirus interception warning

When installing or running `启动分诊脑.cmd / 停止分诊脑.cmd`, Windows Defender or third-party antivirus software (e.g. Huorong, 360) may pop up a "System hardening" or "A program is attempting to..." warning.

**This is a normal false positive, not a virus.** The scripts hide the black command-prompt window by using hidden PowerShell directives (`-WindowStyle Hidden`) in the background to manage the Ollama service process. For security reasons, antivirus software treats "hidden PowerShell execution" as suspicious and intercepts it.

**How to fix:**
1. In the popup, check "Remember this action" and click **Allow**.
2. To avoid being prompted every time, add the whole data root (the `memory_root` in `memory.config.json`, or the project install root) to your antivirus's "trusted" / "whitelist" area.

## 7. Optional: install the local small-model butler (triage brain)

> **Important: this step is OPTIONAL, not required. The default `hash` mode is fully sufficient. Ask the user first and proceed only with their consent.**

### 0. First ask the user
```
"Current mode is pure-local hash: zero dependency, zero cost, fully functional.
Do you also want to install the 'local small-model butler' (Qwen triage brain) for smarter memory classification?
Note: it requires installing Ollama and pulling a ~1.4GB small model on YOUR machine (no API cost, but uses local resources).
Install / not? (Default: not, it works fine as-is)"
```

### 1. With vs without (overall effect)
| | Without (default hash) | With small-model butler (qwen) |
|---|---|---|
| Dependency | zero-dependency, pure local | needs local Ollama + pulled model |
| Classification | hash similarity (weak proactive triage) | local small-model 3-way `net/exp/skip` |
| Network | no | no (local inference, no API cost) |
| Proactive triage | low (mostly hands back to main model) | high (local model force-classifies) |
| Lifecycle | none | starts the model only while EAC runs, stops on close |
| Cost | 0 | local CPU/RAM (no DeepSeek API cost) |

### 2. Prerequisite: which butler files you need
The main package is a **clean core** and does NOT include the butler scripts. The following 4 files come from either the **extension package** `dsh-butler-extension-v1.2.zip` or the **full source** (this repo `scripts/` + `src/`):
- `butler-supervisor.mjs` — lifecycle daemon (EAC on → start ollama; EAC off → stop; single-instance / stop marker / grace self-exit, never a zombie)
- `启动分诊脑.cmd` / `停止分诊脑.cmd` — double-click start/stop (hidden window, location-independent)
- `ollama_triage.cjs` — the triage helper the engine's `qwenTriageSync` needs (must sit next to the engine)

> If using the extension package: unzip the above into this repo's `scripts/` (and `src/`), or let `install.mjs` copy them to the data root in advanced mode.

### 3. If the user agrees: full steps
1. **Set the switch**: in `memory.config.json` set `dual_track.router.triage_brain: "qwen"` (model name via `triage_model`, default `dualtrack-triage`).
2. **Install Ollama**: <https://ollama.com>; pull a model: `ollama pull qwen3:1.7b` (use `qwen3:0.6b` to save resources).
3. **Build the triage model** (one-time): from `config/triage.Modelfile`:
   ```bash
   ollama create dualtrack-triage -f config/triage.Modelfile
   ```
4. **Run the installer**: `node scripts/install.mjs [data-root]`. Now that `triage_brain=qwen`, the script **copies the butler 4 files to the data root** (per the switch), writes a `_butler_note` usage note, and generates `README_BUTLER.txt`.
5. **Start the daemon**: double-click `启动分诊脑.cmd`, or run `node butler-supervisor.mjs` (hidden background). It continuously watches the EAC desktop client → auto-starts `ollama serve` while EAC runs, auto-stops it when EAC closes, and self-exits after a grace period (never a zombie).
6. **Stop the daemon**: double-click `停止分诊脑.cmd`.
7. **Verify**: `node src/memory_dual.js route --text "xxx"` returns `"brain":"qwen"`; `node butler-supervisor.mjs --check <config>` should print `qwen`.

> Note: if the main package has no butler templates, `install.mjs` will say "install `dsh-butler-extension-v1.2.zip`" — in that case have the user install the extension package, or use the full source.

### 4. Safety & robustness
- The daemon only activates when `triage_brain=qwen`; with `hash`, double-clicking the start script prints "current is hash mode, no need to start" and exits.
- Single-instance lock, stop marker, grace self-exit — it **never becomes a zombie**; antivirus false positives on hidden PowerShell are covered in "6. FAQ: Antivirus interception warning".
