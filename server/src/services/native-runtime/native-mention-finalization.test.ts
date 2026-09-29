import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, completionContracts, createDb, heartbeatRuns, issues, issueThreadInteractions, statusDecisionEffects } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";

describe("native mention finalization", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-mention-finalization-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it.each(["done", "in_progress", "in_review"])("finishes the response without changing a %s source task or releasing the owner's run", async (status) => {
    const companyId = randomUUID(), agentId = randomUUID(), ownerId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), ownerRunId = randomUUID();
    const contractId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID(), wakeupRequestId = randomUUID();
    const contractSha256 = `contract-${contractId}`;
    await db.insert(companies).values({ id: companyId, name: "Mention finalization", issuePrefix: `M${companyId.slice(0, 5)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Responder", adapterType: "paperclip_runner", status: "running" },
      { id: ownerId, companyId, name: "Owner", adapterType: "paperclip_runner", status: "running" },
    ]);
    await db.insert(heartbeatRuns).values({ id: ownerRunId, companyId, agentId: ownerId, status: "running" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Source work", status, assigneeAgentId: ownerId,
      executionRunId: status === "done" ? null : ownerRunId, checkoutRunId: status === "done" ? null : ownerRunId, statusVersion: 7, workMode: "standard" });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "mention-test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "mention-test", objective: "Respond to mention", criteria: [{ id: "objective", requirement: "Respond" }] },
      canonicalSha256: contractSha256, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "automation", reason: "issue_comment_mentioned", status: "claimed", runId, payload: { issueId } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: sessionId, runnerInstanceId, completionContractId: contractId,
      completionContractSha256: contractSha256, wakeupRequestId,
      runnerProfileJson: { nativeMentionContext: { version: 1, issueId, agentId, wakeupRequestId } } });
    const [review] = await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "request_confirmation",
      status: "pending", title: "Owner review", summary: "Review the owner's work", continuationPolicy: "none",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", payload: { version: 1, prompt: "Review owner work", acceptLabel: "Accept", rejectLabel: "Reject" } }).returning();
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId,
      completionContractId: contractId, completionContractSha256: contractSha256, sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "mention-test" });
    await port.openRun({ identity: { companyId, issueId, runId, agentId, sessionId }, backendKind: "mock", sourceInstanceId: runnerInstanceId });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: `${runId}:result` });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    await reconcileNativeFinalizations(db, [runId]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({ status: "succeeded", nativePhase: "committed", resultJson: { finalizationReasonCode: "mention_context_finished" } });
    expect(await db.select().from(issues).where(eq(issues.id, issueId))).toEqual([before]);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, review.id))).toEqual([review]);
    expect(await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, issueId))).toEqual([]);
  });
});
