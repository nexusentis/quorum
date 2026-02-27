# Quorum

Multi-agent MCP server that fans out prompts to **Claude**, **Codex**, **Copilot**, **Cursor**, and **Gemini** in parallel, then reconciles their outputs into a single high-confidence recommendation.

## Quickstart (Claude Code)

Install as a Claude Code plugin:

```
/plugin marketplace add federicorinaldi/quorum
/plugin install quorum@quorum-marketplace
```

Then install the agent CLIs you want to use (see [Prerequisites](#prerequisites)), and run:

```
/quorum:run review this repo
```

## Two usage paths

Quorum works in two distinct ways depending on your editor:

### Claude Code — full orchestration

Claude Code gets the complete experience: skills, relay agents, and blind judge reconciliation.

- **`/quorum:run <prompt>`** — Fan out to all enabled agents, deduplicate findings, run blind judge scoring, and present a synthesized recommendation. Supports modes: `review`, `review-codebase`, `architecture`, `implement`, `diagnose`.
- **`/quorum:agent <agent> <prompt>`** — Test a single agent and get the raw result back. Useful for debugging.

Claude participates as both an agent (analyzing code directly) and the judge (scoring anonymized outputs). Agent identities are hidden during scoring to prevent bias.

### Any MCP client — direct tool calls

Cursor, VS Code, Windsurf, and any other MCP-compatible client get access to the MCP tools directly. The client's own LLM decides how to use the results.

- **`codex_query`** / **`copilot_query`** / **`cursor_query`** / **`gemini_query`** — Query a single agent
- **`quorum_query`** — Fan out to all enabled agents in parallel and return collected results

No skills, no relay agents, no blind judge — your editor's LLM handles interpretation.

## Installation

### Claude Code (recommended)

Install directly as a plugin:

```
/plugin marketplace add federicorinaldi/quorum
/plugin install quorum@quorum-marketplace
```

This sets up everything automatically — MCP servers, relay agents, skills, and permissions. Restart Claude Code after installing.

<details>
<summary>What gets installed</summary>

- **`.mcp.json`** — 5 MCP servers (4 individual agents + combined quorum)
- **`settings.json`** — Auto-approve permissions for all agent CLIs and MCP tools
- **`agents/`** — 5 relay agent definitions for parallel fan-out via the Task tool
- **`skills/`** — `/quorum:run` (full orchestration) and `/quorum:agent` (single agent)
- **`quorum.config.json`** — Enable/disable individual agents

</details>

<details>
<summary>Manual setup (from source)</summary>

Clone the repo and install dependencies:

```bash
git clone https://github.com/federicorinaldi/quorum.git
cd quorum/mcp-servers && npm install
# Restart Claude Code to pick up the MCP servers
```

</details>

<details>
<summary><code>.mcp.json</code></summary>

```json
{
  "mcpServers": {
    "quorum-codex": {
      "command": "./mcp-servers/run.sh",
      "args": ["codex-server.ts"],
      "description": "Cross-check: OpenAI Codex CLI wrapper (gpt-5.3-codex)"
    },
    "quorum-copilot": {
      "command": "./mcp-servers/run.sh",
      "args": ["copilot-server.ts"],
      "description": "Cross-check: GitHub Copilot CLI wrapper (ACP + fallback)"
    },
    "quorum-cursor": {
      "command": "./mcp-servers/run.sh",
      "args": ["cursor-server.ts"],
      "description": "Cross-check: Cursor CLI wrapper (Composer 1.5)"
    },
    "quorum-gemini": {
      "command": "./mcp-servers/run.sh",
      "args": ["gemini-server.ts"],
      "description": "Cross-check: Google Gemini CLI wrapper (gemini-3-pro)"
    },
    "quorum": {
      "command": "./mcp-servers/run.sh",
      "args": ["quorum-server.ts"],
      "description": "Quorum: fan out to all agents in parallel and return collected results"
    }
  }
}
```

</details>

<details>
<summary><code>settings.json</code></summary>

```json
{
  "permissions": {
    "allow": [
      "Bash(codex exec --full-auto --sandbox read-only *)",
      "Bash(copilot -p * --silent *)",
      "Bash(copilot --acp)",
      "Bash(agent -p --force --trust *)",
      "Bash(gemini -p * --yolo *)",
      "mcp__quorum-codex__codex_query",
      "mcp__quorum-copilot__copilot_query",
      "mcp__quorum-cursor__cursor_query",
      "mcp__quorum-gemini__gemini_query",
      "mcp__quorum__quorum_query"
    ]
  }
}
```

</details>

### Cursor

```bash
cd your-project
npx quorum-agents --setup cursor
```

This creates `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "quorum-codex": {
      "command": "npx",
      "args": ["quorum-agents", "--server", "codex"],
      "description": "Quorum: relay to codex (Codex, Copilot, Cursor, Gemini)"
    },
    "quorum-copilot": {
      "command": "npx",
      "args": ["quorum-agents", "--server", "copilot"],
      "description": "Quorum: relay to copilot (Codex, Copilot, Cursor, Gemini)"
    },
    "quorum-cursor": {
      "command": "npx",
      "args": ["quorum-agents", "--server", "cursor"],
      "description": "Quorum: relay to cursor (Codex, Copilot, Cursor, Gemini)"
    },
    "quorum-gemini": {
      "command": "npx",
      "args": ["quorum-agents", "--server", "gemini"],
      "description": "Quorum: relay to gemini (Codex, Copilot, Cursor, Gemini)"
    },
    "quorum": {
      "command": "npx",
      "args": ["quorum-agents", "--server", "quorum"],
      "description": "Quorum: fan out to all agents in parallel and return collected results"
    }
  }
}
```

Restart Cursor to pick up the new MCP servers.

### VS Code

```bash
cd your-project
npx quorum-agents --setup vscode
```

This creates `.vscode/mcp.json` (note: VS Code uses `servers` with `type: "stdio"`, not `mcpServers`):

```json
{
  "servers": {
    "quorum-codex": {
      "type": "stdio",
      "command": "npx",
      "args": ["quorum-agents", "--server", "codex"]
    },
    "quorum-copilot": {
      "type": "stdio",
      "command": "npx",
      "args": ["quorum-agents", "--server", "copilot"]
    },
    "quorum-cursor": {
      "type": "stdio",
      "command": "npx",
      "args": ["quorum-agents", "--server", "cursor"]
    },
    "quorum-gemini": {
      "type": "stdio",
      "command": "npx",
      "args": ["quorum-agents", "--server", "gemini"]
    },
    "quorum": {
      "type": "stdio",
      "command": "npx",
      "args": ["quorum-agents", "--server", "quorum"]
    }
  }
}
```

### Windsurf

```bash
cd your-project
npx quorum-agents --setup windsurf
```

This creates `.windsurf/mcp.json` with the same format as Cursor.

### Manual setup

For any MCP client, add 5 servers that each run `npx quorum-agents --server <name>` via stdio:

| Server name | Command | Args |
|-------------|---------|------|
| `quorum-codex` | `npx` | `quorum-agents --server codex` |
| `quorum-copilot` | `npx` | `quorum-agents --server copilot` |
| `quorum-cursor` | `npx` | `quorum-agents --server cursor` |
| `quorum-gemini` | `npx` | `quorum-agents --server gemini` |
| `quorum` | `npx` | `quorum-agents --server quorum` |

## Prerequisites

Each agent CLI must be installed and authenticated separately:

| Agent | CLI command | Install | Verify |
|-------|-------------|---------|--------|
| Claude | *(built-in)* | No install needed — uses Claude Code's own analysis capabilities | — |
| Codex | `codex` | [OpenAI Codex CLI](https://github.com/openai/codex) | `codex --version` |
| Copilot | `copilot` | [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) | `copilot --version` |
| Cursor | `agent` | [Cursor CLI](https://docs.cursor.com/cli) | `agent --version` |
| Gemini | `gemini` | [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini --version` |

You don't need all of them — Quorum works with as few as 2 agents. Disable any you don't have installed via `quorum.config.json`.

## Agent configuration

Edit `quorum.config.json` in the repo root to enable/disable agents:

```json
{
  "agents": {
    "claude": true,
    "codex": true,
    "copilot": true,
    "cursor": true,
    "gemini": true
  }
}
```

This config applies to both usage paths (Claude Code skills and MCP `quorum_query` tool).

## Usage

### Claude Code

```
/quorum:run review this PR
/quorum:run architecture — should we use Redis or Postgres for caching?
/quorum:run diagnose this stack trace
/quorum:run implement the logout flow from the plan above
/quorum:run review this repo
```

The skill auto-detects the mode from context. You can also be explicit:

| Mode | Trigger |
|------|---------|
| `review` | Diff, PR, or specific code to evaluate |
| `review-codebase` | Whole repo or directory review |
| `architecture` | Plan, design, or architecture discussion |
| `implement` | Implementation or spec to validate |
| `diagnose` | Errors, stack traces, or bug reports |

Inline flags:
- `--skip gemini,copilot` — disable specific agents for this run
- `--only codex,cursor` — run only these agents

Single agent testing:
```
/quorum:agent copilot say hello
/quorum:agent cursor what files are in the repo?
```

### MCP clients (Cursor, VS Code, Windsurf, etc.)

Call tools directly from your editor's AI chat. Each tool accepts:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The prompt to send |
| `workdir` | string | No | Working directory (defaults to cwd) |
| `timeout_ms` | number | No | Timeout in ms (default: 120000, max: 600000) |

The `quorum_query` tool adds one extra parameter:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agents` | string[] | No | Which agents to query (default: all enabled in config) |

## Available MCP tools

| Tool | Description |
|------|-------------|
| `codex_query` | Send a read-only prompt to OpenAI Codex CLI (gpt-5.3-codex) |
| `copilot_query` | Send a read-only prompt to GitHub Copilot CLI (ACP mode with plain fallback) |
| `cursor_query` | Send a read-only prompt to Cursor CLI (Composer 1.5) |
| `gemini_query` | Send a read-only prompt to Google Gemini CLI (gemini-3-pro) |
| `quorum_query` | Fan out a prompt to multiple AI agents in parallel and return all results |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Claude Code (or any MCP client)                         │
│                                                          │
│  /quorum:run  ──→  spawns up to 5 agents                 │
│                    in parallel via Task tool              │
└──┬────────┬────────┬────────┬────────┬───────────────────┘
   │        │        │        │        │
   ▼        ▼        ▼        ▼        ▼
 claude   codex    copilot  cursor   gemini    ← agents
 agent    agent    agent    agent    agent
   │        │        │        │        │
   │        ▼        ▼        ▼        ▼
   │     codex    copilot  cursor   gemini     ← MCP servers
   │     server   server   server   server       (subprocess exec)
   │        │        │        │        │
   │        ▼        ▼        ▼        ▼
   │     codex    copilot  agent    gemini     ← external CLIs
   │     CLI      CLI      CLI      CLI
   │
   ▼
 (direct analysis via Read/Glob/Grep — no MCP server)
```

**MCP servers** (`mcp-servers/src/`) wrap each CLI tool in an MCP-compatible interface. Each server exposes a single `*_query` tool that validates inputs (via Zod), spawns the CLI as a subprocess, handles timeouts and fallbacks, and returns a structured JSON result.

**Relay agents** (`agents/`) are thin pass-through agents that call their corresponding MCP tool and return the raw result. They exist so the `/quorum:run` skill can fan out via Claude Code's Task tool. The **claude-agent** is the exception — it directly analyzes code using filesystem tools (Read, Glob, Grep) instead of relaying to an external CLI, giving Claude a dual role as both participant and orchestrator/judge.

**Skills** (`skills/`) implement the orchestration logic:
- `skills/run/` — The main quorum skill. Detects mode, prepares a shared prompt, fans out to all enabled agents, deduplicates findings, runs blind judge reconciliation, and presents results.
- `skills/agent/` — Invokes a single agent for testing.

## Security model

Each agent CLI is invoked with specific permission flags:

| Agent | Flags | Effect |
|-------|-------|--------|
| Codex | `--sandbox read-only` | OS-level sandbox restricts the process to read-only filesystem access |
| Copilot | `--allow-tool read_file,list_dir,grep` | Explicit allowlist — only these three tools are available to the model |
| Cursor | `--force --trust` | Disables interactive confirmation prompts so the CLI can run non-interactively |
| Gemini | `--yolo` | Disables interactive confirmation prompts so the CLI can run non-interactively |

**Codex** and **Copilot** have hard constraints (sandbox and tool allowlist) that prevent write operations. **Cursor** and **Gemini** have broader permissions — the `READ-ONLY` preamble injected into each prompt is a soft constraint, not an OS-level sandbox. This trade-off is intentional: these CLIs do not currently offer read-only sandbox modes.

All CLI permissions are pre-configured in `settings.json` so agents execute without asking for user approval.

## How it works

1. **Prompt preparation** — The skill assembles a shared prompt from conversation context and the appropriate template (`skills/run/templates/`)
2. **Parallel fan-out** — All enabled agents are spawned simultaneously. Relay agents call their MCP server; the claude-agent analyzes directly using filesystem tools
3. **Fallback chains** — Copilot tries ACP mode first, falls back to plain CLI. Gemini tries `--output-format json` first, falls back to plain mode
4. **Mechanical reconciliation** — Findings are deduplicated, contradictions flagged, and disagreements classified (cosmetic/stylistic/structural/correctness)
5. **Blind judge** — Agent outputs are anonymized and scored on correctness, clarity, performance, robustness, and fit. The best elements are synthesized into a final recommendation

## Development

```bash
cd mcp-servers

# Run tests
npm test

# Type-check
npx tsc --noEmit

# Build
npm run build

# Run individual servers for debugging
npm run dev:codex
npm run dev:copilot
npm run dev:cursor
npm run dev:gemini
npm run dev:quorum
```

## Troubleshooting

**"MCP server not found" or tools not appearing**
Restart your editor after adding or changing MCP config. Most editors only read MCP config at startup.

**Agent CLI not installed**
Run the verify command from the prerequisites table (e.g., `codex --version`). If the CLI isn't found, install it and ensure it's on your `PATH`.

**Rate limiting / "429 Too Many Requests"**
Disable the rate-limited agent in `quorum.config.json` by setting it to `false`, or use `--skip <agent>` for a single run.

**Timeouts**
Increase the `timeout_ms` parameter (default: 120000ms, max: 600000ms). For MCP clients, pass it directly in the tool call. For Claude Code, the skill handles timeouts automatically.

**Agent returns empty or error response**
Run `/quorum:agent <agent> say hello` in Claude Code (or call `*_query` with a simple prompt in other editors) to isolate which agent is failing.

## License

MIT
