import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { temporary = await startRecoveryPostgres("failed-action-chat-feedback-"); db = createDb(temporary.connectionString); });
afterAll(async () => { await temporary?.cleanup(); });
it("compares truthful failed-action chat reports with ordinary-task and false-success controls", async () => {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Feedback control", issuePrefix: `C${companyId.slice(0, 7)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "CEO", adapterType: "paperclip_runner", status: "active" });
  async function fixture(conversation: boolean) {
    const issueId = randomUUID(), runId = randomUUID(), contractId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: conversation ? "Chat with CEO" : "Update launch page", status: "in_progress", assigneeAgentId: agentId,
      ...(conversation ? { conversationAgentId: agentId, conversationUserId: "control-user", conversationState: "active" } : {}) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native", completionContractId: contractId,
      contextSnapshot: { issueId, conversationMode: conversation, source: "tool_action_review", toolAction: { invocationId: randomUUID(), actionRequestId: randomUUID(), executionStatus: "failed", decision: "accepted", error: "Synthetic write failed; page unchanged", instructions: "The approved action did not complete successfully. Do not automatically replay it; inspect the recorded outcome first." } } });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 4, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", canonicalSha256: randomUUID(), createdByActorType: "system", createdByActorId: "control", contractJson: { revision: "4", criteria: [{ id: "objective", requirement: conversation ? "Address this request in the current authorized conversation response: Respond to the current conversation context." : "Update launch page successfully." }] } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return runId;
  }
  const report: PrpStructuredRunResult = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "The approved write failed: Synthetic write failed; page unchanged. The page still reads Controlled launch page. No retry executed. A retry requires a new user request.", completionClaim: { contractRevision: "4", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [{ description: "The external page update remains incomplete; retry only on user request.", blocksCompletion: false }] }, evidence: [], verification: [{ commandOrCheck: "Approved external write", status: "failed", detail: "Synthetic write failed; page unchanged" }], attentionRequests: [], artifacts: [] };
  const chat = await fixture(true), ordinary = await fixture(false);
  await expect(nativeCompletionFeedback(db, chat, report)).rejects.toThrow(/Rejection fields: verification\.failed\.[\s\S]*Do not automatically replay the action or request approval again/);
  for (const patch of [{ source: "issue.comment" }, { toolAction: { executionStatus: "succeeded", invocationId: randomUUID(), actionRequestId: randomUUID() } }, { toolAction: { executionStatus: "failed" } }]) {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat));
    const original = row!.contextSnapshot;
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...original, ...patch } }).where(eq(heartbeatRuns.id, chat));
    await expect(nativeCompletionFeedback(db, chat, report)).rejects.toThrow(/^The done report includes unfinished work, failed verification, or an outstanding decision\. Finish the work or report the concrete blocker\/reviewer request\. No human completion approval was created\.$/);
    await db.update(heartbeatRuns).set({ contextSnapshot: original }).where(eq(heartbeatRuns.id, chat));
  }
  await expect(nativeCompletionFeedback(db, ordinary, report)).rejects.toThrow(/^The done report includes unfinished work, failed verification, or an outstanding decision\. Finish the work or report the concrete blocker\/reviewer request\. No human completion approval was created\.$/);
  await expect(nativeCompletionFeedback(db, chat, { ...report, summary: "The page update succeeded." })).rejects.toThrow("failed verification");
  await expect(nativeCompletionFeedback(db, chat, { ...report, verification: [], completionClaim: { ...report.completionClaim, remainingWork: [{ description: "Retry silently before completion", blocksCompletion: true }] } })).rejects.toThrow("Rejection fields: completionClaim.remainingWork.blocksCompletion.");
  await expect(nativeCompletionFeedback(db, ordinary, { ...report, verification: [], completionClaim: { ...report.completionClaim, objectiveSatisfied: false, criteria: [{ criterionId: "objective", status: "not_satisfied", evidenceRefs: [] }] } })).rejects.toThrow("unfinished work");
  await expect(nativeCompletionFeedback(db, chat, { ...report, verification: [{ commandOrCheck: "External write completion", status: "not_run", reasonCode: "external_service_unavailable", detail: "Attempted approved write returned Synthetic write failed; page unchanged." }] })).resolves.toContain("accepted");
  await expect(nativeCompletionFeedback(db, chat, { ...report, verification: [{ commandOrCheck: "Read page after failed attempt", status: "passed", detail: "Verified Controlled launch page is unchanged; external write failed and no retry executed." }] })).resolves.toContain("accepted");
});
