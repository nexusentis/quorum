---
name: run
description: Fan out a task to Claude, Codex, Copilot, Cursor, and Gemini in parallel, then reconcile their outputs into a high-confidence recommendation. Use for planning, code review, implementation validation, bug diagnosis, and architecture decisions — not for quick changes.
disable-model-invocation: true
context: fork
allowed-tools: Task, Read, mcp__quorum__quorum_query
---

# /quorum:run Skill

## Step 0: Determine which agents are enabled

1. Read `quorum.config.json` from the repo root. It has the shape:
   ```json
   { "agents": { "claude": true, "codex": true, "copilot": true, "cursor": true, "gemini": false } }
   ```
   Agents set to `false` are **skipped** — do not spawn them.

2. Check ARGUMENTS for inline overrides (parsed before the mode/prompt):
   - `--skip <agent>[,<agent>...]` — disable specific agents for this run (e.g., `--skip gemini,copilot`)
   - `--only <agent>[,<agent>...]` — run ONLY these agents, ignore config (e.g., `--only codex,cursor`)

   **Validate each agent name** in `--skip` and `--only` against the canonical list: `[claude, codex, copilot, cursor, gemini]`. If any name is not recognized, report an error listing the invalid name(s) and stop. Do not silently ignore typos.

   Strip these flags from the arguments before parsing the mode and prompt.

3. The final enabled set must have **at least 2 agents**. If not, report an error and stop.

## Step 1: Determine the mode and gather context automatically

The user can invoke `/quorum:run` in several ways:
- `/quorum:run` — infer both the mode and context from the conversation so far
- `/quorum:run review` — mode is explicit, context is inferred
- `/quorum:run architecture — should we use X or Y?` — mode and extra context are explicit
- `/quorum:run` after Claude already produced a plan/implementation — the quorum validates what Claude just said

**Mode detection** — infer automatically, never ask the user to clarify:
- If the conversation contains a plan, design, or architecture discussion → `architecture`
- If the conversation contains a diff, PR, or specific code to evaluate → `review`
- If the user asks to review the whole codebase/repo (no specific diff) → `review-codebase`
- If the conversation contains an implementation or spec → `implement`
- If the conversation contains errors, stack traces, or bug reports → `diagnose`
- If none of the above match → `ask`

Load the appropriate prompt template from `skills/run/templates/`.

## Step 2: Prepare the shared prompt from conversation context

**Automatically extract context from the current conversation.** Do NOT ask the user to paste or repeat anything that is already in the conversation history. Specifically:

- If Claude just produced a plan, implementation, analysis, or recommendation — include it verbatim as the subject of the quorum evaluation
- If the user provided code, diffs, errors, or specs earlier in the conversation — include those
- If relevant files were read during the conversation — include the key excerpts
- If the user provides additional inline context with the `/quorum:run` command — merge it in

**For `review-codebase` mode:** Do NOT try to inline the entire codebase into the prompt. The external agents run in the project directory and can read files themselves. Instead:
- Fill the `{SCOPE}` placeholder with what to focus on (e.g., "the entire repo", "the src/ directory", "the authentication module")
- If the user specified a focus area, include it. Otherwise default to the entire repo
- The agents will explore the filesystem, read files, and produce their own findings

For all other modes, assemble the prompt by filling the template placeholders with extracted context. The prompt given to all agents must be IDENTICAL. Do not customize per agent.

Prepend to all prompts:
```
You are operating in READ-ONLY analysis mode. You may read files and explore the codebase, but do NOT write, modify, or delete any files.
Only produce analysis, review findings, implementation proposals, or recommendations as plain text or code blocks.
```

## Step 3: Fan out in parallel

Dispatch all enabled agents simultaneously. Determine the absolute path of the current project root first.

**External agents (codex, copilot, cursor, gemini):** Make a SINGLE call to `mcp__quorum__quorum_query` with:
- `prompt` — the prepared prompt from Step 2
- `workdir` — the absolute project root path
- `agents` — (optional) list of enabled external agents, if not all 4 are enabled

This one call fans out to all external agents in parallel and returns all results. Do NOT call individual agent tools or spawn relay agents — use `quorum_query`.

**Claude agent:** Spawn via the Task tool as `quorum:claude-agent` with the same prompt. This gives Claude a separate participant context so its output can be judged blindly.

Launch both the `quorum_query` call and the `claude-agent` Task simultaneously. Wait for all to complete (or timeout at 120s). Proceed if at least 2 agents return successfully.

## Step 4: Collect and parse results

Parse each agent's JSON response (wrap in try/catch). Classify status:
- Success: has `response` field with content
- Failed: `status === "error"`, timed out, or JSON.parse threw a SyntaxError
- **Rate-limited**: error message contains `429`, `rate limit`, or `too many requests` (case-insensitive)

If JSON.parse fails on an agent's output, treat that agent as failed (status: "error", error: "malformed JSON response") and continue with the remaining agents.

**Rate limit handling:** If any agent failed due to rate limiting, after presenting results report: "Out of tokens in **{agent}**." and ask the user if they want to disable that agent (i.e., set it to `false` in `quorum.config.json`). If the user confirms, update the config file.

If fewer than 2 agents succeeded, report failure and stop.

## Step 5: Mechanical reconciliation (run before judge layer)

Before calling the judge, do a deterministic pass:
1. **Deduplicate identical findings** — if 3+ agents say the exact same thing, mark as HIGH CONFIDENCE
2. **Detect contradictions** — flag where agents give directly opposing recommendations
3. **Classify disagreements:**
   - `cosmetic` — naming, formatting, style (auto-resolve using project conventions, don't flag)
   - `stylistic` — valid alternatives with similar trade-offs (note but don't flag)
   - `structural` — meaningfully different approaches (flag for judge)
   - `correctness` — one or more agents may be wrong (flag for judge, high priority)

## Step 6: Judge layer (blind reconciliation)

You act as the judge. Present agent outputs ANONYMOUSLY as Solution A / B / C / D / E (one per responding agent; randomize mapping each time — do not always assign A=Claude, B=Codex, etc.).

For each flagged disagreement, score the competing solutions on:
1. **Correctness** (1-5): Handles the requirements and edge cases
2. **Clarity** (1-5): Easy to understand and maintain
3. **Performance** (1-5): Appropriate complexity for the context
4. **Robustness** (1-5): Error handling, edge cases, failure modes
5. **Fit** (1-5): Consistent with the existing codebase patterns

Total score determines the winner. For implementation mode: if tests exist, run candidate code against them before scoring — test results override subjective scoring.

If solutions are complementary (each catches different things), synthesize the best elements into a single output.

## Step 7: Present results

Format output as follows:

---
### Quorum Results [{mode}] — {N}/{total enabled} agents responded

**Bottom line:** [one sentence]

**Confidence:** [HIGH / MEDIUM / LOW] — [N] agents agree on the core recommendation

**Agents:** [list enabled agents] | **Skipped:** [list disabled agents, if any]

---

#### Recommendation
[The synthesized best output — code, analysis, or recommendation]

---

#### Disagreements
[Only structural/correctness disagreements, with your reasoning for the resolution]

---

#### Agent Summary
| Agent | Status | Latency | Key Finding |
|-------|--------|---------|-------------|
[Only rows for enabled agents]

<details>
<summary>Raw agent outputs</summary>

[Only sections for enabled agents]
</details>
---

## Rules
- ALWAYS spawn enabled agents in parallel — never sequential
- NEVER reveal agent identity during blind judge scoring
- Claude's participant output (from claude-agent) must be treated identically to all other agents — no self-recognition, no privileged access, no special weighting during judging
- If an agent fails or times out, proceed with remaining agents (minimum 2 successful)
- For implement mode: prefer test-passing over subjective scoring
- Cosmetic/stylistic disagreements: resolve silently, do not surface to user
- The READ-ONLY instruction must always be prepended to all outgoing prompts
- Respect `quorum.config.json` — never spawn a disabled agent unless overridden with `--only`
