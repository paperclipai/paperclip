import { expect, it } from "vitest";
import { buildNativeContinuationPrompt, NATIVE_CONTINUATION_PROMPT_MAX_BYTES } from "./native-continuation.js";

const message = (id: string, body: string) => ({
  id, body, authorType: "user", authorId: "user-1", createdByRunId: null,
  createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z", deleted: false, sourceTrust: null,
});

const prompt = (messages: ReturnType<typeof message>[]) => buildNativeContinuationPrompt({
  previousRunId: "run-1",
  issue: { title: "Task", description: null },
  previousIssue: { title: "Task", description: null },
  wakePayload: {
    reason: "issue_commented", issue: { id: "issue-1" }, commentIds: [], comments: [],
    commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 }, fallbackFetchNeeded: false,
    executionContinuation: {
      version: 1, companyId: "company-1", issueId: "issue-1", objective: "Continue",
      trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
      originCommentIds: [], messages, resumeDelta: { baseRunId: "run-1", messages },
      interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
    },
  },
});

it("uses the bounded bootstrap prompt when a resume delta is too large for one runner turn", () => {
  const small = prompt([message("m-1", "Please add the audit trail.")]);
  expect(JSON.parse(small!).messages.map((entry: { id: string }) => entry.id)).toEqual(["m-1"]);
  const large = Array.from({ length: 30 }, (_, index) => message(`m-${index}`, "x".repeat(20_000)));
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(NATIVE_CONTINUATION_PROMPT_MAX_BYTES);
  expect(prompt(large)).toBeNull();
});

it("measures the resume delta as the runner command serializes it", () => {
  // About 140 KB as compact JSON, but every quote doubles twice in the envelope and command.
  const quoted = [message("m-1", '"'.repeat(70_000))];
  expect(Buffer.byteLength(JSON.stringify(quoted))).toBeLessThan(NATIVE_CONTINUATION_PROMPT_MAX_BYTES);
  expect(prompt(quoted)).toBeNull();
});
