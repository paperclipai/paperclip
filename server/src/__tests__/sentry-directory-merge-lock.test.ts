import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";

// `@sentry/node` is an optional peer and is not installed for this suite.
// Mock it and the exact-version gate so the opt-in capture path runs.
function mockSentryPackage() {
  const captureException = vi.fn(() => "event-id");
  vi.doMock("@sentry/node", () => ({
    init: vi.fn(),
    captureException,
    close: vi.fn(async () => true),
    httpIntegration: vi.fn((options: unknown) => ({ name: "Http", ...(options as object) })),
    onUnhandledRejectionIntegration: vi.fn((options: unknown) => ({ name: "OnUnhandledRejection", ...(options as object) })),
  }));
  vi.doMock("../peer-version-check.js", () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
  return { captureException };
}

async function importFreshSentry() {
  vi.resetModules();
  return await import("../sentry.js");
}

describe("Sentry directory-merge lock timeout context", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.doUnmock("@sentry/node");
    vi.doUnmock("../peer-version-check.js");
    vi.resetModules();
    while (cleanupDirs.length > 0) await rm(cleanupDirs.pop()!, { recursive: true, force: true });
  });

  it("adds allowlisted holder diagnostics to a real lock timeout event only", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("SENTRY_DSN_FRONTEND", "");
    vi.stubEnv("SENTRY_DSN_BACKEND", "https://fixture@example.com/1");
    const sdk = mockSentryPackage();
    const { captureException, sentryReady } = await importFreshSentry();
    await sentryReady;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sentry-lock-"));
    cleanupDirs.push(rootDir);
    vi.stubEnv("PAPERCLIP_HOME", path.join(rootDir, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-instance");
    const targetDir = path.join(rootDir, "target");
    await mkdir(targetDir);
    let timeout: unknown;
    await withDirectoryMergeLock(targetDir, async () => {
      timeout = await withDirectoryMergeLock(targetDir, vi.fn(), process.env, "agent_directory_release", 0).catch((error: unknown) => error);
    });

    captureException(timeout);
    const unrelated = new Error("unrelated");
    captureException(unrelated);

    expect(sdk.captureException.mock.calls[0]).toEqual([
      timeout,
      { tags: { error_code: "workspace_restore_lock_timeout" }, fingerprint: ["{{ default }}"], contexts: {
        directory_merge_lock: { operation: "agent_directory_release", ownerState: "alive", knownLocalHolder: true,
          ownerSameProcess: true, ownerPredatesProcess: false, ownerAgeMs: expect.any(Number), waitMs: expect.any(Number) },
      } },
    ]);
    const context = JSON.stringify((sdk.captureException.mock.calls[0] as unknown[])[1]);
    expect(context).not.toContain(rootDir);
    expect(context).not.toContain(String(process.pid));
    expect(sdk.captureException.mock.calls[1]).toEqual([unrelated]);
  });

  it("keeps run reference tags on a lock timeout event", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("SENTRY_DSN_FRONTEND", "");
    vi.stubEnv("SENTRY_DSN_BACKEND", "https://fixture@example.com/1");
    const sdk = mockSentryPackage();
    const { captureException, sentryReady } = await importFreshSentry();
    await sentryReady;
    const error = Object.assign(new Error("Timed out waiting for workspace restore lock at /private/lock"), {
      code: "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT",
      workspaceRestoreLock: { ownerState: "dead", waitMs: 30_001, pid: 4242 },
    });
    captureException(error, { runId: "11111111-1111-4111-8111-111111111111" });
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      tags: { run_id: "11111111-1111-4111-8111-111111111111", error_code: "workspace_restore_lock_timeout" },
      contexts: { directory_merge_lock: { ownerState: "dead", waitMs: 30_001 } },
      fingerprint: ["{{ default }}"],
    });
  });
});
