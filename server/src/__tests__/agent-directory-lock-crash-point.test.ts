import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("directory-lock crash point", () => {
  let root: string | undefined;
  let control: string;
  let workingCopies: typeof import("../services/agent-directory-working-copies.js");
  let deferral: typeof import("../services/heartbeat/agent-directory-busy.js");

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "directory-lock-crash-point-"));
    control = path.join(root, "crash-point.control");
    vi.stubEnv("PAPERCLIP_CRASH_POINT_CONTROL", control);
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    vi.resetModules();
    workingCopies = await import("../services/agent-directory-working-copies.js");
    deferral = await import("../services/heartbeat/agent-directory-busy.js");
  });

  beforeEach(async () => {
    await writeFile(control, `${randomUUID()} agent_directory.operation_lock.before_acquire:1 fail\n`);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("fails with the lock's own busy error, so preparation defers it like real contention", async () => {
    const { agentDirectoryWorkingCopyService, AgentDirectoryOperationBusyError } = workingCopies;
    const { prepareWithAgentDirectoryDeferral, AgentDirectoryPreparationDeferral } = deferral;
    const service = agentDirectoryWorkingCopyService({} as never, async () => null, async row => row);
    const row = { companyId: "company-1", runId: "run-1", agentId: "agent-1", location: "remote:sandbox-1", receipt: {} };
    const failure = service.collectStopped(row as never);
    await expect(failure).rejects.toBeInstanceOf(AgentDirectoryOperationBusyError);
    await expect(prepareWithAgentDirectoryDeferral(() => failure)).rejects.toBeInstanceOf(AgentDirectoryPreparationDeferral);
  });
});
