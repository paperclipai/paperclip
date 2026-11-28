import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

export const FOLLOW_UP_SWARM_RUN_ID = "5a1d0c2e-7f3b-4c41-9b0a-0d3c8e9f1a21";
export const FOLLOW_UP_REQUEST_ID = "6b2e1d3f-8a4c-4d52-8c1b-1e4d9f0a2b32";
export const FOLLOW_UP_REQUEST = "append three to w1.txt";

const summary = [
  "# Continuation Summary",
  "",
  "- Issue: PAP-48 — Two small files",
  "- Status: done",
  "",
  "## Recent Concrete Actions",
  "",
  "- The latest run finished with status `succeeded` at 2026-11-25T08:53:06.460Z.",
  "- Both w1.txt (containing \"one\") and w2.txt (containing \"two\") have been created in the task folder and verified.",
  "",
  "## Files Delivered",
  "",
  "- `w1.txt`",
  "- `w2.txt`",
].join("\n");

const swarmReply = [
  "Both requested files have been created in the task folder and verified:",
  "",
  "- `w1.txt`: created by helper `worker1` with content `one`",
  "- `w2.txt`: created by helper `worker2` with content `two`",
].join("\n");

/** Sanitised shape of a real follow-up wake: a user comment reopens a done task after a swarm run. */
export function createFollowUpAfterSwarmWake() {
  const message = (id: string, authorType: "user" | "agent", body: string, at: string) => ({
    id,
    authorType,
    authorId: authorType === "user" ? "local-board" : "agent-1",
    createdByRunId: authorType === "agent" ? FOLLOW_UP_SWARM_RUN_ID : null,
    body,
    createdAt: at,
    updatedAt: at,
    deleted: false,
    sourceTrust: null,
  });
  const messages = [
    message("7c3f2e40-9b5d-4e63-9d2c-2f5e0a1b3c43", "user",
      "Create two files in the task folder: w1.txt containing one and w2.txt containing two. Use one helper per file, then verify both files exist with the right content.",
      "2026-11-25T08:52:15.800Z"),
    message("8d4a3f51-0c6e-4f74-8e3d-3a6f1b2c4d54", "agent", "Prepared w1.txt for this response.", "2026-11-25T08:52:57.121Z"),
    message("9e5b4a62-1d7f-4a85-9f4e-4b7a2c3d5e65", "agent", "Prepared w2.txt for this response.", "2026-11-25T08:52:57.642Z"),
    message("af6c5b73-2e8a-4b96-8a5f-5c8b3d4e6f76", "agent", swarmReply, "2026-11-25T08:53:06.513Z"),
    message(FOLLOW_UP_REQUEST_ID, "user", FOLLOW_UP_REQUEST, "2026-11-25T08:53:08.968Z"),
  ];
  const executionContinuation: ExecutionContinuationEnvelope = {
    version: 1,
    companyId: "company-1",
    issueId: "issue-48",
    trigger: { reason: "issue_reopened_via_comment", interactionId: null, sourceRunId: null },
    originCommentIds: [FOLLOW_UP_REQUEST_ID],
    objective: FOLLOW_UP_REQUEST,
    objectiveSource: { kind: "comment", id: FOLLOW_UP_REQUEST_ID, revision: "2026-11-25T08:53:08.968Z" },
    messages,
    humanResponses: [],
    interactionOutcomes: [],
    completedActions: [],
    completedWork: summary,
    recoveryOutcomes: [],
    unresolvedInteractionIds: [],
    coverage: { kind: "full_task_history", throughCommentId: FOLLOW_UP_REQUEST_ID, summaryThroughCommentId: null },
  };
  return {
    summary,
    swarmReply,
    paperclipWake: {
      reason: "issue_reopened_via_comment",
      issue: { id: "issue-48", identifier: "PAP-48", title: "Two small files", status: "in_progress", workMode: "standard", priority: "medium" },
      commentIds: [FOLLOW_UP_REQUEST_ID],
      latestCommentId: FOLLOW_UP_REQUEST_ID,
      comments: [{ id: FOLLOW_UP_REQUEST_ID, body: FOLLOW_UP_REQUEST, author: { type: "user", id: "local-board" }, createdAt: "2026-11-25T08:53:08.968Z" }],
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      fallbackFetchNeeded: false,
      checkedOutByHarness: true,
      continuationSummary: { key: "continuation-summary", title: "Continuation Summary", body: summary },
      executionContinuation,
    },
  };
}
