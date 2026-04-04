import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: string) => void };
      stderr: EventEmitter & { setEncoding: (encoding: string) => void };
      stdin: { write: (chunk: string) => boolean };
      kill: (signal?: string) => boolean;
    };
    proc.stdout = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    proc.stderr = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    proc.stdin = {
      write: vi.fn(() => true),
    };
    proc.kill = vi.fn(() => true);

    queueMicrotask(() => {
      proc.emit("error", new Error("spawn codex ENOENT"));
    });

    return proc;
  }),
}));

describe("codex quota spawn failure", () => {
  it("returns an error result instead of crashing when the codex binary is missing", async () => {
    const savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(
      os.tmpdir(),
      `paperclip-missing-codex-auth-${Date.now()}`
    );
    const { getQuotaWindows } = await import("@paperclipai/adapter-codex-local/server");

    try {
      await expect(getQuotaWindows()).resolves.toEqual({
        provider: "openai",
        ok: false,
        error: expect.stringContaining("spawn codex ENOENT"),
        windows: [],
      });
    } finally {
      if (savedCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = savedCodexHome;
      }
    }
  });
});
