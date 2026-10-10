import { createTeamsAdapter } from "@chat-adapter/teams";
import { describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { createChatSdkEndpointRuntime } from "./chat-sdk-runtime.js";
import {
  deriveTeamsInlineImageLocator,
  parseTeamsInlineImageLocator,
  teamsInlineImageDownloadUrl,
  type TeamsInlineImageScope,
} from "./chat-teams-inline-image-intake.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const endpointId = "22222222-2222-4222-8222-222222222222";
const tenantId = "33333333-3333-4333-8333-333333333333";
const botAppId = "44444444-4444-4444-8444-444444444444";
const principalExternalId = "55555555-5555-4555-8555-555555555555";
const url =
  "https://smba.trafficmanager.net/amer/v3/attachments/0-eus-synthetic/views/original";
const adapter = createTeamsAdapter({
  appId: botAppId,
  appPassword: "synthetic-unused",
  appTenantId: tenantId,
});
function fixture() {
  const raw = {
    type: "message",
    channelId: "msteams",
    id: "1740000000991",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    text: "synthetic private source",
    from: { id: "29:synthetic-user", aadObjectId: principalExternalId },
    recipient: { id: `28:${botAppId}`, isTargeted: false },
    conversation: {
      id: "19:synthetic@thread.tacv2",
      conversationType: "channel",
      tenantId,
    },
    channelData: { tenant: { id: tenantId } },
    attachments: [
      { contentUrl: url, contentType: "image/png", name: "picture.png" },
    ],
  };
  const message = adapter.parseMessage(raw);
  const scope: TeamsInlineImageScope = {
    companyId,
    endpointId,
    tenantId,
    botAppId,
    principalExternalId,
    runtimeGeneration: 3,
    credentialFingerprint: "a".repeat(64),
    threadId: message.threadId,
    messageId: message.id,
  };
  return { raw, message, scope };
}

describe("Teams source-bound inline image resources", () => {
  it("bounds cold SDK token acquisition and prevents a late aborted HTTP request", async () => {
    const f = fixture();
    const runtime = createChatSdkEndpointRuntime({
      companyId,
      endpointId,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Maya",
        credentials: {
          appId: botAppId,
          appPassword: "synthetic-unused",
          appTenantId: tenantId,
        },
      },
      callbacks: { onMessage() {} },
      logger: "silent",
      persistence: {
        async read() {
          return null;
        },
        async compareAndSet() {
          return true;
        },
        async deleteIfVersion() {
          return true;
        },
      },
    });
    const source = { ...f.scope, message: f.message, isDirectMessage: false };
    const descriptor = runtime.attachmentRecoveryDescriptor(
      f.message.attachments[0]!,
      source,
    )!;
    const image = runtime.rehydrateAttachment(descriptor, source)!;
    const client = (
      runtime.getProviderAdapter() as unknown as {
        app: {
          api: {
            http: { token: unknown; http: { defaults: { adapter: unknown } } };
          };
        };
      }
    ).app.api.http;
    let release!: (token: string) => void;
    client.token = () =>
      new Promise<string>((resolve) => {
        release = resolve;
      });
    const adapterRequest = vi.fn(async () => {
      throw new Error("Must not reach HTTP after deadline");
    });
    client.http.defaults.adapter = adapterRequest;
    vi.useFakeTimers();
    let settled = false;
    const result = image.fetchData!().then(
      () => {
        settled = true;
        return "unexpected success";
      },
      (error: unknown) => {
        settled = true;
        return (error as Error).message;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(settled).toBe(true);
      expect(await result).toBe("Teams inline image download unavailable");
      release("synthetic-never-transmitted-token");
      await vi.advanceTimersByTimeAsync(0);
      expect(adapterRequest).not.toHaveBeenCalled();
    } finally {
      release?.("synthetic-never-transmitted-token");
      vi.useRealTimers();
      await result;
      await runtime.shutdown();
    }
  });
  it.each(["channel", "groupChat"])(
    "binds the actual %s parser image without persisting URL, credentials, or text",
    (kind) => {
      const f = fixture();
      f.raw.conversation.conversationType = kind;
      const message = adapter.parseMessage(f.raw);
      const locator = deriveTeamsInlineImageLocator(
        message,
        message.attachments[0]!,
        f.scope,
      );
      expect(locator).toMatchObject({
        ...f.scope,
        kind: "teams_inline_image",
        hostname: "smba.trafficmanager.net",
        region: "amer",
        attachmentId: "0-eus-synthetic",
        view: "original",
        providerUserId: "29:synthetic-user",
      });
      expect(JSON.stringify(locator)).not.toMatch(
        /https:|synthetic-unused|private source|contentUrl|fetchMetadata/,
      );
      expect(teamsInlineImageDownloadUrl(locator!)).toBe(url);
      expect(
        parseTeamsInlineImageLocator(
          JSON.parse(JSON.stringify(locator)),
          f.scope,
        ),
      ).toEqual(locator);
    },
  );

  it.each([
    "wrong_tenant",
    "conflicting_tenant",
    "wrong_app",
    "targeted",
    "personal",
    "unknown_scope",
    "foreign_origin",
    "untrusted_host",
    "query",
    "fragment",
    "encoded_path",
    "traversal",
    "wrong_route",
    "wrong_region",
    "overlong_id",
    "file_download_info",
    "metadata_only",
    "wrong_source",
    "oversize",
  ])("refuses %s without trusting normalized fetchMetadata", (kind) => {
    const f = fixture();
    if (kind === "wrong_tenant") f.raw.conversation.tenantId = endpointId;
    if (kind === "conflicting_tenant") f.raw.channelData.tenant.id = endpointId;
    if (kind === "wrong_app") f.raw.recipient.id = `28:${endpointId}`;
    if (kind === "targeted") f.raw.recipient.isTargeted = true;
    if (kind === "personal") f.raw.conversation.conversationType = "personal";
    if (kind === "unknown_scope")
      f.raw.conversation.conversationType = "unknown";
    if (kind === "foreign_origin")
      f.raw.attachments[0]!.contentUrl = url.replace(
        "smba.trafficmanager.net",
        "other.botframework.com",
      );
    if (kind === "untrusted_host") {
      f.raw.serviceUrl = "https://evil.example/amer/";
      f.raw.attachments[0]!.contentUrl = url.replace(
        "smba.trafficmanager.net",
        "evil.example",
      );
    }
    if (kind === "query") f.raw.attachments[0]!.contentUrl += "?token=private";
    if (kind === "fragment") f.raw.attachments[0]!.contentUrl += "#private";
    if (kind === "encoded_path")
      f.raw.attachments[0]!.contentUrl = url.replace("0-eus", "%30-eus");
    if (kind === "traversal")
      f.raw.attachments[0]!.contentUrl = url.replace(
        "/amer/v3",
        "/other/../amer/v3",
      );
    if (kind === "wrong_route")
      f.raw.attachments[0]!.contentUrl =
        "https://smba.trafficmanager.net/amer/v3/conversations/private";
    if (kind === "wrong_region")
      f.raw.attachments[0]!.contentUrl = url.replace("/amer/", "/emea/");
    if (kind === "overlong_id")
      f.raw.attachments[0]!.contentUrl = url.replace(
        "0-eus-synthetic",
        "x".repeat(1025),
      );
    const message = adapter.parseMessage(f.raw);
    const attachment = message.attachments[0]!;
    if (kind === "file_download_info")
      f.raw.attachments[0]!.contentType =
        "application/vnd.microsoft.teams.file.download.info";
    if (kind === "metadata_only") f.raw.attachments.length = 0;
    if (kind === "wrong_source") f.scope.messageId = "different-source";
    if (kind === "oversize") attachment.size = MAX_ATTACHMENT_BYTES + 1;
    attachment.fetchMetadata = {
      auth: "bot",
      url,
      connectorOrigin: "https://smba.trafficmanager.net",
    };
    expect(
      deriveTeamsInlineImageLocator(message, attachment, f.scope),
    ).toBeNull();
  });

  it.each([
    "companyId",
    "endpointId",
    "tenantId",
    "botAppId",
    "principalExternalId",
    "runtimeGeneration",
    "credentialFingerprint",
    "threadId",
    "messageId",
  ] as const)("refuses retained %s mismatch", (key) => {
    const f = fixture();
    const locator = deriveTeamsInlineImageLocator(
      f.message,
      f.message.attachments[0]!,
      f.scope,
    )!;
    const scope = {
      ...f.scope,
      [key]:
        key === "runtimeGeneration"
          ? 4
          : key === "credentialFingerprint"
            ? "b".repeat(64)
            : "different",
    };
    expect(parseTeamsInlineImageLocator(locator, scope)).toBeNull();
  });

  it("refuses an open stored record or an unsafe reconstructed hostname", () => {
    const f = fixture();
    const locator = deriveTeamsInlineImageLocator(
      f.message,
      f.message.attachments[0]!,
      f.scope,
    )!;
    expect(
      parseTeamsInlineImageLocator({ ...locator, token: "private" }, f.scope),
    ).toBeNull();
    expect(
      parseTeamsInlineImageLocator(
        { ...locator, hostname: "evil.example" },
        f.scope,
      ),
    ).toBeNull();
  });

  it("reconstructs only an exact resource on the authenticated SDK HTTP client, bounded with no redirects", async () => {
    const f = fixture();
    const runtime = createChatSdkEndpointRuntime({
      companyId,
      endpointId,
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Maya",
        credentials: {
          appId: botAppId,
          appPassword: "synthetic-unused",
          appTenantId: tenantId,
        },
      },
      callbacks: { onMessage() {} },
      logger: "silent",
      persistence: {
        async read() {
          return null;
        },
        async compareAndSet() {
          return true;
        },
        async deleteIfVersion() {
          return true;
        },
      },
    });
    const source = { ...f.scope, message: f.message, isDirectMessage: false };
    const unsafe = vi.fn(async () => {
      throw new Error("untrusted supplied closure");
    });
    f.message.attachments[0]!.fetchData = unsafe;
    const descriptor = runtime.attachmentRecoveryDescriptor(
      f.message.attachments[0]!,
      source,
    )!;
    const http = (
      runtime.getProviderAdapter() as unknown as {
        app: { api: { http: { get(...args: unknown[]): Promise<unknown> } } };
      }
    ).app.api.http;
    const get = vi
      .spyOn(http, "get")
      .mockResolvedValue({ data: Buffer.from("synthetic bounded bytes") });
    try {
      expect(runtime.rehydrateAttachment(descriptor)).toBeNull();
      expect(
        runtime.rehydrateAttachment(descriptor, {
          ...source,
          messageId: "other",
        }),
      ).toBeNull();
      const rehydrated = runtime.rehydrateAttachment(
        JSON.parse(JSON.stringify(descriptor)),
        source,
      )!;
      expect(await rehydrated.fetchData!()).toEqual(
        Buffer.from("synthetic bounded bytes"),
      );
      expect(unsafe).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledExactlyOnceWith(
        url,
        expect.objectContaining({
          responseType: "arraybuffer",
          maxRedirects: 0,
          maxContentLength: MAX_ATTACHMENT_BYTES,
          maxBodyLength: MAX_ATTACHMENT_BYTES,
          timeout: 10_000,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(runtime.attachmentRecoveryDescriptor(rehydrated)).toEqual(
        descriptor,
      );
      get.mockRejectedValue(new Error(`PRIVATE ${url}`));
      await expect(rehydrated.fetchData!()).rejects.toThrow(
        "Teams inline image download unavailable",
      );
    } finally {
      get.mockRestore();
      await runtime.shutdown();
    }
  });
});
