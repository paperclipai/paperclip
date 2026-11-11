import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { directoryMergeLockTimeoutDiagnosticsFor } from "./directory-merge-lock-diagnostics.js";
import { withDirectoryMergeLock, WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "./workspace-restore-merge.js";

describe("directoryMergeLockTimeoutDiagnosticsFor", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) await rm(cleanupDirs.pop()!, { recursive: true, force: true });
  });

  it("reduces a real lock timeout to allowlisted holder diagnostics without its path or process id", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-report-"));
    cleanupDirs.push(rootDir);
    vi.stubEnv("PAPERCLIP_HOME", path.join(rootDir, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-instance");
    const targetDir = path.join(rootDir, "target");
    await mkdir(targetDir);
    const contender = vi.fn();
    let caught: unknown;
    await withDirectoryMergeLock(targetDir, async () => {
      caught = await withDirectoryMergeLock(targetDir, contender, process.env, "agent_directory_collect", 0).catch((error: unknown) => error);
    });
    expect(contender).not.toHaveBeenCalled();
    const diagnostics = directoryMergeLockTimeoutDiagnosticsFor(caught);
    expect(diagnostics).toEqual({
      operation: "agent_directory_collect", ownerState: "alive", knownLocalHolder: true,
      ownerSameProcess: true, ownerPredatesProcess: false, ownerAgeMs: expect.any(Number), waitMs: expect.any(Number),
    });
    expect(JSON.stringify(diagnostics)).not.toContain(rootDir);
    expect(JSON.stringify(diagnostics)).not.toContain(String(process.pid));
  });

  it("omits invalid values and ignores other errors", () => {
    expect(directoryMergeLockTimeoutDiagnosticsFor(Object.assign(new Error("Timed out waiting for workspace restore lock at /private"), {
      code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
      workspaceRestoreLock: { operation: "/private/path", ownerState: "reclaimed", ownerSameProcess: "yes", ownerAgeMs: -1, waitMs: 1.5, pid: 4242 },
    }))).toEqual({});
    expect(directoryMergeLockTimeoutDiagnosticsFor(new Error("Timed out waiting for workspace restore lock at /private"))).toBeNull();
    expect(directoryMergeLockTimeoutDiagnosticsFor(null)).toBeNull();
  });
});
