import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import {
  boundExecutionContinuationForPrompt,
  CONTINUATION_PROMPT_ACTIONS_MAX_BYTES,
  CONTINUATION_PROMPT_HUMAN_RESPONSES_MAX_BYTES,
  CONTINUATION_PROMPT_INTERACTIONS_MAX_BYTES,
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

  it("keeps a long message whole while the messages fit, and returns history-free input unchanged", () => {
    const long = "x".repeat(CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS * 2);
    const fits = envelope({ messages: [message("m-1", long)] });
    expect(boundExecutionContinuationForPrompt(fits)).toBe(fits);
    const compact = { ...envelope({}), messages: undefined } as unknown as ExecutionContinuationEnvelope;
    expect(boundExecutionContinuationForPrompt(compact)).toBe(compact);
  });

  it("clips the middle of a very long message but keeps the objective source exact", () => {
    const long = `start ${"x".repeat(CONTINUATION_PROMPT_MESSAGE_BODY_MAX_CHARS * 2)} latest direction`;
    const filler = Array.from({ length: 4 }, (_, index) => message(`f-${index}`, long));
    const bounded = boundExecutionContinuationForPrompt(envelope({
      messages: [...filler, message("m-1", long), message("m-2", long)],
      objectiveSource: { kind: "comment", id: "m-2", revision: null },
    }));
    const clipped = bounded.messages.find((entry) => entry.id === "m-1");
    const objective = bounded.messages.find((entry) => entry.id === "m-2");
    expect(clipped?.bodyTruncated).toBe(true);
    expect(clipped?.body.startsWith("start ")).toBe(true);
    expect(clipped?.body.endsWith("latest direction")).toBe(true);
    expect(objective?.body).toBe(long);
    expect(bounded.coverage.omitted?.clippedMessages).toBe(bounded.messages.length - 1);
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

  it("keeps many large required messages inside the message budget", () => {
    // Three-byte characters: a 20,000-character body is about 60 KB.
    const messages = Array.from({ length: 12 }, (_, index) => message(`o-${index}`, "💊".repeat(10_000)));
    const bounded = boundExecutionContinuationForPrompt(envelope({
      messages, originCommentIds: messages.map((entry) => entry.id),
      objectiveSource: { kind: "comment", id: "o-11", revision: null },
    }));
    expect(bytes(bounded.messages)).toBeLessThanOrEqual(CONTINUATION_PROMPT_MESSAGES_MAX_BYTES);
    expect(bounded.messages.map((entry) => entry.id)).toContain("o-11");
    expect(bounded.coverage.omitted!.messages + bounded.messages.length).toBe(12);
  });

  it("bounds large interaction outcomes and human answers with references to the complete record", () => {
    const answer = (id: string) => ({ id, kind: "ask_user_questions", status: "answered", resolvedByUserId: "user-1",
      resolvedAt: "2026-11-24T00:00:00.000Z", result: { answers: [{ otherText: "a".repeat(100_000) }] } });
    const humanResponses = ["i-0", "i-1", "i-2"].map(answer);
    const interactionOutcomes = humanResponses.map(({ id, kind, status, result }) => ({ id, kind, status, result }));
    const bounded = boundExecutionContinuationForPrompt(envelope({ humanResponses, interactionOutcomes }));
    expect(bytes(bounded.interactionOutcomes)).toBeLessThanOrEqual(CONTINUATION_PROMPT_INTERACTIONS_MAX_BYTES);
    expect(bytes(bounded.humanResponses)).toBeLessThanOrEqual(CONTINUATION_PROMPT_HUMAN_RESPONSES_MAX_BYTES);
    expect(bounded.interactionOutcomes.every((outcome) => JSON.stringify(outcome.result).includes("seeHumanResponse"))).toBe(true);
    expect(bounded.humanResponses?.map((response) => response.id)).toEqual(["i-0", "i-1", "i-2"]);
    expect(bounded.coverage.omitted?.interactionOutcomes).toBe(3);
    expect(bounded.coverage.omitted?.humanResponses).toBe(3);
  });
});
