import { afterEach, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import * as hotRestart from "../hot-restart.js";
import { getServerInfoSnapshot, resetServerInfoCacheForTests } from "../../server-info.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => {
    throw new Error("Git metadata is unavailable; identity must still work");
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  resetServerInfoCacheForTests();
});

it.each([true, false])("keeps controller identity independent of Git commands (OS start available=%s)", async available => {
  const observed = "2026-11-02T12:00:00.000Z";
  const fallback = getServerInfoSnapshot({ gitCommand: () => { throw new Error("no checkout"); } }).processStartedAt;
  resetServerInfoCacheForTests();
  vi.spyOn(hotRestart, "readProcessStartedAt").mockImplementation(async () => {
    if (!available) throw new Error("process start unavailable");
    return observed;
  });
  const subprocess = vi.mocked(childProcess.execFileSync);
  subprocess.mockClear();

  const first = await currentNativeControllerIdentity();
  const second = await currentNativeControllerIdentity();

  expect(first).toEqual(second);
  expect(first.pid).toBe(process.pid);
  expect(first.processStartedAt.toISOString()).toBe(available ? observed : fallback);
  expect(subprocess).not.toHaveBeenCalled();
});
