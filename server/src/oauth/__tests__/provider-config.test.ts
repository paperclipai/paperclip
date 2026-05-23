import { describe, it, expect } from "vitest";
import { OAuthProviderConfigSchema } from "../provider-config.js";

const VALID = {
  id: "github",
  displayName: "GitHub",
  clientCredentials: { clientIdEnv: "X_ID", clientSecretEnv: "X_SECRET" },
  endpoints: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    accountInfo: "https://api.github.com/user",
  },
  scopes: { default: ["repo"], offered: ["repo", "workflow"] },
  pkce: "required",
  authMethod: "post",
  responseFormat: "json",
  accountIdField: "id",
  accountLabelField: "login",
  refresh: { supported: false },
};

describe("OAuthProviderConfigSchema", () => {
  it("accepts a valid config", () => {
    expect(OAuthProviderConfigSchema.parse(VALID).id).toBe("github");
  });

  it("rejects http:// endpoints", () => {
    const bad = {
      ...VALID,
      endpoints: { ...VALID.endpoints, token: "http://insecure.example/token" },
    };
    expect(() => OAuthProviderConfigSchema.parse(bad)).toThrow();
  });

  it("rejects unknown PKCE mode", () => {
    expect(() => OAuthProviderConfigSchema.parse({ ...VALID, pkce: "weird" })).toThrow();
  });

  it("rejects refresh.supported=true without rotatesRefreshToken", () => {
    const bad = { ...VALID, refresh: { supported: true } };
    expect(() => OAuthProviderConfigSchema.parse(bad)).toThrow();
  });

  it("rejects scopes.default not subset of offered", () => {
    const bad = { ...VALID, scopes: { default: ["unknown"], offered: ["repo"] } };
    expect(() => OAuthProviderConfigSchema.parse(bad)).toThrow();
  });
});
