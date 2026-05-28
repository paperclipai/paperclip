import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  detectClickUpAwaitingHumanBridgeEvents,
  getClickUpChatMessageReactions,
  getClickUpChatMessageReplies,
  resolveAwaitingHumanReviewFile,
  sendAwaitingHumanNotification,
} from "../services/awaiting-human-notifications.js";

const originalFetch = globalThis.fetch;

function dbWithExecuteResults(results: unknown[][]): Db {
  const queue = [...results];
  return {
    execute: vi.fn(async () => queue.shift() ?? []),
  } as unknown as Db;
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  delete process.env.CLICKUP_PERSONAL_TOKEN;
  delete process.env.CLICKUP_WORKSPACE_ID;
  delete process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID;
  delete process.env.CLICKUP_ENGINEERING_CHANNEL_ID;
  delete process.env.CLICKUP_AWAITING_HUMAN_REVIEW_LIST_ID;
  delete process.env.CLICKUP_APPROVAL_POSITIVE_REACTIONS;
  delete process.env.CLICKUP_APPROVAL_POSITIVE_REPLY_KEYWORDS;
});

describe.skip("sendAwaitingHumanNotification", () => {
  it("posts the handoff to the configured ClickUp approval chat channel", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-9";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "message-42" } }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "BIZ-35 is waiting on human input",
        summary: "Approve the exact GitHub reply before posting.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Open BIZ-35 in Bizbox and respond there.",
        labels: ["awaiting_human", "request_confirmation"],
      },
    });

    expect(result).toEqual({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "message-42",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/channels/channel-9/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "token-123",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: "message",
      content_format: "text/md",
      content: expect.stringContaining("Open in Bizbox: https://bizbox.example/issues/BIZ-35"),
    });
    const rendered = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).content as string;
    expect(rendered).not.toContain("not approved");
    expect(rendered).not.toContain("Context:");
    expect(rendered).not.toContain("Labels:");
    expect(rendered).not.toContain("Could you take a quick look and respond here in ClickUp?");
    expect(rendered).not.toContain("To approve: react with");
    expect(rendered).not.toContain("If you want changes or have questions: reply here with what you'd like changed, added, or clarified");
  });

  it("uses explicit ClickUp transport overrides for token, workspace, and channel id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { id: "message-override" } }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "Awaiting approval",
        summary: "Please review.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Reply in Bizbox.",
        labels: ["awaiting_human"],
      },
    }, {
      personalToken: "token-company",
      workspaceId: "90161423646",
      channelId: "2kz0m98y-48696",
    });

    expect(result.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v3/workspaces/90161423646/chat/channels/2kz0m98y-48696/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "token-company",
        }),
      }),
    );
  });

  it("includes the Bizbox deliverable and ClickUp review task when a review file is present", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-9";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "message-42" } }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "BIZ-35 is waiting on human input",
        summary: "Please review the attached final report.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Open BIZ-35 in Bizbox and respond there.",
        labels: ["awaiting_human", "request_confirmation"],
        reviewFile: {
          source: "artifact",
          deliverableId: "33333333-3333-4333-8333-333333333333",
          title: "Final report",
          filename: "final-report.md",
          contentType: "text/markdown",
          byteSize: 42,
          contentPath: "/api/attachments/33333333-3333-4333-8333-333333333333/content",
          deliverableUrl: "https://bizbox.example/api/attachments/33333333-3333-4333-8333-333333333333/content",
          clickupTaskUrl: "https://app.clickup.com/t/task-123",
          clickupAttachmentId: "attachment-123",
        },
      },
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content).toContain("Review file: final-report.md");
    expect(body.content).toContain("Bizbox deliverable: https://bizbox.example/api/attachments/33333333-3333-4333-8333-333333333333/content");
    expect(body.content).toContain("ClickUp review task: https://app.clickup.com/t/task-123");
    expect(body.content).toContain("Review file attached on the ClickUp task.");
    expect(body.content).toContain("Open in Bizbox: https://bizbox.example/issues/BIZ-35");
  });

  it("skips delivery when ClickUp chat credentials are missing", async () => {
    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "ask_user_questions",
      notification: {
        title: "BIZ-35 is waiting on human input",
        summary: "Need answers to 2 question(s).",
        link: "/issues/BIZ-35",
        cta: "Open BIZ-35 in Bizbox and respond there.",
        labels: ["awaiting_human", "ask_user_questions"],
      },
    });

    expect(result).toEqual({
      status: "skipped",
      channel: "clickup-chat",
      detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
    });
  });

  it("prefers the new approval channel env vars over the legacy engineering vars", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID = "channel-new";
    process.env.CLICKUP_ENGINEERING_CHANNEL_ID = "channel-legacy";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "message-45" } }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "BIZ-35 is waiting on human input",
        summary: "Approve the exact GitHub reply before posting.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Open BIZ-35 in Bizbox and respond there.",
        labels: ["awaiting_human", "request_confirmation"],
      },
    });

    expect(result.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/channels/channel-new/messages",
      expect.any(Object),
    );
  });

  it("falls back to the legacy engineering env vars when the new approval vars are unset", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_ENGINEERING_CHANNEL_ID = "channel-legacy";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "message-46" } }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "BIZ-35 is waiting on human input",
        summary: "Approve the exact GitHub reply before posting.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Open BIZ-35 in Bizbox and respond there.",
        labels: ["awaiting_human", "request_confirmation"],
      },
    });

    expect(result.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/channels/channel-legacy/messages",
      expect.any(Object),
    );
  });

  it("skips delivery when no deterministic ClickUp channel id is configured", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "ask_user_questions",
      notification: {
        title: "BIZ-35 is waiting on human input",
        summary: "Need answers to 2 question(s).",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Open BIZ-35 in Bizbox and respond there.",
        labels: ["awaiting_human", "ask_user_questions"],
      },
    });

    expect(result).toEqual({
      status: "skipped",
      channel: "clickup-chat",
      detail: "missing-target: CLICKUP_AWAITING_HUMAN_CHANNEL_ID (or CLICKUP_ENGINEERING_CHANNEL_ID)",
    });
  });

  it("retrieves ClickUp message replies for approval polling", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "reply-1", content: "Ship it" },
          { id: "reply-2", message: "Approved" },
        ],
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await getClickUpChatMessageReplies("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "ok",
      replies: [
        { id: "reply-1", messageId: null, reactionsUrl: null, content: "Ship it" },
        { id: "reply-2", messageId: null, reactionsUrl: null, content: "Approved" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/message-42/replies",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "token-123",
        }),
      }),
    );
  });

  it("retrieves ClickUp message reactions for approval polling", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { reaction: "thumbsup", count: 2 },
          { emoji: { name: "eyes" }, users: [{ id: "u1" }] },
        ],
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await getClickUpChatMessageReactions("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "ok",
      reactions: [
        { name: "thumbsup", count: 2 },
        { name: "eyes", count: 1 },
      ],
    });
  });

  it("emits an approval signal for a positive reply before checking reactions", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: "reply-1", content: "yes" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ reaction: "thumbsup", count: 1 }] }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEvents("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "positive-reply-detected",
      events: [{
        kind: "approval_signal",
        externalEventId: "reply:reply-1:approval",
        externalMessageId: "message-42",
        body: "yes",
        metadata: {
          resolutionSource: "clickup_reply",
          clickupReplyId: "reply-1",
        },
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("emits a rejection signal for explicit rejection replies", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: "reply-1", content: "No, please revise this" },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEvents("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "negative-reply-detected",
      events: [{
        kind: "reject_signal",
        externalEventId: "reply:reply-1:rejection",
        externalMessageId: "message-42",
        body: "No, please revise this",
        metadata: {
          resolutionSource: "clickup_reply",
          clickupReplyId: "reply-1",
        },
      }],
    });
  });

  it("emits plain reply events for non-terminal feedback replies", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: "reply-1", content: "Please revise the title." },
            { id: "reply-2", content: "Also add the rollback note." },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEvents("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "non-approval-reply-detected",
      events: [
        {
          kind: "reply",
          externalEventId: "reply-1",
          externalMessageId: "message-42",
          body: "Please revise the title.",
          metadata: { clickupReplyId: "reply-1" },
        },
        {
          kind: "reply",
          externalEventId: "reply-2",
          externalMessageId: "message-42",
          body: "Also add the rollback note.",
          metadata: { clickupReplyId: "reply-2" },
        },
      ],
    });
  });

  it("emits an approval signal for configured positive reactions", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";
    process.env.CLICKUP_APPROVAL_POSITIVE_REACTIONS = "white_check_mark";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "reply-1", content: "Please clarify the final step." }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ reaction: "white_check_mark", count: 1 }],
        }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEvents("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "positive-reaction-detected",
      events: [{
        kind: "approval_signal",
        externalEventId: "reaction:white_check_mark",
        externalMessageId: "message-42",
        body: null,
        metadata: {
          resolutionSource: "clickup_reaction",
          clickupReaction: "white_check_mark",
        },
      }],
    });
  });

  it("returns no events for neutral or noisy reactions", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { reaction: "eyes", count: 2 },
            { reaction: "thumbsdown", count: 1 },
          ],
        }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEvents("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "no-approval-signal",
      events: [],
    });
  });
});

describe.skip("resolveAwaitingHumanReviewFile", () => {
  it("prefers a human artifact deliverable", async () => {
    const db = dbWithExecuteResults([[
      {
        deliverable_id: "33333333-3333-4333-8333-333333333333",
        title: "Final report",
        content_path: "/api/attachments/33333333-3333-4333-8333-333333333333/content",
        content_type: "text/markdown",
        byte_size: 42,
        original_filename: "final-report.md",
        attachment_id: "33333333-3333-4333-8333-333333333333",
        object_key: "companies/company-1/issues/issue-1/final-report.md",
        sha256: "abc123",
      },
    ]]);

    const file = await resolveAwaitingHumanReviewFile(db, {
      companyId: "company-1",
      issueId: "issue-1",
      sourceLink: "https://bizbox.example/issues/BIZ-35",
    });

    expect(file).toMatchObject({
      source: "artifact",
      filename: "final-report.md",
      deliverableUrl: "https://bizbox.example/api/attachments/33333333-3333-4333-8333-333333333333/content",
      objectKey: "companies/company-1/issues/issue-1/final-report.md",
      sha256: "abc123",
    });
  });

  it("falls back to a human deliverable document", async () => {
    const db = dbWithExecuteResults([
      [],
      [{
        deliverable_id: "44444444-4444-4444-8444-444444444444",
        key: "review-notes",
        title: "Review notes",
        format: "markdown",
        body: "# Review notes",
        byte_size: 12,
      }],
    ]);

    const file = await resolveAwaitingHumanReviewFile(db, {
      companyId: "company-1",
      issueId: "issue-1",
      sourceLink: "https://bizbox.example/issues/BIZ-35",
    });

    expect(file).toMatchObject({
      source: "document",
      filename: "review-notes.md",
      contentType: "text/markdown; charset=utf-8",
      deliverableUrl: "https://bizbox.example/api/deliverables/44444444-4444-4444-8444-444444444444/content",
    });
  });

  it("uses the markdown H1 for human deliverable document filenames when the stored title is null", async () => {
    const db = dbWithExecuteResults([
      [],
      [{
        deliverable_id: "55555555-5555-4555-8555-555555555555",
        key: "deliverable",
        title: null,
        format: "markdown",
        body: "# Review Packet",
        byte_size: 14,
      }],
    ]);

    const file = await resolveAwaitingHumanReviewFile(db, {
      companyId: "company-1",
      issueId: "issue-1",
      sourceLink: "https://bizbox.example/issues/BIZ-35",
    });

    expect(file).toMatchObject({
      source: "document",
      title: "Review Packet",
      filename: "review-packet.md",
      deliverableUrl: "https://bizbox.example/api/deliverables/55555555-5555-4555-8555-555555555555/content",
    });
  });

  it("returns null when no review deliverable exists", async () => {
    const db = dbWithExecuteResults([[], []]);

    await expect(resolveAwaitingHumanReviewFile(db, {
      companyId: "company-1",
      issueId: "issue-1",
      sourceLink: "https://bizbox.example/issues/BIZ-35",
    })).resolves.toBeNull();
  });
});
