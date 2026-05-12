import { expect, test, describe } from "bun:test";
import { buildIssueRequest, postIssueAndWakeup } from "../src/index.js";
import type { InboundMessage, ChatToCompanyMapping } from "../src/types.js";

const mapping: ChatToCompanyMapping = {
  chatId: "5395944622",
  companyId: "personal-company-uuid",
  workspace: "personal",
  defaultAgent: "karl",
  requireMention: false,
};

describe("buildIssueRequest", () => {
  test("generates stable logical_task_id from chat + message", () => {
    const msg: InboundMessage = {
      chatId: "5395944622",
      messageId: 42,
      fromUserId: 12345,
      text: "what's on my calendar today?",
      receivedAt: "2026-04-29T10:00:00Z",
    };
    const req = buildIssueRequest(msg, mapping);
    expect(req.logicalTaskId).toBe("telegram:5395944622:42");
    expect(req.companyId).toBe("personal-company-uuid");
    expect(req.source).toBe("telegram");
  });

  test("two redeliveries of the same message get the same logical_task_id", () => {
    const msg: InboundMessage = {
      chatId: "5395944622",
      messageId: 42,
      fromUserId: 12345,
      text: "what's on my calendar today?",
      receivedAt: "2026-04-29T10:00:00Z",
    };
    const a = buildIssueRequest(msg, mapping);
    const b = buildIssueRequest(msg, mapping);
    expect(a.logicalTaskId).toBe(b.logicalTaskId);
  });

  test("title truncates at 80 chars with ellipsis", () => {
    const msg: InboundMessage = {
      chatId: "x",
      messageId: 1,
      fromUserId: 1,
      text: "a".repeat(120),
      receivedAt: "2026-04-29T10:00:00Z",
    };
    const req = buildIssueRequest(msg, mapping);
    expect(req.title.length).toBeLessThanOrEqual(85);
    expect(req.title.endsWith("...")).toBe(true);
  });

  test('voice-only message gets "[voice message]" title', () => {
    const msg: InboundMessage = {
      chatId: "x",
      messageId: 2,
      fromUserId: 1,
      voiceFileId: "AwACAgIAxxx",
      receivedAt: "2026-04-29T10:00:00Z",
    };
    const req = buildIssueRequest(msg, mapping);
    expect(req.title).toBe("[voice message]");
  });
});

describe("postIssueAndWakeup dispatch budget", () => {
  test("blocks before issue creation when logical task budget is exhausted", async () => {
    const req = buildIssueRequest(
      {
        chatId: "5395944622",
        messageId: 99,
        fromUserId: 12345,
        text: "retrying failing task",
        receivedAt: "2026-04-29T10:00:00Z",
      },
      mapping,
    );

    const budget = {
      attemptOrBlock() {
        return { used: 3, remaining: 0, blocked: true };
      },
    } as any;

    let createCalled = false;
    const client = {
      async createIssue() {
        createCalled = true;
        return { id: "issue-1" };
      },
      async wakeAgent() {},
    } as any;

    await expect(postIssueAndWakeup(req, client, budget)).rejects.toThrow("dispatch budget exhausted");
    expect(createCalled).toBe(false);
  });

  test("records the Paperclip issue as a claimed attempt after successful create", async () => {
    const req = buildIssueRequest(
      {
        chatId: "5395944622",
        messageId: 100,
        fromUserId: 12345,
        text: "new task",
        receivedAt: "2026-04-29T10:00:00Z",
      },
      mapping,
    );

    const recorded: unknown[] = [];
    const completed: unknown[] = [];
    const budget = {
      attemptOrBlock() {
        return { used: 1, remaining: 2, blocked: false };
      },
      markCompleted(...args: unknown[]) {
        completed.push(args);
      },
      recordAttempt(row: unknown) {
        recorded.push(row);
      },
    } as any;

    const createIssueCalls: unknown[] = [];
    const client = {
      async createIssue(_companyId: string, body: unknown) {
        createIssueCalls.push(body);
        return { id: "issue-100" };
      },
      async wakeAgent() {},
    } as any;

    await expect(postIssueAndWakeup(req, client, budget)).resolves.toBe("issue-100");
    expect(createIssueCalls).toEqual([
      expect.objectContaining({
        originFingerprint: "telegram:5395944622:100",
      }),
    ]);
    expect(completed).toEqual([["telegram:5395944622:100", "telegram:100"]]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      logicalTaskId: "telegram:5395944622:100",
      source: "telegram",
      paperclipRunId: "issue-100",
      outcome: "claimed",
    });
  });
});
