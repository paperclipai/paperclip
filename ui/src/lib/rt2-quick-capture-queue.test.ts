import { describe, expect, it } from "vitest";
import {
  RT2_QUICK_CAPTURE_MAX_ITEMS,
  RT2_QUICK_CAPTURE_MAX_TEXT_LENGTH,
  enqueueRt2QuickCaptureItem,
  listRt2QuickCaptureQueue,
  markRt2QuickCaptureFailed,
  markRt2QuickCaptureSending,
  markRt2QuickCaptureSent,
  removeRt2QuickCaptureItem,
  rt2QuickCaptureQueueStorageKey,
  type Rt2QuickCaptureQueueStorage,
} from "./rt2-quick-capture-queue";

function createMemoryStorage(): Rt2QuickCaptureQueueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe("rt2 quick capture queue", () => {
  it("round-trips a valid per-company queued capture", () => {
    const storage = createMemoryStorage();
    const { item } = enqueueRt2QuickCaptureItem(storage, {
      id: "qc-1",
      companyId: "company-1",
      projectId: "project-1",
      text: "고객 제안서 정리",
      now: new Date("2026-04-30T00:00:00.000Z"),
    });

    expect(item).toEqual(expect.objectContaining({
      id: "qc-1",
      companyId: "company-1",
      projectId: "project-1",
      source: "mobile",
      channel: "quick-capture:project-1",
      status: "queued",
    }));
    expect(listRt2QuickCaptureQueue(storage, "company-1")).toEqual([item]);
    expect(listRt2QuickCaptureQueue(storage, "company-2")).toEqual([]);
  });

  it("recovers from corrupt storage by clearing the bad queue", () => {
    const storage = createMemoryStorage();
    const key = rt2QuickCaptureQueueStorageKey("company-1");
    storage.setItem(key, "{not-json");

    expect(listRt2QuickCaptureQueue(storage, "company-1")).toEqual([]);
    expect(storage.getItem(key)).toBeNull();
  });

  it("bounds queue size and text length", () => {
    const storage = createMemoryStorage();
    const longText = "가".repeat(RT2_QUICK_CAPTURE_MAX_TEXT_LENGTH + 25);

    for (let index = 0; index < RT2_QUICK_CAPTURE_MAX_ITEMS + 5; index += 1) {
      enqueueRt2QuickCaptureItem(storage, {
        id: `qc-${index}`,
        companyId: "company-1",
        projectId: "project-1",
        text: index === 0 ? longText : `업무 기록 ${index}`,
        now: new Date(Date.UTC(2026, 3, 30, 0, index, 0)),
      });
    }

    const queue = listRt2QuickCaptureQueue(storage, "company-1");
    expect(queue).toHaveLength(RT2_QUICK_CAPTURE_MAX_ITEMS);
    expect(queue[0]?.id).toBe(`qc-${RT2_QUICK_CAPTURE_MAX_ITEMS + 4}`);
    expect(queue.some((item) => item.text.length > RT2_QUICK_CAPTURE_MAX_TEXT_LENGTH)).toBe(false);
  });

  it("persists sending, failed, sent, and remove transitions", () => {
    const storage = createMemoryStorage();
    enqueueRt2QuickCaptureItem(storage, {
      id: "qc-1",
      companyId: "company-1",
      projectId: "project-1",
      text: "전송 상태 확인",
      now: new Date("2026-04-30T00:00:00.000Z"),
    });

    markRt2QuickCaptureSending(storage, "company-1", "qc-1", new Date("2026-04-30T00:01:00.000Z"));
    expect(listRt2QuickCaptureQueue(storage, "company-1")[0]).toEqual(expect.objectContaining({
      status: "sending",
      lastAttemptedAt: "2026-04-30T00:01:00.000Z",
      lastError: null,
    }));

    markRt2QuickCaptureFailed(storage, "company-1", "qc-1", "네트워크 오류", new Date("2026-04-30T00:02:00.000Z"));
    expect(listRt2QuickCaptureQueue(storage, "company-1")[0]).toEqual(expect.objectContaining({
      status: "failed",
      lastError: "네트워크 오류",
    }));

    markRt2QuickCaptureSent(
      storage,
      "company-1",
      "qc-1",
      { draftId: "draft-1", draftStatus: "review_required" },
      new Date("2026-04-30T00:03:00.000Z"),
    );
    expect(listRt2QuickCaptureQueue(storage, "company-1")[0]).toEqual(expect.objectContaining({
      status: "sent",
      sentDraftId: "draft-1",
      sentDraftStatus: "review_required",
      lastError: null,
    }));

    expect(removeRt2QuickCaptureItem(storage, "company-1", "qc-1")).toEqual([]);
  });

  it("normalizes persisted entries and drops auth/session/secret fields", () => {
    const storage = createMemoryStorage();
    const key = rt2QuickCaptureQueueStorageKey("company-1");
    storage.setItem(key, JSON.stringify([
      {
        id: "qc-1",
        companyId: "company-1",
        projectId: "project-1",
        source: "mobile",
        channel: "quick-capture:project-1",
        text: "보안 필드 제외",
        status: "queued",
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z",
        authToken: "token",
        cookie: "session",
        signingSecret: "secret",
        session: { id: "session-1" },
      },
    ]));

    const queue = listRt2QuickCaptureQueue(storage, "company-1");
    expect(queue).toHaveLength(1);
    expect(JSON.stringify(queue[0])).not.toContain("token");
    expect(JSON.stringify(queue[0])).not.toContain("session-1");
    expect(JSON.stringify(queue[0])).not.toContain("secret");
  });
});
