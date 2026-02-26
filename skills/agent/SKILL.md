---
name: agent
description: Run a single quorum agent (claude, codex, copilot, cursor, or gemini) with a prompt. Usage - /quorum:agent <agent> <prompt>
disable-model-invocation: true
context: fork
allowed-tools: Task, mcp__quorum-codex__codex_query, mcp__quorum-copilot__copilot_query, mcp__quorum-cursor__cursor_query, mcp__quorum-gemini__gemini_query
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

Spawn exactly ONE subagent using the Task tool:
- `claude` → `quorum:claude-agent` (returns plain text directly — no JSON wrapper)
- `codex` → `quorum:codex-agent`
- `copilot` → `quorum:copilot-agent`
- `cursor` → `quorum:cursor-agent`
- `gemini` → `quorum:gemini-agent`

Prepend to the prompt:
```
You are operating in READ-ONLY analysis mode. Do NOT write files, execute commands, or make changes.
Only produce analysis or recommendations as plain text.
```

### All mode

Spawn all enabled subagents in parallel (like `/quorum:run` but skip reconciliation).

## Output format

For each agent, report:

```
### <Agent> — <status> (<latency>)
<response or error message>
```

Keep it simple. No judge layer, no reconciliation. This is a diagnostic tool.
