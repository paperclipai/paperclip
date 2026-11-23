import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issues,
  nativeRunFinalizations } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";

// QA Cloud: a fresh assignment run failed before its first provider turn with
// "Database query failed (40P01)" and was left as a task that needed
// reconciliation. The coordinator claim locks the coordinator row, then the
// run row. A writer that holds the run row and then asks for the coordinator
// closes a lock cycle; PostgreSQL aborts the claim, the waiter that checks
// first. The aborted claim rolled back whole, yet it failed the run.
describe("native coordinator claim under a run-then-coordinator lock cycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-claim-deadlock-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Claim deadlock", issuePrefix: "NCD" });
    await db.insert(agents).values({ id: agentId, companyId, name: "OpenCode agent", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode", model: "openrouter/test-model" } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it("retries a claim that lost a deadlock and reaches the provider", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Write the brief", status: "todo", workMode: "standard",
      assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const runId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, responsibleUserId: "board-user", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    // Runtime selection leaves the coordinator unclaimed: observed, attempt 0.
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "opencode", model: "openrouter/test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Write the brief.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "opencode_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));

    // Another writer holds the run row (as a run update does) before the claim
    // starts. Once the claim holds the coordinator and waits for the run row,
    // the writer asks for the coordinator: a deadlock. The writer's own
    // detector waits longer, so PostgreSQL always aborts the claim.
    let writerBlockedClaim = false;
    let releaseWriter!: () => void;
    const writerHoldsRun = new Promise<void>(resolve => { releaseWriter = resolve; });
    const writer = db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '10s'`);
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("no key update");
      const writerPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
      releaseWriter();
      for (let poll = 0; poll < 1_000 && !writerBlockedClaim; poll++) {
        const rows = (await db.execute(
          sql`select 1 from pg_stat_activity where ${writerPid} = any(pg_blocking_pids(pid))`,
        )) as unknown as Array<unknown>;
        if (rows[0]) writerBlockedClaim = true;
        else await new Promise(resolve => setTimeout(resolve, 10));
      }
      await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, runId)).for("update");
    });
    await writerHoldsRun;

    provider.execute.mockReset().mockRejectedValue(new Error("provider_reached_after_claim"));
    const outcome = await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } }).then(() => null, (error: unknown) => error);
    await writer;

    expect(writerBlockedClaim).toBe(true);
    expect((outcome as { cause?: { code?: string } } | null)?.cause?.code).not.toBe("40P01");
    expect(provider.execute).toHaveBeenCalledTimes(1);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(coordinator.attempt).toBe(1);
  }, 120_000);
});
