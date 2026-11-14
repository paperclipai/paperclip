import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeHarnessBackupStamp, verifyNativeHarnessBackupStampAsync } from "./native-harness-backup-stamp.js";

const hooks = vi.hoisted(() => ({ afterOpen: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    hooks.afterOpen?.();
    return handle;
  };
  return { ...actual, default: { ...actual, open }, open };
});

describe("verifyNativeHarnessBackupStampAsync cancellation", () => {
  let base: string;
  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "native-harness-stamp-abort-")));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
  });
  afterEach(async () => {
    hooks.afterOpen = undefined;
    vi.unstubAllEnvs();
    await fs.rm(base, { recursive: true, force: true });
  });

  it("rejects with the signal reason and raises no uncaught AbortError when it aborts before a file read", async () => {
    const sessionScopeId = "session-scope", completedAt = "2026-11-06T00:00:00.000Z";
    const current = path.join(base, createHash("sha256").update(sessionScopeId).digest("hex"), "failover-backups", "current");
    await fs.mkdir(path.join(current, "home"), { recursive: true });
    await fs.writeFile(path.join(current, "home", "history.json"), "{}\n");
    await fs.writeFile(path.join(current, "manifest.json"), JSON.stringify({
      schema: "paperclip.native-harness-backup.v1", normalizedSessionId: "session", runnerInstanceId: "runner",
      sourceProviderLeaseId: "lease", completedAt, directories: [{ name: "home", sha256: `sha256:${"0".repeat(64)}`, bytes: 3 }],
    }));
    const stamp = createNativeHarnessBackupStamp({ manifestPath: path.join(current, "manifest.json"), sessionScopeId,
      authorizedProviderLeaseId: "lease", normalizedSessionId: "session", runnerInstanceId: "runner", completedAt });
    const controller = new AbortController(), reason = new Error("verification cancelled");
    hooks.afterOpen = () => controller.abort(reason);
    const uncaught: unknown[] = [];
    const record = (error: unknown) => { uncaught.push(error); };
    process.on("uncaughtException", record);
    try {
      await expect(verifyNativeHarnessBackupStampAsync(stamp, "lease", controller.signal)).rejects.toBe(reason);
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally { process.off("uncaughtException", record); }
    expect(uncaught).toEqual([]);
  });
});
