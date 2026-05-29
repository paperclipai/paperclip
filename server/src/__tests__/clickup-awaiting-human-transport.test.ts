import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addClickUpChatMessageReaction,
  deleteClickUpChatMessageReaction,
  detectClickUpAwaitingHumanBridgeEvents,
  getClickUpChatMessageReplies,
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
  it("posts multipart review files to task attachments endpoint", async () => {
    process.env.CLICKUP_PERSONAL_TOKEN = "token-123";
    process.env.CLICKUP_WORKSPACE_ID = "workspace-1";

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: "attachment-1",
        url: "https://app.clickup.com/attachment/1",
        parent_entity_type: "tasks",
        parent_id: "task-42",
        title: "review.png",
        mime_type: "image/png",
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await uploadClickUpReviewFile(
      {},
      "task-42",
      {
        source: "artifact",
        deliverableId: "deliverable-1",
        title: "Review image",
        filename: "review.png",
        contentType: "image/png",
        byteSize: 9,
        contentPath: "artifacts/review.png",
        deliverableUrl: "https://bizbox.example/deliverables/1",
      },
      Buffer.from("png-bytes"),
    );

    expect(result).toEqual({
      attachmentId: "attachment-1",
      attachmentUrl: "https://app.clickup.com/attachment/1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
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
        },
      ],
    });
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
