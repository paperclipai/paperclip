import type { Db } from "@paperclipai/db";
import { githubLatestTaskResponseUrl, githubRunReplyState } from "../../chat-run-publications.js";
import { baseThreadId, isMainPullThread } from "./response-target.js";
import { FINISHED_RUN_STATUSES, readGitHubResponseRun, type GitHubResponseRunRead, type GitHubResponseRunState } from "./response-run-state.js";
export { responseRunColumns as githubResponseRunColumns } from "./response-run-state.js";

export type GitHubResponseExecutionInput = {
  companyId: string;
  endpointId: string;
  agentId: string;
  issueId: string;
  deliveryId: string;
  sourceMessageId: string | null;
  issueStatus: string;
  deliveryCreatedAt: Date;
  /** The request's conversation thread, such as `github:owner/repo:12` or `github:owner/repo:12:rc:34`. */
  threadId: string;
};

const STATUS_TEXT = {
  handled: "This request has been handled. See the response in this conversation.",
  paused: "Work is paused. Your request is saved. See the Paperclip task for details.",
  publish_failed: "This turn's reply could not be published. See the Paperclip task for details.",
  ended: "This turn ended without publishing a final response. See the Paperclip task for details.",
  stopped: "This turn stopped before completing. See the Paperclip task for details.",
} as const;

const finished = (status: string | undefined) => (FINISHED_RUN_STATUSES as readonly string[]).includes(status ?? "");

/** Whether the task is idle and this request settles from the earlier run that
 * woke for it, because the latest run belongs to another request. */
export function settlesFromRequestRun(state: GitHubResponseRunState, issueStatus: string) {
  return !!state.latestRun && finished(state.latestRun.status) && !state.ownsLatestRequest &&
    issueStatus !== "blocked" && !!state.finishedRequestRun;
}

export const GITHUB_CONTINUATION_WAIT_MS = 30 * 60_000;

export function awaitsAutomaticContinuation(
  latestRun: { continuesAutomatically: boolean; updatedAt: Date },
  continuesRequest: boolean,
  now = Date.now(),
) {
  return continuesRequest && latestRun.continuesAutomatically && now - latestRun.updatedAt.getTime() < GITHUB_CONTINUATION_WAIT_MS;
}

/** The notice that points a request at the latest response its agent published
 * on the same pull request or issue after the request arrived, if any. */
export async function latestResponseNotice(db: Db,
  input: { companyId: string; endpointId: string; issueId: string; since: Date; threadId: string }) {
  const url = await githubLatestTaskResponseUrl(db, { companyId: input.companyId, endpointId: input.endpointId,
    issueId: input.issueId, since: input.since, baseThreadId: baseThreadId(input.threadId) });
  return url ? `See the [latest response](${url}).` : null;
}

/** `read` is this request's state from a batched page read, if the caller has it. */
export async function githubResponseExecution(db: Db, input: GitHubResponseExecutionInput, read?: GitHubResponseRunRead) {
  const state = read ?? await readGitHubResponseRun(db, input);
  if ("forbidden" in state) throw state.forbidden;
  const { latestRun, ownsLatestRequest, finishedRequestRun, latestContinuesRequestRun } = state;
  const requestRunning = ownsLatestRequest && latestRun?.status === "running";
  const terminal = latestRun && finished(latestRun.status);
  // Once the task is idle, a request whose own run finished earlier settles
  // from that run; otherwise its placeholder would wait for a run that never comes.
  const requestRun = settlesFromRequestRun(state, input.issueStatus) ? finishedRequestRun : null;
  const run = requestRun ?? (terminal && (ownsLatestRequest || input.issueStatus === "blocked") ? latestRun : null);
  const answersRequest = ownsLatestRequest || !!requestRun;

  const reply = run && answersRequest ? await githubRunReplyState(db, {
    companyId: input.companyId, endpointId: input.endpointId, issueId: input.issueId, runId: run.id,
  }) : "none";
  const paused = !!run ? input.issueStatus === "blocked" && !answersRequest
    : input.issueStatus === "blocked" && latestRun?.status !== "running";
  const presentationPending = !!run && answersRequest && run.nativePresentationPending && reply === "none";
  const passiveResponseWait = !!run && answersRequest && run.passiveResponseWait && reply === "none";
  const unanswered = !!run && !presentationPending && reply === "none" && !paused;
  const latestResponse = unanswered ? await latestResponseNotice(db, { companyId: input.companyId,
    endpointId: input.endpointId, issueId: input.issueId, since: input.deliveryCreatedAt, threadId: input.threadId })
    : null;
  const taskFinished = ["done", "cancelled"].includes(input.issueStatus);
  // Precedence: a later published response is more useful to the reader than
  // any notice about this request's own run, including a refused reply.
  const awaitingContinuation = !!run && !!latestRun && !taskFinished &&
    awaitsAutomaticContinuation(latestRun, run.id === latestRun.id || (run.id === requestRun?.id && latestContinuesRequestRun));
  const outcome: keyof typeof STATUS_TEXT | "link" | "waiting" | null =
    presentationPending ? null
    : !run ? paused ? "paused" : null
    : reply === "confirmed" ? "handled"
    : paused ? "paused"
    : latestResponse ? "link"
    : awaitingContinuation || (run.passiveResponseWait && !isMainPullThread(input.threadId) && !taskFinished) ? "waiting"
    : run.responsePublicationFailed ? "publish_failed"
    : run.status === "succeeded" ? "ended" : "stopped";
  const body = outcome === null || outcome === "waiting" ? undefined
    : outcome === "link" ? latestResponse! : STATUS_TEXT[outcome];
  return {
    body, outcome, paused, reply, running: requestRunning, presentationPending, passiveResponseWait, awaitingContinuation,
    continuationDeadline: outcome === "waiting" && awaitingContinuation && latestRun ? latestRun.updatedAt.getTime() + GITHUB_CONTINUATION_WAIT_MS : undefined,
    versionAt: run ? new Date(Math.max(run.updatedAt.getTime(), input.deliveryCreatedAt.getTime()))
      : paused ? input.deliveryCreatedAt : undefined,
    version: JSON.stringify([latestRun?.id ?? null, latestRun?.status ?? null,
      latestRun?.updatedAt.toISOString() ?? null, ownsLatestRequest, input.issueStatus === "blocked", reply, requestRun?.id ?? null]),
  };
}
