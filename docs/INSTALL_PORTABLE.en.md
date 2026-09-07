# Portable Edition User Manual (Portable Users)

> ## ⚠️【Important notice】
> If, after installing the portable edition, you find that the **experience-card high-risk approval feature seems broken**, do not suspect a bug in the system. Immediately check your data root directory for a `memory.config.json` file. If it is missing, or has been cleared, the system will automatically fall back to built-in default keywords, but **please restore the config file for the best experience** (you can copy it back to the data root from the repository's `config/memory.config.template.json`).

This manual is for users who don't write code and want a memory library that installs itself. The idea: **hand this repository to any AI assistant and let it follow `AI_INSTALL.md` to automatically install and self-check** — you only need a machine with Node.js and a one-line prompt to give the AI.

## One-line prompt to have AI install it for you

> Please read `docs/AI_INSTALL.md` in this directory and follow its "Environment / Configuration / Run flow / Self-check" sections step by step to install DualTrack Memory for me, then report the `stats` self-check result.

Send this prompt together with the **entire repository directory** to your AI assistant (ChatGPT / DeepSeek / Claude, etc.), and it will:
1. Copy `config/memory.config.template.json` → `memory.config.json`;
2. Create `.env` (point `memory_root` to the drive you want);
3. Run `node src/memory_dual.js stats` and report.

## Manual (if you don't want to use AI)

1. Install Node.js >= 18.
2. Extract this repository to any directory (e.g. `D:\MyMemory`).
3. Copy configs:
   - `config/memory.config.template.json` → `memory.config.json`
   - `config/.env.example` → `.env` (workable even unmodified; default zero-dep hash embedding)
4. Open a terminal in the repo dir:
   ```bash
   node src/memory_dual.js stats
   ```
   Seeing `{ version:"2.0", network:{...}, experience:{...} }` means installation succeeded.

## FAQ
- **`stats` reports `EPERM`**: point `memory_root` in `memory.config.json` to a directory you can write.
- **Want to store memory on another drive**: change `DSH_MEMORY_ROOT` in `.env`, or `memory_root` in `memory.config.json`, e.g. `D:\my-data`.
- **Lost memory?**: Data lives under your `memory_root` in `network_shards/`, `experience_cards/`, `memory_network.json`. Deleting a node is a soft delete (`garbage` status); it is never physically removed.

## Concepts at a glance
- **Memory net**: daily/background/fuzzy recall — nodes + edges.
- **Experience cards**: tech error/fix cases — with environment check.
- **Butler**: auto-decides which track a sentence belongs to (force-classifies only when similarity > 0.85).
- **Score**: `access + use*2 + validated_count*5`; high-frequency never decays; validated >= 3 is locked forever.
- **V1.1 edge weight / level / fact sheet**: memory-net edges carry `context_score` (hit +0.5 / ignore -0.2 / core-lock 5.0 / dormancy ×0.5); nodes support 5 levels `memory_level` (L5 permanent); the main model can use `facts` with `--used`/`--ignored` to thicken or park memories.
