# Quorum — Architecture Summary

## Overview

Quorum is a multi-agent MCP server that fans out prompts to **Claude**, **Codex**, **Copilot**, **Cursor**, and **Gemini** in parallel, then reconciles their outputs into a single high-confidence recommendation. It uses Claude Code's Task tool for parallel orchestration.

---

## 1. Main Entry Points

### User-Facing Entry Points

| Entry | Type | Description |
|-------|------|-------------|
| `/quorum:run` | Skill | Primary entry. Orchestrates full quorum: mode detection, prompt prep, fan-out, reconciliation, judge layer, final report. |
| `/quorum:agent <agent> <prompt>` | Skill | Single-agent diagnostic. Runs one agent (or `all`) without reconciliation. |

### Programmatic Entry Points

| Entry | Type | Description |
|-------|------|-------------|
| `mcp-servers/cli.ts` | CLI | `npx quorum-agents --server <agent>` starts per-agent server. `--setup <tool>` generates MCP config. |
| `mcp-servers/run.sh` | Shell | Wrapper that invokes `tsx` on a whitelisted server file. Used by `.mcp.json` to spawn individual agent servers. |
| Individual MCP servers | Node | `codex-server.ts`, `copilot-server.ts`, `cursor-server.ts`, `gemini-server.ts` — each exposes a single `*_query` tool. |

### Agent Entry Points (invoked via Task tool)

| Agent | File | Role |
|-------|------|------|
| `quorum:claude-agent` | `agents/claude-agent.md` | Direct analysis via Read/Glob/Grep — no MCP |
| `quorum:codex-agent` | `agents/codex-agent.md` | Relay → `codex_query` MCP tool |
| `quorum:copilot-agent` | `agents/copilot-agent.md` | Relay → `copilot_query` MCP tool |
| `quorum:cursor-agent` | `agents/cursor-agent.md` | Relay → `cursor_query` MCP tool |
| `quorum:gemini-agent` | `agents/gemini-agent.md` | Relay → `gemini_query` MCP tool |

---

## 2. Dependency Flow

```
User invokes /quorum:run
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  skills/run/SKILL.md (orchestration logic)                            │
│  - Reads quorum.config.json                                            │
│  - Loads skills/run/templates/*.md                                     │
│  - Uses: Task, Read, mcp__quorum-*__*_query                            │
└───────────────────────────────────────────────────────────────────────┘
        │
        │  Task tool spawns parallel subagents
        ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ...
│ quorum:claude-   │  │ quorum:codex-    │  │ quorum:copilot-   │
│ agent            │  │ agent            │  │ agent             │
│ (Read/Glob/Grep) │  │ → MCP codex_query│  │ → MCP copilot_query│
└──────────────────┘  └────────┬─────────┘  └────────┬──────────┘
                               │                     │
                               ▼                     ▼
                    ┌──────────────────────────────────────────┐
                    │  MCP servers (stdio, spawned by editor)   │
                    │  mcp-servers/src/{codex,copilot,cursor,  │
                    │  gemini}-server.ts                        │
                    └────────────────────┬─────────────────────┘
                                         │
                                         ▼
                    ┌──────────────────────────────────────────┐
                    │  helpers.ts: runCodex, runCopilot,         │
                    │  runCursor, runGemini                     │
                    │  - validateWorkdir, validateTimeout        │
                    │  - spawnManaged (exec subprocess)          │
                    └────────────────────┬─────────────────────┘
                                         │
                                         ▼
                    ┌──────────────────────────────────────────┐
                    │  External CLIs: codex, copilot, agent,     │
                    │  gemini                                    │
                    └──────────────────────────────────────────┘
```

### Dependency Graph (Code)

```
cli.ts
  └── (dynamic import) codex-server.ts | copilot-server.ts | cursor-server.ts | gemini-server.ts

*-server.ts
  └── helpers.ts (runCodex, runCopilot, runCursor, runGemini, toolSchema, formatSuccess, formatError)

helpers.ts
  ├── zod
  ├── node:child_process (spawn)
  ├── node:fs/promises (stat, realpath)
  └── node:path (resolve)

Skills & Agents
  └── Pure declarative (SKILL.md, *.md) — no code imports
```

---

## 3. Circular Dependencies

**None detected.**

- **cli.ts** → dynamically imports server modules; no reverse dependency.
- ***-server.ts** → import `helpers.ts` only.
- **helpers.ts** → no imports from server modules or cli.
- **Skills/agents** → markdown only; referenced by Claude Code runtime, not by application code.

The dependency flow is strictly top-down: CLI → Servers → Helpers → Node/stdlib.

---

## 4. Error Propagation

### MCP Layer (helpers.ts → tools)

1. **Input validation**  
   - MCP SDK uses `toolSchema` (Zod) via `validateToolInput`. Invalid `prompt`, `timeout_ms`, or `workdir` → MCP returns `InvalidParams` before the handler runs.

2. **Runtime validation**  
   - `validateWorkdir()` — throws if path is not a directory.
   - `validateTimeout()` — throws if `timeout_ms` is out of range or non-finite.

3. **CLI execution**  
   - `spawnManaged()` handles:
     - Timeout → `reject` with message.
     - Buffer overflow (stdout/stderr) → `reject`.
     - Process error/close non-zero → `reject` with truncated error detail.

4. **Error formatting**  
   - All `run*` functions catch errors and return `formatError()` instead of throwing.  
   - Result: `{ agent, model, status: "error", error, latency_ms }` as JSON in tool content.

5. **Fallback chains**  
   - **Copilot**: ACP mode fails → fallback to plain CLI. If both fail → `formatError`.
   - **Gemini**: `--output-format json` fails → fallback to plain. If both fail → `formatError`.

### Skill Layer (run skill)

- Agent timeouts/failures → treated as `status === "error"`.  
- Proceed if **≥ 2 agents** succeed; otherwise report failure and stop.
- No explicit try/catch in skill logic — failures come from Task tool and MCP tool responses.

### CLI (cli.ts)

- `main().catch(e => { console.error(e); process.exit(1); })`  
- Invalid `--server` or `--setup` args → `console.error` + `process.exit(1)`.

### Summary

| Layer | Behavior |
|-------|----------|
| MCP tool args | Zod validation → `InvalidParams` before handler |
| helpers.ts | Errors caught → `formatError()` returns structured JSON |
| Skills | Parse agent JSON; treat `status: "error"` as failed; require ≥2 successes |
| CLI | Uncaught errors → log + exit 1 |

---

## 5. Validation Layers — Gaps and Coverage

### Covered

| Input | Where | How |
|-------|-------|-----|
| Tool args (`prompt`, `workdir`, `timeout_ms`) | MCP SDK + helpers | Zod `toolSchema` + `validateWorkdir` / `validateTimeout` |
| `prompt` | toolSchema | `z.string().min(1)` |
| `timeout_ms` | toolSchema | `z.number().int().min(1000).max(600000)` |
| `workdir` | validateWorkdir | `realpath` + `stat.isDirectory()` |
| run.sh server name | run.sh | Whitelist (`codex-server.ts`, etc.) |

### Missing or Weak

| Gap | Risk | Suggestion |
|-----|------|------------|
| **--skip / --only** | Parsed in skill text; no strict validation of agent names. | Validate against `["claude","codex","copilot","cursor","gemini"]` before use. |
| **Minimum 2 agents** | Checked only in skill logic (natural language). | Could enforce in a shared config loader/validator. |

### Previously Addressed

- **Prompt content**: `MAX_PROMPT_LENGTH` (100,000 chars) enforced in Zod `toolSchema`. Null bytes rejected by `validatePrompt()`.
- **Agent JSON response**: SKILL.md instructs wrapping `JSON.parse` in try/catch; parse errors treated as agent failure.
- **workdir path traversal**: `validateWorkdir()` uses `realpath()` on both the workdir and `process.cwd()`, then checks the canonical path is under the canonical cwd.
- **quorum.config.json**: Validated by the skill at runtime (declarative; the model reads and validates the config shape).
