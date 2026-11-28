import type { RunnerApi } from "./api.js";
import type { MatrixExecution } from "./types.js";
import { createHash } from "node:crypto";
import type { StoryCheck, StoryRun } from "./everyday-observations.js";
import { validControllerReplacementReceipt, type ControllerReplacementReceipt } from "./controller-replacement.js";

/** Only these explicit recovery definitions change the post-replacement user entry point. */
export function retainedControllerFollowupTransport(execution: Pick<MatrixExecution, "suite" | "task">): "browser" | "task_comment_api" {
  return ["daytona-restart-continuity", "remote-workspace-storage", "rolling-web-deployment"].includes(execution.suite.id) && execution.task.id === "recover-controller"
    && execution.suite.definitionMetadata?.retainedControllerContinuation === true
    && execution.suite.definitionMetadata.retainedControllerFollowupTransport === "task_comment_api"
    ? "task_comment_api" : "browser";
}

export async function submitRetainedControllerComment(api: Pick<RunnerApi, "post">, issueId: string, body: string, clientRequestId: string) {
  return api.post<{ id: string }>(`/api/issues/${issueId}/comments`, { body, reopen: true, clientRequestId });
}

export function onePersistedRetainedControllerComment(input: {
  added: Array<{ id?: unknown; body?: unknown; authorAgentId?: unknown; authorType?: unknown }>;
  commentId: string; body: string;
}) {
  return typeof input.commentId === "string" && input.commentId.length > 0
    && input.added.length === 1 && input.added[0]?.id === input.commentId
    && input.added[0].body === input.body && !input.added[0].authorAgentId && input.added[0].authorType === "user";
}

const hash = (value: string | null | undefined) => value ? createHash("sha256").update(value).digest("hex") : null;

/** Public evidence keeps provider/session identifiers hashed. */
export function retainedControllerRun(run: StoryRun) {
  return { runId: run.id, companyId: run.companyId, agentId: run.agentId, issueId: run.nativeIssueId,
    status: run.status, runtimeMode: run.runtimeMode, finishedAt: run.finishedAt,
    nativeSessionSha256: hash(run.nativeSessionId), providerSessionSha256: hash(run.sessionIdAfter) };
}

export function gradeRetainedControllerContinuation(input: {
  before: ReturnType<typeof retainedControllerRun>;
  after: ReturnType<typeof retainedControllerRun>;
  outage: ControllerReplacementReceipt | undefined;
  requestedAt: string;
  completedTool: boolean;
  usefulReply: boolean;
}): StoryCheck[] {
  const { before, after, outage } = input;
  const passed = validControllerReplacementReceipt(outage)
    && before.status === "succeeded" && after.status === "succeeded"
    && before.runtimeMode === "native" && after.runtimeMode === "native"
    && before.runId !== after.runId && before.companyId === after.companyId
    && before.agentId === after.agentId && before.issueId === after.issueId
    && Boolean(before.nativeSessionSha256) && before.nativeSessionSha256 === after.nativeSessionSha256
    && Boolean(before.providerSessionSha256) && before.providerSessionSha256 === after.providerSessionSha256
    && Date.parse(before.finishedAt ?? "") <= Date.parse(outage?.startedAt ?? "")
    && Date.parse(input.requestedAt) >= Date.parse(outage?.startedAt ?? "") + (outage?.readyAfterMs ?? Infinity)
    && Date.parse(after.finishedAt ?? "") >= Date.parse(input.requestedAt)
    && input.completedTool && input.usefulReply;
  return [{ id: "retained-controller-continuation", passed,
    detail: "After completion and another empty-cache replacement, a new native turn must use the same retained provider session and execute the saved project for a useful reply." }];
}
