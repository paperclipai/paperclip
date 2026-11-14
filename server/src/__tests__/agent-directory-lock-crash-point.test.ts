import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("directory-lock crash point", () => {
  let root: string;
  let control: string;
  let agentDirectoryWorkingCopyService: typeof import("../services/agent-directory-working-copies.js").agentDirectoryWorkingCopyService;
  let AgentDirectoryOperationBusyError: typeof import("../services/agent-directory-working-copies.js").AgentDirectoryOperationBusyError;
  let prepareWithAgentDirectoryDeferral: typeof import("../services/heartbeat/agent-directory-busy.js").prepareWithAgentDirectoryDeferral;
  let AgentDirectoryPreparationDeferral: typeof import("../services/heartbeat/agent-directory-busy.js").AgentDirectoryPreparationDeferral;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "directory-lock-crash-point-"));
    control = path.join(root, "crash-point.control");
    vi.stubEnv("PAPERCLIP_CRASH_POINT_CONTROL", control);
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    vi.resetModules();
    ({ agentDirectoryWorkingCopyService, AgentDirectoryOperationBusyError } = await import("../services/agent-directory-working-copies.js"));
    ({ prepareWithAgentDirectoryDeferral, AgentDirectoryPreparationDeferral } = await import("../services/heartbeat/agent-directory-busy.js"));
  }, 120_000);

  beforeEach(async () => {
    await writeFile(control, "t1 agent_directory.operation_lock.before_acquire:1 fail\n");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  it("fails with the lock's own busy error, so preparation defers it like real contention", async () => {
    const service = agentDirectoryWorkingCopyService({} as never, async () => null, async row => row);
    const row = { companyId: "company-1", runId: "run-1", agentId: "agent-1", location: "remote:sandbox-1", receipt: {} };
    const failure = service.collectStopped(row as never);
    await expect(failure).rejects.toBeInstanceOf(AgentDirectoryOperationBusyError);
    await expect(prepareWithAgentDirectoryDeferral(() => failure)).rejects.toBeInstanceOf(AgentDirectoryPreparationDeferral);
  });
});
