import { describe, expect, it } from "vitest";
import { aiConnectionSessionCompatibilityInputs, managedAiSessionIdentityCompatible, aiConnectionOnlyConfigRevision, aiConnectionRevisionMetadata } from "../services/ai-connection-session.js";
import { buildEffectiveRunSessionConfigMetadata, resolveTaskSessionConfigFreshness } from "../services/heartbeat.js";

const binding = { mode: "shared" as const, provider: "openai" as const, method: "subscription" as const, connectionId: "account", grantId: "grant" };
const pool = { mode: "router", connectionId: "pool" };
const sessionIdentity = "grant:alice:0", credentialIdentity = "grant:alice:token";
const config = { provider: "codex", model: "gpt-5.6-sol", env: { OPENAI_API_KEY: "fixture-token" }, managedAiConnection: { ...binding, identity: credentialIdentity, sessionIdentity } };
const base = { adapterType: "paperclip_runner", effectiveAdapterConfig: config, agentRuntimeConfig: { aiConnection: pool }, agentConfigRevision: null as unknown, issueOverrides: null as unknown, workspaceConfig: {}, environment: {}, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] };
type MetadataInput = Parameters<typeof buildEffectiveRunSessionConfigMetadata>[0];
type CompatibilityInput = Parameters<typeof aiConnectionSessionCompatibilityInputs>[0];
const revision = (id: string, beforeBinding: unknown, afterBinding: unknown, extra = {}) => ({
  id, changedKeys: ["runtimeConfig"], createdAt: new Date(`2026-10-02T00:00:0${id.slice(-1)}Z`),
  beforeConfig: { name: "Agent", runtimeConfig: { aiConnection: beforeBinding }, adapterConfig: { model: "gpt-5.6-sol" } },
  afterConfig: { name: "Agent", runtimeConfig: { aiConnection: afterBinding }, adapterConfig: { model: "gpt-5.6-sol" }, ...extra },
});

async function decision(previous: Partial<MetadataInput>, next: Partial<MetadataInput> = {}, compatibility: Partial<CompatibilityInput> = {}, wakeResetReason?: string) {
  const before = await buildEffectiveRunSessionConfigMetadata({ ...base, ...previous });
  const afterInput = { ...base, ...next };
  const after = await buildEffectiveRunSessionConfigMetadata(afterInput);
  const candidates = aiConnectionSessionCompatibilityInputs({ ...afterInput, originalIssueOverrides: null, binding, router: true, storedIdentity: sessionIdentity, sessionIdentity, credentialIdentity, revisions: [], ...compatibility });
  const alternatives = await Promise.all(candidates.map(candidate => buildEffectiveRunSessionConfigMetadata({ ...afterInput, ...candidate })));
  return resolveTaskSessionConfigFreshness({ hasTaskSession: true, configuredModel: String(afterInput.effectiveAdapterConfig.model), taskSessionParams: { __paperclipConfiguredModel: "gpt-5.6-sol", __paperclipConfigFingerprint: before.fingerprint, __paperclipConfigFingerprintVersion: before.version, __paperclipConfigCategoryFingerprints: before.categoryFingerprints }, configMetadata: after, compatibleConfigMetadata: alternatives, wakeResetReason });
}

describe("AI pool session adoption", () => {
  it.each([binding, { ...binding, mode: "delegated" }, { mode: "responsible_user", provider: "openai", method: "api_key" }])("preserves the exact existing configuration through a compatible binding change: %j", async aiConnection => {
    expect((await decision({ agentRuntimeConfig: { aiConnection }, effectiveAdapterConfig: { ...config, managedAiConnection: { ...config.managedAiConnection, mode: aiConnection.mode } } })).reset).toBe(false);
  });
  it("bridges only account-binding edits in revision history", async () => {
    const first = revision("revision-1", null, binding);
    const adoption = revision("revision-2", binding, pool);
    expect(aiConnectionOnlyConfigRevision(adoption)).toBe(true);
    expect((await decision({ agentRuntimeConfig: { aiConnection: binding }, agentConfigRevision: aiConnectionRevisionMetadata(first) }, { agentConfigRevision: aiConnectionRevisionMetadata(adoption) }, { revisions: [adoption, first] })).reset).toBe(false);
  });
  it("handles consecutive binding edits without erasing another configuration revision", async () => {
    const first = revision("revision-1", null, binding);
    const adoption = revision("revision-2", binding, { mode: "router", connectionId: "previous-pool" });
    const switchPool = revision("revision-3", { mode: "router", connectionId: "previous-pool" }, pool);
    expect((await decision({ agentRuntimeConfig: { aiConnection: binding }, agentConfigRevision: aiConnectionRevisionMetadata(first) }, { agentConfigRevision: aiConnectionRevisionMetadata(switchPool) }, { revisions: [switchPool, adoption, first] })).reset).toBe(false);
  });
  it("retains resets when the same edit also changes unrelated configuration", async () => {
    const first = revision("revision-1", null, binding);
    const edit = revision("revision-2", binding, pool, { name: "Renamed agent" });
    expect(aiConnectionOnlyConfigRevision(edit)).toBe(false);
    expect((await decision({ agentRuntimeConfig: { aiConnection: binding }, agentConfigRevision: aiConnectionRevisionMetadata(first) }, { agentConfigRevision: aiConnectionRevisionMetadata(edit) }, { revisions: [edit, first] })).reset).toBe(true);
  });
  it("does not bridge a stale revision over a newer runtime settings change", async () => {
    const first = revision("revision-1", null, binding);
    const adoption = revision("revision-2", binding, pool);
    expect((await decision({ agentRuntimeConfig: { aiConnection: binding }, agentConfigRevision: aiConnectionRevisionMetadata(first) }, { agentRuntimeConfig: { aiConnection: pool, heartbeat: { enabled: false } }, agentConfigRevision: aiConnectionRevisionMetadata(adoption) }, { revisions: [adoption, first] })).reset).toBe(true);
  });
  it.each([
    { effectiveAdapterConfig: { ...config, model: "gpt-5.6-terra" } },
    { effectiveAdapterConfig: { ...config, provider: "acpx", acpxAgent: "codex" } },
    { effectiveAdapterConfig: { ...config, env: { ...config.env, OTHER: "changed" } } },
    { agentRuntimeConfig: { aiConnection: pool, heartbeat: { maxConcurrentRuns: 2 } } },
    { workspaceConfig: { effectiveMode: "isolated_workspace" } },
  ])("preserves normal resets for effective settings changes: %j", async next => {
    expect((await decision({ agentRuntimeConfig: { aiConnection: binding } }, next)).reset).toBe(true);
  });
  it("preserves an explicit session reset even when a compatibility fingerprint matches", async () => {
    expect((await decision({ agentRuntimeConfig: { aiConnection: binding } }, {}, {}, "explicit session reset")).reset).toBe(true);
  });
  it("migrates a legacy token fingerprint only for the unchanged credential at epoch zero", async () => {
    const managed = { ...config.managedAiConnection } as Record<string, unknown>; delete managed.sessionIdentity;
    expect((await decision({ agentRuntimeConfig: { aiConnection: binding }, effectiveAdapterConfig: { ...config, managedAiConnection: managed } }, {}, { storedIdentity: credentialIdentity })).reset).toBe(false);
  });
  it("does not treat a changed token or a manual replacement of the same bytes as legacy-compatible", () => {
    expect(managedAiSessionIdentityCompatible("grant:alice:old-token", sessionIdentity, credentialIdentity)).toBe(false);
    expect(managedAiSessionIdentityCompatible(credentialIdentity, "grant:alice:1", credentialIdentity)).toBe(false);
    expect(managedAiSessionIdentityCompatible(sessionIdentity, "grant:alice:1", credentialIdentity)).toBe(false);
    expect(managedAiSessionIdentityCompatible(sessionIdentity, sessionIdentity, "grant:alice:refreshed-token")).toBe(true);
  });
  it("rejects compatibility candidates for a different account or responsible user", () => {
    const input = { ...base, originalIssueOverrides: null, binding, router: true, sessionIdentity, credentialIdentity, revisions: [] };
    expect(aiConnectionSessionCompatibilityInputs({ ...input, storedIdentity: "other-grant:alice:0" })).toEqual([]);
    expect(aiConnectionSessionCompatibilityInputs({ ...input, storedIdentity: "grant:bob:0" })).toEqual([]);
  });
});
