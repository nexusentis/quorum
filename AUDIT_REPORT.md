# Quorum Audit Report

## 1. Agent Definitions vs MCP Tool Names and Capabilities

### Status: ✅ **Match**

Agent definitions correctly reference the MCP tools:

| Agent | Tool Referenced | MCP Server | Actual Tool Name |
|-------|-----------------|------------|------------------|
| codex-agent | `mcp__quorum-codex__codex_query` | quorum-codex | codex_query |
| copilot-agent | `mcp__quorum-copilot__copilot_query` | quorum-copilot | copilot_query |
| cursor-agent | `mcp__quorum-cursor__cursor_query` | quorum-cursor | cursor_query |
| gemini-agent | `mcp__quorum-gemini__gemini_query` | quorum-gemini | gemini_query |

The `.mcp.json` config spawns per-agent servers (`quorum-codex`, `quorum-copilot`, etc.) via `run.sh`, and each server exposes exactly one tool with the expected name.

**Note:** The unified server was removed. Only per-agent servers are supported.

---

## 2. quorum.config.json Validation

### Status: ⚠️ **Not Validated**

**Finding:** `quorum.config.json` is read only by the skill (natural language instructions tell the model to read it). There is **no programmatic validation** of the config anywhere in the codebase.

The config shape is documented in the skill:
```json
{ "agents": { "claude": true, "codex": true, "copilot": true, "cursor": true, "gemini": false } }
```

**Risks:**
- Malformed JSON → model may fail to parse or misinterpret
- Unknown keys → silently ignored
- Invalid agent names (e.g. `"codexx": true`) → may spawn non-existent agents or be ignored
- Missing `agents` key → undefined behavior

**Recommendation (from ARCHITECTURE.md):** Add a `loadQuorumConfig()` function with Zod schema validation. Validate on read and reject invalid configs. This could live in a small shared module or in the skill loader if one exists.

---

## 3. Missing Error Handling in the Skill Layer

### Status: ⚠️ **Gaps Identified**

The skill layer is declarative (SKILL.md) — the model executes instructions. Error handling is implicit in natural language, not explicit in code.

| Gap | Description |
|-----|-------------|
| **Agent JSON parse** | Skill says "Parse each agent's JSON response" but does not instruct the model to wrap `JSON.parse` in try/catch. Malformed JSON from an agent could cause the flow to fail. ARCHITECTURE.md suggests: treat parse errors as agent failure. |
| **Config parse** | Skill says "Read quorum.config.json" but doesn't handle read failures or invalid JSON. |
| **--skip / --only validation** | Parsed from natural language; no strict validation of agent names against `["claude","codex","copilot","cursor","gemini"]`. Typos (e.g. `--skip codrex`) could be silently ignored. |
| **Minimum 2 agents** | Checked only in skill logic (text). Could be enforced in a validator if config loading is programmatic. |

**Recommendation:** Update SKILL.md to explicitly instruct:
1. When parsing agent JSON: "If JSON.parse throws, treat that agent as failed (status: error) and continue with others."
2. When reading config: "If the file cannot be read or parsed as valid JSON, report an error and stop."
3. Validate `--skip` and `--only` values against the allowed agent list before use.

---

## 4. Test Coverage and Edge Cases

### Status: ✅ **Good Coverage**

**Covered:**
- `validateWorkdir` — cwd, valid dir, non-existent, file, root restriction, symlink resolution
- `validateTimeout` — default, in-range, below min, above max, NaN, Infinity
- `formatSuccess` / `formatError` — structure, Error vs string
- `toolSchema` (Zod) — prompt, timeout, rejections, MAX_PROMPT_LENGTH
- `exec()` — success, non-zero exit, timeout, buffer overflow, spawn error, error truncation
- `runCodex` — success, non-zero exit
- `runCopilot` — ACP success, ACP fail → plain fallback, ACP invalid JSON → fallback
- `runCursor` — success, non-zero exit
- `runGemini` — JSON success, JSON fail → plain fallback, both fail → error
- SIGKILL timer — fires after grace period on timeout
- Environment variable filtering — allowlist enforcement
- UTF-8 multi-byte handling — split chunks across boundaries

---

## 5. Server Architecture

### Status: ✅ **Resolved**

The unified server was removed. Only per-agent servers are supported (`codex-server.ts`, `copilot-server.ts`, `cursor-server.ts`, `gemini-server.ts`), each exposing a single `*_query` tool via individual MCP server instances.

---

## 6. Agent JSON Result Handling

### Status: ✅ **Correct at MCP Layer** | ⚠️ **Skill Layer Relies on Model Compliance**

**MCP layer (helpers.ts):**
- `formatSuccess` and `formatError` always produce valid JSON with shape:
  ```json
  { "agent", "model", "response", "latency_ms", "status": "success"|"error"[, "error"] }
  ```
- `JSON.stringify` is used; output is always well-formed.

**Relay agents:**
- Instructed to "Return the raw JSON result verbatim" from the tool.
- On tool failure, instructed to return `{"agent": "...", "status": "error", "error": "..."}` — a valid structure (though missing `model`, `response`, `latency_ms`).

**Potential mismatch:**
- On MCP tool failure, the tool handler catches and returns `formatError()` — full structure.
- If the relay agent's tool call fails at the client level (e.g. timeout, connection), the agent is instructed to synthesize `{"agent": "codex", "status": "error", "error": "..."}`. This is a **reduced** structure compared to `formatError`, which includes `model`, `response`, `latency_ms`. The skill checks `status === "error"` and uses `response` for success — so the reduced structure is still valid for error classification.

**Skill parsing:**
- Skill says: "Parse each agent's JSON response. Classify status: Success: has `response` field with content; Failed: `status === "error"` or timed out."
- If an agent returns corrupted or non-JSON (e.g. model adds commentary), `JSON.parse` would throw. The skill does not explicitly instruct try/catch.

**Recommendation:** Add to SKILL.md: "If `JSON.parse` on an agent's output fails, treat that agent as failed (status: error) and exclude from reconciliation."

---

## Summary

| # | Area | Status | Priority |
|---|------|--------|----------|
| 1 | Agent defs vs MCP tools | Match (but unified server incompatible) | Medium |
| 2 | quorum.config.json validation | Not validated | High |
| 3 | Skill error handling | Gaps (JSON parse, config, --skip/--only) | Medium |
| 4 | Test coverage | runCodex/runCursor missing; some edge cases | Medium |
| 5 | unified vs per-agent | Minor description drift; logic identical | Low |
| 6 | Agent JSON handling | MCP correct; skill needs parse-failure handling | Medium |
