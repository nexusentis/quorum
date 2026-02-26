import { z } from "zod";
import { spawn } from "node:child_process";
import { stat, realpath, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_BUFFER = 10 * 1024 * 1024;
export const TIMEOUT_DEFAULT = 120_000;
export const TIMEOUT_MIN = 1_000;
export const TIMEOUT_MAX = 600_000;
/** ACP mode cap — ACP is unreliable beyond this; triggers fallback to plain CLI */
export const ACP_TIMEOUT_CAP_MS = 10_000;
/** Time to wait for graceful exit before SIGKILL */
export const SIGKILL_GRACE_MS = 500;

// Error truncation
const ERROR_DETAIL_MAX_LEN = 1000;
const ERROR_TRUNCATE_CHARS = 500;

// Prompt cap
export const MAX_PROMPT_LENGTH = 100_000;

// Model names
const MODEL_CODEX = "gpt-5.3-codex";
const MODEL_COPILOT = "copilot-claude-sonnet";
const MODEL_CURSOR = "composer-1.5";
const MODEL_GEMINI = "gemini-3-pro";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentResult {
  agent: string;
  model: string;
  response: string;
  latency_ms: number;
  status: "success" | "error";
  error?: string;
}

export type ToolReturn = {
  content: [{ type: "text"; text: string }];
};

// ── Schema & Annotations ────────────────────────────────────────────────────

export const toolSchema = {
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH).describe("The full prompt to send"),
  workdir: z.string().optional().describe("Working directory for the command"),
  timeout_ms: z
    .number()
    .int()
    .min(TIMEOUT_MIN)
    .max(TIMEOUT_MAX)
    .optional()
    .default(TIMEOUT_DEFAULT)
    .describe("Timeout in milliseconds"),
};

export const toolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

export const geminiToolAnnotations = {
  readOnlyHint: false,
  openWorldHint: true,
} as const;

// ── Validation Helpers ───────────────────────────────────────────────────────

export async function validateWorkdir(
  workdir: string | undefined
): Promise<string> {
  if (!workdir) return process.cwd();
  if (/\0/.test(workdir)) {
    throw new Error("workdir must not contain null bytes");
  }
  const resolved = resolve(workdir);
  const real = await realpath(resolved);
  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new Error(`workdir is not a directory: ${real}`);
  }
  const cwd = await realpath(process.cwd());
  const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (real !== cwd && !real.startsWith(prefix)) {
    throw new Error(`workdir must be under the current working directory: ${real} is outside ${cwd}`);
  }
  return real;
}

export function validatePrompt(prompt: string): void {
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
  }
  if (/\0/.test(prompt)) {
    throw new Error("prompt must not contain null bytes");
  }
}

export function validateTimeout(timeout_ms: number | undefined): number {
  if (timeout_ms === undefined) return TIMEOUT_DEFAULT;
  if (!Number.isFinite(timeout_ms)) {
    throw new Error(`timeout_ms must be a finite number, got ${timeout_ms}`);
  }
  if (timeout_ms < TIMEOUT_MIN || timeout_ms > TIMEOUT_MAX) {
    throw new Error(
      `timeout_ms must be between ${TIMEOUT_MIN} and ${TIMEOUT_MAX}, got ${timeout_ms}`
    );
  }
  return timeout_ms;
}

// ── Utility Functions ────────────────────────────────────────────────────────

interface SpawnOpts {
  cmd: string;
  args: string[];
  cwd: string;
  timeout: number;
  label: string;
  stdinData?: string;
  processStdout?: (stdout: string, stderr: string, code: number | null) => string;
}

// Allowlist of env vars passed to child processes
const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  // Auth vars needed by CLIs
  "GITHUB_TOKEN", "GH_TOKEN", "COPILOT_TOKEN",
  "OPENAI_API_KEY", "CODEX_API_KEY",
  "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  // Proxy/network
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  // Node
  "NODE_ENV", "NODE_PATH",
];

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function spawnManaged(opts: SpawnOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    function settle(fn: () => void, preserveKillTimer = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!preserveKillTimer && killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      proc.stdout.removeAllListeners();
      proc.stderr.removeAllListeners();
      proc.stdin?.removeAllListeners();
      proc.removeAllListeners();
      fn();
    }

    function killProc(reason: string) {
      if (settled) return;
      try {
        proc.kill("SIGTERM");
      } catch {}

      killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, SIGKILL_GRACE_MS);
      killTimer.unref();

      // preserveKillTimer=true so SIGKILL fires if the process ignores SIGTERM
      settle(() => reject(new Error(reason)), true);
    }

    const timer = setTimeout(() => {
      killProc(`${opts.label} timed out after ${opts.timeout}ms`);
    }, opts.timeout);
    timer.unref();

    proc.stdout.on("data", (c: Buffer) => {
      stdoutLen += c.length;
      if (stdoutLen > MAX_BUFFER) {
        killProc(`${opts.label} stdout exceeded ${MAX_BUFFER} bytes`);
        return;
      }
      stdout += stdoutDecoder.write(c);
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderrLen += c.length;
      if (stderrLen > MAX_BUFFER) {
        killProc(`${opts.label} stderr exceeded ${MAX_BUFFER} bytes`);
        return;
      }
      stderr += stderrDecoder.write(c);
    });
    proc.on("error", (e) => {
      settle(() => reject(e));
    });
    // Node.js guarantees all 'data' events fire before 'close'
    proc.on("close", (code, signal) => {
      settle(() => {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (opts.processStdout) {
          try {
            resolve(opts.processStdout(stdout, stderr, code));
          } catch (e) {
            reject(e);
          }
          return;
        }
        if (code !== 0) {
          const fallback = signal
            ? `${opts.label} terminated by signal ${signal}`
            : `${opts.label} exited with code ${code}`;
          const raw = stderr || stdout || fallback;
          const detail = raw.length > ERROR_DETAIL_MAX_LEN ? raw.slice(0, ERROR_TRUNCATE_CHARS) + "\n...\n" + raw.slice(-ERROR_TRUNCATE_CHARS) : raw;
          reject(new Error(detail));
        } else {
          resolve(stdout);
        }
      });
    });

    if (opts.stdinData !== undefined) {
      proc.stdin?.on("error", (e) => {
        settle(() => reject(new Error(`${opts.label} stdin write failed: ${e.message}`)));
      });
      try {
        proc.stdin?.write(opts.stdinData);
        proc.stdin?.end();
      } catch (e) {
        settle(() => reject(new Error(`${opts.label} stdin write failed: ${e instanceof Error ? e.message : e}`)));
      }
    } else {
      proc.stdin?.end();
    }
  });
}

export function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number }
): Promise<string> {
  return spawnManaged({ cmd, args, cwd: opts.cwd, timeout: opts.timeout, label: cmd });
}

export function formatSuccess(
  agent: string,
  model: string,
  response: string,
  latencyMs: number
): ToolReturn {
  const result: AgentResult = {
    agent,
    model,
    response,
    latency_ms: latencyMs,
    status: "success",
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export function formatError(
  agent: string,
  model: string,
  error: unknown,
  latencyMs: number
): ToolReturn {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const result: AgentResult = {
    agent,
    model,
    response: "",
    latency_ms: latencyMs,
    status: "error",
    error: errorMsg,
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

// ── Agent Execution Functions ────────────────────────────────────────────────

export async function runCodex(
  prompt: string,
  workdir: string | undefined,
  timeout_ms: number | undefined
): Promise<ToolReturn> {
  const start = Date.now();

  try {
    validatePrompt(prompt);
    const cwd = await validateWorkdir(workdir);
    const timeout = validateTimeout(timeout_ms);
    const result = await exec(
      "codex",
      [
        "exec",
        "--full-auto",
        "--sandbox",
        "read-only",
        "-o",
        "/dev/stdout",
        "--",
        prompt,
      ],
      { cwd, timeout }
    );
    return formatSuccess("codex", MODEL_CODEX, result.trim(), Date.now() - start);
  } catch (err) {
    return formatError("codex", MODEL_CODEX, err, Date.now() - start);
  }
}

// ── Copilot internals ────────────────────────────────────────────────────────

function queryViaACP(
  prompt: string,
  cwd: string,
  timeoutMs: number
): Promise<string> {
  const acpLimit = Math.min(timeoutMs, ACP_TIMEOUT_CAP_MS);
  const jsonRpcPayload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "message",
    params: { messages: [{ role: "user", content: prompt }] },
  }) + "\n";

  return spawnManaged({
    cmd: "copilot",
    args: ["--acp"],
    cwd,
    timeout: acpLimit,
    label: "ACP",
    stdinData: jsonRpcPayload,
    processStdout(stdout, stderr, code) {
      if (code !== 0) {
        throw new Error(`ACP exited with code ${code}: ${stderr.slice(-ERROR_TRUNCATE_CHARS)}`);
      }
      try {
        const parsed = JSON.parse(stdout);
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error(`ACP returned non-object JSON: ${stdout.slice(0, ERROR_TRUNCATE_CHARS)}`);
        }
        if (parsed.error) {
          throw new Error(`ACP returned JSON-RPC error: ${JSON.stringify(parsed.error).slice(0, ERROR_TRUNCATE_CHARS)}`);
        }
        if (parsed.result == null) {
          throw new Error(`ACP returned empty response: ${stdout.slice(0, ERROR_TRUNCATE_CHARS)}`);
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error(`ACP returned invalid JSON: ${stdout.slice(0, ERROR_TRUNCATE_CHARS)}`);
        }
        throw e;
      }
      return stdout;
    },
  });
}

function queryViaPlain(
  prompt: string,
  cwd: string,
  timeoutMs: number
): Promise<string> {
  return exec(
    "copilot",
    [
      "--silent",
      "--allow-tool",
      "read_file",
      "--allow-tool",
      "list_dir",
      "--allow-tool",
      "grep",
      "-p",
      "--",
      prompt,
    ],
    { cwd, timeout: timeoutMs }
  );
}

export async function runCopilot(
  prompt: string,
  workdir: string | undefined,
  timeout_ms: number | undefined
): Promise<ToolReturn> {
  const start = Date.now();

  try {
    validatePrompt(prompt);
    const cwd = await validateWorkdir(workdir);
    const timeout = validateTimeout(timeout_ms);
    const deadline = start + timeout;
    let result: string;
    try {
      result = await queryViaACP(prompt, cwd, timeout);
    } catch (acpErr) {
      const msg = acpErr instanceof Error ? acpErr.message : String(acpErr);
      console.error(`[copilot] ACP mode failed in ${cwd} (${msg}), falling back to plain CLI`);
      const remaining = deadline - Date.now();
      if (remaining < TIMEOUT_MIN) throw new Error(`Copilot timed out (insufficient time for fallback after ACP failure)`);
      result = await queryViaPlain(prompt, cwd, remaining);
    }
    return formatSuccess(
      "copilot",
      MODEL_COPILOT,
      result.trim(),
      Date.now() - start
    );
  } catch (err) {
    return formatError(
      "copilot",
      MODEL_COPILOT,
      err,
      Date.now() - start
    );
  }
}

// ── Cursor ───────────────────────────────────────────────────────────────────

export async function runCursor(
  prompt: string,
  workdir: string | undefined,
  timeout_ms: number | undefined
): Promise<ToolReturn> {
  const start = Date.now();

  try {
    validatePrompt(prompt);
    const cwd = await validateWorkdir(workdir);
    const timeout = validateTimeout(timeout_ms);
    const result = await exec(
      "agent",
      [
        "-p",
        "--force",
        "--trust",
        "--output-format",
        "text",
        "--mode",
        "ask",
        "--",
        prompt,
      ],
      { cwd, timeout }
    );
    return formatSuccess(
      "cursor",
      MODEL_CURSOR,
      result.trim(),
      Date.now() - start
    );
  } catch (err) {
    return formatError("cursor", MODEL_CURSOR, err, Date.now() - start);
  }
}

// ── Gemini ───────────────────────────────────────────────────────────────────

export async function runGemini(
  prompt: string,
  workdir: string | undefined,
  timeout_ms: number | undefined
): Promise<ToolReturn> {
  const start = Date.now();

  try {
    validatePrompt(prompt);
    const cwd = await validateWorkdir(workdir);
    const timeout = validateTimeout(timeout_ms);
    const deadline = start + timeout;
    let result: string;
    const jsonTimeout = Math.ceil(timeout * 0.8);
    try {
      result = await exec(
        "gemini",
        ["--yolo", "--output-format", "json", "-p", "--", prompt],
        { cwd, timeout: jsonTimeout }
      );
    } catch (jsonErr) {
      const msg = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
      console.error(`[gemini] JSON format failed in ${cwd} (${msg}), falling back to plain mode`);
      const remaining = deadline - Date.now();
      if (remaining < TIMEOUT_MIN) throw new Error(`Gemini timed out (insufficient time for fallback after JSON format failure)`);
      result = await exec("gemini", ["--yolo", "-p", "--", prompt], {
        cwd,
        timeout: remaining,
      });
    }
    return formatSuccess(
      "gemini",
      MODEL_GEMINI,
      result.trim(),
      Date.now() - start
    );
  } catch (err) {
    return formatError("gemini", MODEL_GEMINI, err, Date.now() - start);
  }
}

// ── Quorum orchestration ────────────────────────────────────────────────────

export const EXTERNAL_AGENT_NAMES = ["codex", "copilot", "cursor", "gemini"] as const;
export type ExternalAgent = (typeof EXTERNAL_AGENT_NAMES)[number];

export const quorumToolSchema = {
  ...toolSchema,
  agents: z
    .array(z.enum(EXTERNAL_AGENT_NAMES as unknown as [ExternalAgent, ...ExternalAgent[]]))
    .refine((a) => new Set(a).size === a.length, "agents must not contain duplicates")
    .optional()
    .describe("Which agents to query (default: all enabled in quorum.config.json)"),
};

export interface QuorumResult {
  agents_queried: number;
  agents_succeeded: number;
  agents_failed: number;
  results: AgentResult[];
  rate_limited: string[];
  total_latency_ms: number;
  error?: string;
}

export async function getEnabledAgents(cwd: string): Promise<ExternalAgent[]> {
  try {
    const configPath = resolve(cwd, "quorum.config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    if (!config.agents || typeof config.agents !== "object" || Array.isArray(config.agents)) {
      return [...EXTERNAL_AGENT_NAMES];
    }
    const enabled = EXTERNAL_AGENT_NAMES.filter(
      (name) => config.agents[name] !== false
    );
    return enabled.length > 0 ? enabled : [...EXTERNAL_AGENT_NAMES];
  } catch (err) {
    const isNotFound = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      console.error(`[quorum] Failed to read quorum.config.json: ${err instanceof Error ? err.message : err}`);
    }
    return [...EXTERNAL_AGENT_NAMES];
  }
}

export function isRateLimited(msg: string): boolean {
  return /429|rate.?limit|too many requests/i.test(msg);
}

const AGENT_RUNNERS: Record<
  ExternalAgent,
  (prompt: string, workdir: string | undefined, timeout_ms: number | undefined) => Promise<ToolReturn>
> = {
  codex: runCodex,
  copilot: runCopilot,
  cursor: runCursor,
  gemini: runGemini,
};

export async function runQuorum(
  prompt: string,
  workdir: string | undefined,
  timeout_ms: number | undefined,
  agents?: ExternalAgent[]
): Promise<ToolReturn> {
  const start = Date.now();

  try {
    validatePrompt(prompt);
    const cwd = await validateWorkdir(workdir);
    const timeout = validateTimeout(timeout_ms);

    const targetAgents = agents && agents.length > 0
      ? agents
      : await getEnabledAgents(cwd);

    const settled = await Promise.allSettled(
      targetAgents.map((agent) => AGENT_RUNNERS[agent](prompt, cwd, timeout))
    );

    const results: AgentResult[] = [];
    const rateLimited: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const agent = targetAgents[i];

      if (outcome.status === "fulfilled") {
        let parsed: AgentResult;
        const raw = outcome.value?.content?.[0]?.text;
        if (!raw) {
          parsed = {
            agent,
            model: "unknown",
            response: "",
            latency_ms: Date.now() - start,
            status: "error",
            error: "empty or malformed tool response",
          };
        } else try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = {
            agent,
            model: "unknown",
            response: "",
            latency_ms: Date.now() - start,
            status: "error",
            error: `malformed JSON response: ${raw.slice(0, 100)}`,
          };
        }
        results.push(parsed);
        if (parsed.status === "error" && parsed.error && isRateLimited(parsed.error)) {
          rateLimited.push(agent);
        }
      } else {
        // Defensive: all runners have try/catch so this branch shouldn't fire,
        // but it protects against future runners that might reject.
        const errorMsg = outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
        results.push({
          agent,
          model: "unknown",
          response: "",
          latency_ms: Date.now() - start,
          status: "error",
          error: errorMsg,
        });
        if (isRateLimited(errorMsg)) {
          rateLimited.push(agent);
        }
      }
    }

    const succeeded = results.filter((r) => r.status === "success").length;
    const failed = results.filter((r) => r.status === "error").length;

    const quorumResult: QuorumResult = {
      agents_queried: targetAgents.length,
      agents_succeeded: succeeded,
      agents_failed: failed,
      results,
      rate_limited: rateLimited,
      total_latency_ms: Date.now() - start,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(quorumResult) }] };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const quorumResult: QuorumResult = {
      agents_queried: 0,
      agents_succeeded: 0,
      agents_failed: 0,
      results: [],
      rate_limited: [],
      total_latency_ms: Date.now() - start,
      error: errorMsg,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(quorumResult) }] };
  }
}
