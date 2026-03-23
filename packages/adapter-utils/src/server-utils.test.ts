import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

describe("runChildProcess", () => {
  it("handles UTF-8 output correctly", async () => {
    const result = await runChildProcess("test-utf8", "echo", ["hello world"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 10,
      graceSec: 2,
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("handles non-UTF8 bytes in stdout without crashing", async () => {
    // printf bytes that are valid WIN1252 but not valid UTF-8 sequences
    // \xc0\xc1 are invalid UTF-8 lead bytes; under WIN1252 they are À and Á
    const result = await runChildProcess(
      "test-win1252",
      "printf",
      ["hello\\xc0\\xc1world"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    // Should not crash — the output contains replacement chars or raw bytes decoded as utf8
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("world");
  });

  it("handles non-UTF8 bytes in stderr without crashing", async () => {
    const result = await runChildProcess(
      "test-win1252-stderr",
      "sh",
      ["-c", "printf 'error\\xc0\\xc1msg' >&2"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("error");
    expect(result.stderr).toContain("msg");
  });

  it("passes onLog chunks as strings for non-UTF8 data", async () => {
    const chunks: string[] = [];
    const result = await runChildProcess(
      "test-onlog-encoding",
      "printf",
      ["data\\xff\\xfedone"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 10,
        graceSec: 2,
        onLog: async (_stream, chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe("string");
    for (const chunk of chunks) {
      expect(typeof chunk).toBe("string");
    }
  });
});
