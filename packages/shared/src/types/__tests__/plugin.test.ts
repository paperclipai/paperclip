import { describe, it, expect } from "vitest";
import type {
  OAuthProviderContribution,
  OAuthProviderContributionConfig,
  OAuthProviderShape,
  PaperclipPluginManifestV1,
} from "../plugin.js";

describe("plugin manifest oauth extension", () => {
  it("OAuthProviderContribution holds a config and an optional shape", () => {
    const cfg: OAuthProviderContributionConfig = {
      id: "x",
      displayName: "X",
      clientCredentials: { clientIdEnv: "X_ID", clientSecretEnv: "X_SECRET" },
      endpoints: {
        authorize: "https://x.example/a",
        token: "https://x.example/t",
        accountInfo: "https://x.example/me",
      },
      scopes: { default: [], offered: [] },
      pkce: "required",
      authMethod: "post",
      responseFormat: "json",
      accountIdField: "id",
      accountLabelField: "name",
      refresh: { supported: false },
    };
    const shape: OAuthProviderShape = {
      parseTokenResponse: () => ({ accessToken: "a" }),
      parseAccountInfo: () => ({ accountId: "a" }),
    };
    const c: OAuthProviderContribution = { config: cfg, shape };
    expect(c.config.id).toBe("x");
    expect(c.shape).toBeDefined();
    const cWithoutShape: OAuthProviderContribution = { config: cfg };
    expect(cWithoutShape.shape).toBeUndefined();
  });

  it("manifest.kind allows oauth_provider and composite alongside sandbox_provider", () => {
    type Kind = NonNullable<PaperclipPluginManifestV1["kind"]>;
    const a: Kind = "oauth_provider";
    const b: Kind = "composite";
    const c: Kind = "sandbox_provider";
    expect([a, b, c]).toEqual(["oauth_provider", "composite", "sandbox_provider"]);
  });

  it("manifest accepts an optional oauthProviders array (compile check)", () => {
    type WithOAuth = Pick<PaperclipPluginManifestV1, "oauthProviders">;
    const m: WithOAuth = {
      oauthProviders: [
        {
          config: {
            id: "x",
            displayName: "X",
            clientCredentials: { clientIdEnv: "X_ID", clientSecretEnv: "X_SECRET" },
            endpoints: {
              authorize: "https://x.example/a",
              token: "https://x.example/t",
              accountInfo: "https://x.example/me",
            },
            scopes: { default: [], offered: [] },
            pkce: "required",
            authMethod: "post",
            responseFormat: "json",
            accountIdField: "id",
            accountLabelField: "name",
            refresh: { supported: false },
          },
        },
      ],
    };
    expect(m.oauthProviders?.length).toBe(1);
  });
});
