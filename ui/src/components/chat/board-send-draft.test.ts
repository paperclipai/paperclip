// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boardSendDraftKey,
  clearBoardSendDraft,
  readBoardSendDraft,
  writeBoardSendDraft,
  canDismissBoardSendBatch,
} from "./board-send-draft";

describe("session-scoped Board send identity", () => {
  it("round-trips the awaiting-consent anchor without storing transfer capabilities", () => {
    const draft = {
      body: "File for review",
      attachmentIds: ["file-1"],
      idempotencyKey: "stable-request-key-1",
      publication: {
        id: "file-part",
        state: "awaiting_consent" as const,
        attempts: 1,
      },
    };
    writeBoardSendDraft("waiting", draft);
    expect(readBoardSendDraft("waiting")).toEqual(draft);
  });
  it("requires consistent whole-batch terminal proof to release a retained anchor", () => {
    const batch = {
      publication: {
        id: "file-part",
        state: "cancelled" as const,
        attempts: 1,
      },
      total: 3,
      published: 1,
      awaitingConsent: 0,
      declined: 1,
      expired: 1,
      cancelled: 0,
      settled: 3,
      canDismiss: true,
    };
    expect(canDismissBoardSendBatch(batch)).toBe(true);
    for (const change of [
      { canDismiss: undefined },
      { settled: 2 },
      { awaitingConsent: 1 },
      { cancelled: 1 },
      { declined: -1 },
      { expired: undefined },
      { parts: [{ id: "waiting", state: "pending" as const, attempts: 0 }] },
    ]) {
      expect(canDismissBoardSendBatch({ ...batch, ...change })).toBe(false);
    }
  });
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });
  it("keeps pending payloads isolated by company, task, endpoint and conversation", () => {
    const scope = ["company", "task", "endpoint", "conversation"] as const;
    const key = boardSendDraftKey(...scope);
    const draft = {
      body: "Intended external update",
      attachmentIds: ["file-1"],
      idempotencyKey: "stable-request-key-1",
      publication: null,
    };
    writeBoardSendDraft(key, draft);
    expect(readBoardSendDraft(key)).toEqual(draft);
    for (let index = 0; index < scope.length; index += 1) {
      const other = [...scope] as [string, string, string, string];
      other[index] = "other";
      expect(readBoardSendDraft(boardSendDraftKey(...other))).toBeNull();
    }
    clearBoardSendDraft(key);
    expect(readBoardSendDraft(key)).toBeNull();
  });
  it("rejects corrupt retained identity instead of silently enabling a new send", () => {
    sessionStorage.setItem("corrupt", '{"body":"draft"}');
    expect(() => readBoardSendDraft("corrupt")).toThrow(
      "Saved channel delivery identity",
    );
  });
  it("preserves selected filename snapshots but rejects names outside the exact send", () => {
    const draft = {
      body: "Intended external update",
      attachmentIds: ["file-1"],
      attachmentNames: [{ id: "file-1", name: "selected-image.png" }],
      idempotencyKey: "stable-request-key-1",
      publication: null,
    };
    writeBoardSendDraft("named", draft);
    expect(readBoardSendDraft("named")).toEqual(draft);
    for (const attachmentNames of [
      [],
      [{ id: "other-file", name: "internal-only.txt" }],
      [{ id: "file-1", name: 123 }],
      [
        { id: "file-1", name: "selected-image.png" },
        { id: "file-1", name: "duplicate.png" },
      ],
    ]) {
      sessionStorage.setItem(
        "named",
        JSON.stringify({ ...draft, attachmentNames }),
      );
      expect(() => readBoardSendDraft("named")).toThrow(
        "Saved channel delivery identity",
      );
    }
  });
  it("surfaces storage write failures before a caller performs its send", () => {
    vi.spyOn(
      Object.getPrototypeOf(sessionStorage),
      "setItem",
    ).mockImplementation(() => {
      throw new Error("Storage full");
    });
    expect(() =>
      writeBoardSendDraft("key", {
        body: "draft",
        attachmentIds: [],
        idempotencyKey: "stable-request-key-1",
        publication: null,
      }),
    ).toThrow("Storage full");
  });
  it("retains only a negative receipt for selected files, never alongside a publication", () => {
    const draft = {
      body: "Keep this message",
      attachmentIds: ["file-1"],
      idempotencyKey: "stable-request-key-1",
      publication: null,
      rejection: {
        code: "chat_board_send_attachments_already_bound" as const,
        attachmentIds: ["file-1"],
      },
    };
    writeBoardSendDraft("rejected", draft);
    expect(readBoardSendDraft("rejected")).toEqual(draft);
    for (const change of [
      { rejection: { code: "unknown", attachmentIds: ["file-1"] } },
      { rejection: { ...draft.rejection, attachmentIds: [] } },
      { rejection: { ...draft.rejection, attachmentIds: ["foreign"] } },
      {
        rejection: { ...draft.rejection, attachmentIds: ["file-1", "file-1"] },
      },
      { publication: { id: "publication-1", state: "pending", attempts: 0 } },
    ]) {
      sessionStorage.setItem(
        "rejected",
        JSON.stringify({ ...draft, ...change }),
      );
      expect(() => readBoardSendDraft("rejected")).toThrow(
        "Saved channel delivery identity",
      );
    }
  });
});
