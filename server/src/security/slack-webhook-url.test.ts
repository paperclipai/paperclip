import { describe, expect, it } from "vitest";
import { validateSlackWebhookUrl } from "./slack-webhook-url.js";

describe("validateSlackWebhookUrl", () => {
  const strict = {
    allowInsecureWebhookUrls: false,
    isProductionLike: false,
  } as const;

  it("allows https://hooks.slack.com webhook URLs", () => {
    const result = validateSlackWebhookUrl("https://hooks.slack.com/services/T1/B2/C3", strict);
    expect(result.usedInsecureException).toBe(false);
    expect(result.hostname).toBe("hooks.slack.com");
  });

  it("rejects http://hooks.slack.com webhook URLs by default", () => {
    expect(() =>
      validateSlackWebhookUrl("http://hooks.slack.com/services/T1/B2/C3", strict),
    ).toThrow("must use https://");
  });

  it("rejects malformed webhook URLs", () => {
    expect(() => validateSlackWebhookUrl("not a url", strict)).toThrow("invalid");
  });

  it("rejects non-Slack https hosts", () => {
    expect(() =>
      validateSlackWebhookUrl("https://example.com/services/T1/B2/C3", strict),
    ).toThrow("host is not allowed");
  });

  it("accepts loopback http only when dev exception is enabled in non-production", () => {
    const result = validateSlackWebhookUrl("http://127.0.0.1:9999/slack-webhook", {
      allowInsecureWebhookUrls: true,
      isProductionLike: false,
    });
    expect(result.usedInsecureException).toBe(true);
    expect(result.hostname).toBe("127.0.0.1");
  });

  it("rejects loopback http when dev exception is disabled", () => {
    expect(() =>
      validateSlackWebhookUrl("http://localhost:3000/slack", {
        allowInsecureWebhookUrls: false,
        isProductionLike: false,
      }),
    ).toThrow("ALLOW_INSECURE_WEBHOOK_URLS=true");
  });

  it("rejects loopback http in production even when exception flag would otherwise allow it", () => {
    expect(() =>
      validateSlackWebhookUrl("http://localhost:3000/slack", {
        allowInsecureWebhookUrls: true,
        isProductionLike: true,
      }),
    ).toThrow("ALLOW_INSECURE_WEBHOOK_URLS=true");
  });
});
