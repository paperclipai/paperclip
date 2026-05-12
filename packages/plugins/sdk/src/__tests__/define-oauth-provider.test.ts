import { describe, it, expect } from "vitest";
import { defineOAuthProvider } from "../define-oauth-provider.js";

describe("defineOAuthProvider", () => {
  it("returns its input unchanged (identity helper)", () => {
    const contribution = {
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
        pkce: "required" as const,
        authMethod: "post" as const,
        responseFormat: "json" as const,
        accountIdField: "id",
        accountLabelField: "name",
        refresh: { supported: false as const },
      },
    };
    expect(defineOAuthProvider(contribution)).toBe(contribution);
  });
});
