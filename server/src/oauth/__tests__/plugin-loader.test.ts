import { describe, it, expect } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { ProviderRegistry } from "../registry.js";
import { registerPluginContributions } from "../plugin-loader.js";

const baseConfig = {
  id: "stripe",
  displayName: "Stripe",
  clientCredentials: {
    clientIdEnv: "STRIPE_OAUTH_CLIENT_ID",
    clientSecretEnv: "STRIPE_OAUTH_CLIENT_SECRET",
  },
  endpoints: {
    authorize: "https://stripe.example/a",
    token: "https://stripe.example/t",
    accountInfo: "https://stripe.example/me",
  },
  scopes: { default: [], offered: [] },
  pkce: "required" as const,
  authMethod: "post" as const,
  responseFormat: "json" as const,
  accountIdField: "id",
  accountLabelField: "name",
  refresh: { supported: false as const },
};

const manifestBase = {
  id: "example.stripe",
  apiVersion: 1 as const,
  version: "1.0.0",
  displayName: "Stripe",
  description: "Stripe OAuth provider",
  author: "Example",
  categories: ["integration"],
  capabilities: ["plugin.bridge"],
  entrypoints: { worker: "./worker.js" },
};

const oauthManifest = {
  ...manifestBase,
  kind: "oauth_provider" as const,
  oauthProviders: [{ config: baseConfig }],
} as unknown as PaperclipPluginManifestV1;

describe("registerPluginContributions", () => {
  it("registers provider when env set", () => {
    const env = {
      STRIPE_OAUTH_CLIENT_ID: "x",
      STRIPE_OAUTH_CLIENT_SECRET: "y",
    } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    registerPluginContributions(r, [oauthManifest]);
    expect(r.get("stripe")).toBeDefined();
    expect(r.get("stripe")?.source).toBe("plugin");
  });

  it("rejects malformed config (Zod validation runs)", () => {
    const env = {
      STRIPE_OAUTH_CLIENT_ID: "x",
      STRIPE_OAUTH_CLIENT_SECRET: "y",
    } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    const bad = {
      ...manifestBase,
      kind: "oauth_provider" as const,
      oauthProviders: [{ config: { ...baseConfig, pkce: "weird" } }],
    } as unknown as PaperclipPluginManifestV1;
    expect(() => registerPluginContributions(r, [bad])).toThrow();
  });

  it("ignores manifests with non-oauth kind", () => {
    const env = {
      STRIPE_OAUTH_CLIENT_ID: "x",
      STRIPE_OAUTH_CLIENT_SECRET: "y",
    } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    const sandbox = {
      ...manifestBase,
      kind: "sandbox_provider" as const,
      oauthProviders: [{ config: baseConfig }],
    } as unknown as PaperclipPluginManifestV1;
    registerPluginContributions(r, [sandbox]);
    expect(r.get("stripe")).toBeUndefined();
  });

  it("processes manifests with composite kind", () => {
    const env = {
      STRIPE_OAUTH_CLIENT_ID: "x",
      STRIPE_OAUTH_CLIENT_SECRET: "y",
    } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    const composite = {
      ...manifestBase,
      kind: "composite" as const,
      oauthProviders: [{ config: baseConfig }],
    } as unknown as PaperclipPluginManifestV1;
    registerPluginContributions(r, [composite]);
    expect(r.get("stripe")).toBeDefined();
  });
});
