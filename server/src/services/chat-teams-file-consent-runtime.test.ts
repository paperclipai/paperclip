import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatSdkEndpointRuntime,
  type ChatSdkEndpointRuntime,
  type ChatSdkCallbackEvent,
} from "./chat-sdk-runtime.js";
import {
  bindTeamsFileConsent,
  buildTeamsFileConsentCard,
  buildTeamsUploadedFileCard,
  createTeamsFileConsentBinding,
  exchangeTeamsFileUpload,
  type TeamsFileConsentEvent,
} from "./chat-teams-file-consent.js";
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
const emea = "https://smba.trafficmanager.net/emea/";
const uploadCanary = "SYNTHETIC-PRIVATE-UPLOAD-URL";
const bytes = Buffer.from("hello");
const binding = createTeamsFileConsentBinding({
  companyId,
  endpointId,
  tenantId,
  botAppId: appId,
  aadObjectId,
  issueId: "66666666-6666-4666-8666-666666666666",
  publicationId: "77777777-7777-4777-8777-777777777777",
  attachmentId: "88888888-8888-4888-8888-888888888888",
  conversationId,
  userId,
  sourceGeneration: 1,
  sourceDigest: "a".repeat(64),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteSize: bytes.length,
  filename: "report.txt",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});
const thread = (
  conversation = conversationId,
  route = amer,
  type = "personal",
) =>
  `teams:${Buffer.from(conversation).toString("base64url")}:${Buffer.from(route).toString("base64url")}:${type}`;

function invoke(action: "accept" | "decline") {
  return {
    type: "invoke",
    name: "fileConsent/invoke",
    id: `activity-${action}`,
    channelId: "msteams",
    serviceUrl: amer,
    from: { id: userId, aadObjectId },
    recipient: { id: `28:${appId}` },
    conversation: {
      id: conversationId,
      conversationType: "personal",
      tenantId,
    },
    channelData: { tenant: { id: tenantId } },
    replyToId: "consent-card-1",
    value: {
      type: "fileUpload",
      action,
      context: { schema: binding.schema, token: binding.token, action },
      ...(action === "accept"
        ? {
            uploadInfo: {
              name: binding.filename,
              fileType: "txt",
              uniqueId: "drive-item-1",
              contentUrl:
                "https://contoso-my.sharepoint.com/personal/user/Documents/report.txt",
              uploadUrl: `https://contoso-my.sharepoint.com/personal/user/_api/upload?token=${uploadCanary}`,
            },
          }
        : {}),
    },
  };
}
function persistence() {
  const rows = new Map<string, ChatSdkStateRecord>();
  const keyFor = (scope: ChatSdkStateScope, key: string) =>
    JSON.stringify([scope.companyId, scope.endpointId, key]);
  const state: ChatSdkStatePersistence = {
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
  return { rows, state };
}
type ConsentCallback = (
  event: ChatSdkCallbackEvent<TeamsFileConsentEvent>,
) => Promise<"recorded" | "ignored" | "denied">;
type FileRuntime = ChatSdkEndpointRuntime & {
  sendTeamsFileConsentCard(
    threadId: string,
    card: ReturnType<typeof buildTeamsFileConsentCard>,
  ): Promise<{ id: string }>;
  sendTeamsUploadedFileCard(
    threadId: string,
    card: ReturnType<typeof buildTeamsUploadedFileCard>,
  ): Promise<{ id: string }>;
};
interface AppSeam {
  server: {
    serviceTokenValidator: {
      check(header: string, body: Record<string, unknown>): Promise<unknown>;
    };
  };
  activitySender: {
    client: { post(url: string, data: unknown): Promise<{ data: unknown }> };
  };
  api: { serviceUrl: string };
}

// Real installed adapter/App router, App.send, ActivitySender and API client.
// Only service JWT verification and final HTTP post are replaced. There is no
// live tenant, Graph, service/DB authority, or successful file-delivery claim.
describe("Teams opt-in file-consent runtime", () => {
  const runtimes: ChatSdkEndpointRuntime[] = [];
  afterEach(async () => {
    try {
      await Promise.all(
        runtimes.splice(0).map((runtime) => runtime.shutdown()),
      );
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
  async function harness(enabled = true, timeout = 2500) {
    const network = vi.fn(async () => {
      throw new Error("Network forbidden");
    });
    vi.stubGlobal("fetch", network);
    const { rows, state } = persistence();
    const callback = vi.fn<ConsentCallback>(async () => "recorded");
    const onMessage = vi.fn();
    const onAction = vi.fn();
    const runtime = createChatSdkEndpointRuntime({
      companyId,
      endpointId,
      persistence: state,
      logger: "silent",
      webhookIngressTimeoutMs: timeout,
      callbacks: {
        onMessage,
        onAction,
        ...(enabled ? { onTeamsFileConsent: callback } : {}),
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
    }) as FileRuntime;
    runtimes.push(runtime);
    await runtime.initialize();
    const app = (runtime.getProviderAdapter() as unknown as { app: AppSeam })
      .app;
    const check = vi
      .spyOn(app.server.serviceTokenValidator, "check")
      .mockImplementation(async (header, body) => {
        if (header !== "Bearer fixture-token")
          throw new Error("Unverified fixture request");
        return {
          appId,
          from: "azure",
          fromId: "service",
          serviceUrl: body.serviceUrl,
          isExpired: () => false,
        };
      });
    const post = vi
      .spyOn(app.activitySender.client, "post")
      .mockResolvedValue({ data: { id: "card-receipt-1" } });
    const dispatch = (
      activity: unknown,
      authorization = "Bearer fixture-token",
    ) =>
      runtime.handleWebhook(
        new Request("https://paperclip.test/webhook", {
          method: "POST",
          headers: { "content-type": "application/json", authorization },
          body: JSON.stringify(activity),
        }),
      );
    return {
      runtime,
      app,
      post,
      check,
      callback,
      dispatch,
      rows,
      network,
      onMessage,
      onAction,
    };
  }

  it.each(["accept", "decline"] as const)(
    "delivers authenticated %s as an unchanged branded, scoped event",
    async (action) => {
      const h = await harness();
      expect((await h.dispatch(invoke(action))).status).toBe(200);
      expect(h.check).toHaveBeenCalledTimes(1);
      expect(h.callback).toHaveBeenCalledTimes(1);
      const wrapped = h.callback.mock.calls[0]![0];
      expect(wrapped).toMatchObject({
        endpointId,
        provider: "microsoft-teams",
        event: {
          companyId,
          endpointId,
          tenantId,
          botAppId: appId,
          conversationId,
          userId,
          aadObjectId,
          action,
        },
      });
      expect(wrapped.event.isHookEvent()).toBe(true);
      expect(JSON.stringify(wrapped)).not.toContain(uploadCanary);
      expect(JSON.stringify([...h.rows])).not.toContain(uploadCanary);
      expect(h.onMessage).not.toHaveBeenCalled();
      expect(h.onAction).not.toHaveBeenCalled();
      expect(h.post).not.toHaveBeenCalled();
      expect(h.network).not.toHaveBeenCalled();
    },
  );

  it("sends a file consent attachment without AdaptiveCard conversion through the real scoped API transport", async () => {
    const h = await harness();
    const card = buildTeamsFileConsentCard(binding);
    await expect(
      h.runtime.sendTeamsFileConsentCard(thread(), card),
    ).resolves.toEqual({ id: "card-receipt-1" });
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]).toEqual([
      `${amer.replace(/\/$/, "")}/v3/conversations/${conversationId}/activities`,
      expect.objectContaining({
        type: "message",
        attachments: [card],
        conversation: { id: conversationId },
        from: { id: appId, role: "bot" },
      }),
    ]);
    expect(JSON.stringify(h.post.mock.calls)).not.toContain(
      "application/vnd.microsoft.card.adaptive",
    );
    expect(h.network).not.toHaveBeenCalled();
  });

  it("sends only confirmed native file-info cards after the authenticated upload capability succeeds", async () => {
    const h = await harness();
    await h.dispatch(invoke("accept"));
    const event = h.callback.mock.calls[0]![0].event;
    const decision = bindTeamsFileConsent({
      event,
      stored: binding,
      current: binding,
      phase: "awaiting_consent",
      cardMessageId: "consent-card-1",
      now: Date.now(),
    });
    if (!decision.ok || decision.action !== "accept")
      throw new Error("Missing exact upload capability");
    expect(() =>
      buildTeamsUploadedFileCard(decision.upload, { kind: "uploaded" }),
    ).toThrow("not confirmed");
    const uploadRequest = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "drive-item-1",
            name: binding.filename,
            size: bytes.length,
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const result = await exchangeTeamsFileUpload({
      upload: decision.upload,
      binding,
      operation: "put",
      bytes,
      authorize: async () => {},
      request: uploadRequest,
    });
    expect(result).toEqual({ kind: "uploaded" });
    const card = buildTeamsUploadedFileCard(decision.upload, result);
    await expect(
      h.runtime.sendTeamsUploadedFileCard(thread(), card),
    ).resolves.toEqual({ id: "card-receipt-1" });
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]![1]).toMatchObject({
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.teams.card.file.info",
          name: binding.filename,
          contentUrl:
            "https://contoso-my.sharepoint.com/personal/user/Documents/report.txt",
          content: { uniqueId: "drive-item-1", fileType: "txt" },
        },
      ],
    });
    expect(JSON.stringify(h.post.mock.calls)).not.toContain(uploadCanary);
    expect(uploadRequest).toHaveBeenCalledTimes(1);
    expect(h.network).not.toHaveBeenCalled();
  });

  it("keeps both methods inactive and does not install a hook without the optional callback", async () => {
    const h = await harness(false);
    await h.dispatch(invoke("accept"));
    expect(h.callback).not.toHaveBeenCalled();
    expect(h.onMessage).not.toHaveBeenCalled();
    expect(h.onAction).not.toHaveBeenCalled();
    await expect(
      h.runtime.sendTeamsFileConsentCard(
        thread(),
        buildTeamsFileConsentCard(binding),
      ),
    ).rejects.toThrow("not enabled");
    await expect(
      h.runtime.sendTeamsUploadedFileCard(thread(), {} as never),
    ).rejects.toThrow("not enabled");
    expect(h.post).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
  });

  it.each(["", "Bearer invalid"])(
    "rejects an unverified consent before the callback (%#)",
    async (authorization) => {
      const h = await harness();
      expect((await h.dispatch(invoke("accept"), authorization)).status).toBe(
        401,
      );
      expect(h.callback).not.toHaveBeenCalled();
      expect(h.post).not.toHaveBeenCalled();
    },
  );

  it.each(["tenant", "bot", "group", "channel"])(
    "rejects authenticated foreign %s scope without ordinary dispatch",
    async (scope) => {
      const h = await harness();
      const raw = invoke("accept");
      if (scope === "tenant") raw.channelData.tenant.id = companyId;
      if (scope === "bot") raw.recipient.id = `28:${endpointId}`;
      if (scope === "group") raw.conversation.conversationType = "groupChat";
      if (scope === "channel") raw.conversation.conversationType = "channel";
      expect([400, 403]).toContain((await h.dispatch(raw)).status);
      expect(h.callback).not.toHaveBeenCalled();
      expect(h.onMessage).not.toHaveBeenCalled();
      expect(h.onAction).not.toHaveBeenCalled();
      expect(h.rows.size).toBe(0);
    },
  );

  it("withholds ACK while receipt persistence waits and returns a retryable deadline without posting a card", async () => {
    const h = await harness(true, 25);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.callback.mockImplementationOnce(async () => {
      await held;
      return "recorded";
    });
    let responded = false;
    const pending = h.dispatch(invoke("accept")).then((response) => {
      responded = true;
      return response;
    });
    try {
      await vi.waitFor(() => expect(h.callback).toHaveBeenCalledTimes(1), {
        interval: 1,
      });
      expect(responded).toBe(false);
      expect((await pending).status).toBe(503);
      expect(h.post).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
  });

  it("keeps thrown persistence errors private and preserves repeated IDs for service dedupe", async () => {
    const h = await harness();
    h.callback.mockRejectedValueOnce(new Error(uploadCanary));
    const failed = await h.dispatch(invoke("decline"));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain(uploadCanary);
    expect((await h.dispatch(invoke("decline"))).status).toBe(200);
    expect(h.callback).toHaveBeenCalledTimes(2);
    expect(h.callback.mock.calls[0]![0].event.activityId).toBe(
      h.callback.mock.calls[1]![0].event.activityId,
    );
    expect(h.post).not.toHaveBeenCalled();
  });

  it("keeps concurrent personal sends on their distinct accepted routes without mutating the default API", async () => {
    const h = await harness();
    const originalApi = h.app.api;
    const firstThread = thread();
    const secondThread = thread("a:second-personal", amer);
    await h.runtime.recordMicrosoftTeamsRoute(secondThread, emea);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.post.mockImplementationOnce(async () => {
      await held;
      return { data: { id: "first-card" } };
    });
    const first = h.runtime.sendTeamsFileConsentCard(
      firstThread,
      buildTeamsFileConsentCard(binding),
    );
    try {
      await vi.waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
      await expect(
        h.runtime.sendTeamsFileConsentCard(
          secondThread,
          buildTeamsFileConsentCard(binding),
        ),
      ).resolves.toEqual({ id: "card-receipt-1" });
      expect(h.post.mock.calls.map(([url]) => url)).toEqual([
        `${amer.replace(/\/$/, "")}/v3/conversations/${conversationId}/activities`,
        `${emea.replace(/\/$/, "")}/v3/conversations/a:second-personal/activities`,
      ]);
      expect(h.app.api).toBe(originalApi);
    } finally {
      release();
      await first;
    }
  });

  it.each([
    ["channel", thread("19:channel", amer, "channel")],
    ["group", thread("19:group", amer, "groupChat")],
    [
      "implicit personal",
      `teams:${Buffer.from(conversationId).toString("base64url")}`,
    ],
    [
      "missing route",
      `teams:${Buffer.from(conversationId).toString("base64url")}:personal`,
    ],
    ["untrusted route", thread(conversationId, "https://attacker.example/")],
    ["thread suffix", thread(`${conversationId};messageid=123`)],
  ])(
    "refuses %s instead of inferring a destination or using the default connector",
    async (_name, destination) => {
      const h = await harness();
      await expect(
        h.runtime.sendTeamsFileConsentCard(
          destination,
          buildTeamsFileConsentCard(binding),
        ),
      ).rejects.toThrow();
      expect(h.post).not.toHaveBeenCalled();
      expect(h.network).not.toHaveBeenCalled();
    },
  );

  it.each(["wrong type", "extra field", "swapped token"])(
    "refuses %s in the native consent-card shape before HTTP",
    async (mode) => {
      const h = await harness();
      const card = buildTeamsFileConsentCard(binding);
      const corrupted =
        mode === "wrong type"
          ? { ...card, contentType: "application/vnd.microsoft.card.adaptive" }
          : mode === "extra field"
            ? {
                ...card,
                contentUrl: `https://attacker.example/${uploadCanary}`,
              }
            : {
                ...card,
                content: {
                  ...card.content,
                  declineContext: {
                    ...card.content.declineContext,
                    token: `pcfc_${"Z".repeat(43)}`,
                  },
                },
              };
      await expect(
        h.runtime.sendTeamsFileConsentCard(thread(), corrupted as never),
      ).rejects.toThrow("invalid file-card shape");
      expect(h.post).not.toHaveBeenCalled();
    },
  );

  it.each(["missing ID", "transport failure"])(
    "does not retry or invent a receipt after %s",
    async (mode) => {
      const h = await harness();
      if (mode === "missing ID") h.post.mockResolvedValueOnce({ data: {} });
      else h.post.mockRejectedValueOnce(new Error(uploadCanary));
      await expect(
        h.runtime.sendTeamsFileConsentCard(
          thread(),
          buildTeamsFileConsentCard(binding),
        ),
      ).rejects.toThrow(
        mode === "missing ID" ? "receipt is unproven" : "result is unknown",
      );
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.app.api.serviceUrl).not.toContain(uploadCanary);
    },
  );
});
