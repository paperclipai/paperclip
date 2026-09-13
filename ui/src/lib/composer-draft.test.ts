// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDraft,
  loadDraft,
  loadDraftAttachments,
  saveDraft,
  saveDraftAttachments,
  loadDraftSubmission,
  saveDraftSubmission,
  clearDraftSubmission,
  settleDraftSubmission,
} from "./composer-draft";

describe("task draft upload receipts", () => {
  const key = "paperclip:issue-comment-draft:task-one";
  const id = "9af8228f-0be7-45ae-a104-6fbe0af6f1d3";
  const receipt = {
    attachmentId: id,
    name: "file.txt",
    size: 5,
    inline: false,
    contentPath: `/api/attachments/${id}/content`,
  };
  beforeEach(() => localStorage.clear());
  it("settles only submitted text and attachments while preserving the next draft", () => {
    const nextId = "aaf8228f-0be7-45ae-a104-6fbe0af6f1d3";
    const nextReceipt = { ...receipt, attachmentId: nextId, contentPath: `/api/attachments/${nextId}/content` };
    saveDraft(key, "Sent\n\nNext");
    saveDraftAttachments(key, [receipt]);
    saveDraftSubmission(key, { attemptId: id, reviewed: false, nextDraftOffset: 6, submittedAttachmentIds: [id] });
    saveDraftAttachments(key, [receipt, nextReceipt], nextId);
    expect(loadDraftAttachments(key)).toEqual([receipt]);
    saveDraftAttachments(key, [receipt, nextReceipt], id);
    expect(settleDraftSubmission(key, nextId)).toBe(false);
    expect(settleDraftSubmission(key, id)).toBe(true);
    expect(loadDraft(key)).toBe("Next");
    expect(loadDraftAttachments(key)).toEqual([nextReceipt]);
    expect(loadDraftSubmission(key)).toBeNull();
  });
  it("keeps chat drafts and pending submission fences within the current tab", () => {
    sessionStorage.clear();
    const chatKey = "paperclip:agent-chat-draft:company:user:agent";
    saveDraft(chatKey, "My chat draft");
    saveDraftSubmission(chatKey, { attemptId: id, reviewed: false });
    expect(loadDraft(chatKey)).toBe("My chat draft");
    expect(loadDraftSubmission(chatKey)?.attemptId).toBe(id);
    expect(localStorage.getItem(chatKey)).toBeNull();
    expect(localStorage.getItem(`${chatKey}:submission:v1`)).toBeNull();
    sessionStorage.clear();
    expect(loadDraftSubmission(chatKey)).toBeNull();
  });
  it("retains a closed task-specific uncertainty marker and only settles the same attempt", () => {
    saveDraftSubmission(key, { attemptId: id, reviewed: false });
    expect(loadDraftSubmission(key)).toEqual({
      attemptId: id,
      reviewed: false,
    });
    localStorage.setItem(
      "other:submission:v1",
      localStorage.getItem(`${key}:submission:v1`)!,
    );
    expect(loadDraftSubmission("other")).toBeNull();
    clearDraftSubmission(key, "different-attempt");
    expect(loadDraftSubmission(key)?.attemptId).toBe(id);
    clearDraftSubmission(key, id);
    expect(loadDraftSubmission(key)).toBeNull();
    saveDraftSubmission(key, { attemptId: id, reviewed: true });
    clearDraft(key);
    expect(loadDraftSubmission(key)?.attemptId).toBe(id);
    clearDraft(key, id);
    expect(loadDraftSubmission(key)).toBeNull();
  });
  it("retains legacy plain text and restores only closed task-keyed receipt metadata", () => {
    saveDraft(key, "Existing draft");
    saveDraftAttachments(key, [receipt]);
    expect(localStorage.getItem(key)).toBe("Existing draft");
    expect(loadDraft(key)).toBe("Existing draft");
    expect(loadDraftAttachments(key)).toEqual([receipt]);
    expect(loadDraftAttachments("different-task")).toEqual([]);
    localStorage.setItem(
      "different-task:attachments:v1",
      localStorage.getItem(`${key}:attachments:v1`)!,
    );
    expect(loadDraftAttachments("different-task")).toEqual([]);
    clearDraft(key);
    expect(loadDraftAttachments(key)).toEqual([]);
  });
  it.each([
    { ...receipt, contentPath: "https://example.test/private" },
    { ...receipt, contentPath: `/api/attachments/other/content` },
    { ...receipt, attachmentId: "not-an-id" },
    { ...receipt, size: -1 },
    { ...receipt, inline: "true" },
    { name: "pending.txt", status: "uploading" },
    { name: "failed.txt", status: "error" },
    { ...receipt, status: "uploading" },
    { ...receipt, status: "error" },
  ])("does not restore an invalid or unusable receipt %#", (invalid) => {
    saveDraftAttachments(key, [invalid]);
    expect(loadDraftAttachments(key)).toEqual([]);
  });
  it("bounds count and raw record size without interpreting Markdown", () => {
    saveDraftAttachments(
      key,
      Array.from({ length: 21 }, () => receipt),
    );
    expect(loadDraftAttachments(key)).toEqual([]);
    localStorage.setItem(`${key}:attachments:v1`, "x".repeat(32_769));
    expect(loadDraftAttachments(key)).toEqual([]);
    saveDraft(key, `[unbound](${receipt.contentPath})`);
    expect(loadDraftAttachments(key)).toEqual([]);
  });
});
