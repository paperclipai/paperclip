import { describe, expect, it } from "vitest";
import {
  MANAGED_CONFIG_ENV_KEY,
  MANAGED_ENVIRONMENT_DRIVERS,
  getManagedInstanceConfig,
  managedFeatureKeySet,
  parseManagedConfigEnv,
} from "../services/managed-config.js";

function envWith(raw: string | undefined) {
  return { [MANAGED_CONFIG_ENV_KEY]: raw };
}

function validDoc(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    mode: "cloud",
    catalogVersion: "2026.720.0",
    features: { enableApps: false, enableStatusCards: true },
    plugins: { autoInstall: ["daytona", "kubernetes"] },
    ...overrides,
  });
}

describe("plugins.workerEnv", () => {
  const plugins = (workerEnv: unknown) => ({ plugins: { autoInstall: ["daytona"], workerEnv } });

  it("is absent from documents that do not declare it", () => {
    expect(parseManagedConfigEnv(envWith(validDoc()))?.plugins).toEqual({ autoInstall: ["daytona", "kubernetes"] });
  });

  it("accepts variable names for an auto-installed plugin", () => {
    const parsed = parseManagedConfigEnv(envWith(validDoc(plugins({ daytona: ["PROVIDER_ORIGIN", "PROVIDER_CAPABILITY_2"] }))));
    expect(parsed?.plugins.workerEnv).toEqual({ daytona: ["PROVIDER_ORIGIN", "PROVIDER_CAPABILITY_2"] });
  });

  it.each([
    "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "BETTER_AUTH_SECRET", "DATABASE_MIGRATION_URL", "DATABASE_URL", "DB_PASSWORD",
    "GH_TOKEN", "GITHUB_TOKEN", "LD_PRELOAD", "NODE_OPTIONS", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_AUTH_SECRET", "PAPERCLIP_BACKUP_WORKER_DATABASE_URL",
    "PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "PAPERCLIP_DECISION_SIGNING_SECRET", "PAPERCLIP_MANAGED_CONFIG",
    "PAPERCLIP_SECRETS_MASTER_KEY", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_TEST_POSTGRES_ADMIN_URL", "PATH", "SENTRY_DSN",
  ])("refuses to start with a grant of %s", (name) => {
    expect(() => parseManagedConfigEnv(envWith(validDoc(plugins({ daytona: [name] }))))).toThrow(`must not grant host credential or loader variable "${name}"`);
  });

  it.each(["PAPERCLIP_CLOUD_API_ORIGIN", "PAPERCLIP_PRIMARY_HOST", "PROVIDER_CAPABILITY", "MONKEY_ORIGIN"])("accepts a grant of %s", (name) => {
    expect(parseManagedConfigEnv(envWith(validDoc(plugins({ daytona: [name] }))))?.plugins.workerEnv).toEqual({ daytona: [name] });
  });

  it.each([
    ["a plugin that is not auto-installed", { other: ["PROVIDER_ORIGIN"] }, /not in "plugins.autoInstall"/],
    ["a non-object section", ["PROVIDER_ORIGIN"], /must be an object/],
    ["an empty grant", { daytona: [] }, /non-empty array/],
    ["a value instead of a name", { daytona: ["https://example.test"] }, /uppercase variable names/],
    ["a lowercase name", { daytona: ["database_url"] }, /uppercase variable names/],
    ["a duplicate name", { daytona: ["PROVIDER_ORIGIN", "PROVIDER_ORIGIN"] }, /duplicate entry/],
  ])("refuses to start with %s", (_label, workerEnv, message) => {
    expect(() => parseManagedConfigEnv(envWith(validDoc(plugins(workerEnv))))).toThrow(message);
  });
});

describe("plugins.enabledCompanies", () => {
  const companyId = "f0679247-e2be-5a76-adb6-6bd360e5a833";
  const plugins = (enabledCompanies: unknown) => ({ plugins: { autoInstall: ["daytona"], enabledCompanies } });

  it("accepts company ids for an auto-installed plugin", () => {
    expect(parseManagedConfigEnv(envWith(validDoc(plugins({ daytona: [companyId] }))))?.plugins.enabledCompanies).toEqual({ daytona: [companyId] });
  });

  it.each([
    ["a plugin that is not auto-installed", { other: [companyId] }, /not in "plugins.autoInstall"/],
    ["a non-object section", [companyId], /must be an object/],
    ["an empty list", { daytona: [] }, /non-empty array/],
    ["a value that is not a UUID", { daytona: ["all"] }, /lowercase company UUIDs/],
    ["an uppercase UUID", { daytona: [companyId.toUpperCase()] }, /lowercase company UUIDs/],
    ["a duplicate id", { daytona: [companyId, companyId] }, /duplicate entry/],
  ])("refuses to start with %s", (_label, enabledCompanies, message) => {
    expect(() => parseManagedConfigEnv(envWith(validDoc(plugins(enabledCompanies))))).toThrow(message);
  });
});

describe("managedFeatureKeySet", () => {
  it("contains exactly the boolean flags of the experimental schema", () => {
    const keys = managedFeatureKeySet();
    expect(keys.has("enableApps")).toBe(true);
    expect(keys.has("enableWorktreeRunExecution")).toBe(true);
    // Server-managed bookkeeping fields are not overlayable features.
    expect(keys.has("worktreeRunExecutionActivatedAt")).toBe(false);
    expect(keys.has("worktreeRunExecutionActivationInstanceId")).toBe(false);
  });
});

describe("parseManagedConfigEnv", () => {
  it("returns null when the env var is absent (self-hosted)", () => {
    expect(parseManagedConfigEnv({})).toBeNull();
    expect(parseManagedConfigEnv(envWith(undefined))).toBeNull();
  });

  it("throws when the env var is present but blank (fail closed)", () => {
    expect(() => parseManagedConfigEnv(envWith(""))).toThrow(/is set but blank/);
    expect(() => parseManagedConfigEnv(envWith("   "))).toThrow(/is set but blank/);
    expect(() => parseManagedConfigEnv(envWith("\n\t"))).toThrow(/is set but blank/);
  });

  it("parses a complete valid document", () => {
    const config = parseManagedConfigEnv(envWith(validDoc()));
    expect(config).toEqual({
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.720.0",
      features: { enableApps: false, enableStatusCards: true },
      plugins: { autoInstall: ["daytona", "kubernetes"] },
      environments: [],
      pluginEnvironments: [],
    });
  });

  it("accepts the deprecated runner ingress key for managed-config compatibility", () => {
    const config = parseManagedConfigEnv(
      envWith(validDoc({ features: { enableRunnerPreviewIngress: true } })),
    );

    expect(config?.features).toEqual({ enableRunnerPreviewIngress: true });
  });

  it("accepts empty features {} and autoInstall [] sections", () => {
    const config = parseManagedConfigEnv(
      envWith(validDoc({ features: {}, plugins: { autoInstall: [] } })),
    );
    expect(config).toEqual({
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.720.0",
      features: {},
      plugins: { autoInstall: [] },
      environments: [],
      pluginEnvironments: [],
    });
  });

  it("throws when the features section is missing (fail closed)", () => {
    const doc = { v: 1, mode: "cloud", catalogVersion: "2026.720.0", plugins: { autoInstall: [] } };
    expect(() => parseManagedConfigEnv(envWith(JSON.stringify(doc)))).toThrow(
      /requires a "features" object/,
    );
  });

  it("throws when the plugins section or autoInstall is missing (fail closed)", () => {
    const noPlugins = {
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.720.0",
      features: {},
    };
    expect(() => parseManagedConfigEnv(envWith(JSON.stringify(noPlugins)))).toThrow(
      /requires a "plugins" object/,
    );
    expect(() => parseManagedConfigEnv(envWith(validDoc({ plugins: {} })))).toThrow(
      /requires a "plugins.autoInstall" array/,
    );
  });

  it("returns a frozen document", () => {
    const config = parseManagedConfigEnv(envWith(validDoc()));
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config?.features)).toBe(true);
    expect(Object.isFrozen(config?.plugins.autoInstall)).toBe(true);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseManagedConfigEnv(envWith("{not json"))).toThrow(
      /PAPERCLIP_MANAGED_CONFIG is not valid JSON/,
    );
  });

  it("throws on non-object documents", () => {
    expect(() => parseManagedConfigEnv(envWith("[]"))).toThrow(/must be a JSON object/);
    expect(() => parseManagedConfigEnv(envWith("42"))).toThrow(/must be a JSON object/);
    expect(() => parseManagedConfigEnv(envWith("null"))).toThrow(/must be a JSON object/);
    expect(() => parseManagedConfigEnv(envWith('"cloud"'))).toThrow(/must be a JSON object/);
  });

  it("throws on an unknown top-level key", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ extra: true })))).toThrow(
      /unknown top-level key "extra"/,
    );
  });

  it("throws on an unsupported v", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ v: 2 })))).toThrow(
      /unsupported "v" 2; this build supports v=1/,
    );
    expect(() => parseManagedConfigEnv(envWith(validDoc({ v: "1" })))).toThrow(/unsupported "v"/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(JSON.stringify({ mode: "cloud", catalogVersion: "x" })),
      ),
    ).toThrow(/unsupported "v"/);
  });

  it("throws on a non-cloud mode", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ mode: "self-hosted" })))).toThrow(
      /invalid "mode" "self-hosted"; expected "cloud"/,
    );
    expect(() =>
      parseManagedConfigEnv(envWith(JSON.stringify({ v: 1, catalogVersion: "x" }))),
    ).toThrow(/invalid "mode"/);
  });

  it("throws on a missing or empty catalogVersion", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(JSON.stringify({ v: 1, mode: "cloud" }))),
    ).toThrow(/non-empty string "catalogVersion"/);
    expect(() => parseManagedConfigEnv(envWith(validDoc({ catalogVersion: "" })))).toThrow(
      /non-empty string "catalogVersion"/,
    );
    expect(() => parseManagedConfigEnv(envWith(validDoc({ catalogVersion: 7 })))).toThrow(
      /non-empty string "catalogVersion"/,
    );
  });

  it("throws on a non-object features section", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ features: ["enableApps"] })))).toThrow(
      /"features" must be an object/,
    );
  });

  it.each([true, false])("ignores the retired Pipelines flag (%s) from older Cloud catalogs", (enabled) => {
    const config = parseManagedConfigEnv(envWith(validDoc({
      features: { enablePipelines: enabled, enableCases: true },
    })));
    expect(config?.features).toEqual({ enableCases: true });
    expect(managedFeatureKeySet().has("enablePipelines")).toBe(false);
  });

  it("throws on an unknown feature key", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableTimeTravel: true } }))),
    ).toThrow(/unknown feature key "enableTimeTravel"/);
    // A server-managed bookkeeping field is not an overlayable feature.
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ features: { worktreeRunExecutionActivatedAt: true } })),
      ),
    ).toThrow(/unknown feature key "worktreeRunExecutionActivatedAt"/);
  });

  it("throws on a feature key the catalog does not mark tier \"managed\"", () => {
    // `enableStreamlinedLeftNavigation` is a real schema flag, but its catalog
    // tier is `preference` (tenant-controllable) — a managed-config document
    // targeting it has incompatible catalog semantics and must fail closed.
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ features: { enableStreamlinedLeftNavigation: true } })),
      ),
    ).toThrow(
      /"features" key "enableStreamlinedLeftNavigation" has tier "preference".*only tier "managed" keys/,
    );
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableDecisions: false } }))),
    ).toThrow(/has tier "preference"/);
  });

  it("throws on non-boolean feature values", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableApps: "true" } }))),
    ).toThrow(/"features.enableApps" must be a boolean/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableApps: 1 } }))),
    ).toThrow(/"features.enableApps" must be a boolean/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ features: { enableApps: null } }))),
    ).toThrow(/"features.enableApps" must be a boolean/);
  });

  it("throws on malformed plugins sections", () => {
    expect(() => parseManagedConfigEnv(envWith(validDoc({ plugins: [] })))).toThrow(
      /"plugins" must be an object/,
    );
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { install: [] } }))),
    ).toThrow(/"plugins" has unknown key "install"/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { autoInstall: "daytona" } }))),
    ).toThrow(/"plugins.autoInstall" must be an array/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { autoInstall: [""] } }))),
    ).toThrow(/non-empty strings/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { autoInstall: [" daytona"] } }))),
    ).toThrow(/non-empty strings/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ plugins: { autoInstall: [42] } }))),
    ).toThrow(/non-empty strings/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ plugins: { autoInstall: ["daytona", "daytona"] } })),
      ),
    ).toThrow(/duplicate entry "daytona"/);
  });
});

describe("parseManagedConfigEnv environments section", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    name: "Daytona",
    provider: "daytona",
    config: { target: "us" },
    ...overrides,
  });

  it("defaults to an empty list when the section is absent (pre-section documents keep booting)", () => {
    const config = parseManagedConfigEnv(envWith(validDoc()));
    expect(config?.environments).toEqual([]);
  });

  it("parses a declared environment and freezes it", () => {
    const config = parseManagedConfigEnv(
      envWith(validDoc({ environments: [entry({ description: "Managed Daytona sandbox." })] })),
    );
    expect(config?.environments).toHaveLength(1);
    const spec = config?.environments[0];
    expect(spec?.name).toBe("Daytona");
    expect(spec?.description).toBe("Managed Daytona sandbox.");
    expect(spec?.provider).toBe("daytona");
    expect(spec?.config).toEqual({ target: "us" });
    expect(Object.isFrozen(config?.environments)).toBe(true);
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec?.config)).toBe(true);
  });

  it("treats config and description as optional", () => {
    const config = parseManagedConfigEnv(
      envWith(validDoc({ environments: [{ name: "Daytona", provider: "daytona" }] })),
    );
    expect(config?.environments[0]?.config).toEqual({});
    expect(config?.environments[0]?.description).toBeUndefined();
  });

  it("rejects a non-array section and non-object entries", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: {} }))),
    ).toThrow(/"environments" must be an array/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: ["daytona"] }))),
    ).toThrow(/"environments\[0\]" must be an object/);
  });

  it("rejects more than one sandbox entry (single managed sandbox slot)", () => {
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ environments: [entry(), entry({ name: "Other", provider: "kubernetes" })] })),
      ),
    ).toThrow(/at most one sandbox entry/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ environments: [entry(), entry({ name: "Other", driver: "sandbox", provider: "kubernetes" })] })),
      ),
    ).toThrow(/at most one sandbox entry/);
  });

  it("rejects unknown entry keys", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ envVars: {} })] }))),
    ).toThrow(/unknown key "envVars"/);
  });

  it("rejects malformed names, descriptions, and providers", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ name: "" })] }))),
    ).toThrow(/"environments\[0\].name"/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ name: " Daytona" })] }))),
    ).toThrow(/"environments\[0\].name"/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ description: " " })] }))),
    ).toThrow(/"environments\[0\].description"/);
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ provider: 7 })] }))),
    ).toThrow(/"environments\[0\].provider"/);
  });

  it("rejects a provider that plugins.autoInstall does not provision", () => {
    expect(() =>
      parseManagedConfigEnv(envWith(validDoc({ environments: [entry({ provider: "modal" })] }))),
    ).toThrow(/not in "plugins.autoInstall"/);
  });

  it("rejects a config that sets provider", () => {
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ environments: [entry({ config: { provider: "daytona" } })] })),
      ),
    ).toThrow(/must not set "provider"/);
  });

  it("rejects secret-bearing config keys at any depth (secrets travel as env vars)", () => {
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ environments: [entry({ config: { apiKey: "not-a-real-key" } })] })),
      ),
    ).toThrow(/looks secret-bearing/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(validDoc({ environments: [entry({ config: { auth: { accessToken: "t" } } })] })),
      ),
    ).toThrow(/auth.accessToken/);
    expect(() =>
      parseManagedConfigEnv(
        envWith(
          validDoc({ environments: [entry({ config: { adapters: [{ clientSecret: "s" }] } })] }),
        ),
      ),
    ).toThrow(/adapters\[0\].clientSecret/);
  });
});

describe("parseManagedConfigEnv plugin environment entries", () => {
  const PLUGIN_KEY = "paperclip-cloud.plugin-agent-computer";
  // The exact entry Paperclip Cloud delivers (Cloud PR 12 contract).
  const computer = (overrides: Record<string, unknown> = {}) => ({
    name: "Paperclip Computer",
    description: "Runs the agent on its own computer",
    driver: "plugin",
    pluginKey: PLUGIN_KEY,
    driverKey: "tasks",
    driverConfig: {},
    instanceDefault: true,
    ...overrides,
  });
  const sandbox = { name: "Paperclip Sandbox", provider: "daytona", config: { target: "us" } };
  // `plugins.autoInstall` holds catalog keys; the computer plugin's key is
  // "agent-computer", while the entry's `pluginKey` is its manifest id.
  const docWith = (environments: unknown[], autoInstall = ["daytona", "agent-computer"]) =>
    envWith(validDoc({ plugins: { autoInstall }, environments }));

  it("exports the driver list Cloud detects by name", () => {
    expect(MANAGED_ENVIRONMENT_DRIVERS).toEqual(["sandbox", "plugin"]);
  });

  it("parses an old document's sandbox entry unchanged", () => {
    const config = parseManagedConfigEnv(docWith([sandbox]));
    expect(config?.environments).toEqual([{ name: "Paperclip Sandbox", provider: "daytona", config: { target: "us" } }]);
    expect(config?.pluginEnvironments).toEqual([]);
  });

  it("parses the sandbox entry beside the Paperclip Computer entry", () => {
    const config = parseManagedConfigEnv(docWith([sandbox, computer()]));
    expect(config?.environments).toEqual([{ name: "Paperclip Sandbox", provider: "daytona", config: { target: "us" } }]);
    expect(config?.pluginEnvironments).toEqual([{
      driver: "plugin",
      name: "Paperclip Computer",
      description: "Runs the agent on its own computer",
      pluginKey: PLUGIN_KEY,
      driverKey: "tasks",
      driverConfig: {},
      instanceDefault: true,
    }]);
    expect(Object.isFrozen(config?.pluginEnvironments)).toBe(true);
    expect(Object.isFrozen(config?.pluginEnvironments[0])).toBe(true);
  });

  it("parses a plugin entry alone, with optional fields omitted", () => {
    const config = parseManagedConfigEnv(docWith([{ name: "Computer", driver: "plugin", pluginKey: PLUGIN_KEY, driverKey: "tasks" }]));
    expect(config?.environments).toEqual([]);
    expect(config?.pluginEnvironments[0]).toMatchObject({ driverConfig: {}, instanceDefault: false });
    expect(config?.pluginEnvironments[0]?.description).toBeUndefined();
  });

  it("refuses duplicate names, including across drivers", () => {
    expect(() => parseManagedConfigEnv(docWith([sandbox, computer({ name: "Paperclip Sandbox" })])))
      .toThrow(/"environments\[1\].name" duplicates another entry's name/);
  });

  it("refuses a duplicate pluginKey and driverKey pair", () => {
    expect(() => parseManagedConfigEnv(docWith([computer(), computer({ name: "Second", instanceDefault: false })])))
      .toThrow(/duplicates another plugin entry's pluginKey and driverKey/);
  });

  it("does not compare the manifest id with autoInstall catalog keys (boot checks the catalog)", () => {
    expect(parseManagedConfigEnv(docWith([computer()]))?.pluginEnvironments[0]?.pluginKey).toBe(PLUGIN_KEY);
  });

  it("refuses instanceDefault on two entries", () => {
    expect(() => parseManagedConfigEnv(docWith([computer(), computer({ name: "Second", driverKey: "other" })])))
      .toThrow(/at most one entry may become the instance default/);
  });

  it("refuses instanceDefault on the sandbox entry, even false", () => {
    expect(() => parseManagedConfigEnv(docWith([{ ...sandbox, instanceDefault: true }])))
      .toThrow(/"environments\[0\].instanceDefault" is not allowed on the sandbox entry/);
    expect(() => parseManagedConfigEnv(docWith([{ ...sandbox, instanceDefault: false }])))
      .toThrow(/not allowed on the sandbox entry/);
  });

  it("refuses a non-boolean instanceDefault", () => {
    expect(() => parseManagedConfigEnv(docWith([computer({ instanceDefault: "yes" })])))
      .toThrow(/"environments\[0\].instanceDefault" must be a boolean/);
  });

  it("refuses secret-like driverConfig keys at any depth", () => {
    expect(() => parseManagedConfigEnv(docWith([computer({ driverConfig: { apiToken: "t" } })])))
      .toThrow(/"environments\[0\].driverConfig" key "apiToken" looks secret-bearing/);
    expect(() => parseManagedConfigEnv(docWith([computer({ driverConfig: { auth: [{ password: "p" }] } })])))
      .toThrow(/auth\[0\].password/);
  });

  it("refuses unknown keys, including sandbox keys on a plugin entry and the reverse", () => {
    expect(() => parseManagedConfigEnv(docWith([computer({ envVars: {} })]))).toThrow(/unknown key "envVars"/);
    expect(() => parseManagedConfigEnv(docWith([computer({ provider: "daytona" })]))).toThrow(/unknown key "provider"/);
    expect(() => parseManagedConfigEnv(docWith([{ ...sandbox, pluginKey: PLUGIN_KEY }]))).toThrow(/unknown key "pluginKey"/);
  });

  it("refuses an unknown driver and malformed plugin fields", () => {
    expect(() => parseManagedConfigEnv(docWith([computer({ driver: "ssh" })]))).toThrow(/"environments\[0\].driver" must be one of "sandbox", "plugin"/);
    expect(() => parseManagedConfigEnv(docWith([computer({ driverKey: "Tasks" })]))).toThrow(/"environments\[0\].driverKey" must start/);
    expect(() => parseManagedConfigEnv(docWith([computer({ driverKey: undefined })]))).toThrow(/"environments\[0\].driverKey" must be a non-empty string/);
    expect(() => parseManagedConfigEnv(docWith([computer({ driverConfig: [] })]))).toThrow(/"environments\[0\].driverConfig" must be an object/);
  });
});

describe("getManagedInstanceConfig", () => {
  it("caches by raw env value and reparses when it changes", () => {
    const raw = validDoc();
    const first = getManagedInstanceConfig(envWith(raw));
    const second = getManagedInstanceConfig(envWith(raw));
    expect(second).toBe(first);

    const changed = getManagedInstanceConfig(
      envWith(validDoc({ catalogVersion: "2026.721.0" })),
    );
    expect(changed?.catalogVersion).toBe("2026.721.0");
    expect(changed).not.toBe(first);

    expect(getManagedInstanceConfig(envWith(undefined))).toBeNull();
  });

  it("rethrows parse failures on every call instead of caching them", () => {
    expect(() => getManagedInstanceConfig(envWith("{bad"))).toThrow(/not valid JSON/);
    expect(() => getManagedInstanceConfig(envWith("{bad"))).toThrow(/not valid JSON/);
  });
});
