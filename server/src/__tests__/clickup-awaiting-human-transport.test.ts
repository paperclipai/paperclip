import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addClickUpChatMessageReaction,
  deleteClickUpChatMessageReaction,
  detectClickUpAwaitingHumanBridgeEvents,
  detectClickUpAwaitingHumanBridgeEventsAfterMessage,
  getClickUpChatMessageReplies,
  sendClickUpTransportTestMessage,
  sendAwaitingHumanNotification,
  sendAwaitingHumanNotificationReply,
  uploadClickUpReviewFile,
} from "../services/clickup-awaiting-human-transport.js";
import { logger } from "../middleware/logger.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  delete process.env.CLICKUP_PERSONAL_TOKEN;
  delete process.env.CLICKUP_WORKSPACE_ID;
});

describe("addClickUpChatMessageReaction", () => {
  it("posts a like reaction to the ClickUp chat message", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => "",
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await addClickUpChatMessageReaction("message-42", "white_check_mark");

    expect(result).toEqual({
      status: "sent",
      detail: "sent",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/message-42/reactions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "token-123",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      reaction: "white_check_mark",
    });
  });

  it("treats an already-existing reaction as a successful acknowledgement", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        status: 400,
        message: "reaction already exists",
        trace_id: 123,
        timestamp: 1671534256138,
      }),
    }) as typeof fetch;

    const result = await addClickUpChatMessageReaction("message-42", "white_check_mark");

    expect(result).toEqual({
      status: "sent",
      detail: "already-exists",
    });
  });

  it("surfaces spec error messages for unsupported reactions", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        status: 400,
        message: "reaction party_blob is not supported",
        trace_id: 123,
        timestamp: 1671534256138,
      }),
    }) as typeof fetch;

    const result = await addClickUpChatMessageReaction("message-42", "party_blob");

    expect(result).toEqual({
      status: "failed",
      detail: "http-error:400:reaction party_blob is not supported",
    });
  });
});

describe("deleteClickUpChatMessageReaction", () => {
  it("deletes a reaction from the ClickUp chat message", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => "",
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await deleteClickUpChatMessageReaction("message-42", "brain_is_thinking");

    expect(result).toEqual({
      status: "sent",
      detail: "deleted",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/message-42/reactions/brain_is_thinking",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "token-123",
          "Content-Type": "application/json",
        }),
      }),
    );
  });
});

describe("uploadClickUpReviewFile", () => {
  const reviewFile = {
    source: "artifact" as const,
    deliverableId: "deliverable-1",
    title: "Review image",
    filename: "review.png",
    contentType: "image/png",
    byteSize: 9,
    contentPath: "artifacts/review.png",
    deliverableUrl: "https://bizbox.example/deliverables/1",
  };
  const v3UploadResponse = {
    date_updated: 1737065673712,
    date_created: 1737065673712,
    extension: "jpeg",
    id: "51971815-ae25-49d5-b90c-4988f400a307.png",
    mime_type: "image/jpeg",
    parent_entity_type: "tasks",
    parent_id: "task-42",
    size: 14697,
    signed: true,
    thumbnail_small: "https://attachments.clickup.com/thumb/small/example.jpeg",
    thumbnail_medium: "https://attachments.clickup.com/thumb/medium/example.jpeg",
    thumbnail_large: "https://attachments.clickup.com/thumb/large/example.jpeg",
    title: "example.jpeg",
    url: "https://t90161423646.p.clickup-attachments.com/t90161423646/306827e9-d043-426d-8944-8cc537ba9213/example.jpeg?view=open",
    user_id: 123456,
  };

  it("posts multipart review files to task attachments endpoint", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ status: 404, message: "Not Found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "task-42" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(v3UploadResponse),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await uploadClickUpReviewFile({}, "task-42", reviewFile, Buffer.from("png-bytes"));

    expect(result).toEqual({
      attachmentId: "51971815-ae25-49d5-b90c-4988f400a307.png",
      attachmentUrl: "https://t90161423646.p.clickup-attachments.com/t90161423646/306827e9-d043-426d-8944-8cc537ba9213/example.jpeg?view=open",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.clickup.com/api/v3/workspaces/workspace-1/attachments/task-42/attachments",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "token-123",
        }),
        body: expect.any(FormData),
      }),
    );
  });

  it("resolves custom task ids and falls back to v2 upload when v3 returns 404", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "90161423646";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "internal-task-id" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          status: 404,
          message: "Not Found or Authorized",
          trace_id: 1471351153931534568,
          timestamp: 1780037995526,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: "51971815-ae25-49d5-b90c-4988f400a307.png",
          url: "https://t90161423646.p.clickup-attachments.com/t90161423646/306827e9-d043-426d-8944-8cc537ba9213/example.jpeg?view=open",
        }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await uploadClickUpReviewFile(
      {},
      "86d35fwx8",
      reviewFile,
      Buffer.from("png-bytes"),
    );

    expect(result).toEqual({
      attachmentId: "51971815-ae25-49d5-b90c-4988f400a307.png",
      attachmentUrl: "https://t90161423646.p.clickup-attachments.com/t90161423646/306827e9-d043-426d-8944-8cc537ba9213/example.jpeg?view=open",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.clickup.com/api/v2/task/86d35fwx8?custom_task_ids=true&team_id=90161423646",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "token-123" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.clickup.com/api/v3/workspaces/90161423646/attachments/internal-task-id/attachments",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.clickup.com/api/v2/task/86d35fwx8/attachment?custom_task_ids=true&team_id=90161423646",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("deleteClickUpChatMessageReaction", () => {
  it("surfaces spec error messages for unsupported delete reactions", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        status: 400,
        message: "reaction party_blob is not supported",
        trace_id: 123,
        timestamp: 1671534256138,
      }),
    }) as typeof fetch;

    const result = await deleteClickUpChatMessageReaction("message-42", "party_blob");

    expect(result).toEqual({
      status: "failed",
      detail: "http-error:400:reaction party_blob is not supported",
    });
  });
});

describe("getClickUpChatMessageReplies", () => {
  it("extracts reply rows from the spec response shape", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "reply-row-1",
            parent_message: "message-42",
            content: "approve",
            links: {
              reactions: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-row-1/reactions",
            },
          },
        ],
      }),
    }) as typeof fetch;

    const result = await getClickUpChatMessageReplies("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "ok",
      replies: [
        {
          id: "reply-row-1",
          parentMessageId: "message-42",
          reactionsUrl: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-row-1/reactions",
          content: "approve",
          dateMs: null,
        },
      ],
    });
  });

  it("orders same-time replies by IDs beyond Number precision", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "9007199254740993",
            parent_message: "message-42",
            content: "second",
            links: { reactions: "https://example.test/reactions/second" },
          },
          {
            id: "9007199254740992",
            parent_message: "message-42",
            content: "first",
            links: { reactions: "https://example.test/reactions/first" },
          },
        ],
      }),
    }) as typeof fetch;

    const result = await getClickUpChatMessageReplies("message-42");

    expect(result.status).toBe("sent");
    expect(result.replies.map((reply) => reply.id)).toEqual([
      "9007199254740992",
      "9007199254740993",
    ]);
  });

  it("paginates replies and orders them chronologically across all pages", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: "reply-3",
            parent_message: "message-42",
            content: "third",
            date: 3000,
            links: { reactions: "https://example.test/reactions/third" },
          }],
          next_cursor: "cursor-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "reply-1",
              parent_message: "message-42",
              content: "first",
              date: 1000,
              links: { reactions: "https://example.test/reactions/first" },
            },
            {
              id: "reply-2",
              parent_message: "message-42",
              content: "second",
              date: 2000,
              links: { reactions: "https://example.test/reactions/second" },
            },
          ],
          next_cursor: null,
        }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await getClickUpChatMessageReplies("message-42");

    expect(result.status).toBe("sent");
    expect(result.replies.map((reply) => reply.id)).toEqual(["reply-1", "reply-2", "reply-3"]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/message-42/replies",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/message-42/replies?cursor=cursor-1",
      expect.anything(),
    );
  });

  it("paginates through more than twenty reply pages", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn();
    for (let page = 0; page < 21; page += 1) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: `reply-${page + 1}`,
            parent_message: "message-42",
            content: `Reply ${page + 1}`,
            date: page + 1,
            links: { reactions: `https://example.test/reactions/${page + 1}` },
          }],
          next_cursor: page === 20 ? null : `cursor-${page + 1}`,
        }),
      });
    }
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await getClickUpChatMessageReplies("message-42");

    expect(result.status).toBe("sent");
    expect(result.replies).toHaveLength(21);
    expect(result.replies.at(-1)?.id).toBe("reply-21");
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });

  it("aborts slow ClickUp reply polling requests", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) {
          return Promise.reject(new Error("missing abort signal"));
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("AbortError: ClickUp request timed out"));
          }, { once: true });
        });
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const resultPromise = getClickUpChatMessageReplies("message-42");
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(resultPromise).resolves.toEqual({
        status: "failed",
        detail: "AbortError: ClickUp request timed out",
        replies: [],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/message-42/replies",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "token-123",
          }),
          signal: expect.any(Object),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads reply content from top-level content field", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "reply-row-2",
            parent_message: "message-42",
            content: "Reject",
            links: {
              reactions: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-row-2/reactions",
            },
          },
        ],
      }),
    }) as typeof fetch;

    const result = await getClickUpChatMessageReplies("message-42");

    expect(result.replies[0]?.content).toBe("Reject");
  });
});

describe("sendAwaitingHumanNotification review context", () => {
  it("renders approval stage and notifies reviewers by direct message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ member: { user: { username: "Primary Lead" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ member: { user: { username: "Secondary Lead" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "message-review" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "dm-channel-primary" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "dm-message-primary" }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "BIZ-35 needs confirmation",
        summary: "Please review the approval item.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Reply in Bizbox.",
        labels: ["awaiting_human", "request_confirmation"],
        approvalContext: {
          approvalName: "Policy approval",
          requiresSecondReview: true,
        },
      },
    }, {
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-9",
      primaryReviewerUserId: "primary-user-id",
      secondaryReviewerUserId: "secondary-user-id",
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(body.content).toContain("Approval: Policy approval");
    expect(body.content).toContain("Approval stage: primary review");
    expect(body.content).toContain("Primary reviewer: a direct message will be sent to Primary Lead.");
    expect(body.content).toContain("Next step: the secondary reviewer, Secondary Lead, will be notified if the approval is accepted.");
    expect(body.content).not.toContain("clickup://user/");
    expect(body.content).toContain("Next step:");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/team/workspace-1/user/primary-user-id",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/team/workspace-1/user/secondary-user-id",
      expect.anything(),
    );
    expect(String(fetchMock.mock.calls[4]?.[1]?.body)).toContain("Hi Primary Lead,");
    expect(String(fetchMock.mock.calls[4]?.[1]?.body)).toContain(
      "Original approval thread: https://app.clickup.com/workspace-1/chat/r/channel-9/t/message-review",
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("caps reviewer DM titles separately from full handover titles", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ member: { user: { username: "Primary Lead" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "message-review" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "dm-channel-primary" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "dm-message-primary" }),
      });
    globalThis.fetch = fetchMock as typeof fetch;
    const title = "x".repeat(50_000);

    await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title,
        summary: "Please review the approval item.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Reply in Bizbox.",
        labels: ["awaiting_human", "request_confirmation"],
        approvalContext: { approvalName: "Policy approval" },
      },
    }, {
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-9",
      primaryReviewerUserId: "primary-user-id",
    });

    const dm = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(dm.content).toContain(`${"x".repeat(119)}…`);
    expect(dm.content).not.toContain(title);
    expect(dm.content.length).toBeLessThanOrEqual(40_000);
  });

  it("keeps the primary reviewer label un-attributed when only a secondary reviewer is configured", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ member: { user: { username: "Secondary Lead" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "message-review" }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "BIZ-35 needs confirmation",
        summary: "Please review the approval item.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Reply in Bizbox.",
        labels: ["awaiting_human", "request_confirmation"],
        approvalContext: {
          approvalName: "Policy approval",
          requiresSecondReview: true,
        },
      },
    }, {
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-9",
      primaryReviewerUserId: null,
      secondaryReviewerUserId: "secondary-user-id",
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.content).toContain("Approval: Policy approval");
    expect(body.content).toContain("Approval stage: primary review");
    expect(body.content).toContain("Primary reviewer: not configured.");
    expect(body.content).toContain("Next step: the secondary reviewer, Secondary Lead, will be notified if the approval is accepted.");
    expect(body.content).not.toContain("Primary reviewer: notified in a direct message.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the secondary reviewer name visible in final-stage approval messages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ member: { user: { username: "Primary Lead" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ member: { user: { username: "Secondary Lead" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "message-final" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "dm-channel-secondary" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "dm-message-secondary" }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotification({
      companyId: "company-1",
      issueId: "issue-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "BIZ-35 needs confirmation",
        summary: "Please review the approval item.",
        link: "https://bizbox.example/issues/BIZ-35",
        cta: "Reply in Bizbox.",
        labels: ["awaiting_human", "request_confirmation"],
        approvalContext: {
          approvalName: "Policy approval",
          approvalStage: "final",
          requiresSecondReview: true,
        },
      },
    }, {
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-9",
      primaryReviewerUserId: "primary-user-id",
      secondaryReviewerUserId: "secondary-user-id",
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(body.content).toContain("Approval stage: final check");
    expect(body.content).toContain("Reviewer: a direct message will be sent to Secondary Lead.");
    expect(body.content).toContain("Next step: the final reviewer handles the approval after the primary review clears.");
    expect(String(fetchMock.mock.calls[4]?.[1]?.body)).toContain(
      "Original approval thread: https://app.clickup.com/workspace-1/chat/r/channel-9/t/message-final",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/team/workspace-1/user/primary-user-id",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/team/workspace-1/user/secondary-user-id",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("sendAwaitingHumanNotificationReply", () => {
  it("posts a ClickUp chat reply under the workflow thread root", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: "question-reply-1" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotificationReply("thread-root-1", {
      companyId: "company-1",
      issueId: "handoff-1",
      handoffKind: "ask_user_questions",
      notification: {
        title: "Workflow input required",
        summary: "Which city?",
        body: "Which city should I check?",
        link: "",
        cta: "Reply with your response.",
        labels: ["workflow_handoff", "response"],
      },
    });

    expect(result).toEqual({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "question-reply-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/thread-root-1/replies",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "token-123",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      type: "message",
      content: "**Workflow input required**\n\nWhich city should I check?\n\nReply with your response.",
      content_format: "text/md",
    });
  });

  it("does not resend reviewer DMs when posting an approval reply", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: "question-reply-1" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotificationReply("thread-root-1", {
      companyId: "company-1",
      issueId: "handoff-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "Workflow approval required",
        summary: "Landing page approval required",
        body: "Please approve this change.",
        link: "",
        cta: "Reply with: approve or reject.",
        labels: ["workflow_handoff", "approval"],
        approvalContext: {
          approvalName: "Policy approval",
          requiresSecondReview: true,
        },
      },
    }, {
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-9",
      primaryReviewerUserId: "primary-user-id",
      secondaryReviewerUserId: "secondary-user-id",
    });

    expect(result).toEqual({
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: "question-reply-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).content).toContain("Approval: Policy approval");
  });

  it("keeps long workflow approval replies intact instead of applying the short channel-message cap", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const longApprovalBody = [
      "# Landing Page Approval Required",
      "",
      "## Slug",
      "",
      "- `adk-bizbox-human-gate-smoke-1780911620717` (new)",
      "",
      "## Section Order",
      "",
      ...Array.from({ length: 100 }, (_, index) =>
        `- Section ${index + 1}: This line should remain visible in the ClickUp thread reply so the human can review the complete workflow approval context before replying.`,
      ),
      "",
      "## Final Decision",
      "",
      "Please approve or reject this landing page plan.",
    ].join("\n");

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: "question-reply-1" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendAwaitingHumanNotificationReply("thread-root-1", {
      companyId: "company-1",
      issueId: "handoff-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "Workflow approval required",
        summary: "Landing page approval required",
        body: longApprovalBody,
        link: "",
        cta: "Reply with: approve or reject (optionally include a note).",
        labels: ["workflow_handoff", "approval"],
      },
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content.length).toBeGreaterThan(10_000);
    expect(body.content).toContain("Section 100");
    expect(body.content).toContain("Please approve or reject this landing page plan.");
    expect(body.content).toContain("Reply with: approve or reject");
    expect(body.content).not.toMatch(/…$/);
  });

  it("preserves reply CTA instructions when the body reaches its limit", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: "question-reply-2" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const cta = "Reply with: approve or reject.";

    await sendAwaitingHumanNotificationReply("thread-root-1", {
      companyId: "company-1",
      issueId: "handoff-1",
      handoffKind: "request_confirmation",
      notification: {
        title: "Workflow approval required",
        summary: "Landing page approval required",
        body: "Detailed approval context. ".repeat(2_000),
        link: "",
        cta,
        labels: ["workflow_handoff", "approval"],
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content).toContain(`…\n\n${cta}`);
    expect(body.content.length).toBeLessThanOrEqual(40_000);
  });
});

describe("sendClickUpTransportTestMessage reviewer notifications", () => {
  it("renders reviewer direct message prompts and sends them in order", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ member: { user: { username: "Primary Lead" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ member: { user: { username: "Secondary Lead" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "message-reviewers" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "dm-channel-primary" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "dm-message-primary" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "dm-channel-secondary" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "dm-message-secondary" }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendClickUpTransportTestMessage({
      title: "Bizbox ClickUp reviewer notification test",
      summary: "Bizbox completed a reviewer notification test for ClickUp.",
      body: "The configured bridge successfully delivered a reviewer notification test payload to the target ClickUp channel.",
      link: "https://bizbox.example/company/settings/awaiting-human",
      cta: "No action is required.",
      reviewerTargets: [
        { label: "Primary reviewer", userId: "primary-user-id" },
        { label: "Secondary reviewer", userId: "secondary-user-id" },
      ],
    }, {
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-9",
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(body.content).toContain("Reviewer notification test:");
    expect(body.content).toContain("Primary reviewer: a direct message will be sent");
    expect(body.content).toContain("Secondary reviewer: a direct message will be sent");
    expect(body.content).not.toContain("clickup://user/");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/team/workspace-1/user/primary-user-id",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/team/workspace-1/user/secondary-user-id",
      expect.anything(),
    );
    expect(String(fetchMock.mock.calls[4]?.[1]?.body)).toContain("Hi Primary Lead,");
    expect(String(fetchMock.mock.calls[4]?.[1]?.body)).toContain(
      "Original approval thread: https://app.clickup.com/workspace-1/chat/r/channel-9/t/message-reviewers",
    );
    expect(String(fetchMock.mock.calls[6]?.[1]?.body)).toContain("Hi Secondary Lead,");
    expect(String(fetchMock.mock.calls[6]?.[1]?.body)).toContain(
      "Original approval thread: https://app.clickup.com/workspace-1/chat/r/channel-9/t/message-reviewers",
    );
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/chat/channels/direct_message")).length).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("does not claim reviewer DM delivery when a direct message fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ member: { user: { username: "Primary Lead" } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "message-reviewers" }),
      })
      .mockRejectedValueOnce(new Error("ClickUp DM unavailable"));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendClickUpTransportTestMessage({
      title: "Bizbox ClickUp reviewer notification test",
      summary: "Bizbox completed a reviewer notification test for ClickUp.",
      link: "https://bizbox.example/company/settings/awaiting-human",
      reviewerTargets: [
        { label: "Primary reviewer", userId: "primary-user-id" },
      ],
    }, {
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-9",
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.content).toContain("Primary reviewer: a direct message will be sent");
    expect(body.content).not.toContain("notified in a direct message");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "primary-user-id" }),
      "clickup awaiting human reviewer DM failed",
    );
  });

  it("omits the reviewer section when no reviewer targets are configured", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: "message-reviewers" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendClickUpTransportTestMessage({
      title: "Bizbox ClickUp reviewer notification test",
      summary: "Bizbox completed a reviewer notification test for ClickUp.",
      body: "The configured bridge successfully delivered a reviewer notification test payload to the target ClickUp channel.",
      link: "https://bizbox.example/company/settings/awaiting-human",
      cta: "No action is required.",
      reviewerTargets: [
        { label: "Primary reviewer", userId: null },
        { label: "Secondary reviewer", userId: undefined },
      ],
    }, {
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-9",
    });

    expect(result.status).toBe("sent");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content).not.toContain("Reviewer notification test:");
    expect(body.content).not.toContain("not configured");
  });

  it("falls back to the raw user id when the ClickUp display name cannot be resolved", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ message: "Not found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "message-reviewers" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "dm-channel-primary" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: "dm-message-primary" }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendClickUpTransportTestMessage({
      title: "Bizbox ClickUp reviewer notification test",
      summary: "Bizbox completed a reviewer notification test for ClickUp.",
      body: "The configured bridge successfully delivered a reviewer notification test payload to the target ClickUp channel.",
      link: "https://bizbox.example/company/settings/awaiting-human",
      cta: "No action is required.",
      reviewerTargets: [
        { label: "Primary reviewer", userId: "primary-user-id" },
      ],
    }, {
      personalToken: "token-123",
      workspaceId: "workspace-1",
      channelId: "channel-9",
    });

    expect(result.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/channels/direct_message",
      expect.objectContaining({
        body: JSON.stringify({ user_ids: ["primary-user-id"] }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/channels/dm-channel-primary/messages",
      expect.objectContaining({
        body: expect.stringContaining("Hi primary-user-id,"),
      }),
    );
  });
});

describe("detectClickUpAwaitingHumanBridgeEvents", () => {
  it("skips replies without stable reply ids and logs a warning", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            parent_message: "message-42",
            content: "First reply",
            links: { reactions: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-unknown-1/reactions", tagged_users: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-unknown-1/tagged_users" },
          },
          {
            parent_message: "message-42",
            content: "Second reply",
            links: { reactions: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-unknown-2/reactions", tagged_users: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-unknown-2/tagged_users" },
          },
        ],
      }),
    }) as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEvents("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "no-replies",
      events: [],
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(
      1,
      {
        messageId: "message-42",
        reply: {
          id: undefined,
          parentMessageId: "message-42",
          reactionsUrl: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-unknown-1/reactions",
          content: "First reply",
          dateMs: null,
        },
      },
      "Skipping ClickUp reply without stable reply.id",
    );
  });

  it("returns reply events for every thread reply with text", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: "reply-1",
          parent_message: "message-42",
          content: "Reject",
          links: {
            reactions: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-1/reactions",
            tagged_users: "https://api.clickup.com/api/v3/workspaces/workspace-1/chat/messages/reply-1/tagged_users",
          },
        }],
      }),
    }) as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEvents("message-42");

    expect(result).toEqual({
      status: "sent",
      detail: "replies-detected",
      events: [{
        kind: "reply",
        externalEventId: "reply-1",
        externalMessageId: "message-42",
        body: "Reject",
        metadata: { clickupReplyId: "reply-1" },
      }],
    });
  });
});

describe("detectClickUpAwaitingHumanBridgeEventsAfterMessage", () => {
  it("returns only replies after the current bot question marker", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "previous-human-reply",
            parent_message: "thread-root-1",
            content: "Melbourne",
            date: 1000,
            links: { reactions: "https://example.test/reactions/previous" },
          },
          {
            id: "question-reply-2",
            parent_message: "thread-root-1",
            content: "Which unit?",
            date: 2000,
            links: { reactions: "https://example.test/reactions/question" },
          },
          {
            id: "human-reply-2",
            parent_message: "thread-root-1",
            content: "Celsius",
            date: 3000,
            links: { reactions: "https://example.test/reactions/answer" },
          },
        ],
      }),
    }) as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEventsAfterMessage(
      "thread-root-1",
      "question-reply-2",
    );

    expect(result).toEqual({
      status: "sent",
      detail: "replies-detected",
      events: [{
        kind: "reply",
        externalEventId: "human-reply-2",
        externalThreadId: "thread-root-1",
        externalMessageId: "question-reply-2",
        body: "Celsius",
        metadata: {
          clickupReplyId: "human-reply-2",
          clickupThreadId: "thread-root-1",
          clickupQuestionMessageId: "question-reply-2",
        },
      }],
    });
  });

  it("does not accept replies when the bot question marker is missing", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: "human-reply-1",
          parent_message: "thread-root-1",
          content: "Sydney",
          date: 3000,
          links: { reactions: "https://example.test/reactions/answer" },
        }],
      }),
    }) as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEventsAfterMessage(
      "thread-root-1",
      "question-reply-1",
    );

    expect(result).toEqual({
      status: "failed",
      detail: "question-marker-not-found",
      events: [],
    });
  });

  it("normalizes ClickUp newest-first replies before applying the question marker", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "80160041502274",
            parent_message: "80160041502221",
            content: "Ankara Turkey",
            date: 1780920048301,
            links: { reactions: "https://example.test/reactions/answer" },
          },
          {
            id: "80160041502222",
            parent_message: "80160041502221",
            content: "**Workflow input required**",
            date: 1780920031891,
            links: { reactions: "https://example.test/reactions/question" },
          },
        ],
      }),
    }) as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEventsAfterMessage(
      "80160041502221",
      "80160041502222",
    );

    expect(result).toEqual({
      status: "sent",
      detail: "replies-detected",
      events: [{
        kind: "reply",
        externalEventId: "80160041502274",
        externalThreadId: "80160041502221",
        externalMessageId: "80160041502222",
        body: "Ankara Turkey",
        metadata: {
          clickupReplyId: "80160041502274",
          clickupThreadId: "80160041502221",
          clickupQuestionMessageId: "80160041502222",
        },
      }],
    });
  });

  it("detects a human answer on page 2 after a marker on page 1", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: "question-reply-1",
            parent_message: "thread-root-1",
            content: "**Workflow input required**",
            date: 1000,
            links: { reactions: "https://example.test/reactions/question" },
          }],
          next_cursor: "cursor-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: "human-reply-1",
            parent_message: "thread-root-1",
            content: "Celsius",
            date: 2000,
            links: { reactions: "https://example.test/reactions/answer" },
          }],
          next_cursor: null,
        }),
      }) as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEventsAfterMessage(
      "thread-root-1",
      "question-reply-1",
    );

    expect(result.status).toBe("sent");
    expect(result.detail).toBe("replies-detected");
    expect(result.events.map((event) => event.externalEventId)).toEqual(["human-reply-1"]);
  });

  it("detects a marker on page 2 after older replies on page 1", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: "previous-human-reply",
            parent_message: "thread-root-1",
            content: "Sydney",
            date: 1000,
            links: { reactions: "https://example.test/reactions/previous" },
          }],
          next_cursor: "cursor-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "question-reply-2",
              parent_message: "thread-root-1",
              content: "**Workflow input required**",
              date: 2000,
              links: { reactions: "https://example.test/reactions/question" },
            },
            {
              id: "human-reply-2",
              parent_message: "thread-root-1",
              content: "Fahrenheit",
              date: 3000,
              links: { reactions: "https://example.test/reactions/answer" },
            },
          ],
          next_cursor: null,
        }),
      }) as typeof fetch;

    const result = await detectClickUpAwaitingHumanBridgeEventsAfterMessage(
      "thread-root-1",
      "question-reply-2",
    );

    expect(result.status).toBe("sent");
    expect(result.detail).toBe("replies-detected");
    expect(result.events.map((event) => event.externalEventId)).toEqual(["human-reply-2"]);
  });
});
