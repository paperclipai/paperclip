// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDraft,
  loadDraft,
  loadDraftRecoveryKey,
  preserveDraftInTab,
  loadDraftAttachments,
  saveDraft,
  saveDraftAttachments,
  loadDraftSubmission,
  saveDraftSubmission,
  clearDraftSubmission,
  settleDraftSubmission,
  replayableRequest,
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
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
  it("persists a tab recovery without touching shared text, receipts, or pending submission", () => {
    sessionStorage.clear();
    saveDraft(key, "Other tab text");
    saveDraftAttachments(key, [receipt]);
    saveDraftSubmission(key, { attemptId: id, reviewed: false });
    const fork = preserveDraftInTab(key, "This tab text", [receipt]);
    expect(fork.persisted).toBe(true);
    expect(loadDraftRecoveryKey(key)).toBe(fork.key);
    expect(loadDraft(fork.key)).toBe("This tab text");
    expect(loadDraftAttachments(fork.key)).toEqual([receipt]);
    expect(loadDraftSubmission(fork.key)).toBeNull();
    expect(loadDraft(key)).toBe("Other tab text");
    expect(loadDraftAttachments(key)).toEqual([receipt]);
    expect(loadDraftSubmission(key)?.attemptId).toBe(id);
    clearDraft(fork.key);
    expect(loadDraft(fork.key)).toBe("");
    expect(loadDraft(key)).toBe("Other tab text");
    expect(loadDraftSubmission(key)?.attemptId).toBe(id);
  });

  it("retires a finished recovery but keeps or restores its mapping for unsent work", () => {
    sessionStorage.clear();
    saveDraft(key, "Shared draft stays available");
    const fork = preserveDraftInTab(key, "Recovered message", []);
    saveDraftSubmission(fork.key, { attemptId: id, reviewed: false });
    expect(settleDraftSubmission(fork.key, id)).toBe(true);
    expect(loadDraftRecoveryKey(key)).toBeNull();
    expect(loadDraft(key)).toBe("Shared draft stays available");

    saveDraft(fork.key, "Next recovered draft");
    expect(loadDraftRecoveryKey(key)).toBe(fork.key);
    saveDraftSubmission(fork.key, { attemptId: id, reviewed: false, nextDraftOffset: 0, submittedAttachmentIds: [] });
    expect(settleDraftSubmission(fork.key, id)).toBe(true);
    expect(loadDraftRecoveryKey(key)).toBe(fork.key);
    expect(loadDraft(fork.key)).toBe("Next recovered draft");
    clearDraft(fork.key);
    expect(loadDraftRecoveryKey(key)).toBeNull();
    saveDraftAttachments(fork.key, [receipt]);
    expect(loadDraftRecoveryKey(key)).toBe(fork.key);
    expect(loadDraftAttachments(fork.key)).toEqual([receipt]);
  });

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
  it.each([
    { label: "long task comment", draftKey: key, body: "a".repeat(300_000) },
    { label: "escaped task comment", draftKey: key, body: "\n".repeat(150_000) },
    { label: "long chat comment", draftKey: "paperclip:agent-chat-draft:large", body: "a".repeat(300_000) },
    { label: "escaped chat comment", draftKey: "paperclip:agent-chat-draft:large", body: "\n".repeat(150_000) },
  ])("restores a large accepted request with its original key ($label)", ({ draftKey, body }) => {
    const request = { body };
    saveDraftSubmission(draftKey, { attemptId: id, reviewed: false, request, requestOwner: "user-1" });
    const loaded = loadDraftSubmission(draftKey);
    expect(loaded?.attemptId).toBe(id);
    expect(loaded?.request?.body === body).toBe(true);
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

describe("replayable comment requests", () => {
  const key = "paperclip:issue-comment-draft:task-two";
  const id = "1c6ad4b0-7f55-4c1e-9d6a-2a3d2b1f4e10";
  beforeEach(() => localStorage.clear());

  it("replays a retained request only for the account that made it", () => {
    saveDraft(key, "Sent during the outage");
    saveDraftSubmission(key, { attemptId: id, reviewed: false, request: { body: "Sent during the outage" }, requestOwner: "user-1" });
    const stored = loadDraftSubmission(key);
    expect(stored?.requestOwner).toBe("user-1");
    expect(replayableRequest(stored, "user-1")).toEqual({ body: "Sent during the outage" });
    expect(replayableRequest(stored, "user-2")).toBeUndefined();
    expect(replayableRequest(stored, undefined)).toBeUndefined();
  });

  it.each([
    { reassignment: { assigneeAgentId: "old-agent", assigneeUserId: null } },
    { runSettings: { model: "old-model" } },
    { reopen: true },
  ])("does not replay a composite mutation that can overwrite newer task changes: %j", (changes) => {
    saveDraftSubmission(key, { attemptId: id, reviewed: false, request: { body: "Keep the comment", ...changes }, requestOwner: "user-1" });
    expect(replayableRequest(loadDraftSubmission(key), "user-1")).toBeUndefined();
    expect(loadDraftSubmission(key)?.request?.body).toBe("Keep the comment");
  });

  it("never replays a request with no recorded account", () => {
    saveDraft(key, "Older record");
    saveDraftSubmission(key, { attemptId: id, reviewed: false, request: { body: "Older record" } });
    expect(replayableRequest(loadDraftSubmission(key), "user-1")).toBeUndefined();
  });
});
