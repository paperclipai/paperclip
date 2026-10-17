import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  issueWorkProducts,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";

// Regression test for the cancel_continuations attribution gap: the effect
// terminalised the heartbeat run with no errorCode, no resultJson marker and
// no activity_log row, so recovery could not tell the cancellation apart
// from agent stranding.
describeEmbeddedPostgres("cancel_continuations run attribution", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-cancel-attribution-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Cancel attribution", issuePrefix: "CAT" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cancel attribution agent",
      adapterType: "codex_local",
      status: "running",
    });
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  async function seedIssueScopeCancellation() {
    const issueId = randomUUID();
    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    const workProductId = randomUUID();
    const label = `cancel-attribution-${runId}`;

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: label,
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      nativeIssueId: issueId,
      contextSnapshot: { issueId },
      completionContractId: contractId,
      completionContractSha256: `contract:${label}`,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "corpus-v1", criteria: [{ id: "objective", requirement: label }] },
      canonicalSha256: `contract:${label}`,
      createdByActorType: "system",
      createdByActorId: "cancel-attribution-test",
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fingerprint:${label}`,
      schemaStatus: "accepted",
      resultJson: {
        result: {
          reportedWorkDisposition: "completed",
          summary: label,
          attentionRequests: [],
          completionClaim: {
            contractRevision: "corpus-v1",
            objectiveSatisfied: true,
            criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [`work_product:${workProductId}`] }],
            remainingWork: [],
          },
          verification: [{ commandOrCheck: "fixture", status: "passed", artifactRef: `work_product:${workProductId}` }],
        },
        terminal: { runTerminalState: "succeeded" },
      },
      canonicalSha256: `result:${label}`,
    });
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: `${label} evidence`,
      status: "ready_for_review",
      reviewState: "approved",
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress",
      priorStatusVersion: 0,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessmentJson: {},
      inputDigest: `assessment:${label}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "assessing",
      resultId,
      assessmentId,
    });
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_status_changed",
      status: "queued",
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "cancel-attribution-test",
      idempotencyKey: `cancel-attribution:${runId}`,
    }).returning({ id: agentWakeupRequests.id });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: label },
    }).returning({ id: issueThreadInteractions.id });
    return { issueId, runId, assessmentId, wakeId: wake!.id, interactionId: interaction!.id };
  }

  it("stamps errorCode, resultJson attribution and an activity row on the cancelled run", async () => {
    const seeded = await seedIssueScopeCancellation();

    await commitNativeStatusDecision({
      db,
      companyId,
      issueId: seeded.issueId,
      runId: seeded.runId,
      assessmentId: seeded.assessmentId,
      priorStatus: "in_progress",
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision: {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "cancelled",
        toStatus: "cancelled",
        reasonCode: "cancellation_issue_authorized",
        unblockDescriptor: null,
        effects: [{ kind: "release_checkout" }, { kind: "cancel_continuations" }],
      },
    });

    const [run] = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, seeded.runId), eq(heartbeatRuns.companyId, companyId)));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("native_cancelled_continuations");
    expect(run?.error).toContain("cancel_continuations");
    expect(run?.resultJson).toMatchObject({
      stopReason: "cancelled",
      cancelledByActorType: "system",
      cancelledByActorId: "native-status-committer",
      cancelledWakeRequestIds: [seeded.wakeId],
      cancelledInteractionIds: [seeded.interactionId],
    });

    const activity = await db.select().from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.runId, seeded.runId),
        eq(activityLog.action, "heartbeat.cancelled"),
      ));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actorType: "system",
      actorId: "native-status-committer",
      entityType: "heartbeat_run",
      entityId: seeded.runId,
    });
  }, 30_000);
});
