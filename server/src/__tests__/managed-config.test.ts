import { describe, expect, it } from "vitest";
import {
  MANAGED_CONFIG_ENV_KEY,
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
    features: { enableApps: false, enablePipelines: true },
    plugins: { autoInstall: ["daytona", "kubernetes"] },
    ...overrides,
  });
}

describe("managedFeatureKeySet", () => {
  it("contains exactly the boolean flags of the experimental schema", () => {
    const keys = managedFeatureKeySet();
    expect(keys.has("enableApps")).toBe(true);
    expect(keys.has("enableWorktreeRunExecution")).toBe(true);
    // Server-managed bookkeeping fields are not overlayable features.
    expect(keys.has("worktreeRunExecutionActivatedAt")).toBe(false);
    expect(keys.has("worktreeRunExecutionActivationInstanceId")).toBe(false);
    expect(keys.has("issueGraphLivenessAutoRecoveryLookbackHours")).toBe(false);
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
      features: { enableApps: false, enablePipelines: true },
      plugins: { autoInstall: ["daytona", "kubernetes"] },
    });
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
