import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../registry.js";
import type { OAuthProviderConfig } from "../provider-config.js";

const cfg = (id: string): OAuthProviderConfig => ({
  id,
  displayName: id,
  clientCredentials: {
    clientIdEnv: `${id.toUpperCase()}_ID`,
    clientSecretEnv: `${id.toUpperCase()}_SECRET`,
  },
  endpoints: {
    authorize: "https://x.example/a",
    token: "https://x.example/t",
    accountInfo: "https://x.example/u",
  },
  scopes: { default: [], offered: [] },
  pkce: "required",
  authMethod: "post",
  responseFormat: "json",
  accountIdField: "id",
  accountLabelField: "name",
  refresh: { supported: false },
});

describe("ProviderRegistry", () => {
  it("registers a provider when env vars set", () => {
    const r = new ProviderRegistry({
      env: { GH_ID: "id", GH_SECRET: "s" } as Record<string, string>,
    });
    r.register(cfg("gh"), "yaml");
    expect(r.get("gh")?.clientId).toBe("id");
  });

  it("skips a provider when env vars missing", () => {
    const r = new ProviderRegistry({ env: {} });
    r.register(cfg("gh"), "yaml");
    expect(r.get("gh")).toBeUndefined();
  });

  it("file source wins over plugin source", () => {
    const env = { GH_ID: "id", GH_SECRET: "s" } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    r.register(cfg("gh"), "yaml");
    r.register({ ...cfg("gh"), displayName: "Plugin GH" }, "plugin");
    expect(r.get("gh")?.config.displayName).toBe("gh");
  });

  it("plugin loaded first then yaml: yaml replaces", () => {
    const env = { GH_ID: "id", GH_SECRET: "s" } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    r.register({ ...cfg("gh"), displayName: "Plugin GH" }, "plugin");
    r.register(cfg("gh"), "yaml");
    expect(r.get("gh")?.config.displayName).toBe("gh");
  });

  it("list() returns all registered providers", () => {
    const env = {
      A_ID: "i",
      A_SECRET: "s",
      B_ID: "i",
      B_SECRET: "s",
    } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    r.register(cfg("a"), "yaml");
    r.register(cfg("b"), "yaml");
    expect(r.list().map((p) => p.config.id).sort()).toEqual(["a", "b"]);
  });
});
