import { describe, expect, it } from "vitest";
import { PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES } from "@paperclipai/adapter-utils";
import { getServerAdapter } from "../../adapters/registry.js";
import { resolvePaperclipRunnerNativeProviderInput, resolvePaperclipRunnerProviderProfile } from "../native-runtime/provider-profile.js";
import { resolveHeartbeatNativeLifecyclePolicy } from "./native-lifecycle.js";
import { CONFIG_REVISION_FIELDS } from "../../lib/agent-records.js";
import { ENVIRONMENT_CONFIG_SCHEMA_KEYS } from "../environment-config.js";
import {
  AGENT_REVISION_FIELD_SESSION_INPUTS,
  AGENT_RUNTIME_CONFIG_SESSION_INPUTS,
  ENVIRONMENT_CONFIG_SESSION_INPUTS,
  ENVIRONMENT_SELECTION_SESSION_INPUTS,
  PAPERCLIP_RUNNER_ADAPTER_CONFIG_SESSION_INPUTS,
  SELECTED_ENVIRONMENT_SESSION_INPUTS,
} from "./session-fingerprint-inputs.js";
import {
  buildEffectiveRunSessionConfigMetadata,
  buildSessionConfigCategoryValues,
  resolveTaskSessionConfigFreshness,
} from "./workspaces.js";

const CLASSIFY =
  "Classify it in session-fingerprint-inputs.ts: kept if a change can alter what the provider thread saw or may do, "
  + "excluded (with the reason) if it cannot. An unclassified field discards saved sessions blindly or keeps them unsafely.";

const unclassified = (keys: Iterable<string>, table: Record<string, unknown>) =>
  [...new Set(keys)].filter(key => !Object.hasOwn(table, key)).sort();

describe("session fingerprint input classification (backstop)", () => {
  it("classifies every agent field that records a configuration revision", () => {
    expect(unclassified(CONFIG_REVISION_FIELDS, AGENT_REVISION_FIELD_SESSION_INPUTS), CLASSIFY).toEqual([]);
    expect(Object.keys(AGENT_REVISION_FIELD_SESSION_INPUTS).sort()).toEqual([...CONFIG_REVISION_FIELDS].sort());
  });

  it("classifies every paperclip_runner config schema field and provider permission key", async () => {
    const schema = await getServerAdapter("paperclip_runner").getConfigSchema?.();
    const schemaKeys = (schema?.fields ?? []).map(field => field.key);
    expect(schemaKeys.length).toBeGreaterThan(0);
    const permissionKeys = Object.values(PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES)
      .flatMap(capability => capability.configurable ? [capability.configKey] : []);
    expect(unclassified([...schemaKeys, ...permissionKeys], PAPERCLIP_RUNNER_ADAPTER_CONFIG_SESSION_INPUTS), CLASSIFY).toEqual([]);
  });

  it("classifies every top-level environment driver config key, and only real keys", () => {
    const schemaKeys = Object.values(ENVIRONMENT_CONFIG_SCHEMA_KEYS).flat();
    expect(unclassified(schemaKeys, ENVIRONMENT_CONFIG_SESSION_INPUTS), CLASSIFY).toEqual([]);
    expect(Object.keys(ENVIRONMENT_CONFIG_SESSION_INPUTS).filter(key => !schemaKeys.includes(key))).toEqual([]);
  });

  it.each([
    { provider: "codex", model: "gpt-5.4-mini", codexPermissionMode: "never", lifecycleMode: "warm", idleTimeoutMs: 60_000 },
    { provider: "opencode", model: "openai/gpt-5.4-mini", opencodePermissionMode: "allow" },
  ])("keeps every excluded runner key out of the native execution input: %j", base => {
    const nativeInputs = (config: Record<string, unknown>) => {
      const backend = resolvePaperclipRunnerProviderProfile(config).backend;
      return {
        provider: resolvePaperclipRunnerNativeProviderInput({ backend, adapterConfig: config }),
        lifecyclePolicy: resolveHeartbeatNativeLifecyclePolicy({
          adapterType: "paperclip_runner", backend, agentMode: config.lifecycleMode, agentIdleTimeoutMs: config.idleTimeoutMs,
          managedAiSelected: false, taskOwned: true, localTarget: false,
        }),
      };
    };
    const reference = nativeInputs(base);
    const inertKeys = [
      ...Object.entries(PAPERCLIP_RUNNER_ADAPTER_CONFIG_SESSION_INPUTS).filter(([, value]) => value.kind === "excluded").map(([key]) => key),
      ...Object.values(PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES).flatMap(capability => capability.configurable ? [capability.configKey] : [])
        .filter(key => key !== PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[base.provider as "codex" | "opencode"].configKey),
    ];
    expect(inertKeys.length).toBeGreaterThan(0);
    for (const key of inertKeys) {
      expect(nativeInputs({ ...base, [key]: 12_345 }), `${key} reaches the native execution input; keep it in the fingerprint`).toEqual(reference);
    }
    expect(nativeInputs({ ...base, idleTimeoutMs: 120_000, lifecycleMode: "warm" }).lifecyclePolicy)
      .not.toEqual(nativeInputs({ ...base, idleTimeoutMs: 60_000, lifecycleMode: "warm" }).lifecyclePolicy);
  });

  it("pins the shape of every hashed category, so a new field cannot join the fingerprint unclassified", () => {
    const values = buildSessionConfigCategoryValues({
      adapterType: "paperclip_runner",
      agentIdentityKeyId: "key-1",
      effectiveAdapterConfig: { provider: "codex", model: "model-a" },
      agentRuntimeConfig: { aiConnection: { mode: "shared" }, heartbeat: { enabled: true } },
      instructions: { configured: true },
      issueOverrides: { model: "model-b" },
      workspaceConfig: { requestedMode: "agent_default", effectiveMode: "agent_default" },
      environment: {
        selectionSource: "agent_default",
        selectedEnvironmentId: "environment-1",
        selectedEnvironment: { id: "environment-1", driver: "plugin", config: { pluginKey: "p" }, configRevisionAt: "2099-01-01T00:00:00.000Z" },
        executionPolicy: { mode: "default" },
      },
      environmentEnv: { A: "1" },
      projectEnv: { B: "2" },
      routineEnv: { C: "3" },
      secretManifest: [],
      runtimeSkills: [],
      agentConfigRevision: { id: "revision-1", changedKeys: ["adapterConfig"], configRevisionAt: "2099-01-01T00:00:00.000Z" },
    });
    expect(Object.keys(values).sort(), CLASSIFY).toEqual([
      "adapter", "adapterConfig", "agentRuntimeConfig", "envBindings", "environment", "instructions",
      "issueOverrides", "runtimeSkills", "secrets", "workspaceConfig",
    ]);
    expect(Object.keys(values.adapter).sort(), CLASSIFY).toEqual(["adapterType", "agentIdentityKeyId"]);
    const environment = values.environment as Record<string, unknown>;
    expect(Object.keys(environment).sort(), CLASSIFY).toEqual(
      Object.entries(ENVIRONMENT_SELECTION_SESSION_INPUTS).filter(([, value]) => value.kind === "kept").map(([key]) => key).sort(),
    );
    expect(Object.keys(environment.selectedEnvironment as object).sort(), CLASSIFY).toEqual(
      Object.entries(SELECTED_ENVIRONMENT_SESSION_INPUTS).filter(([, value]) => value.kind === "kept").map(([key]) => key).sort(),
    );
    expect(Object.keys(values.agentRuntimeConfig as object)).toEqual(["aiConnection"]);
    expect(Object.keys(values.envBindings).sort()).toEqual(["environment", "project", "routine"]);
    expect(AGENT_RUNTIME_CONFIG_SESSION_INPUTS.heartbeat.kind).toBe("excluded");
  });
});

type MetadataInput = Parameters<typeof buildEffectiveRunSessionConfigMetadata>[0];

const baseInput: MetadataInput = {
  adapterType: "paperclip_runner",
  effectiveAdapterConfig: {
    provider: "codex", model: "model-a", codexPermissionMode: "never", lifecycleMode: "warm",
    idleTimeoutMs: 60_000, timeoutSec: 0, graceSec: 15, opencodePermissionMode: "allow", acpxPermissionMode: "approve-all",
  },
  agentRuntimeConfig: { aiConnection: { mode: "shared", grantId: "grant-1" }, heartbeat: { enabled: false, maxConcurrentRuns: 20 } },
  issueOverrides: null,
  workspaceConfig: { requestedMode: "agent_default", effectiveMode: "agent_default" },
  environment: {
    selectionSource: "agent_default",
    selectedEnvironmentId: "environment-1",
    selectedEnvironment: {
      id: "environment-1", driver: "plugin", configRevisionAt: "2099-01-01T00:00:00.000Z",
      config: { pluginKey: "plugin-a", driverKey: "tasks", driverConfig: { image: "image-a" }, runnerIdleTimeoutMs: 60_000 },
    },
  },
  environmentEnv: null,
  projectEnv: null,
  routineEnv: null,
  runtimeSkills: [],
  agentConfigRevision: { id: "revision-1", changedKeys: ["adapterConfig"], configRevisionAt: "2099-01-01T00:00:00.000Z" },
};

const withAdapterConfig = (patch: Record<string, unknown>): Partial<MetadataInput> => ({
  effectiveAdapterConfig: { ...baseInput.effectiveAdapterConfig, ...patch },
});
const withSelectedEnvironment = (patch: Record<string, unknown>, configPatch: Record<string, unknown> = {}): Partial<MetadataInput> => {
  const environment = baseInput.environment as { selectedEnvironment: { config: Record<string, unknown> } & Record<string, unknown> };
  return { environment: { ...(baseInput.environment as object), selectedEnvironment: {
    ...environment.selectedEnvironment, ...patch, config: { ...environment.selectedEnvironment.config, ...configPatch },
  } } };
};

async function freshness(next: Partial<MetadataInput>, compatible: Partial<MetadataInput>[] = []) {
  const saved = await buildEffectiveRunSessionConfigMetadata(baseInput);
  const configMetadata = await buildEffectiveRunSessionConfigMetadata({ ...baseInput, ...next });
  const compatibleConfigMetadata = await Promise.all(compatible.map(input => buildEffectiveRunSessionConfigMetadata({ ...baseInput, ...next, ...input })));
  return resolveTaskSessionConfigFreshness({
    hasTaskSession: true, configuredModel: "model-a", configMetadata, compatibleConfigMetadata,
    taskSessionParams: {
      __paperclipConfiguredModel: "model-a", __paperclipConfigFingerprint: saved.fingerprint,
      __paperclipConfigFingerprintVersion: saved.version, __paperclipConfigCategoryFingerprints: saved.categoryFingerprints,
    },
  });
}

describe("session fingerprint keeps sessions across non-thread changes", () => {
  it.each<[string, Partial<MetadataInput>]>([
    ["a new config revision, even one that restores the same values",
      { agentConfigRevision: { id: "revision-2", changedKeys: ["adapterConfig"], configRevisionAt: "2099-01-02T00:00:00.000Z" } }],
    ["a revision of display-only agent fields", { agentConfigRevision: { id: "revision-3", changedKeys: ["name", "icon"], configRevisionAt: "2099-01-03T00:00:00.000Z" } }],
    ["the turn time limit", withAdapterConfig({ timeoutSec: 3600 })],
    ["the legacy kill grace", withAdapterConfig({ graceSec: 30 })],
    ["another provider's permission mode", withAdapterConfig({ opencodePermissionMode: "deny", acpxPermissionMode: "deny-all" })],
    ["wake scheduling", { agentRuntimeConfig: { aiConnection: { mode: "shared", grantId: "grant-1" }, heartbeat: { enabled: true, intervalSec: 300 } } }],
    ["the environment row's update time", withSelectedEnvironment({ configRevisionAt: "2099-02-01T00:00:00.000Z" })],
    ["how the same environment was selected", { environment: { ...(baseInput.environment as object), selectionSource: "issue" } }],
    ["the environment's release, log streaming, and RPC timeout settings",
      withSelectedEnvironment({}, { archiveOnRelease: true, streamRunLogs: false, timeoutMs: 30_000 })],
  ])("does not reset for %s", async (_label, next) => {
    expect(await freshness(next)).toMatchObject({ reset: false, changedCategories: [] });
  });

  it("drops Codex-only search for another provider but keeps it for Codex", async () => {
    const opencode = { provider: "opencode", opencodePermissionMode: "allow" };
    const saved = await buildEffectiveRunSessionConfigMetadata({ ...baseInput, ...withAdapterConfig(opencode) });
    const next = await buildEffectiveRunSessionConfigMetadata({ ...baseInput, ...withAdapterConfig({ ...opencode, search: false }) });
    expect(next.fingerprint).toBe(saved.fingerprint);
    expect((await freshness(withAdapterConfig({ search: false }))).reset).toBe(true);
  });
});

describe("session fingerprint still resets for thread changes", () => {
  it.each<[string, Partial<MetadataInput>]>([
    ["the model", withAdapterConfig({ model: "model-b" })],
    ["the provider", withAdapterConfig({ provider: "opencode" })],
    ["the active provider's permission mode", withAdapterConfig({ codexPermissionMode: "on-request" })],
    ["the lifecycle mode", withAdapterConfig({ lifecycleMode: "per_turn" })],
    ["the warm idle window, which the native session digest compares", withAdapterConfig({ idleTimeoutMs: 300_000 })],
    ["the environment's warm idle window", withSelectedEnvironment({}, { runnerIdleTimeoutMs: 300_000 })],
    ["the environment's lease reuse, which can change the default lifecycle", withSelectedEnvironment({}, { reuseLease: true })],
    ["the provider account", { agentRuntimeConfig: { aiConnection: { mode: "shared", grantId: "grant-2" }, heartbeat: { enabled: false, maxConcurrentRuns: 20 } } }],
    ["an unclassified runtime setting", { agentRuntimeConfig: { aiConnection: { mode: "shared", grantId: "grant-1" }, futureSetting: true } }],
    ["an unclassified adapter setting", withAdapterConfig({ futureSetting: true })],
    ["the environment", { environment: { ...(baseInput.environment as object), selectedEnvironmentId: "environment-2" } }],
    ["the plugin driver config", withSelectedEnvironment({}, { driverConfig: { image: "image-b" } })],
    ["the environment's lifecycle mode", withSelectedEnvironment({}, { runnerLifecycleMode: "per_turn" })],
  ])("resets for %s", async (_label, next) => {
    expect((await freshness(next)).reset).toBe(true);
  });
});

describe("legacy session fingerprints", () => {
  it("reproduces the fingerprint saved before non-thread inputs left it", async () => {
    const input: MetadataInput = {
      adapterType: "paperclip_runner",
      effectiveAdapterConfig: { provider: "codex", model: "model-a", codexPermissionMode: "never", lifecycleMode: "warm", idleTimeoutMs: 60000, timeoutSec: 0, graceSec: 15, opencodePermissionMode: "allow" },
      agentRuntimeConfig: { aiConnection: { mode: "shared" }, heartbeat: { enabled: false } },
      issueOverrides: null, workspaceConfig: { requestedMode: "agent_default" },
      environment: { selectionSource: "agent_default", selectedEnvironmentId: "e1", selectedEnvironment: {
        id: "e1", driver: "plugin", configRevisionAt: "2099-01-01T00:00:00.000Z", config: { pluginKey: "p", runnerIdleTimeoutMs: 60000, reuseLease: true },
      } },
      environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [],
      agentConfigRevision: { id: "r1", changedKeys: ["adapterConfig"], configRevisionAt: "2099-01-01T00:00:00.000Z" },
    };
    expect((await buildEffectiveRunSessionConfigMetadata({ ...input, legacyComposition: true })).fingerprint)
      .toBe("v1:sha256:1fbf35727ca022f7abe258b6277419c7fb19f6f911d7b02e52670681479528b5");
    expect((await buildEffectiveRunSessionConfigMetadata({ ...input, adapterType: "codex_local", legacyComposition: true })).fingerprint)
      .toBe("v1:sha256:59f18fe1541c686ab9d29476b1b0525ab492053ab7b4d5fbd910a5b7503ca203");
  });

  it("accepts a session saved with the legacy composition for the same inputs, once", async () => {
    const legacySaved = await buildEffectiveRunSessionConfigMetadata({ ...baseInput, legacyComposition: true });
    const current = await buildEffectiveRunSessionConfigMetadata(baseInput);
    expect(legacySaved.fingerprint).not.toBe(current.fingerprint);
    const decide = async (next: Partial<MetadataInput>) => resolveTaskSessionConfigFreshness({
      hasTaskSession: true, configuredModel: "model-a",
      configMetadata: await buildEffectiveRunSessionConfigMetadata({ ...baseInput, ...next }),
      compatibleConfigMetadata: [await buildEffectiveRunSessionConfigMetadata({ ...baseInput, ...next, legacyComposition: true })],
      taskSessionParams: {
        __paperclipConfiguredModel: "model-a", __paperclipConfigFingerprint: legacySaved.fingerprint,
        __paperclipConfigFingerprintVersion: legacySaved.version, __paperclipConfigCategoryFingerprints: legacySaved.categoryFingerprints,
      },
    });
    expect((await decide({})).reset).toBe(false);
    expect((await decide({ agentConfigRevision: { id: "revision-2", changedKeys: ["adapterConfig"], configRevisionAt: "2099-01-02T00:00:00.000Z" } })).reset).toBe(true);
  });
});
