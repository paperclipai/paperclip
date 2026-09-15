import { describe, expect, it } from "vitest";
import {
  isPrivateChatWebhookHttpRequest,
  isSecretSensitiveHttpRequest,
  shouldSilenceHttpSuccessLog,
} from "../middleware/http-log-policy.js";

describe("isPrivateChatWebhookHttpRequest", () => {
  it("protects the native webhook namespace, including rejected methods and query data", () => {
    for (const provider of [
      "slack",
      "github",
      "discord",
      "telegram",
      "microsoft-teams",
    ]) {
      for (const method of ["POST", "GET", "PUT", "DELETE"]) {
        for (const suffix of ["", "/", "?ignored=private"]) {
          const path = `/api/chat-webhooks/endpoint-1/${provider}${suffix}`;
          expect(isPrivateChatWebhookHttpRequest(method, path)).toBe(true);
          expect(isSecretSensitiveHttpRequest(method, path)).toBe(true);
        }
      }
    }
    expect(
      isPrivateChatWebhookHttpRequest("POST", "/API/CHAT-WEBHOOKS/id/SLACK"),
    ).toBe(true);
    for (const path of [
      "/api/chat-webhooks",
      "/api/chat-webhooks/id",
      "/api/chat-webhooks/id/slack/history",
      "/api/chat-webhooks//slack",
      "/api/chat-webhooks/%2Fprivate/%XX",
      "http://host.invalid/api/chat-webhooks/id/slack?private=true",
      "http://host.invalid/api/chat-webhooks/../private-component",
      "HTTPS://user:private@host.invalid/API/CHAT-WEBHOOKS/id/SLACK/",
    ])
      expect(isPrivateChatWebhookHttpRequest("POST", path)).toBe(true);
  });

  it("does not change adjacent non-webhook routes", () => {
    for (const path of [
      "/api/chat-webhooks-extra/id/slack",
      "https://host.invalid/api/chat-webhooks-extra/id/slack",
      "/api/other/chat-webhooks/id/slack",
      "/api/chat-endpoints/id/test",
      "/chat-webhooks/id/slack",
    ])
      expect(isPrivateChatWebhookHttpRequest("POST", path)).toBe(false);
    expect(
      isPrivateChatWebhookHttpRequest(undefined, "/api/chat-webhooks/id/slack"),
    ).toBe(false);
    expect(isPrivateChatWebhookHttpRequest("POST", undefined)).toBe(false);
  });
});

describe("isSecretSensitiveHttpRequest", () => {
  it("identifies credential-bearing chat setup mutations", () => {
    expect(
      isSecretSensitiveHttpRequest(
        "POST",
        "/api/chat-endpoints/endpoint-1/setup",
      ),
    ).toBe(true);
    expect(
      isSecretSensitiveHttpRequest(
        "POST",
        "/api/chat-endpoints/endpoint-1/setup-secret?rotation=true",
      ),
    ).toBe(true);
    expect(
      isSecretSensitiveHttpRequest(
        "GET",
        "/api/chat-endpoints/endpoint-1/setup",
      ),
    ).toBe(false);
    expect(
      isSecretSensitiveHttpRequest(
        "POST",
        "/api/chat-endpoints/endpoint-1/test",
      ),
    ).toBe(false);
  });
});

describe("shouldSilenceHttpSuccessLog", () => {
  it("silences cached 304 responses", () => {
    expect(
      shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 304),
    ).toBe(true);
  });

  it("silences successful polling endpoints", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 200)).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/heartbeat-runs",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/heartbeat-runs/b7044268-19b6-4b3a-a9f3-9c57dce70253/log?offset=1103894&limitBytes=256000",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/live-runs?minCount=3",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "HEAD",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/sidebar-badges",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/issues?includeRoutineExecutions=true",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/activity",
        200,
      ),
    ).toBe(true);
  });

  it("silences successful static asset requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/index.html", 200)).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/@fs/Users/dotta/paperclip/ui/src/main.tsx",
        200,
      ),
    ).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/src/App.tsx?t=123", 200)).toBe(
      true,
    );
    expect(shouldSilenceHttpSuccessLog("GET", "/site.webmanifest", 200)).toBe(
      true,
    );
    expect(shouldSilenceHttpSuccessLog("GET", "/sw.js", 200)).toBe(true);
  });

  it("keeps normal successful application requests", () => {
    expect(
      shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 200),
    ).toBe(false);
    expect(
      shouldSilenceHttpSuccessLog("PATCH", "/api/issues/PAP-1383", 200),
    ).toBe(false);
  });

  it("keeps failing requests visible", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 500)).toBe(false);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/@fs/Users/dotta/paperclip/ui/src/main.tsx",
        404,
      ),
    ).toBe(false);
  });
});
