import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveVercelConnectSubject,
  vercelConnectCallbackUrl,
  vercelConnectIntegrationStatus,
  vercelConnectSdkOptions,
  vercelGrantReference,
  vercelTokenRequest,
} from "./vercel-connect.js";
import type { VercelConnectCredentialReference } from "@paperclipai/shared";

const credential: VercelConnectCredentialReference = {
  provider: "vercel_connect",
  connectorId: "scl_posthog",
  connectorUid: "posthog-paperclip",
  service: "posthog",
  connectorType: "api-key",
  principalMode: "user",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  scopes: ["read", "write"],
};

afterEach(() => vi.unstubAllEnvs());

describe("Vercel Connect credential adapter", () => {
  it("canonicalizes Paperclip's loopback callback to Vercel's accepted localhost form", () => {
    expect(vercelConnectCallbackUrl(
      "http://127.0.0.1:3200/api/tools/oauth/callback?stale=1#fragment",
      "one-time-state",
    )).toBe("http://localhost:3200/api/tools/vercel-connect/callback?state=one-time-state");
    expect(vercelConnectCallbackUrl(
      "https://paperclip.example/api/tools/oauth/callback",
      "one-time-state",
    )).toBe("https://paperclip.example/api/tools/vercel-connect/callback?state=one-time-state");
  });

  it("gates new setup separately from runtime credential availability", () => {
    expect(vercelConnectIntegrationStatus({
      PAPERCLIP_VERCEL_CONNECT_ENABLED: "false",
      PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN: "bootstrap-token",
    } as NodeJS.ProcessEnv)).toMatchObject({
      enabled: false,
      configured: true,
      authentication: "access_token",
    });
    expect(vercelConnectIntegrationStatus({
      PAPERCLIP_VERCEL_CONNECT_ENABLED: "true",
      VERCEL_OIDC_TOKEN: "workload-token",
      PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN: "fallback-token",
    } as NodeJS.ProcessEnv)).toMatchObject({
      enabled: true,
      configured: true,
      authentication: "workload_oidc",
    });
  });

  it("prefers workload OIDC over the access-token fallback", () => {
    expect(vercelConnectSdkOptions({
      VERCEL_OIDC_TOKEN: "workload-token",
      PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN: "stale-fallback-token",
    } as NodeJS.ProcessEnv)).toEqual({});
    expect(vercelConnectSdkOptions({
      PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN: "fallback-token",
    } as NodeJS.ProcessEnv, true)).toEqual({
      vercelToken: "fallback-token",
      forceRefresh: true,
    });
  });

  it("derives stable company- and user-bound subjects without browser input", () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "instance-one");
    const base = {
      credential,
      connectionId: "connection-one",
      companyId: "company-one",
      grantKind: "user" as const,
      subjectUserId: "user-one",
    };
    const first = deriveVercelConnectSubject(base);
    expect(first).toEqual(deriveVercelConnectSubject(base));
    expect(first.subject).toMatchObject({ type: "user", id: expect.stringMatching(/^pc_/) });
    expect(deriveVercelConnectSubject({ ...base, companyId: "company-two" }).subject).not.toEqual(first.subject);
    expect(deriveVercelConnectSubject({ ...base, subjectUserId: "user-two" }).subject).not.toEqual(first.subject);
  });

  it("uses app subjects without reusable browser-provided identifiers", () => {
    const appCredential = { ...credential, principalMode: "app" as const };
    expect(deriveVercelConnectSubject({
      credential: appCredential,
      connectionId: "connection-one",
      companyId: "company-one",
      grantKind: "organization",
    })).toEqual({ subject: { type: "app" } });
    expect(vercelTokenRequest({
      credential: appCredential,
      connectionId: "connection-one",
      companyId: "company-one",
      resources: ["https://mcp.posthog.com/mcp"],
      grant: { kind: "organization", subjectUserId: null, externalCredential: null },
    })).toMatchObject({
      connector: "posthog-paperclip",
      subject: { type: "app" },
      resources: ["https://mcp.posthog.com/mcp"],
    });
  });

  it("persists only the allow-listed grant summary, never bearer or upstream claims", () => {
    const reference = vercelGrantReference({
      credential,
      subjectId: "pc_subject",
      verifiedAt: new Date("2026-08-26T12:00:00.000Z"),
      token: {
        token: "provider-bearer-must-not-persist",
        tokenId: "stk_123",
        expiresAt: Date.parse("2026-08-26T13:00:00.000Z"),
        connector: { id: "scl_posthog", uid: "posthog-paperclip", type: "api-key" },
        installationId: "installation-1",
        tenantId: "project-1",
        claims: { email: "private@example.com" },
        metadata: { arbitrary: "private" },
      },
    });
    expect(reference).toEqual({
      provider: "vercel_connect",
      subjectType: "user",
      subjectId: "pc_subject",
      installationId: "installation-1",
      tenantId: "project-1",
      tokenId: "stk_123",
      expiresAt: "2026-08-26T13:00:00.000Z",
      lastVerifiedAt: "2026-08-26T12:00:00.000Z",
    });
    expect(JSON.stringify(reference)).not.toContain("provider-bearer");
    expect(JSON.stringify(reference)).not.toContain("private@example.com");
  });
});
