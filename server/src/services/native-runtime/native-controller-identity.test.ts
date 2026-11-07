import { afterEach, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import * as hotRestart from "../hot-restart.js";
import { getServerInfoSnapshot, resetServerInfoCacheForTests } from "../../server-info.js";
import { currentNativeControllerIdentity, isCurrentNativeControllerProcess } from "./native-restart-recovery.js";
import {
  currentControllerBootId,
  currentControllerProcess,
  resetCurrentProcessStartedAtForTests,
} from "../controller-process-identity.js";
import { legacyControllerBootId } from "../legacy-controller-lease.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => {
    throw new Error("Git metadata is unavailable; identity must still work");
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  resetServerInfoCacheForTests();
  resetCurrentProcessStartedAtForTests();
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

it("stamps one boot id for native claims, legacy leases and creation intents", async () => {
  vi.spyOn(hotRestart, "readProcessStartedAt").mockResolvedValue("2026-11-02T12:00:00.000Z");
  const native = await currentNativeControllerIdentity();
  const controller = await currentControllerProcess();

  expect(native.bootId).toBe(currentControllerBootId());
  expect(legacyControllerBootId).toBe(currentControllerBootId());
  expect(controller.bootId).toBe(currentControllerBootId());
  expect(controller.processStartedAt).toBe(native.processStartedAt.toISOString());
  expect(isCurrentNativeControllerProcess({ controllerBootId: legacyControllerBootId, controllerPid: process.pid })).toBe(true);
});

it("reads this process's start time from the OS once across claims and renewals", async () => {
  const read = vi.spyOn(hotRestart, "readProcessStartedAt").mockResolvedValue("2026-11-02T12:00:00.000Z");

  await Promise.all(Array.from({ length: 5 }, () => currentNativeControllerIdentity()));
  for (let i = 0; i < 5; i++) {
    await currentNativeControllerIdentity();
    await currentControllerProcess();
  }

  expect(read).toHaveBeenCalledTimes(1);
});

it("retries a failed start-time read instead of caching the failure", async () => {
  const read = vi.spyOn(hotRestart, "readProcessStartedAt")
    .mockRejectedValueOnce(new Error("ps unavailable"))
    .mockResolvedValue("2026-11-02T12:00:00.000Z");

  expect((await currentControllerProcess()).processStartedAt).toBeNull();
  expect((await currentControllerProcess()).processStartedAt).toBe("2026-11-02T12:00:00.000Z");
  await currentNativeControllerIdentity();

  expect(read).toHaveBeenCalledTimes(2);
});
