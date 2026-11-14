import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildPaperclipWakePayload } from "./run-preparation.js";

const COMPANY = "company-1";
const ISSUE = "issue-1";

type WakeComment = NonNullable<
  Parameters<typeof buildPaperclipWakePayload>[0]["wakeCommentRows"]
>[number];

type StoredAttachment = {
  id: string;
  issueCommentId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAtMs: number;
};

let attachments: StoredAttachment[] = [];
let countQueries = 0;

function chunkText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(chunkText).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as { queryChunks?: unknown; value?: unknown };
  if (record.queryChunks !== undefined) return chunkText(record.queryChunks);
  if (record.value !== undefined) return chunkText(record.value);
  return "";
}

function createDb(): Db {
  return {
    select(shape?: Record<string, unknown>) {
      const isCount = Boolean(shape && Object.prototype.hasOwnProperty.call(shape, "count"));
      let limited = false;
      let descending = false;
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.from = self;
      chain.innerJoin = self;
      chain.leftJoin = self;
      chain.where = self;
      chain.groupBy = self;
      chain.orderBy = (...args: unknown[]) => {
        descending = args.some((arg) => chunkText(arg).toLowerCase().includes("desc"));
        return chain;
      };
      chain.limit = () => {
        limited = true;
        return chain;
      };
      chain.then = (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        let rows: unknown[];
        if (limited) {
          const sorted = [...attachments].sort((left, right) => {
            const byTime = left.createdAtMs - right.createdAtMs;
            const byId = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
            const compared = byTime || byId;
            return descending ? -compared : compared;
          });
          rows = sorted.slice(0, 21).map(({ createdAtMs: _createdAtMs, ...row }) => row);
        } else if (isCount) {
          countQueries += 1;
          rows = [{ count: attachments.length }];
        } else {
          rows = [];
        }
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      };
      return chain;
    },
  } as unknown as Db;
}

function comment(id: string, body: string, createdAt: string): WakeComment {
  return {
    id,
    companyId: COMPANY,
    issueId: ISSUE,
    body,
    origin: "comment",
    authorType: "user",
    authorAgentId: null,
    authorUserId: "user-1",
    presentation: null,
    metadata: null,
    deletedAt: null,
    deletedByType: null,
    deletedByAgentId: null,
    deletedByUserId: null,
    deletedByRunId: null,
    sourceTrust: null,
    createdAt: new Date(createdAt),
  };
}

function commentsFor(ids: string[], bodyFor: (id: string) => string) {
  return ids.map((id, index) =>
    comment(id, bodyFor(id), `2026-11-01T00:${String(index).padStart(2, "0")}:00.000Z`),
  );
}

async function wake(ids: string[], rows: WakeComment[]) {
  countQueries = 0;
  return buildPaperclipWakePayload({
    db: createDb(),
    companyId: COMPANY,
    issueSummary: {
      id: ISSUE,
      identifier: "PAP-19198",
      title: "Wake window",
      description: "Short brief",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
    },
    wakeCommentRows: rows,
    contextSnapshot: {
      issueId: ISSUE,
      wakeReason: "issue_commented",
      wakeCommentIds: ids,
    },
  });
}

function commentIds(payload: Awaited<ReturnType<typeof wake>>) {
  return (payload?.comments ?? []).map((entry) => entry.id);
}

function attachmentIds(value: unknown): string[] {
  expect(Array.isArray(value)).toBe(true);
  return (value as { id: string }[]).map((entry) => entry.id);
}

describe("wake comment window", () => {
  it("keeps a short batch in arrival order and does not mention a cut", async () => {
    attachments = [];
    const ids = ["c1", "c2", "c3"];
    const payload = await wake(ids, commentsFor(ids, (id) => `body ${id}`));
    expect(commentIds(payload)).toEqual(ids);
    expect(payload?.latestCommentId).toBe("c3");
    expect(payload?.commentWindow).toMatchObject({
      requestedCount: 3,
      includedCount: 3,
      missingCount: 0,
      cutCount: 0,
      cutCommentIds: [],
      cutAttachmentCount: 0,
    });
    expect(payload?.truncated).toBe(false);
    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain("- pending comments: 3/3");
    expect(prompt).toContain("- latest comment id: c3");
    expect(prompt).toContain("1. comment c1");
    expect(prompt).toContain("3. comment c3");
    expect(prompt).not.toContain("cut comments");
    expect(prompt).not.toContain("cut attachments");
    expect(countQueries).toBe(0);
  });

  it("keeps the newest eight comments and names the oldest comments that were cut", async () => {
    attachments = [];
    const ids = Array.from({ length: 11 }, (_, index) => `c${index + 1}`);
    const payload = await wake(ids, commentsFor(ids, (id) => `body ${id}`));
    expect(commentIds(payload)).toEqual(["c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11"]);
    expect(payload?.latestCommentId).toBe("c11");
    expect(payload?.commentWindow).toEqual({
      requestedCount: 11,
      includedCount: 8,
      missingCount: 0,
      cutCount: 3,
      cutCommentIds: ["c1", "c2", "c3"],
      cutAttachmentCount: 0,
    });
    expect(payload?.fallbackFetchNeeded).toBe(true);
    const prompt = renderPaperclipWakePrompt(payload);
    const latestAt = prompt.indexOf("- latest comment id: c11");
    const cutAt = prompt.indexOf(
      "- cut comments: the oldest 3 of 11 are not in this wake; read them with GET /api/issues/issue-1/comments (cut ids: c1, c2, c3)",
    );
    const fallbackAt = prompt.indexOf("- fallback fetch needed: yes");
    expect(latestAt).toBeGreaterThan(-1);
    expect(cutAt).toBeGreaterThan(latestAt);
    expect(fallbackAt).toBeGreaterThan(cutAt);
    expect(prompt).toContain("1. comment c4");
    expect(prompt).toContain("8. comment c11");
    expect(prompt).not.toMatch(/^1\. comment c1 /m);
  });

  it("names read_current_wake_comments for a native external-chat cut and keeps the thread GET otherwise", async () => {
    attachments = [];
    const ids = Array.from({ length: 11 }, (_, index) => `c${index + 1}`);
    const payload = await wake(ids, commentsFor(ids, (id) => `body ${id}`));
    const chatWake = {
      ...payload,
      externalChatProvider: "github",
      checkedOutByHarness: true,
    };
    const generic = renderPaperclipWakePrompt(chatWake);
    expect(generic).toContain(
      "- cut comments: the oldest 3 of 11 are not in this wake; read them with GET /api/issues/issue-1/comments (cut ids: c1, c2, c3)",
    );
    expect(generic).not.toContain("read_current_wake_comments");

    for (const resumedSession of [false, true]) {
      const prompt = renderPaperclipWakePrompt(chatWake, {
        nativeWakeReaderAvailable: true,
        resumedSession,
      });
      expect(prompt).toContain("call `read_current_wake_comments` without a cursor");
      expect(prompt).toContain("Make zero other Paperclip API calls");
      expect(prompt).toContain(
        "- cut comments: the oldest 3 of 11 are not in this wake; read them with `read_current_wake_comments` (cut ids: c1, c2, c3)",
      );
      expect(prompt).not.toContain("GET /api/issues/");
    }
  });

  it("keeps the newest comments when early long bodies would spend the 12000-character budget", async () => {
    attachments = [];
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    const payload = await wake(ids, commentsFor(ids, () => "x".repeat(4_000)));
    expect(commentIds(payload)).toEqual(["c3", "c4", "c5"]);
    expect(payload?.comments?.map((entry) => String(entry.body).length)).toEqual([4_000, 4_000, 4_000]);
    expect(payload?.comments?.every((entry) => entry.bodyTruncated === false)).toBe(true);
    expect(payload?.commentWindow).toMatchObject({
      requestedCount: 5,
      includedCount: 3,
      missingCount: 0,
      cutCount: 2,
      cutCommentIds: ["c1", "c2"],
    });
    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain(
      "- cut comments: the oldest 2 of 5 are not in this wake; read them with GET /api/issues/issue-1/comments (cut ids: c1, c2)",
    );
    expect(prompt).toContain("1. comment c3");
    expect(prompt).toContain("3. comment c5");
    expect(prompt).not.toContain("[comment body truncated]");
  });

  it("truncates one long comment body without calling that comment a cut", async () => {
    attachments = [];
    const payload = await wake(["c1"], commentsFor(["c1"], () => "y".repeat(5_000)));
    expect(commentIds(payload)).toEqual(["c1"]);
    expect(payload?.comments?.[0]).toMatchObject({ bodyTruncated: true });
    expect(String(payload?.comments?.[0]?.body)).toHaveLength(4_000);
    expect(payload?.commentWindow).toMatchObject({ cutCount: 0, cutCommentIds: [], includedCount: 1 });
    expect(renderPaperclipWakePrompt(payload)).not.toContain("cut comments");
  });

  it("keeps the newest twenty attachments and counts the older ones only after a cut", async () => {
    const stored = Array.from({ length: 21 }, (_, index) => {
      const number = index + 1;
      return {
        id: `a${String(number).padStart(2, "0")}`,
        issueCommentId: "c1",
        filename: `file-${number}.txt`,
        contentType: "text/plain",
        byteSize: 12,
        createdAtMs: Date.UTC(2026, 0, number),
      };
    });
    attachments = stored.slice(0, 2);
    const short = await wake(["c1"], commentsFor(["c1"], () => "body"));
    expect(countQueries).toBe(0);
    expect(attachmentIds(short?.comments?.[0]?.attachments)).toEqual(["a01", "a02"]);
    expect(renderPaperclipWakePrompt(short)).not.toContain("cut attachments");

    attachments = stored;
    const payload = await wake(["c1"], commentsFor(["c1"], () => "body"));
    expect(countQueries).toBe(1);
    const kept = attachmentIds(payload?.comments?.[0]?.attachments);
    expect(kept).toEqual(stored.slice(1).map((entry) => entry.id));
    expect(payload?.commentWindow).toMatchObject({ cutAttachmentCount: 1, cutCount: 0 });
    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain("- cut attachments: the oldest 1 are not in this wake");
    expect(prompt.indexOf("- latest comment id:")).toBeLessThan(prompt.indexOf("- cut attachments:"));
    expect(prompt.indexOf("- cut attachments:")).toBeLessThan(prompt.indexOf("- fallback fetch needed:"));
  });

  it("lists at most twenty cut comment ids and still reports the full cut count", async () => {
    attachments = [];
    const ids = Array.from({ length: 30 }, (_, index) => `c${index + 1}`);
    const payload = await wake(ids, commentsFor(ids, (id) => `body ${id}`));
    expect(commentIds(payload)).toEqual(ids.slice(22));
    expect(payload?.commentWindow).toMatchObject({
      requestedCount: 30,
      includedCount: 8,
      cutCount: 22,
      cutCommentIds: ids.slice(0, 20),
    });
    expect(renderPaperclipWakePrompt(payload)).toContain(
      `- cut comments: the oldest 22 of 30 are not in this wake; read them with GET /api/issues/issue-1/comments (cut ids: ${ids.slice(0, 20).join(", ")}, ...)`,
    );
  });
});
