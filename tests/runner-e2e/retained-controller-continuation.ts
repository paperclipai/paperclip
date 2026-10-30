import { createHash } from "node:crypto";
import type { StoryCheck, StoryRun } from "./everyday-observations.js";
import { validControllerOutageReceipt, type ControllerOutageReceipt } from "./controller-outage.js";

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
  outage: ControllerOutageReceipt | undefined;
  requestedAt: string;
  completedTool: boolean;
  usefulReply: boolean;
}): StoryCheck[] {
  const { before, after, outage } = input;
  const passed = validControllerOutageReceipt(outage)
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
