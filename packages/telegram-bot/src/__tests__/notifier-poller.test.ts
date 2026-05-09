import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotifierApi } from "../notifier/api.js";
import { NotifierDedup } from "../notifier/dedup.js";
import { NotifierPoller, type TgSender } from "../notifier/poller.js";
import { ReplyStore } from "../state/reply-store.js";
import { mockFetch } from "./helpers.js";

const DINAR = "dinar-uuid";
const STRANGER = "stranger-uuid";
const CHAT = "55555";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "notifier-poller-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

type Sent = { chatId: string; text: string; messageId: number };

function setupSender(): { send: TgSender; sent: Sent[] } {
  const sent: Sent[] = [];
  let counter = 1000;
  const send: TgSender = async (chatId, text) => {
    counter += 1;
    sent.push({ chatId, text, messageId: counter });
    return { message_id: counter };
  };
  return { send, sent };
}

describe("NotifierPoller", () => {
  it("delivers all 4 event types on first tick, filtering non-Dinar items", async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.method === "GET" && req.url.includes("/issues") && req.url.includes("status=in_review")) {
        return {
          status: 200,
          body: [
            { id: "i-int", identifier: "THE-1", title: "Owned in_review", createdByUserId: DINAR },
            { id: "i-int-stranger", identifier: "THE-2", title: "Stranger in_review", createdByUserId: STRANGER },
          ],
        };
      }
      if (req.method === "GET" && req.url.includes("/issues") && req.url.includes("status=blocked")) {
        return {
          status: 200,
          body: [
            { id: "i-block", identifier: "THE-3", title: "Mine blocked", createdByUserId: DINAR, description: "unblock owner: Динар: запусти build" },
            { id: "i-block-stranger", identifier: "THE-4", title: "Foreign blocked", createdByUserId: STRANGER },
          ],
        };
      }
      if (req.method === "GET" && req.url.includes("/issues") && req.url.includes("status=done")) {
        return {
          status: 200,
          body: [
            { id: "i-done", identifier: "THE-5", title: "My done", createdByUserId: DINAR, assigneeAgentId: "agent-1" },
            { id: "i-done-stranger", identifier: "THE-6", title: "Other done", createdByUserId: STRANGER },
          ],
        };
      }
      if (req.method === "GET" && req.url.includes("/api/issues/i-int/interactions")) {
        return {
          status: 200,
          body: [
            {
              id: "x-1",
              issueId: "i-int",
              kind: "ask_user_questions",
              status: "pending",
              title: "Need answer",
              createdByAgentId: "agent-1",
            },
            {
              id: "x-2",
              issueId: "i-int",
              kind: "ask_user_questions",
              status: "accepted",
              title: "Already done",
            },
          ],
        };
      }
      if (req.method === "GET" && req.url.includes("/approvals")) {
        return {
          status: 200,
          body: [{ id: "ap-1", status: "pending", payload: { title: "Pay invoice", summary: "" } }],
        };
      }
      if (req.method === "GET" && req.url.includes("/api/agents/agent-1")) {
        return { status: 200, body: { id: "agent-1", displayName: "CTO" } };
      }
      if (req.method === "GET" && req.url.includes("/api/issues/i-done/comments")) {
        return { status: 200, body: [{ id: "c1", body: "shipped to prod" }] };
      }
      return { status: 200, body: [] };
    });

    const api = new NotifierApi({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: "co",
      fetchImpl,
    });
    const dedup = new NotifierDedup({ filePath: path.join(tmpDir, "seen.json") });
    const replyStore = new ReplyStore();
    const { send, sent } = setupSender();

    const poller = new NotifierPoller({
      api,
      dedup,
      replyStore,
      send,
      dinarUserId: DINAR,
      dinarChatId: CHAT,
      intervalMs: 60_000, // long; we don't start the timer
    });
    await dedup.load();
    const result = await poller.tick();

    expect(result.sent).toBe(4); // 1 interaction + 1 approval + 1 blocked + 1 done
    expect(sent.some((s) => s.text.startsWith("🔔"))).toBe(true);
    expect(sent.some((s) => s.text.startsWith("✋"))).toBe(true);
    expect(sent.some((s) => s.text.startsWith("🚧"))).toBe(true);
    expect(sent.some((s) => s.text.startsWith("✅"))).toBe(true);
    // Stranger items must NOT have been sent.
    expect(sent.find((s) => s.text.includes("THE-2"))).toBeUndefined();
    expect(sent.find((s) => s.text.includes("THE-4"))).toBeUndefined();
    expect(sent.find((s) => s.text.includes("THE-6"))).toBeUndefined();

    // ReplyStore should map every Telegram message id back to its issue.
    for (const s of sent) {
      const target = replyStore.lookup(CHAT, s.messageId);
      expect(target).toBeTruthy();
    }
    // Blocked rendering uses the description's unblock-owner action when available.
    const blockedMsg = sent.find((s) => s.text.startsWith("🚧"))!;
    expect(blockedMsg.text).toContain("Динар: запусти build");
    // Done rendering uses last comment + agent display name.
    const doneMsg = sent.find((s) => s.text.startsWith("✅"))!;
    expect(doneMsg.text).toContain("Ассигни: CTO");
    expect(doneMsg.text).toContain("shipped to prod");
  });

  it("does not re-deliver events on second tick (dedup)", async () => {
    let approvalsCalls = 0;
    const fetchImpl = mockFetch((req) => {
      if (req.method === "GET" && req.url.includes("/approvals")) {
        approvalsCalls += 1;
        return {
          status: 200,
          body: [{ id: "ap-1", status: "pending", payload: { title: "Repeat me" } }],
        };
      }
      return { status: 200, body: [] };
    });

    const api = new NotifierApi({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: "co",
      fetchImpl,
    });
    const dedup = new NotifierDedup({ filePath: path.join(tmpDir, "seen.json") });
    const replyStore = new ReplyStore();
    const { send, sent } = setupSender();

    const poller = new NotifierPoller({
      api,
      dedup,
      replyStore,
      send,
      dinarUserId: DINAR,
      dinarChatId: CHAT,
      intervalMs: 60_000,
    });

    await poller.tick();
    await poller.tick();

    expect(approvalsCalls).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it("persists dedup across restart (new poller instance does not resend)", async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.method === "GET" && req.url.includes("/approvals")) {
        return { status: 200, body: [{ id: "ap-1", status: "pending", payload: { title: "Once" } }] };
      }
      return { status: 200, body: [] };
    });
    const file = path.join(tmpDir, "restart.json");

    const api = new NotifierApi({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: "co",
      fetchImpl,
    });
    const replyStore = new ReplyStore();

    {
      const dedup = new NotifierDedup({ filePath: file });
      const { send, sent } = setupSender();
      const p = new NotifierPoller({
        api,
        dedup,
        replyStore,
        send,
        dinarUserId: DINAR,
        dinarChatId: CHAT,
        intervalMs: 60_000,
      });
      await p.tick();
      expect(sent).toHaveLength(1);
    }
    {
      const dedup2 = new NotifierDedup({ filePath: file });
      const { send, sent } = setupSender();
      const p2 = new NotifierPoller({
        api,
        dedup: dedup2,
        replyStore,
        send,
        dinarUserId: DINAR,
        dinarChatId: CHAT,
        intervalMs: 60_000,
      });
      await p2.tick();
      expect(sent).toHaveLength(0);
    }
  });

  it("retries Telegram send errors with backoff and gives up after maxAttempts", async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.method === "GET" && req.url.includes("/approvals")) {
        return { status: 200, body: [{ id: "ap-flaky", status: "pending", payload: { title: "Flaky" } }] };
      }
      return { status: 200, body: [] };
    });

    const api = new NotifierApi({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: "co",
      fetchImpl,
    });
    const dedup = new NotifierDedup({ filePath: path.join(tmpDir, "flaky.json") });
    const replyStore = new ReplyStore();

    let attempts = 0;
    const send: TgSender = async () => {
      attempts += 1;
      throw new Error("TG 429");
    };

    const poller = new NotifierPoller({
      api,
      dedup,
      replyStore,
      send,
      dinarUserId: DINAR,
      dinarChatId: CHAT,
      intervalMs: 60_000,
      maxSendAttempts: 3,
      baseSendBackoffMs: 1, // keep test fast
    });
    const result = await poller.tick();
    expect(attempts).toBe(3);
    expect(result.sent).toBe(0);
    expect(result.errors).toBeGreaterThan(0);
    // Failed delivery does NOT remember dedup, so a future successful tick still has a chance.
    expect(dedup.has("approval", "approval:ap-flaky")).toBe(false);
  });

  it("weekly_digest: forwards CEO digest comment from a routine_execution issue to dinarChatId", async () => {
    const ROUTINE = "9e2f3eea-routine";
    const RUN_ISSUE = "run-issue-id";
    const DIGEST_BODY = "# 📊 Weekly Board Digest — 2026-W19\n\nTop closed: THE-100";
    const fetchImpl = mockFetch((req) => {
      if (
        req.method === "GET" &&
        req.url.includes("/issues") &&
        req.url.includes("originKind=routine_execution")
      ) {
        return {
          status: 200,
          body: [
            {
              id: RUN_ISSUE,
              identifier: "THE-393",
              title: "CEO Weekly Board Digest",
              status: "in_review",
              originKind: "routine_execution",
              originId: ROUTINE,
            },
            // distractor: another routine's run-issue must NOT be picked up
            {
              id: "other",
              identifier: "THE-200",
              title: "CFO Daily Pulse",
              status: "done",
              originKind: "routine_execution",
              originId: "different-routine",
            },
          ],
        };
      }
      if (req.url.includes(`/api/issues/${RUN_ISSUE}/comments`)) {
        return { status: 200, body: [{ id: "comment-1", body: DIGEST_BODY }] };
      }
      return { status: 200, body: [] };
    });

    const api = new NotifierApi({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: "co",
      fetchImpl,
    });
    const dedup = new NotifierDedup({ filePath: path.join(tmpDir, "wd.json") });
    const replyStore = new ReplyStore();
    const { send, sent } = setupSender();

    const poller = new NotifierPoller({
      api,
      dedup,
      replyStore,
      send,
      dinarUserId: DINAR,
      dinarChatId: CHAT,
      intervalMs: 60_000,
      weeklyDigestRoutineId: ROUTINE,
    });
    const result = await poller.tick();
    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(CHAT);
    expect(sent[0].text).toContain("📊 Weekly Board Digest");
    expect(sent[0].text).toContain("Top closed: THE-100");
    expect(sent[0].text).toContain(
      "https://paperclip.thethirdchair.ru/THE/issues/THE-393",
    );
    // distractor must not appear
    expect(sent[0].text).not.toContain("CFO Daily Pulse");

    // Second tick — no re-delivery (dedup).
    await poller.tick();
    expect(sent).toHaveLength(1);
  });

  it("weekly_digest: skipped entirely when weeklyDigestRoutineId is unset", async () => {
    let routineCalls = 0;
    const fetchImpl = mockFetch((req) => {
      if (
        req.method === "GET" &&
        req.url.includes("/issues") &&
        req.url.includes("originKind=routine_execution")
      ) {
        routineCalls += 1;
        return { status: 200, body: [] };
      }
      return { status: 200, body: [] };
    });

    const api = new NotifierApi({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: "co",
      fetchImpl,
    });
    const dedup = new NotifierDedup({ filePath: path.join(tmpDir, "wd-disabled.json") });
    const replyStore = new ReplyStore();
    const { send } = setupSender();

    const poller = new NotifierPoller({
      api,
      dedup,
      replyStore,
      send,
      dinarUserId: DINAR,
      dinarChatId: CHAT,
      intervalMs: 60_000,
      // weeklyDigestRoutineId omitted on purpose
    });
    await poller.tick();
    expect(routineCalls).toBe(0);
  });

  it("weekly_digest: defers when routine_execution issue has no comment yet (dedup not poisoned)", async () => {
    const ROUTINE = "ceo-routine-empty";
    const RUN_ISSUE = "run-empty";
    const fetchImpl = mockFetch((req) => {
      if (
        req.method === "GET" &&
        req.url.includes("/issues") &&
        req.url.includes("originKind=routine_execution")
      ) {
        return {
          status: 200,
          body: [
            {
              id: RUN_ISSUE,
              identifier: "THE-999",
              title: "Pre-comment digest",
              status: "in_review",
              originKind: "routine_execution",
              originId: ROUTINE,
            },
          ],
        };
      }
      if (req.url.includes(`/api/issues/${RUN_ISSUE}/comments`)) {
        return { status: 200, body: [] };
      }
      return { status: 200, body: [] };
    });

    const api = new NotifierApi({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: "co",
      fetchImpl,
    });
    const dedup = new NotifierDedup({ filePath: path.join(tmpDir, "wd-defer.json") });
    const replyStore = new ReplyStore();
    const { send, sent } = setupSender();

    const poller = new NotifierPoller({
      api,
      dedup,
      replyStore,
      send,
      dinarUserId: DINAR,
      dinarChatId: CHAT,
      intervalMs: 60_000,
      weeklyDigestRoutineId: ROUTINE,
    });
    const result = await poller.tick();
    expect(sent).toHaveLength(0);
    expect(result.skipped).toBeGreaterThan(0);
    // Dedup must NOT have remembered this run-issue — next tick can still
    // deliver once the comment lands.
    expect(dedup.has("weekly_digest", `weekly_digest:${RUN_ISSUE}`)).toBe(false);
  });

  it("survives a Paperclip API outage on one event type without crashing the whole tick", async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.method === "GET" && req.url.includes("status=in_review")) {
        return { status: 500, body: { error: "boom" } };
      }
      if (req.method === "GET" && req.url.includes("/approvals")) {
        return { status: 200, body: [{ id: "ap-2", status: "pending", payload: { title: "Survived" } }] };
      }
      return { status: 200, body: [] };
    });

    const api = new NotifierApi({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: "co",
      fetchImpl,
    });
    const dedup = new NotifierDedup({ filePath: path.join(tmpDir, "outage.json") });
    const replyStore = new ReplyStore();
    const { send, sent } = setupSender();

    const poller = new NotifierPoller({
      api,
      dedup,
      replyStore,
      send,
      dinarUserId: DINAR,
      dinarChatId: CHAT,
      intervalMs: 60_000,
    });
    const result = await poller.tick();
    expect(result.errors).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Survived");
  });
});
