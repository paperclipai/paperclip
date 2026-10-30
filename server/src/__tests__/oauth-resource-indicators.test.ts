import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  isMicrosoftOAuthUrl,
  isMicrosoftResourceUrl,
  isMicrosoftV2OAuthUrl,
  shouldOmitMicrosoftResourceIndicator,
} from "../services/tool-access/oauth/metadata.js";
import {
  normalizeOAuthProviderError,
  oauthProviderErrorMessage,
} from "../services/tool-access/oauth/provider-errors.js";
import { createOAuthClientProtocol } from "../services/tool-access/oauth/client.js";
import { createOAuthAuthorizationStart } from "../services/tool-access/oauth/authorization-start.js";

describe("OAuth Resource Indicators and Provider Handling", () => {
  describe("isMicrosoftV2OAuthUrl", () => {
    it.each([
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "https://login.microsoftonline.com/tenant-id-123/oauth2/v2.0/token",
      "https://login.microsoft.com/v2.0",
      "https://custom.login.microsoftonline.com/oauth2/v2.0/authorize",
    ])("recognizes Microsoft Entra ID v2.0 endpoint %s", (url) => {
      expect(isMicrosoftV2OAuthUrl(url)).toBe(true);
      expect(isMicrosoftOAuthUrl(url)).toBe(true);
    });

    it.each([
      "https://login.microsoftonline.com/common/oauth2/authorize",
      "https://login.microsoftonline.com/tenant-id-123/oauth2/token",
      "https://login.windows.net/tenant-id-123/oauth2/token",
    ])("rejects Microsoft v1 endpoint %s so resource parameter is preserved", (url) => {
      expect(isMicrosoftV2OAuthUrl(url)).toBe(false);
      expect(isMicrosoftOAuthUrl(url)).toBe(false);
    });

    it.each([
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://github.com/login/oauth/authorize",
      "https://app.asana.com/-/oauth_authorize",
      "https://mcp.example.com/oauth/authorize",
      "",
      null,
      undefined,
    ])("rejects non-Microsoft endpoint %s", (url) => {
      expect(isMicrosoftV2OAuthUrl(url)).toBe(false);
    });
  });

  describe("isMicrosoftResourceUrl", () => {
    it.each([
      "https://mcp.dev.azure.com/CareConnections",
      "https://dev.azure.com/my-org",
      "https://graph.microsoft.com",
      "https://management.azure.com",
      "https://app.vssps.visualstudio.com",
      "https://api.office.com",
    ])("recognizes Microsoft resource destination %s", (url) => {
      expect(isMicrosoftResourceUrl(url)).toBe(true);
    });

    it.each([
      "https://attacker.evil/mcp",
      "https://evil-mcp.com/sse",
      "https://example.com/api",
      "https://github.com",
      "",
      null,
      undefined,
    ])("rejects non-Microsoft resource %s", (url) => {
      expect(isMicrosoftResourceUrl(url)).toBe(false);
    });
  });

  describe("shouldOmitMicrosoftResourceIndicator", () => {
    it("omits resource for verified Microsoft v2 endpoint and Microsoft resource", () => {
      expect(
        shouldOmitMicrosoftResourceIndicator({
          oauthUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
          resource: "https://mcp.dev.azure.com/CareConnections",
          scopes: ["https://mcp.dev.azure.com/.default", "offline_access"],
        }),
      ).toBe(true);
    });

    it("does NOT omit resource if resource belongs to an untrusted non-Microsoft host (negative test)", () => {
      expect(
        shouldOmitMicrosoftResourceIndicator({
          oauthUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
          resource: "https://attacker.evil/mcp",
          scopes: ["https://graph.microsoft.com/.default"],
        }),
      ).toBe(false);
    });

    it("does NOT omit resource if requested scope targets a different resource host (negative test)", () => {
      expect(
        shouldOmitMicrosoftResourceIndicator({
          oauthUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
          resource: "https://mcp.dev.azure.com/CareConnections",
          scopes: ["https://graph.microsoft.com/.default"],
        }),
      ).toBe(false);
    });

    it("does NOT omit resource for Microsoft v1 endpoints", () => {
      expect(
        shouldOmitMicrosoftResourceIndicator({
          oauthUrl: "https://login.microsoftonline.com/common/oauth2/authorize",
          resource: "https://graph.microsoft.com",
          scopes: ["https://graph.microsoft.com/.default"],
        }),
      ).toBe(false);
    });

    it("does NOT omit resource for generic non-Microsoft OAuth providers", () => {
      expect(
        shouldOmitMicrosoftResourceIndicator({
          oauthUrl: "https://oauth.example.com/authorize",
          resource: "https://mcp.example.com/server",
          scopes: ["tools.read"],
        }),
      ).toBe(false);
    });
  });

  describe("Authorization URL construction", () => {
    function createMockAuthStart(authorizationUrl: string, resource: string | null, scopes: string[] = ["https://mcp.dev.azure.com/.default"]) {
      const mockDb = {
        delete: () => ({ where: () => Promise.resolve() }),
        insert: () => ({ values: () => Promise.resolve() }),
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      } as unknown as Db;

      const connectionRow = {
        id: "conn-fixture",
        companyId: "company-fixture",
        name: "Test Connection",
        status: "draft" as const,
        credentialPolicy: "per_user" as const,
        config: { transport: "http", sourceTemplateKey: null },
      };

      return createOAuthAuthorizationStart(mockDb, {
        now: () => new Date(),
        getConnectionRow: async () => connectionRow as any,
        setupPolicy: {
          assertConnectorConnectionSetupEnabled: async () => {},
          assertExperimentalConnectorSetupEnabled: async () => {},
        } as any,
        fixedPersonalIdentityForReconnect: async () => null,
        currentCloudConnector: () => null,
        vercelConnect: null,
        ensureOAuthClient: async () => ({
          connection: connectionRow as any,
          client: {
            clientId: "fixture-client-id",
            clientIdEnv: null,
            clientSecret: null,
            clientSecretEnv: null,
          },
          source: "static" as const,
        }),
        oauthEndpointsForConnection: async () => ({
          provider: "fixture-provider",
          authorizationUrl,
          tokenUrl: "https://example.com/token",
          resource,
          offlineAccessSupported: true,
          scopes,
        }),
        assertOAuthEndpointUrl: (_type, url) => url,
      });
    }

    it("omits resource parameter from authorization URL for Microsoft Entra ID v2.0 with Microsoft resource", async () => {
      const startOAuth = createMockAuthStart(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "https://mcp.dev.azure.com/CareConnections",
        ["https://mcp.dev.azure.com/.default"],
      );

      const result = await startOAuth("company-fixture", "conn-fixture", {
        redirectUri: "https://paperclip.example:3100/api/tools/oauth/callback",
        actor: { actorType: "user", actorId: "user-123" },
      });

      const url = new URL(result.authorizationUrl);
      expect(url.searchParams.get("resource")).toBeNull();
      expect(url.searchParams.get("client_id")).toBe("fixture-client-id");
    });

    it("preserves resource parameter when metadata pairs a Microsoft v2 auth server with a non-Microsoft resource (negative test)", async () => {
      const startOAuth = createMockAuthStart(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "https://attacker.evil/mcp",
        ["https://graph.microsoft.com/.default"],
      );

      const result = await startOAuth("company-fixture", "conn-fixture", {
        redirectUri: "https://paperclip.example:3100/api/tools/oauth/callback",
        actor: { actorType: "user", actorId: "user-123" },
      });

      const url = new URL(result.authorizationUrl);
      expect(url.searchParams.get("resource")).toBe("https://attacker.evil/mcp");
    });

    it("preserves resource parameter on authorization URL for Microsoft v1 endpoints", async () => {
      const startOAuth = createMockAuthStart(
        "https://login.microsoftonline.com/common/oauth2/authorize",
        "https://graph.microsoft.com",
        ["https://graph.microsoft.com/.default"],
      );

      const result = await startOAuth("company-fixture", "conn-fixture", {
        redirectUri: "https://paperclip.example:3100/api/tools/oauth/callback",
        actor: { actorType: "user", actorId: "user-123" },
      });

      const url = new URL(result.authorizationUrl);
      expect(url.searchParams.get("resource")).toBe("https://graph.microsoft.com");
    });

    it("preserves resource parameter on authorization URL for generic providers", async () => {
      const startOAuth = createMockAuthStart(
        "https://oauth.example.com/authorize",
        "https://mcp.example.com/server",
        ["tools.read"],
      );

      const result = await startOAuth("company-fixture", "conn-fixture", {
        redirectUri: "https://paperclip.example:3100/api/tools/oauth/callback",
        actor: { actorType: "user", actorId: "user-123" },
      });

      const url = new URL(result.authorizationUrl);
      expect(url.searchParams.get("resource")).toBe("https://mcp.example.com/server");
    });
  });

  describe("Token exchange and refresh requests", () => {
    function setupClientProtocol() {
      const calls: Array<{ url: string; body: URLSearchParams }> = [];
      const fetchRemoteHttpUrl = vi.fn().mockImplementation(async (url: string, init: any) => {
        calls.push({ url, body: init.body as URLSearchParams });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "fixture-access-token",
            refresh_token: "fixture-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        };
      });

      const protocol = createOAuthClientProtocol({
        fetchRemoteHttpUrl,
        assertOAuthEndpointUrl: (_type, url) => url,
      });

      return { protocol, calls };
    }

    describe("code exchange", () => {
      it("omits resource in POST body for Microsoft Entra ID v2.0 token endpoint with Microsoft resource", async () => {
        const { protocol, calls } = setupClientProtocol();

        await protocol.exchangeOAuthToken({
          tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          clientId: "client-fixture",
          code: "authz-code-123",
          redirectUri: "https://paperclip.example:3100/api/tools/oauth/callback",
          codeVerifier: "verifier-xyz",
          resource: "https://mcp.dev.azure.com/CareConnections",
          scopes: ["https://mcp.dev.azure.com/.default"],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].body.get("resource")).toBeNull();
        expect(calls[0].body.get("grant_type")).toBe("authorization_code");
      });

      it("preserves resource in POST body when pairing Microsoft v2 token URL with non-Microsoft resource (negative test)", async () => {
        const { protocol, calls } = setupClientProtocol();

        await protocol.exchangeOAuthToken({
          tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          clientId: "client-fixture",
          code: "authz-code-123",
          redirectUri: "https://paperclip.example:3100/api/tools/oauth/callback",
          codeVerifier: "verifier-xyz",
          resource: "https://attacker.evil/mcp",
          scopes: ["https://graph.microsoft.com/.default"],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].body.get("resource")).toBe("https://attacker.evil/mcp");
      });

      it("preserves resource in POST body for Microsoft v1 token endpoint", async () => {
        const { protocol, calls } = setupClientProtocol();

        await protocol.exchangeOAuthToken({
          tokenUrl: "https://login.microsoftonline.com/common/oauth2/token",
          clientId: "client-fixture",
          code: "authz-code-123",
          redirectUri: "https://paperclip.example:3100/api/tools/oauth/callback",
          codeVerifier: "verifier-xyz",
          resource: "https://graph.microsoft.com",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].body.get("resource")).toBe("https://graph.microsoft.com");
      });

      it("preserves resource in POST body for generic provider", async () => {
        const { protocol, calls } = setupClientProtocol();

        await protocol.exchangeOAuthToken({
          tokenUrl: "https://oauth.example.com/token",
          clientId: "client-fixture",
          code: "authz-code-123",
          redirectUri: "https://paperclip.example:3100/api/tools/oauth/callback",
          codeVerifier: "verifier-xyz",
          resource: "https://mcp.example.com/server",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].body.get("resource")).toBe("https://mcp.example.com/server");
      });
    });

    describe("token refresh", () => {
      it("omits resource in POST body for Microsoft Entra ID v2.0 token endpoint with Microsoft resource during refresh", async () => {
        const { protocol, calls } = setupClientProtocol();

        await protocol.exchangeOAuthToken({
          tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          clientId: "client-fixture",
          grantType: "refresh_token",
          refreshToken: "refresh-xyz",
          resource: "https://mcp.dev.azure.com/CareConnections",
          scopes: ["https://mcp.dev.azure.com/.default"],
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].body.get("resource")).toBeNull();
        expect(calls[0].body.get("grant_type")).toBe("refresh_token");
      });

      it("preserves resource in POST body for Microsoft v2 token URL with non-Microsoft resource during refresh (negative test)", async () => {
        const { protocol, calls } = setupClientProtocol();

        await protocol.exchangeOAuthToken({
          tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          clientId: "client-fixture",
          grantType: "refresh_token",
          refreshToken: "refresh-xyz",
          resource: "https://attacker.evil/mcp",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].body.get("resource")).toBe("https://attacker.evil/mcp");
      });

      it("preserves resource in POST body for Microsoft v1 token endpoint during refresh", async () => {
        const { protocol, calls } = setupClientProtocol();

        await protocol.exchangeOAuthToken({
          tokenUrl: "https://login.microsoftonline.com/common/oauth2/token",
          clientId: "client-fixture",
          grantType: "refresh_token",
          refreshToken: "refresh-xyz",
          resource: "https://graph.microsoft.com",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].body.get("resource")).toBe("https://graph.microsoft.com");
      });

      it("preserves resource in POST body for generic provider during refresh", async () => {
        const { protocol, calls } = setupClientProtocol();

        await protocol.exchangeOAuthToken({
          tokenUrl: "https://oauth.example.com/token",
          clientId: "client-fixture",
          grantType: "refresh_token",
          refreshToken: "refresh-xyz",
          resource: "https://mcp.example.com/server",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].body.get("resource")).toBe("https://mcp.example.com/server");
      });
    });
  });

  describe("RFC 8707 provider error handling", () => {
    it("recognizes and normalizes invalid_target error code", () => {
      expect(normalizeOAuthProviderError("invalid_target")).toBe("invalid_target");
    });

    it("maps invalid_target to a friendly error message", () => {
      expect(
        oauthProviderErrorMessage(
          "invalid_target",
          "The authorization server denied the request.",
        ),
      ).toBe("The authorization server rejected the requested resource target.");
    });
  });
});
