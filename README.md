# session-store

A custom `session_search` tool for **oh-my-pi (OMP)** and **pi-agent** that lets the agent search **offline / completed / archived sessions** — the ones that `history://` cannot reach.

OMP's built-in `history://` only serves sessions whose agent process is still online. Once a session ends, it becomes invisible — even though the full transcript and metadata remain on disk. This extension closes that gap by exposing a custom tool the agent can call during any conversation, in any mode (TUI or RPC).

Returns **structured JSON** with session IDs, project paths, timestamps, content snippets, and message counts. The agent can answer "which session did I work on X in?" without reading `.jsonl` files or launching a TUI.

## Why

```
User:  帮我找7月30日讨论 stateStore 的记录
Agent: → session_search(action="content", query="stateStore", since="2026-07-30", until="2026-07-31")
       ← [{ session_id, project, time, snippet, message_count, resume_hint }]
Agent: Found it — StrategyAudit project, July 30, session 019fb35e…
       Resume with: omp --resume 019fb35e-946...
```

No TUI. No file reading. No `history://` dependency. Works in RPC mode.

## How it works

```
Agent calls session_search tool
       │
   action = ?
       ├─ keyword  → FTS5 search (history.db) + summary search (stage1_outputs)
       │             fast, covers user prompts + auto-extracted summaries
       │
   ├─ content  → ripgrep pre-filter + JSONL parse (full conversation text)
       │             exhaustive, searches every message in every .jsonl
       │             falls back to pure-JS file scan if rg unavailable
       │
   └─ list      → threads table (agent.db)
                     browse sessions by project and/or time range
       │
   time filter (since/until) applied to all modes
       │
       ▼
   structured JSON result: [{ session_id, project, time, title, summary, snippet, path, message_count, resume_hint }]
```

## Three search modes

| Mode | What it searches | Speed | Coverage |
|---|---|---|---|
| `keyword` | FTS5 index of user prompts + `stage1_outputs` summaries | fast | user messages + auto-summaries |
| `content` | Full text of every `.jsonl` transcript file | slower | exhaustive — assistant replies, tool calls, everything |
| `list` | `threads` table metadata (id, cwd, mtime) | fastest | browse by project/time |

## Time filtering

All three modes support `since` and `until` parameters. Three formats accepted:

| Format | Example | Meaning |
|---|---|---|
| Date | `2026-07-30` | that day 00:00 |
| ISO datetime | `2026-07-30T17:30:00+08:00` | exact timestamp |
| Relative | `3d`, `6h`, `2w` | now - N |

## Install

```sh
omp plugin install session-store
```

Or link from source:

```sh
cd session-store
npm install
npm run build
omp plugin link .
```

Restart OMP after installing. The `session_search` tool appears in the agent's tool list automatically.

## Usage

The agent calls the tool — you don't call it directly. Just ask naturally:

```
帮我找之前讨论 stateStore 的 session
列出最近3天 ChordAuditMatrix 项目的所有 session
搜索7月30日17点左右关于 DHTDynamic 的对话
```

The agent will invoke `session_search` with appropriate parameters and parse the structured JSON response.

### Direct tool parameters

| Parameter | Required | Description |
|---|---|---|
| `action` | yes | `keyword` \| `content` \| `list` |
| `query` | keyword/content | Search query (plain text) |
| `project` | no | Filter by project name or path substring |
| `since` | no | Lower time bound |
| `until` | no | Upper time bound |
| `limit` | no | Max results (default 10) |

### Example response

```json
{
  "action": "content",
  "total": 5,
  "results": [{
    "session_id": "019fb35e-9460-7000-...",
    "project": "StrategyAudit",
    "cwd": "/Users/.../StrategyAudit",
    "time": "2026-07-30T14:12:31.034Z",
    "title": "strategy_audit_statestore_v4",
    "summary": "StateStore serialization audit...",
    "snippet": "…maintain中只能维护stateStore，不能生成新tag…",
    "path": "~/.omp/agent/sessions/-Desktop.../019fb35e....jsonl",
    "message_count": 123,
    "resume_hint": "omp --resume 019fb35e-9460-7000-..."
  }]
}
```

## Data sources

All data is read directly from OMP's on-disk storage — no runtime API dependency:

| Source | Path | Contents |
|---|---|---|
| history.db | `~/.omp/agent/history.db` | FTS5 full-text index of user prompts (`history_fts` table) |
| agent.db | `~/.omp/agent/agent.db` | Session registry (`threads`) + auto-extracted summaries (`stage1_outputs`) |
| sessions/ | `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl` | Full conversation transcripts |

## Architecture: custom tool, zero runtime deps

- **`bun:sqlite`** for SQLite access — built into OMP's Bun runtime, no npm install needed. OMP's binary strings explicitly recommend `bun:sqlite` over `better-sqlite3`.
- **`node:fs`** for `.jsonl` file reading — pure Node/Bun built-in.
- **`ripgrep`** (optional) for fast content pre-filtering — falls back to pure-JS file scan when unavailable. Not a hard dependency.
- No `SessionManager.listAll()`, no `history://`, no `ctx.ui.*` — works in headless/RPC mode where `hasUI === false`.

## Extension API surface used

| API | Purpose |
|---|---|
| `pi.registerTool({ name, parameters, execute })` | Register custom `session_search` tool |
| `pi.zod` | Injected zod module for tool parameter schemas |
| `pi.exec(command, args)` | Run `rg` for fast file pre-filtering (optional, with fallback) |

## Project layout

```
session-store/
├── README.md
├── package.json          ← omp.extensions / pi.extensions manifest
├── LICENSE               ← MIT
├── tsconfig.json
├── src/
│   ├── index.ts          ← Entry point: registerTool("session_search")
│   ├── types.ts          ← ExtensionAPI, ToolDefinition, SessionMatch
│   ├── time.ts           ← Time parsing (date / ISO / relative "3d")
│   ├── parse.ts         ← JSONL transcript parser + content search + snippet extraction
│   └── search/
│       └── index.ts      ← Three search engines (keyword / content / list)
└── dist/
    └── index.js          ← Bundled output (bun build, ~16KB)
```

## Compatibility

- **OMP** (oh-my-pi) — fully supported, primary target
- **pi-agent** — compatible via `pi.extensions` manifest (same API surface)
- **RPC mode** — fully functional (`hasUI === false` safe, no UI calls)
- **TUI mode** — fully functional

## Limitations

- `keyword` mode only searches user prompts (FTS5 index) and auto-extracted summaries — not assistant replies or tool output. Use `content` mode for exhaustive search.
- `content` mode scans `.jsonl` files on every call — no persistent index. Fast enough for hundreds of sessions (ripgrep pre-filter), but not designed for thousands.
- `stage1_outputs` summaries may be incomplete (not all sessions have auto-extracted summaries). Matches without summaries still return metadata + path.

## License

MIT
