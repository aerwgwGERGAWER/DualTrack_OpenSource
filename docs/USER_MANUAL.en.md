# DualTrack Memory - User Manual (English)

> Chinese: [`USER_MANUAL.md`](./USER_MANUAL.md) · AI auto-install: [`AI_INSTALL.md`](./AI_INSTALL.md)

## 1. What it is
DualTrack Memory is an **open-source white-box memory system for AI Agents**. It lets an agent persist and recall memory across sessions/windows while keeping storage infinite and context finite (tiny nav + read-on-demand + forget).

## 2. Two tracks
| Track | Stores | Role |
|---|---|---|
| **Memory net** (`memory_network.json`) | nodes + edges + tags | **fuzzy association** — casual chat / background / fuzzy search ("that thing about X") |
| **Experience cards** (`experience_cards`) | symptom/cause/solution/env/warning | **precise troubleshooting** — bugs / faults / fixes |

## 3. Core concepts
- **Butler / router**: classifies each utterance. First does a **keyword match** for "tech error / case" (hit ⇒ experience cards first); if not, then judges by **semantic similarity** — **>0.85 forces the memory net**, otherwise hands back to the main model. Hash fallback by default; `embedding_provider: "bge"` switches to bge-m3.
- **Scoring**: `Total = access + use*2 + validated_count*5`. High-frequency never decays; low-frequency decays (5% after >30d idle); **validated_count>=3 is locked forever**.
- **Tag-level distributed lock**: per-tag partition locking; safe with concurrent instances.
- **Soft delete**: marks `garbage` + `deleted_at`; never physically deleted (recoverable).
- **Pluggable embeddings**: Hash (zero-dep) default, bge slot reserved.

## 4. Install
Requires **Node.js >= 18**. Zero runtime deps.
```bash
cp config/memory.config.template.json memory.config.json
node src/memory_dual.js stats     # self-check; creates data dirs
```

## 5. Config (`memory.config.json`)
| Field | Purpose | Default |
|---|---|---|
| `memory_root` | data root (any drive); empty = config dir | config dir |
| `dual_track.router.embedding_provider` | `"hash"` or `"bge"` | `"hash"` |
| `dual_track.router.sim_threshold` | router force-classify threshold | `0.85` |
| `dual_track.memory_network.summary_max_len` | summary char cap | 20 |
| `dual_track.experience_cards.risk_keywords_high/low` | auto risk-classification keywords | **built-in defaults** |
| `scoring.*` | score/decay/lock rules | see §3 |

> **Built-in fallback**: even if `memory.config.json` is missing/cleared, the engine uses built-in defaults — including **risk-classification keywords** — so **"high-risk → approval" never fails** in the default state.

## 6. Data layout
```
memory_root/
├─ memory_network.json          memory-net index
├─ network_shards/<tag>.json    per-tag nodes+edges
├─ experience_cards/EXP-*.json  experience cards
├─ experience_index.json        experience index
├─ approvals/                   pending high-risk reports
└─ .locks/                      tag-level locks (temp)
```

## 7. Commands
### Memory net
```bash
node src/memory_dual.js net-add --tags tech-plugin --content "full text" --summary "short" --warning "caution" [--link target,related,0.6]
node src/memory_dual.js net-search --query "keyword" [--threshold 0.4]
node src/memory_dual.js net-read --id <node_id>
node src/memory_dual.js net-softdelete --id <node_id>
node src/memory_dual.js net-list
```
### Experience cards
```bash
node src/memory_dual.js exp-add --symptom s --cause c --solution s --env "MC1.20.1/A770/16G" --warning w [--force]
node src/memory_dual.js exp-get --id EXP-xxxx --env "current"     # env mismatch → "outdated, re-verify"
node src/memory_dual.js exp-validate --id EXP-xxxx                # +1; v>=3 locked
node src/memory_dual.js exp-list
node src/memory_dual.js exp-approvals
```
### Butler / Decay / Stats
```bash
node src/memory_dual.js route --text "this sentence"   # net | exp | null
node src/memory_dual.js decay
node src/memory_dual.js stats
```

**Risk rules**: `exp-add` auto-classifies — **low-risk** (adjustments) **writes directly**; **high-risk** (source changes / cross-version) **creates a pending approval report**.

## V1.2 New Features

### facts (task fact sheet)
Lets the main model tell the butler what happened this session, so it can update edge weights / levels.

- Command: `facts --op-level <1-5> --used <id,...> --ignored <id,...>`
- Params:
  - `--op-level`: operation level (1-5); default 3 (work). Butler cross-checks `dsh-web.log`: claims 5 but no code ops → downgrade to 3; high log density but reports 3 → upgrade to 4.
  - `--used`: nodes the main model said "this memory helped", edges +0.5, mark "real-useful".
  - `--ignored`: nodes the main model said "I saw it but unused", edges -0.2, mark "staging pool".
- Examples:
  1. High-density modification (op=5): `node src/memory_dual.js facts --op-level 5 --used aaa123,bbb456 --ignored ccc789`
  2. Normal query (op=3): `node src/memory_dual.js facts --op-level 3 --used ddd000`
  3. Pure chat (op=1): `node src/memory_dual.js facts --op-level 1 --ignored eee111`

### --level (layering)
Set `memory_level` (1-5) when adding a node; `validated_count>=3` forces L5; when nodes<5000 and `max_level<5`, L2 merges into L1, L4 into L3.

| Level | Name | Meaning | Decay |
|---|---|---|---|
| L1 | Shallow | pure daily chat, no tool calls | decays most |
| L2 | Normal | tool calls, no core code change | normal decay (merges to L1 if <5000) |
| L3 | Work | routine tech changes, normal troubleshooting | normal decay |
| L4 | Important | core arch change, high-risk fix (BOM/EPERM) | slow decay (merges to L3 if <5000) |
| L5 | Core-locked | validated_count>=3 | locked forever |

Command: `node src/memory_dual.js net-add --tags tech-plugin --content "full" --summary "short" --level 4`

### context_score (dynamic edge weight)
A weight on each edge; drives the ordering of associated clues.

| Rule | Value | Scenario |
|---|---|---|
| Default | 0.1 | initial value on new edges |
| Hit | +0.5 | "this really solved my problem" → thicken |
| Ignore | -0.2 | "saw it but useless" → thin, hits floor |
| Lower bound | 0.1 | locked after hitting 0.1; edge never deleted |
| Core lock | 5.0 | validated_count>=3 → all edges forced to 5.0 |
| Dormancy | ×0.5 | >30 days since last activation → halve |

Scenario: a `facts --used` hit thickens the edge +0.5; `net-search` after activation sorts edges by weight desc, taking top 5 (or top 3 when few) as the clue cluster.

## 8. FAQ
- **Risk approval seems broken**: first check `memory.config.json` exists / isn't cleared (see the note in `INSTALL_PORTABLE.md`). Built-in keywords still back-stop it, but restore the config for best results.
- **`EPERM ... .lock`**: data root not writable; point `memory_root` to a writable dir.
- **`corrupt session log: seq gap`**: a session-data issue (not this library); recover via the session reader or start fresh.
- **`module not found` / `Unknown frame descriptor`**: Node too old, or a private multi-frame zstd file — upgrade Node / don't hand-edit such files.

## 9. Disclaimer
This project was published for personal development; the author has limited time and provides **no human support or installation guidance**. Use your own AI assistant for any issue.
