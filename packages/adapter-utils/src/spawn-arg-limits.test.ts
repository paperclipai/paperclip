import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

// Linux MAX_ARG_STRLEN is 32 * PAGE_SIZE: 131072 bytes on 4 KiB hosts. One
// argv or environment string at that size (or above) makes spawn fail with
// E2BIG before the child starts. Adapters that pass a full prompt as an
// argument cross this limit as soon as the wake payload grows, which is the
// failure this file documents.
const MAX_ARG_STRLEN_BYTES = 32 * 4096;

// Above every Linux per-string and total limit (MAX_ARG_STRLEN 128 KiB on
// 4 KiB hosts, ARG_MAX 2 MiB), so this entry fails with E2BIG on any Linux
// host regardless of page size.
const ALWAYS_OVER_LIMIT_BYTES = 3 * 1024 * 1024;

const baseOptions = {
  cwd: process.cwd(),
  env: {} as Record<string, string>,
  timeoutSec: 15,
  graceSec: 5,
  onLog: async () => {},
};

async function spawnWithSingleArg(bytes: number): Promise<{ started: boolean; error?: Error }> {
  try {
    const result = await runChildProcess(`probe-${bytes}`, "/bin/true", ["x".repeat(bytes)], baseOptions);
    return { started: (result.exitCode ?? 1) === 0 };
  } catch (error) {
    return { started: false, error: error as Error };
  }
}

// Probe the host instead of assuming 4 KiB pages: on a host with larger
// pages the 131072-byte boundary is not the real limit and the boundary test
// would assert something the platform does not do.
const maxArgStrlenProbe = await spawnWithSingleArg(MAX_ARG_STRLEN_BYTES);
const reproducesMaxArgStrlen =
  !maxArgStrlenProbe.started &&
  maxArgStrlenProbe.error?.message.includes("E2BIG") === true;

describe("spawn argv limits", () => {
  it.runIf(reproducesMaxArgStrlen)(
    "rejects one argv entry at MAX_ARG_STRLEN with E2BIG",
    async () => {
      const outcome = await spawnWithSingleArg(MAX_ARG_STRLEN_BYTES);
      expect(outcome.started).toBe(false);
      expect(outcome.error?.message).toContain("E2BIG");
    },
  );

  it("starts a process when one argv entry stays below MAX_ARG_STRLEN", async () => {
    if (!reproducesMaxArgStrlen) return;
    const outcome = await spawnWithSingleArg(MAX_ARG_STRLEN_BYTES - 1);
    expect(outcome.started).toBe(true);
  });

  it("reports argv and env sizes when spawn fails with E2BIG", async () => {
    const oversized = "y".repeat(ALWAYS_OVER_LIMIT_BYTES);
    await expect(
      runChildProcess("e2big-sizes", "/bin/true", ["--cwd", "/tmp", oversized], baseOptions),
    ).rejects.toThrow(
      new RegExp(
        `argv: 4 entries, \\d+ bytes total, largest entry #3 with ${ALWAYS_OVER_LIMIT_BYTES + 1} bytes\\.` +
          ` env: \\d+ entries, \\d+ bytes total, largest "\\w+" with \\d+ bytes\\.`,
      ),
    );
  });

  it("keeps the E2BIG failure message actionable", async () => {
    const oversized = "z".repeat(ALWAYS_OVER_LIMIT_BYTES);
    await expect(
      runChildProcess("e2big-hint", "/bin/true", [oversized], baseOptions),
    ).rejects.toThrow(/spawn E2BIG \(argument list too long\)/);
    await expect(
      runChildProcess("e2big-hint-2", "/bin/true", [oversized], baseOptions),
    ).rejects.toThrow(/Move the oversized payload to a file or to stdin instead of argv or env\./);
  });
});