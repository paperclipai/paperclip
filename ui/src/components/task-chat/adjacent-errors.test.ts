import { describe, expect, it } from "vitest";
import { compactAdjacentErrors } from "./adjacent-errors";
import type { TaskChatItem, TaskChatMarkerItem, TaskChatMessageItem } from "./task-chat-model";

const failed: TaskChatMarkerItem = {
  id: "failure", kind: "marker", variant: "interrupted", label: "Run failed", runId: "run-1",
};
const recovery: TaskChatMessageItem = {
  id: "recovery", kind: "message", author: "system", text: "Paperclip retried continuation, but it still has no live execution path.",
  presentation: { kind: "system_notice", title: "No live execution path", tone: "danger", detailsDefaultOpen: false },
};

describe("compactAdjacentErrors", () => {
  it.each([
    [failed, recovery],
    [recovery, failed],
  ])("keeps the later row and all of its details in either order", (first, last) => {
    const items = [first, last];
    expect(compactAdjacentErrors(items).items).toEqual([last]);
    expect(items).toEqual([first, last]);
  });

  it("compacts a contiguous group only when both error sources are present", () => {
    const latest = { ...failed, id: "latest", detail: "Newest error", runId: "run-2" };
    expect(compactAdjacentErrors([failed, recovery, latest]).items).toEqual([latest]);
    expect(compactAdjacentErrors([failed, latest]).items).toEqual([failed, latest]);
    expect(compactAdjacentErrors([recovery, { ...recovery, id: "other" }]).items).toHaveLength(2);
  });

  it("preserves the latest suppressed run retry without changing saved rows", () => {
    const latestFailure = { ...failed, id: "last-failure", runId: "last-run", retryable: false };
    const items = [failed, latestFailure, recovery];
    const compacted = compactAdjacentErrors(items);
    expect(compacted.items).toEqual([recovery]);
    expect(compacted.retryMarkers.get(recovery.id)).toBe(latestFailure);
    expect(items).toEqual([failed, latestFailure, recovery]);
    expect(compactAdjacentErrors([failed, { id: "human", kind: "message", author: "human", text: "Retry?" }, recovery]).retryMarkers.size).toBe(0);
  });

  it.each([
    recovery.text,
    "Paperclip automatically retried dispatch for this assigned `todo` issue during terminal run recovery, but it still has no live execution path.",
    "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry made progress, but it still has no live execution path.",
    "Paperclip retried this issue's run after it ended without finishing, but the bounded retry budget is spent and it still has no live execution path.",
  ])("recognizes an old unstructured recovery comment: %s", (text) => {
    const legacy = { ...recovery, text, presentation: null };
    expect(compactAdjacentErrors([failed, legacy]).items).toEqual([legacy]);
  });

  it.each(["Automatic recovery blocked", "Error: usage limit reached"])(
    "recognizes a saved stranded-recovery notice with the producer title %s", (title) => {
      // buildStrandedRecoveryEscalationNotice saves this metadata even when
      // its default or source-run title replaces the recovery-family title.
      const notice: TaskChatMessageItem = {
        ...recovery,
        text: "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry made progress, but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.",
        presentation: { ...recovery.presentation!, title },
        metadata: { version: 1, sourceRunId: "run-1", sections: [{ title: "Recovery", rows: [
          { type: "key_value", label: "Recovery action", value: "recovery-action-1" },
          { type: "key_value", label: "Recovery owner", value: "Board decision required" },
        ] }] },
      };
      const compacted = compactAdjacentErrors([failed, notice]);
      expect(compacted.items).toEqual([notice]);
      expect(compacted.retryMarkers.get(notice.id)).toBe(failed);
      expect(compactAdjacentErrors([notice, failed]).items).toEqual([failed]);
    },
  );

  it.each([
    { ...recovery, presentation: { ...recovery.presentation!, title: "Child task blocked" } },
    { ...recovery, presentation: { ...recovery.presentation!, title: "" } },
    { ...recovery, presentation: { ...recovery.presentation!, title: "Automatic recovery blocked" } },
    { ...recovery, presentation: { ...recovery.presentation!, title: "Automatic recovery blocked" }, metadata: {
      version: 1 as const, sections: [{ title: "Recovery", rows: [{ type: "key_value" as const, label: "Recovery action", value: "" }] }],
    } },
    { ...recovery, text: "Child task has no live execution path.", metadata: {
      version: 1 as const, sections: [{ title: "Recovery", rows: [{ type: "key_value" as const, label: "Recovery action", value: "child-action" }] }],
    }, presentation: { ...recovery.presentation!, title: "Child task blocked" } },
    { ...recovery, presentation: null, text: "Child task has no live execution path. Parent must review its result." },
    { ...recovery, presentation: null, text: "Child task report: Paperclip retried continuation, but it still has no live execution path." },
  ])("preserves unrelated notices and their retry boundaries: $text ($presentation.title)", (boundary) => {
    const lastFailure = { ...failed, id: "last-failure", runId: "last-run" };
    for (const last of [recovery, lastFailure]) {
      const items = [failed, { ...boundary, id: "unrelated" }, last];
      const result = compactAdjacentErrors(items);
      expect(result.items).toEqual(items);
      expect(result.retryMarkers.size).toBe(0);
    }
  });

  const boundaries: TaskChatItem[] = [
    { id: "human", kind: "message", author: "human", text: "Please try again." },
    { id: "agent", kind: "message", author: "agent", text: "There is no live execution path." },
    { id: "system", kind: "message", author: "system", text: "Child task completed." },
    { id: "session", kind: "marker", variant: "session_start", label: "Session reset" },
    { ...failed, id: "cancelled", tone: "neutral", label: "Stopped" },
    { ...failed, id: "credential", credentialAccess: { agentName: "Coder", deniedUser: "you", settingsHref: "/agents/coder" } },
    { id: "tool", kind: "tool", name: "Read file", status: "completed" },
  ];
  it.each(boundaries.map((boundary) => [boundary.id, boundary] as const))(
    "keeps both errors across a %s row", (_, boundary) => {
      const items = [failed, boundary, recovery];
      expect(compactAdjacentErrors(items).items).toEqual(items);
    },
  );
});
