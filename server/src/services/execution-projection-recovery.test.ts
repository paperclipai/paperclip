import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { executionProjectionsForRuns } from "./execution-projection.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("persisted stopped-workspace projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("stopped-workspace-projection");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("reads recovered files on a cancelled run through the real batched query", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped workspace", issuePrefix: "SWP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review current changes", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "cancelled", finishedAt: new Date(),
      contextSnapshot: { issueId }, resultJson: { workspaceRestoreFailure: "restore_failed" } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-workspace:${runId}`,
      ownerType: "system", status: "resolved", outcome: "blocked", resolvedAt: new Date(),
      nextAction: "The original sandbox is retained for workspace repair.",
      evidence: { runId, continuationDelivery: "invalidated",
        automaticRecovery: { replay: "blocked", actionOutcome: "unknown", policy: "preserve_without_replay_v1" },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId, status: "recovered",
          stage: "saving_receipts", attempt: 1, attemptLimit: 6, retryable: true, requestIds: [] },
      } });
    const projections = await executionProjectionsForRuns(db, companyId, [runId]);
    expect(projections.get(runId)).toMatchObject({ phase: "recovery_needed", label: "Stopped",
      nextAction: "Saved work recovered. Send a message to continue.", permittedActions: ["inspect_run"] });
  });
});
