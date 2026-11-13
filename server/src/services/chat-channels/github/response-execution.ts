import type { Db } from "@paperclipai/db";
import { githubRunReplyState } from "../../chat-run-publications.js";
import { readGitHubResponseRun } from "./response-run-state.js";
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
};

export async function githubResponseExecution(db: Db, input: GitHubResponseExecutionInput) {
  const { latestRun, ownsLatestRequest } = await readGitHubResponseRun(db, input);
  const requestRunning = ownsLatestRequest && latestRun?.status === "running";
  const terminal = latestRun && ["succeeded", "failed", "interrupted", "timed_out", "cancelled"].includes(latestRun.status);
  const run = terminal && (ownsLatestRequest || input.issueStatus === "blocked") ? latestRun : null;

  const reply = run && ownsLatestRequest ? await githubRunReplyState(db, {
    companyId: input.companyId, endpointId: input.endpointId, issueId: input.issueId, runId: run.id,
  }) : "none";
  const paused = !!run ? input.issueStatus === "blocked" && !ownsLatestRequest
    : input.issueStatus === "blocked" && latestRun?.status !== "running";
  const presentationPending = !!run && ownsLatestRequest && run.nativePresentationPending && reply === "none";
  const passiveResponseWait = !!run && ownsLatestRequest && run.passiveResponseWait && reply === "none";
  const body = presentationPending ? undefined : run ? reply === "confirmed" ? "This request has been handled. See the response in this conversation."
    : paused ? "Work is paused. Your request is saved. See the Paperclip task for details."
    : run.status === "succeeded" ? "This turn ended without publishing a final response. See the Paperclip task for details."
    : "This turn stopped before completing. See the Paperclip task for details."
    : paused ? "Work is paused. Your request is saved. See the Paperclip task for details." : undefined;
  return {
    body, paused, reply, running: requestRunning, presentationPending, passiveResponseWait,
    versionAt: run ? new Date(Math.max(run.updatedAt.getTime(), input.deliveryCreatedAt.getTime()))
      : paused ? input.deliveryCreatedAt : undefined,
    version: JSON.stringify([latestRun?.id ?? null, latestRun?.status ?? null,
      latestRun?.updatedAt.toISOString() ?? null, ownsLatestRequest, input.issueStatus === "blocked", reply]),
  };
}
