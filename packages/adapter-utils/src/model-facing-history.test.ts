import { describe, expect, it } from "vitest";
import { modelFacingObject } from "./model-facing-history.js";

describe("withoutModelHiddenRunIds", () => {
  it("drops run ids at every depth and keeps other values", () => {
    const createdAt = new Date("2026-11-25T08:53:08.968Z");
    const projected = modelFacingObject({
      trigger: { reason: "issue_commented", sourceRunId: "run-1" },
      messages: [
        { id: "comment-agent", authorType: "agent", createdByRunId: "run-1", body: "done", createdAt },
        { id: "comment-cli", authorType: "user", createdByRunId: "run-2", body: "from the CLI" },
        { id: "comment-user", authorType: "user", createdByRunId: null, body: "append three" },
      ],
      completedActions: [{ runId: "run-1", receiptId: "receipt-1", result: { attachmentId: "a-1" } }],
      sourceTrust: { disposition: "quarantined", sourceRunId: "run-1", sourceIssueId: "issue-1" },
      coverage: { kind: "task_history_delta", baseRunId: "run-1" },
      runIdentifier: "kept",
    });
    expect(JSON.stringify(projected)).not.toMatch(/run-[12]/);
    const messages = projected.messages as Array<Record<string, unknown>>;
    expect(messages[0]!.createdAt).toBe(createdAt);
    expect(messages.map((message) => message.createdByRunId)).toEqual([undefined, true, undefined]);
    expect(projected.completedActions).toEqual([{ receiptId: "receipt-1", result: { attachmentId: "a-1" } }]);
    expect(projected.sourceTrust).toEqual({ disposition: "quarantined", sourceIssueId: "issue-1" });
    expect(projected.runIdentifier).toBe("kept");
  });
});
