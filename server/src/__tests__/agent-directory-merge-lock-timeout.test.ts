import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("agent directory merge-lock wait timeout", () => {
  let home: string | null = null;
  let target: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (target) await rm(target, { recursive: true, force: true });
    if (home) await rm(home, { recursive: true, force: true });
    target = null;
    home = null;
  });

  async function fixture() {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-directory-lock-home-")));
    target = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-directory-lock-target-")));
    const { withDirectoryMergeLock, WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } = await import("@paperclipai/adapter-utils/workspace-restore-merge");
    const service = await import("../services/agent-directory-working-copies.js");
    const busy = await import("../services/heartbeat/agent-directory-busy.js");
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "agent-directory-lock-test");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "false");
    const localRoot = path.join(target, "a", "b", "c");
    await mkdir(localRoot, { recursive: true });
    const row = { companyId: "company-1", runId: "run-1", agentId: "agent-1", location: "local", localRoot, receipt: {} };
    return { withDirectoryMergeLock, WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE, service, busy, row };
  }

  it("reports acquisition timeouts as AgentDirectoryOperationBusyError so the run defers instead of failing", async () => {
    const { withDirectoryMergeLock, service, busy, row } = await fixture();
    let release!: () => void;
    let heldResolve!: () => void;
    const held = new Promise<void>(resolve => { heldResolve = resolve; });
    const releaseHolder = new Promise<void>(resolve => { release = resolve; });
    const holder = withDirectoryMergeLock(target!, async () => { heldResolve(); await releaseHolder; },
      { PAPERCLIP_HOME: home!, PAPERCLIP_INSTANCE_ID: "agent-directory-lock-test" });
    try {
      await Promise.race([
        held,
        holder.then(
          () => { throw new Error("merge-lock holder finished before its callback started"); },
          error => { throw error; },
        ),
      ]);
      const copies = service.agentDirectoryWorkingCopyService({} as never, async () => null, async r => r);
      const failure = copies.collectStopped(row as never);
      await expect(failure).rejects.toBeInstanceOf(service.AgentDirectoryOperationBusyError);
      await expect(busy.prepareWithAgentDirectoryDeferral(() => Promise.reject(new service.AgentDirectoryOperationBusyError())))
        .rejects.toBeInstanceOf(busy.AgentDirectoryPreparationDeferral);
    } finally {
      release();
      await holder;
    }
  }, 90_000);

  it("keeps a lock-timeout error raised by the work inside the lock", async () => {
    const { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE, service, row } = await fixture();
    const inner: NodeJS.ErrnoException = new Error(`Timed out waiting for workspace restore lock at ${target}`);
    inner.code = WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE;
    const copies = service.agentDirectoryWorkingCopyService({} as never, async () => { throw inner; }, async r => r);
    await expect(copies.collectStopped(row as never)).rejects.toBe(inner);
  }, 60_000);
});
