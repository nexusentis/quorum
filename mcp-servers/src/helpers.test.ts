import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  validateWorkdir,
  validateTimeout,
  validatePrompt,
  formatSuccess,
  formatError,
  exec,
  runCodex,
  runCopilot,
  runCursor,
  runGemini,
  runQuorum,
  getEnabledAgents,
  isRateLimited,
  toolSchema,
  quorumToolSchema,
  EXTERNAL_AGENT_NAMES,
  TIMEOUT_DEFAULT,
  TIMEOUT_MIN,
  TIMEOUT_MAX,
  MAX_BUFFER,
  MAX_PROMPT_LENGTH,
  SIGKILL_GRACE_MS,
} from "./helpers.js";
import { EventEmitter } from "node:events";
import { z } from "zod";

// ── validateWorkdir ──────────────────────────────────────────────────────────

describe("validateWorkdir", () => {
  it("returns cwd when workdir is undefined", async () => {
    const result = await validateWorkdir(undefined);
    expect(result).toBe(process.cwd());
  });

  it("resolves a valid directory under cwd", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".helpers-test-"));
    const real = await realpath(dir);
    try {
      const result = await validateWorkdir(dir);
      expect(result).toBe(real);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws for a non-existent path", async () => {
    await expect(validateWorkdir("/nonexistent-path-abc123")).rejects.toThrow();
  });

  it("throws for a file (not a directory)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helpers-test-"));
    const file = join(dir, "file.txt");
    await writeFile(file, "hello");
    try {
      await expect(validateWorkdir(file)).rejects.toThrow(
        "workdir is not a directory"
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ── validateTimeout ──────────────────────────────────────────────────────────

describe("validateTimeout", () => {
  it("returns default for undefined", () => {
    expect(validateTimeout(undefined)).toBe(TIMEOUT_DEFAULT);
  });

  it("returns the value when within range", () => {
    expect(validateTimeout(5000)).toBe(5000);
  });

  it("throws for values below TIMEOUT_MIN", () => {
    expect(() => validateTimeout(500)).toThrow(
      `timeout_ms must be between ${TIMEOUT_MIN} and ${TIMEOUT_MAX}`
    );
  });

  it("throws for values above TIMEOUT_MAX", () => {
    expect(() => validateTimeout(700_000)).toThrow(
      `timeout_ms must be between ${TIMEOUT_MIN} and ${TIMEOUT_MAX}`
    );
  });

  it("throws for NaN", () => {
    expect(() => validateTimeout(NaN)).toThrow("must be a finite number");
  });

  it("throws for Infinity", () => {
    expect(() => validateTimeout(Infinity)).toThrow("must be a finite number");
  });
});

// ── formatSuccess / formatError ──────────────────────────────────────────────

describe("formatSuccess", () => {
  it("returns correct structure", () => {
    const result = formatSuccess("test-agent", "test-model", "hello", 42);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      agent: "test-agent",
      model: "test-model",
      response: "hello",
      latency_ms: 42,
      status: "success",
    });
  });
});

describe("formatError", () => {
  it("returns correct structure with Error object", () => {
    const result = formatError(
      "test-agent",
      "test-model",
      new Error("boom"),
      99
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      agent: "test-agent",
      model: "test-model",
      response: "",
      latency_ms: 99,
      status: "error",
      error: "boom",
    });
  });

  it("handles string errors", () => {
    const result = formatError("a", "m", "string error", 1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("string error");
  });
});

// ── toolSchema Zod validation ────────────────────────────────────────────────

describe("toolSchema", () => {
  const schema = z.object(toolSchema);

  it("accepts a valid prompt", () => {
    const result = schema.parse({ prompt: "hello" });
    expect(result.prompt).toBe("hello");
    expect(result.timeout_ms).toBe(TIMEOUT_DEFAULT);
  });

  it("rejects missing prompt", () => {
    expect(() => schema.parse({})).toThrow();
  });

  it("rejects empty prompt", () => {
    expect(() => schema.parse({ prompt: "" })).toThrow();
  });

  it("accepts a valid timeout_ms", () => {
    const result = schema.parse({ prompt: "hi", timeout_ms: 5000 });
    expect(result.timeout_ms).toBe(5000);
  });

  it("rejects timeout_ms below TIMEOUT_MIN", () => {
    expect(() => schema.parse({ prompt: "hi", timeout_ms: 500 })).toThrow();
  });

  it("rejects timeout_ms above TIMEOUT_MAX", () => {
    expect(() =>
      schema.parse({ prompt: "hi", timeout_ms: 700_000 })
    ).toThrow();
  });

  it("rejects non-integer timeout_ms", () => {
    expect(() =>
      schema.parse({ prompt: "hi", timeout_ms: 1000.5 })
    ).toThrow();
  });

  it("rejects prompt exceeding MAX_PROMPT_LENGTH", () => {
    expect(() =>
      schema.parse({ prompt: "x".repeat(MAX_PROMPT_LENGTH + 1) })
    ).toThrow();
  });

  it("accepts prompt at MAX_PROMPT_LENGTH", () => {
    const result = schema.parse({ prompt: "x".repeat(MAX_PROMPT_LENGTH) });
    expect(result.prompt.length).toBe(MAX_PROMPT_LENGTH);
  });
});

// ── Mock spawn helper ────────────────────────────────────────────────────────

interface MockProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

function createMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

// ── exec() tests ────────────────────────────────────────────────────────────

describe("exec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with stdout on exit code 0", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("echo", ["hello"], { cwd: "/tmp", timeout: 5000 });
    proc.stdout.emit("data", Buffer.from("hello world"));
    proc.emit("close", 0);

    const result = await promise;
    expect(result).toBe("hello world");
  });

  it("rejects with stderr/stdout detail on non-zero exit code", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("fail", [], { cwd: "/tmp", timeout: 5000 });
    proc.stderr.emit("data", Buffer.from("something went wrong"));
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow("something went wrong");
  });

  it("rejects on timeout (sends SIGTERM)", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("slow", [], { cwd: "/tmp", timeout: 1000 });

    vi.advanceTimersByTime(1000);

    await expect(promise).rejects.toThrow("slow timed out after 1000ms");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects on stdout buffer overflow", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("big", [], { cwd: "/tmp", timeout: 5000 });
    const bigBuf = Buffer.alloc(MAX_BUFFER + 1, "x");
    proc.stdout.emit("data", bigBuf);

    await expect(promise).rejects.toThrow("stdout exceeded");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects on spawn error", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("nope", [], { cwd: "/tmp", timeout: 5000 });
    proc.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow("ENOENT");
  });

  it("truncates long error detail", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("verbose", [], { cwd: "/tmp", timeout: 5000 });
    const longErr = "x".repeat(2000);
    proc.stderr.emit("data", Buffer.from(longErr));
    proc.emit("close", 1);

    const err = await promise.catch((e: Error) => e);
    expect(err.message).toContain("...");
    expect(err.message.length).toBeLessThan(longErr.length);
  });
});

// ── runCopilot fallback tests ───────────────────────────────────────────────

describe("runCopilot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ACP result on success", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runCopilot("hello", process.cwd(), 120_000);

    // Wait for spawn to be called (after async validateWorkdir)
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    // Send valid JSON-RPC response so ACP processStdout accepts it
    const acpResponse = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: "ACP response" } });
    proc.stdout.emit("data", Buffer.from(acpResponse));
    proc.emit("close", 0);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("success");
    expect(parsed.response).toBe(acpResponse);
  });

  it("falls back to plain CLI when ACP fails", async () => {
    const acpProc = createMockProc();
    const plainProc = createMockProc();
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? acpProc : plainProc) as any;
    });

    const promise = runCopilot("hello", process.cwd(), 120_000);

    // Wait for ACP spawn
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    // ACP fails
    acpProc.stderr.emit("data", Buffer.from("ACP broken"));
    acpProc.emit("close", 1);

    // Wait for fallback to spawn
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    // Plain succeeds
    plainProc.stdout.emit("data", Buffer.from("plain response"));
    plainProc.emit("close", 0);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("success");
    expect(parsed.response).toBe("plain response");
  });
});

// ── runGemini fallback tests ────────────────────────────────────────────────

describe("runGemini", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns result on JSON mode success", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runGemini("hello", process.cwd(), 120_000);

    // Wait for spawn to be called (after async validateWorkdir)
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    proc.stdout.emit("data", Buffer.from('{"answer": "yes"}'));
    proc.emit("close", 0);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("success");
    expect(parsed.response).toBe('{"answer": "yes"}');
  });

  it("falls back to plain mode when JSON mode fails", async () => {
    const jsonProc = createMockProc();
    const plainProc = createMockProc();
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? jsonProc : plainProc) as any;
    });

    const promise = runGemini("hello", process.cwd(), 120_000);

    // Wait for JSON mode spawn
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    // JSON mode fails
    jsonProc.stderr.emit("data", Buffer.from("unknown flag"));
    jsonProc.emit("close", 1);

    // Wait for fallback spawn
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    // Plain mode succeeds
    plainProc.stdout.emit("data", Buffer.from("plain answer"));
    plainProc.emit("close", 0);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("success");
    expect(parsed.response).toBe("plain answer");
  });

  it("returns error when both modes fail", async () => {
    const jsonProc = createMockProc();
    const plainProc = createMockProc();
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? jsonProc : plainProc) as any;
    });

    const promise = runGemini("hello", process.cwd(), 120_000);

    // Wait for JSON mode spawn
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    // JSON mode fails
    jsonProc.stderr.emit("data", Buffer.from("json fail"));
    jsonProc.emit("close", 1);

    // Wait for fallback spawn
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    // Plain mode also fails
    plainProc.stderr.emit("data", Buffer.from("plain fail"));
    plainProc.emit("close", 1);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
  });
});

// ── validateWorkdir null bytes ───────────────────────────────────────────────

describe("validateWorkdir null bytes", () => {
  it("rejects workdir containing null bytes", async () => {
    await expect(validateWorkdir("/tmp/foo\0bar")).rejects.toThrow(
      "workdir must not contain null bytes"
    );
  });
});

// ── validateWorkdir root restriction ────────────────────────────────────────

describe("validateWorkdir root restriction", () => {
  it("rejects workdir outside cwd", async () => {
    await expect(validateWorkdir("/etc")).rejects.toThrow(
      "workdir must be under the current working directory"
    );
  });

  it("accepts workdir under cwd", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".test-workdir-"));
    const real = await realpath(dir);
    try {
      const result = await validateWorkdir(dir);
      expect(result).toBe(real);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ── SIGKILL timer test ──────────────────────────────────────────────────────

describe("SIGKILL on timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends SIGKILL after grace period when process ignores SIGTERM", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("stubborn", [], { cwd: "/tmp", timeout: 1000 });

    // Trigger timeout → SIGTERM
    vi.advanceTimersByTime(1000);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    // Advance past SIGKILL grace period
    vi.advanceTimersByTime(SIGKILL_GRACE_MS);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

    await expect(promise).rejects.toThrow("stubborn timed out after 1000ms");
  });
});

// ── runCodex tests ──────────────────────────────────────────────────────────

describe("runCodex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes codex with correct flags and returns success", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runCodex("analyze this", process.cwd(), 120_000);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      ["exec", "--full-auto", "--sandbox", "read-only", "-o", "/dev/stdout", "--", "analyze this"],
      expect.objectContaining({ cwd: expect.any(String) })
    );

    proc.stdout.emit("data", Buffer.from("codex result"));
    proc.emit("close", 0);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("success");
    expect(parsed.agent).toBe("codex");
    expect(parsed.response).toBe("codex result");
  });

  it("returns error on non-zero exit", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runCodex("fail", process.cwd(), 120_000);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    proc.stderr.emit("data", Buffer.from("codex error"));
    proc.emit("close", 1);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.agent).toBe("codex");
  });
});

// ── runCursor tests ─────────────────────────────────────────────────────────

describe("runCursor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes agent with correct flags and returns success", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runCursor("analyze this", process.cwd(), 120_000);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "agent",
      ["-p", "--force", "--trust", "--output-format", "text", "--mode", "ask", "--", "analyze this"],
      expect.objectContaining({ cwd: expect.any(String) })
    );

    proc.stdout.emit("data", Buffer.from("cursor result"));
    proc.emit("close", 0);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("success");
    expect(parsed.agent).toBe("cursor");
    expect(parsed.response).toBe("cursor result");
  });

  it("returns error on non-zero exit", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runCursor("fail", process.cwd(), 120_000);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    proc.stderr.emit("data", Buffer.from("cursor error"));
    proc.emit("close", 1);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.agent).toBe("cursor");
  });
});

// ── ACP SyntaxError fallback test ───────────────────────────────────────────

describe("runCopilot ACP invalid JSON", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to plain CLI when ACP returns invalid JSON", async () => {
    const acpProc = createMockProc();
    const plainProc = createMockProc();
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? acpProc : plainProc) as any;
    });

    const promise = runCopilot("hello", process.cwd(), 120_000);

    // Wait for ACP spawn
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    // ACP returns invalid JSON (exit code 0 but bad output)
    acpProc.stdout.emit("data", Buffer.from("not valid json {{{"));
    acpProc.emit("close", 0);

    // Wait for fallback to plain CLI
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    // Plain CLI succeeds
    plainProc.stdout.emit("data", Buffer.from("plain response"));
    plainProc.emit("close", 0);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("success");
    expect(parsed.response).toBe("plain response");
  });
});

// ── getEnabledAgents tests ──────────────────────────────────────────────────

describe("getEnabledAgents", () => {
  it("returns all agents when config file is missing", async () => {
    const agents = await getEnabledAgents("/nonexistent-path-xyz");
    expect(agents).toEqual([...EXTERNAL_AGENT_NAMES]);
  });

  it("returns only enabled agents from config", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".quorum-test-"));
    try {
      await writeFile(
        join(dir, "quorum.config.json"),
        JSON.stringify({ agents: { codex: true, copilot: false, cursor: true, gemini: false } })
      );
      const agents = await getEnabledAgents(dir);
      expect(agents).toEqual(["codex", "cursor"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns all agents and logs warning when config has invalid JSON", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".quorum-test-"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(join(dir, "quorum.config.json"), "not json{{{");
      const agents = await getEnabledAgents(dir);
      expect(agents).toEqual([...EXTERNAL_AGENT_NAMES]);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("[quorum] Failed to read quorum.config.json"));
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true });
    }
  });

  it("ignores claude agent in config", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".quorum-test-"));
    try {
      await writeFile(
        join(dir, "quorum.config.json"),
        JSON.stringify({ agents: { claude: true, codex: true, copilot: true, cursor: true, gemini: true } })
      );
      const agents = await getEnabledAgents(dir);
      // claude is not in EXTERNAL_AGENT_NAMES, so it's ignored
      expect(agents).toEqual([...EXTERNAL_AGENT_NAMES]);
      expect(agents).not.toContain("claude");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns all agents when all are disabled (fallback)", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".quorum-test-"));
    try {
      await writeFile(
        join(dir, "quorum.config.json"),
        JSON.stringify({ agents: { codex: false, copilot: false, cursor: false, gemini: false } })
      );
      const agents = await getEnabledAgents(dir);
      expect(agents).toEqual([...EXTERNAL_AGENT_NAMES]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ── isRateLimited tests ─────────────────────────────────────────────────────

describe("isRateLimited", () => {
  it("detects 429 status code", () => {
    expect(isRateLimited("HTTP 429 Too Many Requests")).toBe(true);
  });

  it("detects rate limit text", () => {
    expect(isRateLimited("rate limit exceeded")).toBe(true);
    expect(isRateLimited("Rate Limit")).toBe(true);
  });

  it("detects too many requests", () => {
    expect(isRateLimited("too many requests")).toBe(true);
  });

  it("returns false for normal errors", () => {
    expect(isRateLimited("connection timeout")).toBe(false);
    expect(isRateLimited("ENOENT")).toBe(false);
  });
});

// ── quorumToolSchema tests ──────────────────────────────────────────────────

describe("quorumToolSchema", () => {
  const schema = z.object(quorumToolSchema);

  it("accepts valid prompt without agents", () => {
    const result = schema.parse({ prompt: "hello" });
    expect(result.prompt).toBe("hello");
    expect(result.agents).toBeUndefined();
  });

  it("accepts valid agent names", () => {
    const result = schema.parse({ prompt: "hi", agents: ["codex", "gemini"] });
    expect(result.agents).toEqual(["codex", "gemini"]);
  });

  it("rejects invalid agent names", () => {
    expect(() =>
      schema.parse({ prompt: "hi", agents: ["claude"] })
    ).toThrow();
    expect(() =>
      schema.parse({ prompt: "hi", agents: ["invalid"] })
    ).toThrow();
  });

  it("accepts empty agents array", () => {
    const result = schema.parse({ prompt: "hi", agents: [] });
    expect(result.agents).toEqual([]);
  });

  it("rejects duplicate agent names", () => {
    expect(() =>
      schema.parse({ prompt: "hi", agents: ["codex", "codex"] })
    ).toThrow();
  });
});

// ── runQuorum tests ─────────────────────────────────────────────────────────

describe("runQuorum", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fans out to specified agents and collects results", async () => {
    const codexProc = createMockProc();
    const geminiProc = createMockProc();
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return codexProc as any;
      return geminiProc as any;
    });

    const promise = runQuorum("test prompt", process.cwd(), 120_000, ["codex", "gemini"]);

    // Wait for both spawns
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    // Both succeed
    codexProc.stdout.emit("data", Buffer.from("codex answer"));
    codexProc.emit("close", 0);

    geminiProc.stdout.emit("data", Buffer.from("gemini answer"));
    geminiProc.emit("close", 0);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.agents_queried).toBe(2);
    expect(parsed.agents_succeeded).toBe(2);
    expect(parsed.agents_failed).toBe(0);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].agent).toBe("codex");
    expect(parsed.results[0].status).toBe("success");
    expect(parsed.results[1].agent).toBe("gemini");
    expect(parsed.results[1].status).toBe("success");
    expect(parsed.rate_limited).toEqual([]);
    expect(parsed.total_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("handles partial failure without aborting", async () => {
    const codexProc = createMockProc();
    const geminiProc = createMockProc();
    // Route by command name since concurrent async makes call order non-deterministic
    mockSpawn.mockImplementation(((cmd: string) => {
      if (cmd === "codex") return codexProc as any;
      return geminiProc as any;
    }) as any);

    const promise = runQuorum("test", process.cwd(), 120_000, ["codex", "gemini"]);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    // Codex fails
    codexProc.stderr.emit("data", Buffer.from("codex broke"));
    codexProc.emit("close", 1);

    // Gemini succeeds
    geminiProc.stdout.emit("data", Buffer.from("gemini works"));
    geminiProc.emit("close", 0);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.agents_queried).toBe(2);
    expect(parsed.agents_succeeded).toBe(1);
    expect(parsed.agents_failed).toBe(1);
    expect(parsed.results).toHaveLength(2);
  });

  it("detects rate-limited agents", async () => {
    const codexProc = createMockProc();
    mockSpawn.mockReturnValue(codexProc as any);

    const promise = runQuorum("test", process.cwd(), 120_000, ["codex"]);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    // Codex returns 429 error
    codexProc.stderr.emit("data", Buffer.from("429 rate limit exceeded"));
    codexProc.emit("close", 1);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.agents_failed).toBe(1);
    expect(parsed.rate_limited).toEqual(["codex"]);
  });

  it("returns validation error for invalid prompt", async () => {
    const result = await runQuorum("test\0bad", process.cwd(), 120_000, ["codex"]);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeDefined();
    expect(parsed.agents_queried).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it("uses config-enabled agents when no agents parameter provided", async () => {
    // Create a config with only codex enabled
    const dir = await mkdtemp(join(process.cwd(), ".quorum-test-"));
    const origCwd = process.cwd();
    try {
      await writeFile(
        join(dir, "quorum.config.json"),
        JSON.stringify({ agents: { codex: true, copilot: false, cursor: false, gemini: false } })
      );

      const codexProc = createMockProc();
      mockSpawn.mockReturnValue(codexProc as any);

      // Call without agents parameter — should read config
      const promise = runQuorum("test", dir, 120_000);

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalledTimes(1);
      });

      codexProc.stdout.emit("data", Buffer.from("codex response"));
      codexProc.emit("close", 0);

      const result = await promise;
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.agents_queried).toBe(1);
      expect(parsed.results[0].agent).toBe("codex");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ── validatePrompt tests ────────────────────────────────────────────────────

describe("validatePrompt", () => {
  it("accepts a normal prompt", () => {
    expect(() => validatePrompt("hello world")).not.toThrow();
  });

  it("rejects prompt with null bytes", () => {
    expect(() => validatePrompt("test\0bad")).toThrow("must not contain null bytes");
  });

  it("rejects prompt exceeding MAX_PROMPT_LENGTH", () => {
    expect(() => validatePrompt("x".repeat(MAX_PROMPT_LENGTH + 1))).toThrow(
      `prompt exceeds maximum length of ${MAX_PROMPT_LENGTH}`
    );
  });

  it("accepts prompt at exactly MAX_PROMPT_LENGTH", () => {
    expect(() => validatePrompt("x".repeat(MAX_PROMPT_LENGTH))).not.toThrow();
  });
});

// ── stderr overflow test ────────────────────────────────────────────────────

describe("exec stderr overflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects on stderr buffer overflow", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("noisy", [], { cwd: "/tmp", timeout: 5000 });
    const bigBuf = Buffer.alloc(MAX_BUFFER + 1, "x");
    proc.stderr.emit("data", bigBuf);

    await expect(promise).rejects.toThrow("stderr exceeded");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

// ── signal termination test ─────────────────────────────────────────────────

describe("exec signal termination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports signal name when process is killed by signal", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("killed", [], { cwd: "/tmp", timeout: 5000 });
    // Process killed by signal — code is null, signal is provided
    proc.emit("close", null, "SIGTERM");

    await expect(promise).rejects.toThrow("terminated by signal SIGTERM");
  });
});

// ── Copilot fallback timeout exhaustion ─────────────────────────────────────

describe("runCopilot fallback timeout exhaustion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns error when ACP exhausts timeout budget leaving insufficient time for fallback", async () => {
    const acpProc = createMockProc();
    mockSpawn.mockReturnValue(acpProc as any);

    // Use minimum timeout — ACP cap is 10s but timeout is only 1s
    const promise = runCopilot("hello", process.cwd(), TIMEOUT_MIN);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    // ACP times out
    vi.advanceTimersByTime(TIMEOUT_MIN);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
  });
});

// ── Gemini fallback timeout exhaustion ──────────────────────────────────────

describe("runGemini fallback timeout exhaustion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns error when JSON mode exhausts timeout budget leaving insufficient time for fallback", async () => {
    const jsonProc = createMockProc();
    mockSpawn.mockReturnValue(jsonProc as any);

    // Use minimum timeout — 80% of 1000ms = 800ms for JSON mode, leaving 200ms < TIMEOUT_MIN
    const promise = runGemini("hello", process.cwd(), TIMEOUT_MIN);

    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    // JSON mode times out at 80% of budget
    vi.advanceTimersByTime(TIMEOUT_MIN);

    const result = await promise;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("error");
  });
});

