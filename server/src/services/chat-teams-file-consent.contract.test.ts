import { afterEach, describe, expect, it, vi } from "vitest";
import { createTeamsAdapter } from "@chat-adapter/teams";
import type { Logger } from "chat";
import {
  installTeamsFileConsentHook,
  type TeamsConsentApp,
} from "./chat-teams-file-consent.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const appId = "22222222-2222-4222-8222-222222222222";
const companyId = "33333333-3333-4333-8333-333333333333";
const endpointId = "44444444-4444-4444-8444-444444444444";
const userId = "29:synthetic-consent-user";
const aadObjectId = "55555555-5555-4555-8555-555555555555";
const conversationId = "a:synthetic-personal-chat";
const token = `pcfc_${"A".repeat(43)}`;
const serviceUrl = "https://smba.trafficmanager.net/amer/";

function invoke(action: "accept" | "decline") {
  return {
    type: "invoke",
    name: "fileConsent/invoke",
    id: `synthetic-${action}`,
    channelId: "msteams",
    serviceUrl,
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
      context: { schema: "paperclip.teams.file-consent.v1", token, action },
      ...(action === "accept"
        ? {
            uploadInfo: {
              name: "report.txt",
              fileType: "txt",
              uniqueId: "drive-item-1",
              contentUrl:
                "https://contoso-my.sharepoint.com/personal/user/Documents/report.txt",
              uploadUrl:
                "https://contoso-my.sharepoint.com/personal/user/_api/v2.0/drive/items/item/uploadSession?upload-token=SYNTHETIC-UPLOAD-CANARY",
            },
          }
        : {}),
    },
  };
}

// Real pinned adapter HTTP bridge + Microsoft Teams App router. Only its
// service-token validator is replaced. This is NOT live tenant/JWT proof or
// Paperclip DB authorization. No request may contact any external service.
describe("pinned Teams file-consent invoke boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function harness() {
    const network = vi.fn(async () => {
      throw new Error("No network in this fixture");
    });
    vi.stubGlobal("fetch", network);
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child() {
        return this;
      },
    };
    const adapter = createTeamsAdapter({
      appId,
      appPassword: "synthetic-only",
      appTenantId: tenantId,
      appType: "SingleTenant",
      logger,
    });
    await adapter.initialize({
      getState: () => ({ get: async () => null, set: async () => {} }),
    } as never);
    const app = (
      adapter as unknown as {
        app: {
          server: {
            serviceTokenValidator: {
              check(
                header: string,
                body: Record<string, unknown>,
              ): Promise<unknown>;
            };
          };
        };
      }
    ).app;
    const check = vi
      .spyOn(app.server.serviceTokenValidator, "check")
      .mockImplementation(async (header, body) => {
        if (header !== "Bearer synthetic-service-token")
          throw new Error("Synthetic auth refusal");
        return {
          appId,
          from: "azure",
          fromId: "synthetic-service",
          serviceUrl: body.serviceUrl,
          isExpired: () => false,
        };
      });
    const callback = vi.fn<
      (event: unknown) => Promise<"recorded" | "ignored" | "denied">
    >(async () => "recorded");
    installTeamsFileConsentHook(app as unknown as TeamsConsentApp, {
      companyId,
      endpointId,
      tenantId,
      botAppId: appId,
      onConsent: callback,
    });
    const dispatch = async (
      activity: unknown,
      authorization = "Bearer synthetic-service-token",
    ) =>
      adapter.handleWebhook(
        new Request("https://paperclip.test/chat-webhook", {
          method: "POST",
          headers: { "content-type": "application/json", authorization },
          body: JSON.stringify(activity),
        }),
      );
    return { callback, dispatch, check, network, logger };
  }

  it.each(["accept", "decline"] as const)(
    "dispatches authenticated %s to the closed consent callback",
    async (action) => {
      const { callback, dispatch, check, network } = await harness();
      const response = await dispatch(invoke(action));
      expect(response.status).toBe(200);
      expect(check).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]![0]).toMatchObject({
        companyId,
        endpointId,
        action,
        conversationId,
        userId,
        aadObjectId,
        tenantId,
      });
      expect(JSON.stringify(callback.mock.calls)).not.toContain(
        "SYNTHETIC-UPLOAD-CANARY",
      );
      expect(network).not.toHaveBeenCalled();
    },
  );

  it.each(["", "Bearer wrong-synthetic-token"])(
    "rejects an unverified request before the hook (%#)",
    async (authorization) => {
      const { callback, dispatch, network } = await harness();
      const response = await dispatch(invoke("accept"), authorization);
      expect(response.status).toBe(401);
      expect(callback).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "foreign tenant",
      (a: ReturnType<typeof invoke>) => {
        a.channelData.tenant.id = companyId;
      },
    ],
    [
      "foreign bot",
      (a: ReturnType<typeof invoke>) => {
        a.recipient.id = `28:${endpointId}`;
      },
    ],
    [
      "channel",
      (a: ReturnType<typeof invoke>) => {
        a.conversation.conversationType = "channel";
      },
    ],
    [
      "group",
      (a: ReturnType<typeof invoke>) => {
        a.conversation.conversationType = "groupChat";
      },
    ],
    [
      "swapped action",
      (a: ReturnType<typeof invoke>) => {
        a.value.context.action = "decline";
      },
    ],
  ])(
    "rejects authenticated but mismatched %s without ordinary message/action dispatch",
    async (_name, mutate) => {
      const { callback, dispatch, check, network } = await harness();
      const raw = invoke("accept");
      mutate(raw);
      const response = await dispatch(raw);
      expect([400, 403]).toContain(response.status);
      expect(check).toHaveBeenCalledTimes(1);
      expect(callback).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("does not acknowledge while the durable callback is pending, and does not call file delivery an invoke ACK", async () => {
    const { callback, dispatch, network } = await harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    callback.mockImplementationOnce(async () => {
      await held;
      return "recorded";
    });
    let responded = false;
    const pending = dispatch(invoke("accept")).then((response) => {
      responded = true;
      return response;
    });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(responded).toBe(false);
    release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(network).not.toHaveBeenCalled(); // No upload or file-info publication.
  });

  it("keeps callback persistence failure retryable without leaking a capability through SDK errors", async () => {
    const { callback, dispatch, network, logger } = await harness();
    callback.mockRejectedValueOnce(new Error("SYNTHETIC-UPLOAD-CANARY"));
    const response = await dispatch(invoke("accept"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SYNTHETIC-UPLOAD-CANARY");
    expect(
      JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain("SYNTHETIC-UPLOAD-CANARY");
    expect(network).not.toHaveBeenCalled();
  });

  it("projects repeated delivery IDs unchanged for caller-owned durable deduplication", async () => {
    const { callback, dispatch, network } = await harness();
    await dispatch(invoke("decline"));
    await dispatch(invoke("decline"));
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[0]![0]).toEqual(callback.mock.calls[1]![0]);
    expect(network).not.toHaveBeenCalled();
  });
});
