import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { exec } from "./helpers.js";

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

describe("exec UTF-8 robustness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles multi-byte UTF-8 characters split across chunks", async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc as any);

    const promise = exec("echo", [], { cwd: "/tmp", timeout: 5000 });

    // Rocket emoji 🚀 is F0 9F 9A 80
    const chunk1 = Buffer.from([0xf0, 0x9f]);
    const chunk2 = Buffer.from([0x9a, 0x80]);

    proc.stdout.emit("data", chunk1);
    proc.stdout.emit("data", chunk2);
    proc.emit("close", 0);

    const result = await promise;
    expect(result).toBe("🚀");
  });
});
