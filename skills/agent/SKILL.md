---
name: agent
description: Run a single quorum agent (claude, codex, copilot, cursor, or gemini) with a prompt. Usage - /quorum:agent <agent> <prompt>
disable-model-invocation: true
context: fork
---

# /quorum:agent Skill

Test a single quorum agent by sending it a prompt and returning the raw result.

## Usage

```
/quorum:agent <agent> <prompt>
```

Where `<agent>` is one of: `claude`, `codex`, `copilot`, `cursor`, `gemini`, or `all` (to test all enabled agents).

Examples:
- `/quorum:agent copilot say hello`
- `/quorum:agent cursor what files are in the repo?`
- `/quorum:agent all say hello`

## Instructions

1. Parse the first word of ARGUMENTS as the agent name. Everything after is the prompt.
2. If the agent name is missing or invalid, list the valid options and ask.
3. If the prompt is missing, default to: `Reply with only the word 'ok'`

### Single agent mode (claude/codex/copilot/cursor/gemini)

Determine the absolute path of the current project root (the directory the user is working in).

Prepend to the prompt:
```
You are operating in READ-ONLY analysis mode. You may read files and explore the codebase, but do NOT write, modify, or delete any files.
Only produce analysis or recommendations as plain text.
```

**External agents (codex, copilot, cursor, gemini):** Call the MCP tool directly with the `workdir` parameter:
- `codex` → call `mcp__quorum-codex__codex_query` with `prompt` and `workdir`
- `copilot` → call `mcp__quorum-copilot__copilot_query` with `prompt` and `workdir`
- `cursor` → call `mcp__quorum-cursor__cursor_query` with `prompt` and `workdir`
- `gemini` → call `mcp__quorum-gemini__gemini_query` with `prompt` and `workdir`

**Claude agent:** Spawn via Task tool as `quorum:claude-agent`.

### All mode

Call `mcp__quorum__quorum_query` with the prompt and `workdir` to fan out to all external agents in parallel, and spawn `quorum:claude-agent` via Task tool simultaneously. Skip reconciliation — just report raw results.

## Output format

For each agent, report:

```
### <Agent> — <status> (<latency>)
<response or error message>
```

Keep it simple. No judge layer, no reconciliation. This is a diagnostic tool.
