import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { exec, runGemini } from "./helpers.js";

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

describe("repro identified issues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends SIGKILL after grace period when SIGTERM is ignored (correct behavior)", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("slow", [], { cwd: "/tmp", timeout: 1000 });
    vi.advanceTimersByTime(1000);

    await expect(promise).rejects.toThrow("slow timed out after 1000ms");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    // SIGKILL fires after SIGKILL_GRACE_MS if process hasn't exited
    vi.advanceTimersByTime(500);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("runGemini: prompt is passed as -p value (not positional)", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    // Prompt like "-h" is safe because it's the value of -p, not a standalone flag
    const promise = runGemini("-h", process.cwd(), 1000);

    // Wait for spawn to be called
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalled();
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "gemini",
      ["--yolo", "--output-format", "json", "-p", "-h"],
      expect.anything()
    );
  });

  it("environment variables are filtered to an allowlist", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    exec("cmd", [], { cwd: "/tmp", timeout: 1000 });

    const spawnOptions = mockSpawn.mock.calls[0][2];
    // env should be an object (not undefined), containing only allowlisted keys
    expect(spawnOptions.env).toBeDefined();
    expect(typeof spawnOptions.env).toBe("object");
    // PATH should be present (it's in the allowlist)
    if (process.env.PATH) {
      expect(spawnOptions.env.PATH).toBe(process.env.PATH);
    }
    // A random env var should NOT be present
    process.env.__QUORUM_TEST_SECRET__ = "leaked";
    exec("cmd2", [], { cwd: "/tmp", timeout: 1000 });
    const opts2 = mockSpawn.mock.calls[1][2];
    expect(opts2.env.__QUORUM_TEST_SECRET__).toBeUndefined();
    delete process.env.__QUORUM_TEST_SECRET__;
  });
});
