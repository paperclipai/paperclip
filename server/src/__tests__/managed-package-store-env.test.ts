import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedAiSessionFingerprintConfig, managedPackageStoreEnvironment } from "../services/ai-connection-runtime.js";

const companyId = "11111111-2222-4333-8444-555555555555";

describe("managed package store environment", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_HOME", "/srv/paperclip-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "fixture");
  });
  afterEach(() => vi.unstubAllEnvs());

  const store = path.join("/srv/paperclip-home", "instances", "fixture", "package-stores", companyId, "pnpm");

  it("gives every run of a company the same store outside its throwaway home", () => {
    expect(managedPackageStoreEnvironment(companyId, {}, {})).toEqual({ npm_config_store_dir: store, pnpm_config_store_dir: store });
    expect(managedPackageStoreEnvironment(companyId, {}, {})).toEqual(managedPackageStoreEnvironment(companyId, {}, {}));
  });

  it.each([
    ["the adapter config", { pnpm_config_store_dir: "/custom/store" }, {}],
    ["the server environment", {}, { npm_config_store_dir: "/custom/store" }],
    ["an upper-case server variable", {}, { NPM_CONFIG_STORE_DIR: "/custom/store" }],
    ["an upper-case adapter variable", { PNPM_CONFIG_STORE_DIR: "/custom/store" }, {}],
  ])("keeps a store chosen in %s", (_label, configured, processEnv) => {
    expect(managedPackageStoreEnvironment(companyId, configured, processEnv)).toEqual({});
  });

  it("ignores an empty value and rejects an unsafe company id", () => {
    expect(managedPackageStoreEnvironment(companyId, { npm_config_store_dir: "" }, {})).toHaveProperty("npm_config_store_dir", store);
    expect(managedPackageStoreEnvironment("../other", {}, {})).toEqual({});
  });

  it("leaves the session fingerprint unchanged by the injected store", () => {
    const home = "/tmp/paperclip-ai-run";
    const base = { env: { HOME: home, XDG_DATA_HOME: path.join(home, "data") } };
    const withStore = { env: { ...base.env, ...managedPackageStoreEnvironment(companyId, {}, {}) } };
    expect(managedAiSessionFingerprintConfig(withStore, home)).toEqual(managedAiSessionFingerprintConfig(base, home));
    const custom = { env: { ...base.env, npm_config_store_dir: "/custom/store" } };
    expect(managedAiSessionFingerprintConfig(custom, home).env).toHaveProperty("npm_config_store_dir", "/custom/store");
  });
});
