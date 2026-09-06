import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatSdkEndpointRuntime,
  type ChatSdkMessageCallbackEvent,
} from "./chat-sdk-runtime.js";
import type {
  ChatSdkStateCompareAndSetInput,
  ChatSdkStateDeleteInput,
  ChatSdkStatePersistence,
  ChatSdkStateRecord,
  ChatSdkStateScope,
} from "./chat-sdk-state.js";

function memoryPersistence(): ChatSdkStatePersistence {
  const rows = new Map<string, ChatSdkStateRecord>();
  const key = (scope: ChatSdkStateScope, value: string) =>
    `${scope.companyId}:${scope.endpointId}:${value}`;
  return {
    async read(scope, value) {
      return rows.get(key(scope, value)) ?? null;
    },
    async compareAndSet(input: ChatSdkStateCompareAndSetInput) {
      const storageKey = key(input, input.key);
      const current = rows.get(storageKey);
      if ((current?.version ?? null) !== input.expectedVersion) return false;
      rows.set(storageKey, {
        expiresAt: input.expiresAt,
        value: input.value,
        version: (current?.version ?? 0) + 1,
      });
      return true;
    },
    async deleteIfVersion(input: ChatSdkStateDeleteInput) {
      const storageKey = key(input, input.key);
      const current = rows.get(storageKey);
      if (current?.version !== input.expectedVersion) return false;
      rows.delete(storageKey);
      return true;
    },
  };
}

const webhookSecret = "github-provider-stress-secret";

function signedGitHubRequest(
  event: "issue_comment" | "pull_request_review_comment",
  payload: Record<string, unknown>,
  deliveryId?: string,
) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", webhookSecret)
    .update(body)
    .digest("hex");
  const resolvedDeliveryId =
    deliveryId ??
    `delivery-${String((payload.comment as { id?: unknown } | undefined)?.id ?? "event")}`;
  return new Request("https://paperclip.example/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": resolvedDeliveryId,
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

function commentPayload(input: {
  body: string;
  commentId: number;
  number: number;
  pullRequest?: boolean;
  reviewRootId?: number;
  senderId?: number;
}) {
  const userId = input.senderId ?? 7001;
  return {
    action: "created",
    comment: {
      id: input.commentId,
      in_reply_to_id: input.reviewRootId,
      body: input.body,
      created_at: "2026-09-05T12:00:00Z",
      updated_at: "2026-09-05T12:00:00Z",
      html_url: `https://github.com/paperclipai/chat-e2e/issues/${input.number}#issuecomment-${input.commentId}`,
      user: {
        id: userId,
        login: userId === 9001 ? "maya-paperclip[bot]" : "alex-e2e",
        type: userId === 9001 ? "Bot" : "User",
      },
    },
    installation: { id: 2468 },
    issue: {
      number: input.number,
      ...(input.pullRequest ? { pull_request: {} } : {}),
    },
    pull_request: { number: input.number },
    repository: {
      id: 97531,
      name: "chat-e2e",
      full_name: "paperclipai/chat-e2e",
      owner: { id: 1357, login: "paperclipai" },
    },
    sender: {
      id: userId,
      login: userId === 9001 ? "maya-paperclip[bot]" : "alex-e2e",
    },
  };
}

describe("GitHub published adapter stress contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes issue, PR, inline, and subscribed follow-up boundaries and suppresses the bot's own event", async () => {
    const providerRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        providerRequests.push(String(input));
        return new Response(
          JSON.stringify({
            id: 1,
            content: "+1",
            user: { id: 9001, login: "maya-paperclip[bot]" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const deliveries: ChatSdkMessageCallbackEvent[] = [];
    const runtime = createChatSdkEndpointRuntime({
      callbacks: {
        async onMessage(event) {
          deliveries.push(event);
          await event.thread.adapter.addReaction(
            event.thread.id,
            event.message.id,
            "eyes",
          );
          if (event.trigger === "mention") await event.thread.subscribe();
        },
      },
      companyId: "company-github-provider-stress",
      endpointId: "endpoint-github-provider-stress",
      logger: "silent",
      persistence: memoryPersistence(),
      providerConfig: {
        provider: "github",
        userName: "maya-paperclip[bot]",
        credentials: {
          botUserId: 9001,
          token: "github-token-never-logged",
          webhookSecret,
        },
      },
    });
    await runtime.initialize();

    const cases = [
      {
        event: "issue_comment" as const,
        payload: commentPayload({
          body: "@maya-paperclip[bot] issue root",
          commentId: 4201,
          number: 42,
        }),
      },
      {
        event: "issue_comment" as const,
        payload: commentPayload({
          body: "@maya-paperclip[bot] PR root",
          commentId: 4301,
          number: 43,
          pullRequest: true,
        }),
      },
      {
        event: "pull_request_review_comment" as const,
        payload: commentPayload({
          body: "@maya-paperclip[bot] inline root",
          commentId: 4401,
          number: 43,
          pullRequest: true,
          reviewRootId: 4401,
        }),
      },
    ];
    for (const item of cases) {
      const response = await runtime.handleWebhook(
        signedGitHubRequest(item.event, item.payload),
      );
      expect(response.status).toBe(200);
    }
    const followup = commentPayload({
      body: "unmentioned issue follow-up",
      commentId: 4202,
      number: 42,
    });
    expect(
      (
        await runtime.handleWebhook(
          signedGitHubRequest("issue_comment", followup),
        )
      ).status,
    ).toBe(200);
    const selfEvent = commentPayload({
      body: "@maya-paperclip[bot] outbound self event",
      commentId: 4203,
      number: 42,
      senderId: 9001,
    });
    expect(
      (
        await runtime.handleWebhook(
          signedGitHubRequest("issue_comment", selfEvent),
        )
      ).status,
    ).toBe(200);

    expect(
      deliveries.map((delivery) => ({
        id: delivery.message.id,
        threadId: delivery.thread.id,
        trigger: delivery.trigger,
      })),
    ).toEqual([
      {
        id: "4201",
        threadId: "github:paperclipai/chat-e2e:issue:42",
        trigger: "mention",
      },
      {
        id: "4301",
        threadId: "github:paperclipai/chat-e2e:43",
        trigger: "mention",
      },
      {
        id: "4401",
        threadId: "github:paperclipai/chat-e2e:43:rc:4401",
        trigger: "mention",
      },
      {
        id: "4202",
        threadId: "github:paperclipai/chat-e2e:issue:42",
        trigger: "subscribed_message",
      },
    ]);
    expect(providerRequests).toHaveLength(4);
    expect(providerRequests.every((url) => url.includes("/reactions"))).toBe(
      true,
    );
    await runtime.shutdown();
  });

  it("keeps stable identities across reordered and exactly duplicated raw deliveries", async () => {
    const deliveries: ChatSdkMessageCallbackEvent[] = [];
    const runtime = createChatSdkEndpointRuntime({
      callbacks: {
        onMessage(event) {
          deliveries.push(event);
        },
      },
      companyId: "company-github-reorder-stress",
      endpointId: "endpoint-github-reorder-stress",
      logger: "silent",
      persistence: memoryPersistence(),
      providerConfig: {
        provider: "github",
        userName: "maya-paperclip[bot]",
        credentials: {
          botUserId: 9001,
          token: "github-token-never-logged",
          webhookSecret,
        },
      },
    });
    await runtime.initialize();
    const newer = commentPayload({
      body: "@maya-paperclip[bot] newer comment delivered first",
      commentId: 5102,
      number: 51,
    });
    const older = commentPayload({
      body: "@maya-paperclip[bot] older root delivered late",
      commentId: 5101,
      number: 51,
    });
    try {
      for (const request of [
        signedGitHubRequest("issue_comment", newer, "github-delivery-5102"),
        signedGitHubRequest("issue_comment", older, "github-delivery-5101"),
        signedGitHubRequest("issue_comment", older, "github-delivery-5101"),
      ]) {
        expect((await runtime.handleWebhook(request)).status).toBe(200);
      }

      expect(
        deliveries.map((delivery) => ({
          id: delivery.message.id,
          threadId: delivery.thread.id,
        })),
      ).toEqual([
        {
          id: "5102",
          threadId: "github:paperclipai/chat-e2e:issue:51",
        },
        {
          id: "5101",
          threadId: "github:paperclipai/chat-e2e:issue:51",
        },
        {
          id: "5101",
          threadId: "github:paperclipai/chat-e2e:issue:51",
        },
      ]);
    } finally {
      await runtime.shutdown();
    }
  });
});
