import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asBoolean, runChildProcess } from "./server-utils.js";

describe("asBoolean", () => {
  it("returns boolean true when value is true", () => {
    expect(asBoolean(true, false)).toBe(true);
  });

  it("returns boolean false when value is false", () => {
    expect(asBoolean(false, true)).toBe(false);
  });

  it("coerces string 'true' to true", () => {
    expect(asBoolean("true", false)).toBe(true);
  });

  it("coerces string 'false' to false", () => {
    expect(asBoolean("false", true)).toBe(false);
  });

  it("coerces case-insensitive string booleans", () => {
    expect(asBoolean("True", false)).toBe(true);
    expect(asBoolean("FALSE", true)).toBe(false);
    expect(asBoolean("TRUE", false)).toBe(true);
  });

  it("returns fallback for undefined", () => {
    expect(asBoolean(undefined, true)).toBe(true);
    expect(asBoolean(undefined, false)).toBe(false);
  });

  it("returns fallback for null", () => {
    expect(asBoolean(null, true)).toBe(true);
  });

  it("returns fallback for non-boolean strings", () => {
    expect(asBoolean("yes", false)).toBe(false);
    expect(asBoolean("1", false)).toBe(false);
  });

  it("returns fallback for numbers", () => {
    expect(asBoolean(0, true)).toBe(true);
    expect(asBoolean(1, false)).toBe(false);
  });
});

describe("runChildProcess", () => {
  it("waits for onSpawn before sending stdin to the child", async () => {
    const spawnDelayMs = 150;
    const startedAt = Date.now();
    let onSpawnCompletedAt = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data));",
      ],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
          onSpawnCompletedAt = Date.now();
        },
      },
    );
    const finishedAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
    expect(onSpawnCompletedAt).toBeGreaterThanOrEqual(startedAt + spawnDelayMs);
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(spawnDelayMs);
  });
});
