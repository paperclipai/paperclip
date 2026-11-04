import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueRecoveryActions,
  issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
import * as platformProof from "./native-workspace-platform-proof.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("retained workspace recovery ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-workspace-finalization-ownership-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  // The failed writer's recovery saves its files while the task's next run waits
  // for that save. The waiting run must not make the recovery report a changed binding.
  it.each([
    { successor: "waiting_for_writer", expected: true },
    { successor: "due_while_waiting_for_writer", expected: true },
    { successor: "waiting_for_other_holder", expected: false },
    { successor: "unrelated_queued_run", expected: false },
    { successor: "none", expected: true },
  ] as const)("claims a verified stopped owner when the task successor is $successor", async ({ successor, expected }) => {
    const [company] = await db.insert(companies).values({ name: "Ownership", issuePrefix: `O${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue saved work",
      status: "in_progress", assigneeAgentId: agent.id }).returning();
    const worker = { provider: "railway" as const, projectId: "p", environmentId: "e", serviceId: "s", deploymentId: "old" };
    const owner = { token: randomUUID(), hostname: "another-controller", pid: 1234,
      processStartedAt: new Date().toISOString(), worker };
    const [writer] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      runtimeMode: "legacy", status: "failed", finishedAt: new Date(),
      runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } }).returning();
    const [repair] = await db.insert(issueRecoveryActions).values({ companyId: company.id, sourceIssueId: issue.id,
      kind: "active_run_watchdog", cause: "run_failed", fingerprint: writer.id, nextAction: "Save the files.",
      evidence: { runId: writer.id, workspaceRecovery: { runId: writer.id } } }).returning();
    if (successor !== "none") {
      const [deferred] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
        status: "cancelled", errorCode: "workspace_busy", finishedAt: new Date(),
        resultJson: { workspaceBusy: { holderRunId: successor === "waiting_for_other_holder" ? randomUUID() : writer.id } },
      }).returning();
      const [next] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
        status: successor === "waiting_for_writer" || successor === "waiting_for_other_holder" ? "scheduled_retry" : "queued",
        retryOfRunId: deferred.id, scheduledRetryAttempt: 1,
        scheduledRetryReason: successor === "unrelated_queued_run" ? null : "workspace_busy" }).returning();
      await db.update(issues).set({ executionRunId: next.id }).where(eq(issues.id, issue.id));
    }
    vi.spyOn(platformProof, "requestWorkspaceWorkerStopProof").mockResolvedValue({ status: "verified", proof: {
      v: 1, iss: "paperclip-cloud", aud: "paperclip-workspace-worker-stop/v1", sub: "stack", runId: writer.id,
      ownerToken: owner.token, worker, stopped: true, iat: 1, exp: 61 } });

    const result = await withNativeWorkspaceFinalizationOwnership({ db, companyId: company.id, runId: writer.id,
      retainedRepairActionId: repair.id }, async () => "saved");

    expect(result).toEqual(expected ? { acquired: true, value: "saved" } : { acquired: false, reason: "binding_changed" });
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writer.id));
    if (!expected) expect(current.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toEqual(owner);
  });
});
