import { describe, expect, it } from "vitest";
import { findHeartbeatRunCompletionComment, resolveHeartbeatRunResponse } from "../heartbeat-run-summary.js";

describe("system notices and final run replies", () => {
  const notice = { id: "workspace-ready", body: "## Workspace Ready", presentation: { kind: "system_notice" } };
  const final = { id: "final-reply", body: "Hi" };

  it.each([undefined, {}, { semanticToolReceipts: {} }])("does not use a system notice as an explicit reply with %j", resultJson => {
    const existingComment = findHeartbeatRunCompletionComment([notice], resultJson);
    expect(existingComment).toBeNull();
    expect(resolveHeartbeatRunResponse({ resultJson, existingComment,
      finalAgentMessage: { text: "Hi", channel: "final", sourceEventId: "final-event" },
    })).toMatchObject({ text: "Hi", decision: { commentAction: "create" } });
  });

  it.each([[notice, final], [final, notice]])("keeps an explicit reply when notices are also present", (...comments) => {
    expect(findHeartbeatRunCompletionComment(comments, {})).toEqual(final);
  });

  it("uses the stored presentation type instead of the comment text", () => {
    const explicit = { id: "explicit", body: notice.body };
    expect(findHeartbeatRunCompletionComment([explicit], {})).toEqual(explicit);
    expect(findHeartbeatRunCompletionComment([{ ...notice, body: "A different generated notice" }], {})).toBeNull();
  });

  it("still excludes receipt-bound progress alongside a system notice", () => {
    const progress = { id: "progress", body: "Working" };
    const resultJson = { semanticToolReceipts: { progress: { operationId: "report_progress", result: { commentId: progress.id } } } };
    expect(findHeartbeatRunCompletionComment([notice, progress], resultJson)).toBeNull();
    expect(findHeartbeatRunCompletionComment([notice, progress, final], resultJson)).toEqual(final);
  });
});
