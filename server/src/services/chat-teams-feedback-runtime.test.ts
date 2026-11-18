import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatSdkEndpointRuntime,
  type ChatSdkCallbackEvent,
  type ChatSdkEndpointRuntime,
} from "./chat-sdk-runtime.js";
import type { TeamsFeedbackEvent } from "./chat-channels/microsoft-teams/feedback-loop.js";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateRecord,
  ChatSdkStateScope,
} from "./chat-sdk-state.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const appId = "22222222-2222-4222-8222-222222222222";
const companyId = "33333333-3333-4333-8333-333333333333";
const endpointId = "44444444-4444-4444-8444-444444444444";
const aadObjectId = "55555555-5555-4555-8555-555555555555";
const userId = "29:synthetic-user";
const conversationId = "a:synthetic-personal";
const amer = "https://smba.trafficmanager.net/amer/";
const thread = (conversation = conversationId, route = amer) =>
  `teams:${Buffer.from(conversation).toString("base64url")}:${Buffer.from(route).toString("base64url")}:personal`;

function feedbackInvoke(
  reaction: "like" | "dislike",
  feedback: unknown = JSON.stringify({ feedbackText: "  Clear answer.  " }),
) {
  return {
    type: "invoke",
    name: "message/submitAction",
    id: `activity-${reaction}`,
    channelId: "msteams",
    serviceUrl: amer,
    from: { id: userId, aadObjectId, name: "Synthetic User" },
    recipient: { id: `28:${appId}` },
    conversation: {
      id: conversationId,
      conversationType: "personal",
      tenantId,
    },
    channelData: { tenant: { id: tenantId } },
    replyToId: "bot-reply-1",
    value: {
      actionName: "feedback",
      actionValue: { reaction, feedback },
    },
  };
}

function persistence(): ChatSdkStatePersistence {
  const rows = new Map<string, ChatSdkStateRecord>();
  const keyFor = (scope: ChatSdkStateScope, key: string) =>
    JSON.stringify([scope.companyId, scope.endpointId, key]);
  return {
    async read(scope, key) {
      return rows.get(keyFor(scope, key)) ?? null;
    },
    async compareAndSet(input) {
      const key = keyFor(input, input.key);
      const old = rows.get(key);
      if ((old?.version ?? null) !== input.expectedVersion) return false;
      rows.set(key, {
        value: input.value,
        expiresAt: input.expiresAt,
        version: (old?.version ?? 0) + 1,
      });
      return true;
    },
    async deleteIfVersion(input) {
      const key = keyFor(input, input.key);
      if (rows.get(key)?.version !== input.expectedVersion) return false;
      return rows.delete(key);
    },
  };
}

type FeedbackCallback = (
  event: ChatSdkCallbackEvent<TeamsFeedbackEvent>,
) => Promise<"retry" | void>;
interface AppSeam {
  server: {
    serviceTokenValidator: {
      check(header: string, body: Record<string, unknown>): Promise<unknown>;
    };
  };
  activitySender: {
    client: { post(url: string, data: unknown): Promise<{ data: unknown }> };
  };
  api: {
    serviceUrl: string;
    http: { put(url: string, data: unknown): Promise<{ data: unknown }> };
  };
}

describe("Teams native feedback runtime", () => {
  const runtimes: ChatSdkEndpointRuntime[] = [];
  afterEach(async () => {
    try {
      await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  async function harness(enabled = true) {
    const network = vi.fn(async () => {
      throw new Error("Network forbidden");
    });
    vi.stubGlobal("fetch", network);
    const callback = vi.fn<FeedbackCallback>(async () => {});
    const onMessage = vi.fn();
    const onAction = vi.fn();
    const runtime = createChatSdkEndpointRuntime({
      companyId,
      endpointId,
      persistence: persistence(),
      logger: "silent",
      callbacks: {
        onMessage,
        onAction,
        ...(enabled ? { onTeamsFeedback: callback } : {}),
      },
      providerConfig: {
        provider: "microsoft-teams",
        userName: "maya",
        credentials: {
          appId,
          appPassword: "synthetic-password",
          appTenantId: tenantId,
          appType: "SingleTenant",
        },
      },
    });
    runtimes.push(runtime);
    await runtime.initialize();
    const app = (runtime.getProviderAdapter() as unknown as { app: AppSeam })
      .app;
    vi.spyOn(app.server.serviceTokenValidator, "check").mockImplementation(
      async (header, body) => {
        if (header !== "Bearer fixture-token")
          throw new Error("Unverified fixture request");
        return {
          appId,
          from: "azure",
          fromId: "service",
          serviceUrl: body.serviceUrl,
          isExpired: () => false,
        };
      },
    );
    const post = vi
      .spyOn(app.activitySender.client, "post")
      .mockResolvedValue({ data: { id: "bot-reply-1" } });
    const put = vi
      .spyOn(app.api.http, "put")
      .mockResolvedValue({ data: { id: "bot-reply-1" } });
    const dispatch = (activity: unknown) =>
      runtime.handleWebhook(
        new Request("https://paperclip.test/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fixture-token",
          },
          body: JSON.stringify(activity),
        }),
      );
    return { runtime, post, put, callback, dispatch, network, onMessage, onAction };
  }

  it.each([
    ["like", "up", "Clear answer."],
    ["dislike", "down", "Clear answer."],
  ] as const)(
    "delivers an authenticated %s as a normalized vote",
    async (reaction, vote, reason) => {
      const h = await harness();
      expect((await h.dispatch(feedbackInvoke(reaction))).status).toBe(200);
      expect(h.callback).toHaveBeenCalledTimes(1);
      expect(h.callback.mock.calls[0]![0]).toEqual({
        endpointId,
        provider: "microsoft-teams",
        event: {
          activityId: `activity-${reaction}`,
          threadId: `teams:${Buffer.from(conversationId).toString("base64url")}`,
          replyToId: "bot-reply-1",
          userId,
          aadObjectId,
          vote,
          reason,
        },
      });
      expect(h.onMessage).not.toHaveBeenCalled();
      expect(h.onAction).not.toHaveBeenCalled();
      expect(h.post).not.toHaveBeenCalled();
      expect(h.network).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["empty form", JSON.stringify({ feedbackText: "   " })],
    ["unparseable form", "{not json"],
    ["missing form", null],
  ])("keeps the vote without a reason for a %s", async (_name, feedback) => {
    const h = await harness();
    expect((await h.dispatch(feedbackInvoke("dislike", feedback))).status).toBe(
      200,
    );
    expect(h.callback.mock.calls[0]![0].event).toMatchObject({
      vote: "down",
      reason: null,
    });
  });

  it("caps the reason at the shared validator length", async () => {
    const h = await harness();
    await h.dispatch(
      feedbackInvoke("like", JSON.stringify({ feedbackText: "x".repeat(1500) })),
    );
    expect(h.callback.mock.calls[0]![0].event.reason).toHaveLength(1000);
  });

  it.each(["tenant", "bot", "action"])(
    "acknowledges but ignores a foreign %s",
    async (scope) => {
      const h = await harness();
      const raw = feedbackInvoke("like");
      if (scope === "tenant") {
        raw.conversation.tenantId = companyId;
        raw.channelData.tenant.id = companyId;
      }
      if (scope === "bot") raw.recipient.id = `28:${endpointId}`;
      if (scope === "action") raw.value.actionName = "other";
      expect((await h.dispatch(raw)).status).toBe(200);
      expect(h.callback).not.toHaveBeenCalled();
      expect(h.onMessage).not.toHaveBeenCalled();
    },
  );

  it("acknowledges the invoke when recording the vote fails", async () => {
    const h = await harness();
    h.callback.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await h.dispatch(feedbackInvoke("like"));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("database unavailable");
  });

  it("asks Teams to retry when the rated reply is still settling", async () => {
    const h = await harness();
    h.callback.mockResolvedValueOnce("retry");
    const response = await h.dispatch(feedbackInvoke("like"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(h.callback).toHaveBeenCalledTimes(1);
  });

  it("does not deliver feedback without the optional callback", async () => {
    const h = await harness(false);
    await h.dispatch(feedbackInvoke("like"));
    expect(h.callback).not.toHaveBeenCalled();
    expect(h.onMessage).not.toHaveBeenCalled();
    expect(h.onAction).not.toHaveBeenCalled();
  });

  it("enables native feedback only on messages sent inside the feedback scope", async () => {
    const h = await harness();
    await h.runtime
      .thread(thread())
      .post({ markdown: "Progress notice" });
    await h.runtime.withTeamsFeedbackLoop(() =>
      h.runtime.thread(thread()).post({ markdown: "Agent reply" }),
    );
    expect(h.post).toHaveBeenCalledTimes(2);
    const [plain, rated] = h.post.mock.calls.map(([, body]) => body) as Array<{
      text: string;
      channelData?: Record<string, unknown>;
    }>;
    expect(plain!.text).toContain("Progress notice");
    expect(plain!.channelData?.feedbackLoopEnabled).toBeUndefined();
    expect(rated!.text).toContain("Agent reply");
    expect(rated!.channelData).toMatchObject({ feedbackLoopEnabled: true });
  });

  it("enables native feedback when a queued message is edited into the agent reply", async () => {
    const h = await harness();
    const adapter = h.runtime.getProviderAdapter();
    await adapter.editMessage(thread(), "bot-reply-1", { markdown: "Working" });
    await h.runtime.withTeamsFeedbackLoop(() =>
      adapter.editMessage(thread(), "bot-reply-1", { markdown: "Agent reply" }),
    );
    expect(h.put).toHaveBeenCalledTimes(2);
    const [plain, rated] = h.put.mock.calls as Array<
      [string, { text: string; channelData?: Record<string, unknown> }]
    >;
    expect(rated![0]).toBe(
      `${amer.replace(/\/$/, "")}/v3/conversations/${conversationId}/activities/bot-reply-1`,
    );
    expect(plain![1].channelData?.feedbackLoopEnabled).toBeUndefined();
    expect(rated![1].channelData).toMatchObject({ feedbackLoopEnabled: true });
    expect(h.post).not.toHaveBeenCalled();
  });
});
