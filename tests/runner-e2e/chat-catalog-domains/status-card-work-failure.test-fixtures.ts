import { createHash } from "node:crypto";
import { cardChecklistSourceData } from "./status-card-work-failure.js";
import { notesReadResponse } from "./external-provider.js";
import type { CardWorkEvidence } from "./status-card-work-failure.js";
import type { StatusCard, StatusCardUpdate } from "../../../packages/shared/src/validators/status-card.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function cardWorkFixture() {
  const t = (seconds: number) => new Date(Date.parse("2026-10-28T12:00:00Z") + seconds * 1000).toISOString();
  const recipe = { companyId: "company", workerId: "morgan", connectionId: "connection", readEntryId: "read-action", instructionRevisionId: "revision", instructionSha256: sha("saved static recipe"), interestPrompt: "Launch blockers and current synthetic checklist verification" };
  const run = { id: "failed-native", companyId: "company", agentId: "morgan", status: "succeeded", runtimeMode: "native", startedAt: t(20), finishedAt: t(30), contextSnapshot: { issueId: "failure-task" }, costAccountingPending: false, costAccountedAt: t(31),
    usageJson: { accountingReceiptReady: true, accountingCaptureFailed: false, accountingProviderWorkStarted: true, accountingReceiptId: "receipt", accountingReceiptSourceId: "source", accountingReceiptSequence: 1, accountingReceiptReceivedAt: t(30), usageSource: "per_run", provider: "openrouter", biller: "openrouter", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", billingType: "metered_api", inputTokens: 10, outputTokens: 3, accountingCostCoverage: "unpriced" } };
  const invocation = { id: "invocation", companyId: "company", agentId: "morgan", issueId: "failure-task", runId: run.id, connectionId: "connection", catalogEntryId: "read-action", policyDecision: "allow", status: "failed", errorCode: "tool_error", startedAt: t(21), completedAt: t(24), argumentsHash: sha("arguments"), resultHash: null };
  const audit = { invocationId: "invocation", companyId: "company", agentId: "morgan", issueId: "failure-task", runId: run.id, connectionId: "connection", catalogEntryId: "read-action", outcome: "failure", decision: "deny", reasonCode: "tool_error", metadata: { execution: { transport: "mcp_remote", request: { dispatched: true, upstreamToolName: "launch_read", mcpMethod: "tools/call", requestId: "request" }, response: { httpStatus: 200 } } } };
  const workerRun = (id: string, issueId: string, offset: number) => ({ ...structuredClone(run), id, startedAt: t(offset), finishedAt: t(offset + 5), contextSnapshot: { issueId } });
  const runs = [workerRun("worker-run", "generation-task", 0), workerRun("source-run", "chat", 6), workerRun("new-worker-run", "refresh-task", 10), workerRun("ceo-two", "chat", 16), workerRun("ceo-three", "chat", 18), run, workerRun("ceo-four", "chat", 32)];
  for (const row of runs) if (row.contextSnapshot.issueId === "chat") row.agentId = "ceo";
  const checklistSource = { id: "source", companyId: "company", title: "Payment approval blocks launch", status: "blocked" };
  const evidence = { recipe, checklistSource, instruction: { path: "AGENTS.md", content: "saved static recipe", revision: { id: "revision", companyId: "company", agentId: "morgan", source: "board" } }, runs,
    overview: { companyId: "company", policies: [{ scopeType: "company", scopeId: "company" }, { scopeType: "agent", scopeId: "morgan" }, { scopeType: "agent", scopeId: "ceo" }].map(p => ({ ...p, companyId: "company", isActive: true, hardStopEnabled: true, amount: 500, unpricedUsagePolicy: "allow", pendingRunCount: 0, paused: false, status: "ok", remainingAmount: 400 })) },
    generation: { id: "failure-task", companyId: "company", assigneeAgentId: "morgan", status: "blocked", description: '```json\n'+JSON.stringify({ companyId: "company", statusCardId: "card", generationIssueId: "failure-task" })+'\n```' },
    decisions: { runId: run.id, decisions: [{ invocation, auditEvents: [audit] }] },
    calls: [{ method: "tools/call", name: "launch_read", authorized: true, sequence: 4, requestIdSha256: sha("request"), responseHttpStatus: 200, toolError: true, responseSha256: sha(JSON.stringify(notesReadResponse(cardChecklistSourceData(checklistSource), true))), receivedAt: Date.parse(t(22)), respondedAt: Date.parse(t(23)) }],
    comments: [{ id: "comment", companyId: "company", issueId: "failure-task", authorAgentId: "morgan", createdByRunId: run.id, body: "The required current checklist is unavailable; generation is blocked." }],
    activity: [{ id: "audit", companyId: "company", entityId: "failure-task", runId: run.id, action: "issue.updated", actorType: "system", actorId: "native-status-committer", details: { source: "native_status_decision", toStatus: "blocked" } }],
  } as unknown as CardWorkEvidence;
  const card = { id: "card", companyId: "company", agentId: "morgan", interestPrompt: recipe.interestPrompt, state: "error", failureReason: "Generation task blocked before writing a summary", generatingIssueId: null } as StatusCard;
  const update = { id: "failed-update", cardId: "card", generationIssueId: "failure-task", runId: null, kind: "full", status: "failed", error: card.failureReason, startedAt: t(19), finishedAt: t(25) } as StatusCardUpdate;
  return { evidence, card, update, runId: run.id };
}
export function successfulCardWorkFixture(runId: string, issueId: string, updateId: string) {
  const value = cardWorkFixture(), e = value.evidence, run = e.runs.find(r => r.id === runId)!;
  e.generation.id = issueId; e.generation.status = "done"; e.generation.description = '```json\n'+JSON.stringify({ companyId: "company", statusCardId: "card", generationIssueId: issueId })+'\n```';
  const v = e.decisions.decisions[0]!.invocation, a = e.decisions.decisions[0]!.auditEvents[0]!;
  Object.assign(v, { runId, issueId, status: "succeeded", errorCode: null, resultHash: sha("result"), startedAt: run.startedAt, completedAt: run.finishedAt });
  Object.assign(a, { runId, issueId, outcome: "success", decision: "allow", reasonCode: "tool_completed" });
  e.decisions.runId = runId; e.calls[0]!.toolError = false; e.calls[0]!.responseSha256 = sha(JSON.stringify(notesReadResponse(cardChecklistSourceData(e.checklistSource), false))); e.calls[0]!.receivedAt = Date.parse(run.startedAt!) + 1000; e.calls[0]!.respondedAt = Date.parse(run.startedAt!) + 2000;
  const update = { ...value.update, id: updateId, generationIssueId: issueId, runId, status: "ok", error: null } as StatusCardUpdate;
  return { evidence: e, update };
}
