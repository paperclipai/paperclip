import type { ChatRun } from "../chat-flow.js";
import type { Entity } from "./internal-support.js";

export interface TaskPlanRevision extends Entity { revisionNumber?: number }
export interface TaskPlanReadEvidence {
  document?: Entity; revision?: TaskPlanRevision; workerDocument?: Entity; workerTask?: Entity;
}
export function currentWorkerTaskPlan(input: TaskPlanReadEvidence & {
  task?: Entity; companyId: string; sourceId?: string; leadId: string; workerId: string;
  creatorRun?: ChatRun; workerRun?: ChatRun;
}): string {
  const { task, document: plan, revision, workerDocument: read, workerTask, creatorRun, workerRun } = input;
  if (!task || !plan || !revision || !read || !workerTask || !creatorRun || !workerRun) return "";
  if ((plan as Entity & { sourceTrust?: { disposition?: string } | null }).sourceTrust?.disposition === "quarantined") return "";
  const ownsRun = (run: ChatRun, issueId: string, agentId: string) => run.companyId === input.companyId && run.agentId === agentId
    && (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) === issueId;
  const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
  const authored = time(revision.createdAt), updated = time(plan.updatedAt), dispatched = time(workerRun.startedAt), creatorStarted = time(creatorRun.startedAt);
  if (task.companyId !== input.companyId || task.assigneeAgentId !== input.workerId || workerTask.id !== task.id
    || workerTask.companyId !== task.companyId || workerTask.assigneeAgentId !== input.workerId
    || !input.sourceId || !ownsRun(creatorRun, input.sourceId, input.leadId) || creatorRun.status !== "succeeded"
    || !ownsRun(workerRun, task.id, input.workerId) || !["running", "succeeded"].includes(workerRun.status)
    || ![authored, updated, dispatched, creatorStarted].every(Number.isFinite)
    || authored < creatorStarted || updated < authored || updated > dispatched) return "";
  if (plan.companyId !== task.companyId || plan.issueId !== task.id || plan.key !== "plan" || !plan.id
    || plan.createdByAgentId !== input.leadId || plan.updatedByAgentId !== input.leadId
    || !plan.latestRevisionId || !Number.isSafeInteger(plan.latestRevisionNumber) || plan.latestRevisionNumber! < 1
    || typeof plan.body !== "string" || !plan.body.trim() || plan.body.length > 200_000
    || revision.id !== plan.latestRevisionId || revision.documentId !== plan.id || revision.companyId !== task.companyId
    || revision.issueId !== task.id || revision.key !== "plan" || revision.revisionNumber !== plan.latestRevisionNumber
    || revision.body !== plan.body || revision.createdByAgentId !== input.leadId || revision.createdByRunId !== creatorRun.id) return "";
  if (["id", "companyId", "issueId", "key", "latestRevisionId", "latestRevisionNumber", "body", "updatedAt", "createdByAgentId", "updatedByAgentId"].some(key => read[key as keyof Entity] !== plan[key as keyof Entity])) return "";
  return plan.body;
}

export function finalSourceReturn(input: { task: Entity & { completedAt?: string }; sourceId: unknown; companyId: string; leadId: string;
  delivery: unknown; sourceComments: unknown; runs: ChatRun[] }): boolean {
  const delivery = input.delivery as { checks?: Array<{ id: string; passed: boolean }>; response?: Entity } | undefined;
  const wanted = ["completion-worker-done", "completion-output-saved", "completion-source-response", "completion-source-correlated", "completion-result-access"];
  if (!delivery || !Array.isArray(delivery.checks) || delivery.checks.length !== wanted.length
    || wanted.some(id => delivery.checks!.filter(row => row?.id === id && row.passed === true).length !== 1)
    || !Array.isArray(input.sourceComments) || typeof input.sourceId !== "string" || !delivery.response?.id) return false;
  const selected = input.sourceComments.filter((row: Entity | null) => row?.id === delivery.response!.id) as Entity[];
  if (selected.length !== 1) return false;
  const response = selected[0]!;
  if (["id", "companyId", "issueId", "authorAgentId", "createdByRunId", "createdAt", "body"].some(key => response[key as keyof Entity] !== delivery.response![key as keyof Entity])
    || response.companyId !== input.companyId || response.issueId !== input.sourceId || response.authorAgentId !== input.leadId || input.task.companyId !== input.companyId
    || input.task.status !== "done" || !Number.isFinite(Date.parse(input.task.completedAt ?? ""))
    || !Number.isFinite(Date.parse(response.createdAt ?? "")) || Date.parse(response.createdAt!) < Date.parse(input.task.completedAt!)) return false;
  const runs = input.runs.filter(run => run.id === response.createdByRunId && run.companyId === input.companyId && run.agentId === input.leadId
    && run.status === "succeeded" && (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) === input.sourceId);
  if (runs.length !== 1 || !Array.isArray(runs[0]!.contextSnapshot?.chatCompletionUpdates)) return false;
  const updates = (runs[0]!.contextSnapshot!.chatCompletionUpdates as Array<{ id?: string; status?: string }>).filter(row => row?.id === input.task.id);
  return updates.length === 1 && updates[0]!.status === "done";
}
