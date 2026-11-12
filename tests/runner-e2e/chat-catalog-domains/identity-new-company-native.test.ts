import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NEW_COMPANY_NATIVE_MODEL, NEW_COMPANY_PROVIDER_MODEL, nativeSetupRequest, requireNativeFirstAgentProof } from "./identity-new-company-native-proof.js";
import { aiRoutingModel } from "../../../packages/shared/src/ai-provider-routing.js";
import { createAiConnectionSchema } from "../../../packages/shared/src/ai-connections.js";
import { resolveRouteOnboardingOptions } from "../../../ui/src/lib/onboarding-route.js";
type Proof = Parameters<typeof requireNativeFirstAgentProof>[0];
const companyId = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222";
function proof(): Proof {
  const binding = { provider: "openrouter", method: "api_key", mode: "delegated", connectionId: "connection", grantId: "grant" };
  const request = { companyId, agentId, environmentId: "local-target", adapterType: "paperclip_runner", provider: "opencode", model: NEW_COMPANY_NATIVE_MODEL, binding, containsCredential: false };
  // Synthetic projections of the actual public DTOs. No API, grant or agent is created.
  return {
    company: { id: companyId, name: "Website business", issuePrefix: "WEB", defaultResponsibleUserId: "human" },
    agent: { id: agentId, companyId, name: "CEO", role: "ceo", adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: NEW_COMPANY_NATIVE_MODEL }, runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false } }, defaultEnvironmentId: "local-target", lifecycleState: "ready", status: "idle" },
    humanId: "human", environment: { id: "local-target", driver: "local" }, savedSetupAgentId: agentId,
    probes: [{ ...request, sequence: 1, httpStatus: 200, resultAdapterType: "paperclip_runner", status: "pass", checks: [{ code: "opencode_hello_probe_passed", level: "info" }] }],
    hires: [{ ...request, sequence: 2, httpStatus: 201, resultAgentId: agentId }], connection: { connectionId: "connection", grantId: "grant" },
    accounts: { currentUserId: "human", canManageConnections: true, connections: [{ id: "connection", grantId: "grant", companyId, provider: "openrouter", method: "api_key", name: "My OpenRouter", status: "connected", ownership: "personal", ownerUserId: "human", isDefault: false,
      routing: { kind: "openrouter", protocol: "chat", auth: "bearer", models: [{ id: NEW_COMPANY_PROVIDER_MODEL }] } }] },
    grants: { currentUserId: "human", connection: { id: "connection", uid: "connection" }, grants: [{ id: "grant", connectionId: "connection", companyId, kind: "user", subjectUserId: "human", status: "active" }] },
    installs: [{ companyId, connectionId: "connection", targetType: "agent", targetId: agentId }],
  } as unknown as Proof;
}
describe("native first-agent public setup custody", () => {
  it("accepts the same saved CEO/account/local model test and hire", () => expect(() => requireNativeFirstAgentProof(proof())).not.toThrow());
  for (const [name, mutate] of Object.entries<(p: Proof) => void>({
    "remote target": p => { p.environment.driver = "remote"; },
    "wrong selected target": p => { p.probes[0]!.environmentId = "other"; },
    "wrong company": p => { p.probes[0]!.companyId = "other"; },
    "foreign setup agent": p => { p.probes[0]!.agentId = "other"; },
    "legacy adapter": p => { p.probes[0]!.adapterType = "opencode_local"; },
    "legacy result": p => { p.probes[0]!.resultAdapterType = "opencode_local"; },
    "wrong runtime": p => { p.probes[0]!.provider = "codex"; },
    "wrong model": p => { p.probes[0]!.model = "openrouter/other"; },
    "key validation only": p => { p.probes[0]!.checks = [{ code: "ai_connection_api_key_reverified", level: "info" }]; },
    "wrong hello": p => { p.probes[0]!.checks = [{ code: "codex_hello_probe_passed", level: "info" }]; },
    "probe denied": p => { p.probes[0]!.httpStatus = 403; },
    "warning probe": p => { p.probes[0]!.status = "warn"; },
    "probe error": p => { p.probes[0]!.checks.push({ code: "adapter_auth_missing", level: "error" }); },
    "missing probe": p => { p.probes = []; },
    "second probe": p => { p.probes.push(p.probes[0]!); },
    "late probe": p => { p.probes[0]!.sequence = 3; },
    "missing chronology": p => { p.probes[0]!.sequence = Number.NaN; },
    "foreign account tested": p => { p.probes[0]!.binding = { ...p.probes[0]!.binding!, mode: "delegated", connectionId: "other", grantId: "grant" }; },
    "default-account substitution": p => { p.probes[0]!.binding = { provider: "openrouter", method: "api_key", mode: "responsible_user" }; },
    "raw credential in test": p => { p.probes[0]!.containsCredential = true; },
    "duplicate hire": p => { p.hires.push(p.hires[0]!); },
    "different hire model": p => { p.hires[0]!.model = "other"; },
    "hire replaces setup": p => { p.hires[0]!.resultAgentId = "other"; },
    "hire denied": p => { p.hires[0]!.httpStatus = 403; },
    "final different company": p => { p.agent.companyId = "other"; },
    "renamed general profile": p => { p.agent.role = "general"; },
    "not ready": p => { p.agent.lifecycleState = "setup"; },
    "wrong saved model": p => { p.agent.adapterConfig.model = "other"; },
    "foreign saved environment": p => { p.agent.defaultEnvironmentId = "other"; },
    "enabled first work": p => { p.agent.runtimeConfig.heartbeat = { enabled: true }; },
    "foreign saved grant": p => { p.agent.runtimeConfig.aiConnection = { provider: "openrouter", method: "api_key", mode: "delegated", connectionId: "connection", grantId: "other" }; },
    "other responsible person": p => { p.company.defaultResponsibleUserId = "other"; },
    "other signed-in person": p => { p.accounts.currentUserId = "other"; },
    "shared account": p => { p.accounts.connections[0]!.ownership = "shared"; },
    "unavailable account": p => { p.accounts.connections[0]!.status = "needs_attention"; },
    "foreign account owner": p => { p.accounts.connections[0]!.ownerUserId = "other"; },
    "wrong route protocol": p => { p.accounts.connections[0]!.routing!.protocol = "responses"; },
    "wrong catalog model": p => { p.accounts.connections[0]!.routing!.models[0]!.id = "other"; },
    "no public grant": p => { p.grants.grants = []; },
    "foreign grant": p => { p.grants.grants[0]!.companyId = "other"; },
    "other grant owner": p => { p.grants.grants[0]!.subjectUserId = "other"; },
    "revoked grant": p => { p.grants.grants[0]!.status = "revoked"; },
    "no installation": p => { p.installs = []; },
    "company-wide access": p => { p.installs[0]!.targetType = "company"; p.installs[0]!.targetId = companyId; },
    "other agent access": p => { p.installs[0]!.targetId = "other"; },
  })) it(`rejects ${name}`, () => { const p = proof(); mutate(p); expect(() => requireNativeFirstAgentProof(p)).toThrow(); });
  it("normalizes the existing public test and hire shapes without exposing raw credentials", () => {
    const p = proof(); const config = { provider: "opencode", model: NEW_COMPANY_NATIVE_MODEL };
    expect(nativeSetupRequest({ companyId, adapterType: "paperclip_runner", sequence: 1, body: { agentId, environmentId: "local-target", adapterConfig: config, aiConnection: p.agent.runtimeConfig.aiConnection } }, "synthetic-private-key"))
      .toMatchObject({ agentId, environmentId: "local-target", containsCredential: false, binding: p.agent.runtimeConfig.aiConnection });
    const result = nativeSetupRequest({ companyId, adapterType: "paperclip_runner", sequence: 2, body: { setupAgentId: agentId, defaultEnvironmentId: "local-target", adapterConfig: { ...config, env: { OPENROUTER_API_KEY: "synthetic-private-key" } }, runtimeConfig: p.agent.runtimeConfig } }, "synthetic-private-key");
    expect(result).toMatchObject({ agentId, environmentId: "local-target", containsCredential: true }); expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
  });
});
describe("actual supported route and provider contracts", () => {
  it("ordinary saved-company agents/new does not mount onboarding", () => {
    expect(resolveRouteOnboardingOptions({ pathname: "/WEB/agents/new", companyPrefix: "WEB", companies: [{ id: companyId, issuePrefix: "WEB" }] })).toBeNull();
    expect(resolveRouteOnboardingOptions({ pathname: "/WEB/onboarding", companyPrefix: "WEB", companies: [{ id: companyId, issuePrefix: "WEB" }] })).not.toBeNull();
  });
  it("keeps public OpenRouter catalog ID and native model normalization consistent", () => {
    const routing = proof().accounts.connections[0]!.routing!;
    expect(aiRoutingModel(routing, "opencode_local", NEW_COMPANY_PROVIDER_MODEL)).toBe(NEW_COMPANY_NATIVE_MODEL);
    expect(aiRoutingModel(routing, "opencode_local", NEW_COMPANY_NATIVE_MODEL)).toBe(NEW_COMPANY_NATIVE_MODEL);
    expect(createAiConnectionSchema.parse({ provider: "openrouter", method: "api_key", name: "My OpenRouter", ownership: "personal", allAgents: false, agentIds: [agentId], routing, apiKey: "synthetic-private-key" })).toMatchObject({ ownership: "personal", agentIds: [agentId], allAgents: false });
  });
  it("binds the original production UI draft gate and public first-agent hold/reuse", () => {
    const source = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    expect(source("ui/src/components/OnboardingWizard.tsx")).toContain('const setupSnapshot = step === 4');
    expect(source("ui/src/context/DialogContext.tsx")).toContain('const [onboardingOpen, setOnboardingOpen] = useState(false)');
    expect(source("ui/src/components/new-agent/AgentBasicsDialog.tsx")).toContain('role: existing.length ? "general" : "ceo"');
    expect(source("ui/src/components/new-agent/AgentBasicsDialog.tsx")).toContain('buildNewAgentRuntimeConfig({ heartbeatEnabled: false })');
    expect(source("ui/src/components/new-agent/NewAgentSetup.tsx")).toContain('setupAgentId: created.id');
    expect(source("ui/src/lib/test-agent-setup.ts")).toContain('input.adapterType,');
  });
});
