import { expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { teamConfigureExternalCases } from "./external-team-configure.js";

type Probe = { status: string; testedAt: string; checks: Array<{ code: string; level: string }> };
function setupFixture(missing: Probe, working: Probe = { status: "pass", testedAt: "2026-11-03T00:00:00Z", checks: [] }) {
  const member = (id: string) => ({ id, companyId: "company", name: id, adapterType: "paperclip_runner", adapterConfig: {}, metadata: { paperclip: { catalogTeam: { catalogId: "team" } } } });
  const members = [member("qa"), member("coder")];
  const probes = vi.fn(async (_path: string, body: { agentId?: string }) => body.agentId === "qa" ? missing : working);
  const evidence = vi.fn(async (_name: string, _value: unknown) => {});
  const api = {
    get: async (path: string) => {
      if (path === "/api/teams/catalog") return [{ id: "team", slug: "product-engineering", compatibility: "compatible", agentSlugs: ["qa", "senior-coder"] }];
      if (path.endsWith("/agents")) return members;
      if (path.endsWith("/config-revisions")) return [{ id: "working-revision" }];
      if (path === "/api/agents/coder") return members[1];
      if (["/projects", "/routines", "/teams/catalog/installed"].some(suffix => path.endsWith(suffix))) return [];
      throw new Error("Unexpected setup read");
    },
    postSensitive: async (path: string, body: { agentId?: string }) => path.endsWith("/install")
      ? { portabilityImport: { agents: [{ id: "qa", slug: "qa" }, { id: "coder", slug: "senior-coder" }] } }
      : probes(path, body),
    patchSensitive: vi.fn(async (_path: string, _body: unknown) => {}),
    post: vi.fn(async (_path: string) => {}), patch: vi.fn(async (_path: string, _body: unknown) => {}),
  };
  const ctx = { input: { api, evidence, nonce: "synthetic-team-prerequisite", workspacePath: "/synthetic/workspace", fixtures: { company: { id: "company" }, agent: { id: "ceo" }, environment: { id: "environment" }, secretRefs: {} }, execution: { profile: { credential: "OPENROUTER_API_KEY", buildAgent: () => ({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" } }) }, environment: { id: "local" } } }, refreshIssue: async () => {}, issue: () => ({ id: "source" }) } as unknown as ChatCatalogContext;
  return { ctx, evidence, probes, api };
}
const authWarning: Probe = { status: "warn", testedAt: "2026-11-03T00:00:00Z", checks: [{ code: "opencode_hello_probe_auth_required", level: "warn" }] };
it("the actual setup admits the adapter's exact missing-auth warning and preserves the independently passing member", async () => {
  const f = setupFixture(authWarning), definition = teamConfigureExternalCases[0]!;
  let state: Record<string, unknown> | undefined;
  try {
    state = await definition.setup(f.ctx);
    expect(state.initialProbes).toEqual([{ agentId: "qa", ...authWarning }, { agentId: "coder", status: "pass", testedAt: authWarning.testedAt, checks: [] }]);
    expect((await definition.verifySetup!(f.ctx, state)).passed).toBe(true);
    expect(f.probes).toHaveBeenCalledTimes(2);
    expect(f.evidence).toHaveBeenCalledWith("chat-catalog-team-initial-probes.json", { initialProbes: state.initialProbes });
    expect(f.api.patchSensitive).toHaveBeenCalledTimes(1);
    expect(f.api.patch).toHaveBeenCalledTimes(1);
  } finally { await definition.cleanup!(f.ctx, state ?? {}); }
});
it("retains no provider messages or session fields in the precondition witness", async () => {
  const canary = "synthetic-private-probe-content";
  const raw = { ...authWarning, providerSession: canary, checks: authWarning.checks.map(check => ({ ...check, message: canary, detail: canary })) };
  const f = setupFixture(raw), definition = teamConfigureExternalCases[0]!;
  let state: Record<string, unknown> | undefined;
  try {
    state = await definition.setup(f.ctx);
    expect(JSON.stringify(f.evidence.mock.calls)).not.toContain(canary);
    expect(Object.keys((f.evidence.mock.calls[0]![1] as { initialProbes: object[] }).initialProbes[0]!).sort()).toEqual(["agentId", "checks", "status", "testedAt"]);
  } finally { await definition.cleanup!(f.ctx, state ?? {}); }
});
it.each(["generic warning", "timeout", "model", "wrong level", "other error", "working warning", "working error"])("actual setup rejects %s and retains only closed probe fields before refusing", async fault => {
  const missing = structuredClone(authWarning), working: Probe = { status: "pass", testedAt: authWarning.testedAt, checks: [] };
  if (fault === "generic warning") missing.checks[0]!.code = "opencode_hello_probe_unexpected_output";
  if (fault === "timeout") missing.checks[0]!.code = "opencode_hello_probe_timed_out";
  if (fault === "model") missing.checks[0]!.code = "opencode_hello_probe_model_unavailable";
  if (fault === "wrong level") missing.checks[0]!.level = "info";
  if (fault === "other error") missing.checks.push({ code: "opencode_hello_probe_failed", level: "error" });
  if (fault === "working warning") working.status = "warn";
  if (fault === "working error") working.checks.push({ code: "opencode_hello_probe_failed", level: "error" });
  const f = setupFixture(missing, working);
  await expect(teamConfigureExternalCases[0]!.setup(f.ctx)).rejects.toThrow("actual per-member runtime probes");
  expect(f.probes).toHaveBeenCalledTimes(2);
  expect(f.evidence).toHaveBeenCalledTimes(1);
  expect(f.evidence.mock.calls[0]![1]).toEqual({ initialProbes: [{ agentId: "qa", ...missing }, { agentId: "coder", ...working }] });
  expect(f.api.post).not.toHaveBeenCalled();
});
