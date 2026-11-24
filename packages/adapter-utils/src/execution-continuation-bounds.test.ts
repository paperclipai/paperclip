import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import {
  boundExecutionContinuationForPrompt,
  CONTINUATION_PROMPT_ACTIONS_MAX_BYTES,
  CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS,
  CONTINUATION_PROMPT_MESSAGES_MAX_BYTES,
} from "./execution-continuation-bounds.js";

const message = (id: string, body: string): ExecutionContinuationEnvelope["messages"][number] => ({
  id, authorType: "user", authorId: "user-1", createdByRunId: null, body,
  createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z", deleted: false, sourceTrust: "human",
});

const envelope = (input: Partial<ExecutionContinuationEnvelope>): ExecutionContinuationEnvelope => ({
  version: 1, companyId: "company-1", issueId: "issue-1",
  trigger: { reason: "issue_blockers_resolved", interactionId: null, sourceRunId: null },
  originCommentIds: [], objective: "Continue.", messages: [], interactionOutcomes: [], completedWork: null,
  unresolvedInteractionIds: [],
  coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
  ...input,
});

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("boundExecutionContinuationForPrompt", () => {
  it("returns a history that already fits unchanged", () => {
    const continuation = envelope({ messages: [message("m-1", "Short")] });
    expect(boundExecutionContinuationForPrompt(continuation)).toBe(continuation);
  });

  it("keeps the origin, objective and newest messages and records what it omits", () => {
    const messages = Array.from({ length: 200 }, (_, index) => message(`m-${index}`, "x".repeat(2_000)));
    const bounded = boundExecutionContinuationForPrompt(envelope({
      messages, originCommentIds: ["m-0"], objectiveSource: { kind: "comment", id: "m-5", revision: null },
    }));
    const ids = bounded.messages.map((entry) => entry.id);
    expect(ids).toContain("m-0");
    expect(ids).toContain("m-5");
    expect(ids.at(-1)).toBe("m-199");
    expect(bytes(bounded.messages)).toBeLessThanOrEqual(CONTINUATION_PROMPT_MESSAGES_MAX_BYTES + 2 * 2_500);
    // Chronological order is preserved.
    expect(ids).toEqual([...ids].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))));
    expect(bounded.coverage.omitted?.messages).toBe(200 - ids.length);
    expect(bounded.coverage.omitted?.oldestIncludedMessageId).toBe("m-0");
  });

  it("clips the middle of a very long message but keeps the objective source exact", () => {
    const long = `start ${"x".repeat(CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS * 2)} latest direction`;
    const bounded = boundExecutionContinuationForPrompt(envelope({
      messages: [message("m-1", long), message("m-2", long)],
      objectiveSource: { kind: "comment", id: "m-2", revision: null },
    }));
    const [clipped, objective] = bounded.messages;
    expect(clipped?.bodyTruncated).toBe(true);
    expect(clipped?.body.startsWith("start ")).toBe(true);
    expect(clipped?.body.endsWith("latest direction")).toBe(true);
    expect(objective?.body).toBe(long);
    expect(bounded.coverage.omitted?.clippedMessages).toBe(1);
  });

  it("keeps the newest action results and leaves older actions as completed references", () => {
    const completedActions = Array.from({ length: 300 }, (_, index) => ({
      runId: "run-1", receiptId: `r-${index}`, operationId: "write_document", result: { body: "y".repeat(3_000) },
    }));
    const bounded = boundExecutionContinuationForPrompt(envelope({ completedActions }));
    const actions = bounded.completedActions ?? [];
    expect(bytes(actions)).toBeLessThanOrEqual(CONTINUATION_PROMPT_ACTIONS_MAX_BYTES);
    expect(actions.at(-1)).toEqual(completedActions.at(-1));
    expect(actions[0]?.result).toEqual({ resultOmitted: true });
    const omitted = bounded.coverage.omitted!;
    expect(omitted.completedActions + actions.length).toBe(300);
    expect(omitted.completedActionResults).toBe(actions.filter((action) =>
      JSON.stringify(action.result) === JSON.stringify({ resultOmitted: true })).length);
  });
});
