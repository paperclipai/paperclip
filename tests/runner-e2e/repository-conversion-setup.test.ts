import { describe, expect, it, vi } from "vitest";
import { runnerSuites } from "./catalog.js";
import { convertRepositoryProofAgent } from "./repository-conversion-setup.js";

function fixtures(driver = "sandbox"): Parameters<typeof convertRepositoryProofAgent>[1] {
  return { agent: { id: "agent", name: "Fixture Agent", companyId: "company" }, company: { id: "company", name: "Fixture Company" }, environment: { id: "environment", driver,
    config: { image: `image@sha256:${"a".repeat(64)}` } } };
}

describe("real legacy conversion prerequisites", () => {
  it("constructs compatible legacy settings before recording a retention baseline", () => {
    const suite = runnerSuites.find(suite => suite.id === "legacy-conversion")!;
    for (const profile of suite.profiles) {
      const agent = profile.buildAgent({ environmentId: "environment", environmentFixtureId: "local", workspacePath: "/owned/workspace",
        executionId: "fixture", secretRefs: { OPENAI_API_KEY: { type: "secret_ref", secretId: "codex-reference", version: "latest" },
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "claude-reference", version: "latest" } } });
      expect(agent.runner).toBe("legacy");
      expect(agent.adapterType).toBe(profile.provider === "codex" ? "codex_local" : "claude_local");
      expect(agent.adapterConfig).toMatchObject({ model: profile.model, timeoutSec: 360, cwd: "/owned/workspace" });
      expect(agent.adapterConfig).not.toHaveProperty("extraArgs");
      expect(agent.adapterConfig).not.toHaveProperty("maxTurnsPerRun");
      expect((agent.adapterConfig as Record<string, any>).env).toMatchObject(profile.provider === "codex"
        ? { OPENAI_API_KEY: { type: "secret_ref", secretId: "codex-reference", version: "latest" } }
        : { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "claude-reference", version: "latest" } });
    }
  });
  it("qualifies the sandbox before selecting Runner for either provider", async () => {
    const fixture = fixtures(); let qualified = false;
    const api = { post: vi.fn(async () => { qualified = true; return { ok: true, details: { platformQualificationRecorded: true, leaseId: "lease" } }; }),
      patch: vi.fn(async () => { if (!qualified) throw new Error("agent_runner_unavailable"); return {}; }) };
    await expect(convertRepositoryProofAgent(api as any, fixture)).resolves.toBeUndefined();
    expect(api.post).toHaveBeenCalledWith("/api/environments/environment/probe?companyId=company", {}, { timeout: 330_000 });
    expect(fixture.setupProbe).toMatchObject({ leaseId: "lease" });
    expect(api.patch).toHaveBeenCalledExactlyOnceWith("/api/agents/agent", { runner: "paperclip" });
  });
  it("does not attempt conversion when platform qualification is absent", async () => {
    const fixture = fixtures(); const api = { post: vi.fn(async () => ({ ok: true, details: { leaseId: "lease" } })), patch: vi.fn() };
    await expect(convertRepositoryProofAgent(api as any, fixture)).rejects.toThrow("qualification");
    expect(api.patch).not.toHaveBeenCalled();
    expect(fixture.setupProbe?.leaseId).toBe("lease");
  });
  it("retains uncertain probe accounting when the response is lost", async () => {
    const fixture = fixtures(); const api = { post: vi.fn(async () => { throw new Error("connection lost"); }), patch: vi.fn() };
    await expect(convertRepositoryProofAgent(api as any, fixture)).rejects.toThrow("connection lost");
    expect(api.patch).not.toHaveBeenCalled();
    expect(fixture.setupLeaseAccountingIncomplete).toBe(true);
  });
  it.each([{ image: "image:latest" }, { image: `image@sha256:${"a".repeat(64)}`, snapshot: "snapshot" }])("refuses an unqualified image before creating a sandbox", async config => {
    const fixture = fixtures(); fixture.environment.config = config;
    const api = { post: vi.fn(), patch: vi.fn() };
    await expect(convertRepositoryProofAgent(api as any, fixture)).rejects.toThrow("immutable");
    expect(api.post).not.toHaveBeenCalled(); expect(api.patch).not.toHaveBeenCalled();
  });
  it("converts a local agent without creating a remote sandbox", async () => {
    const api = { post: vi.fn(), patch: vi.fn(async () => ({})) };
    await convertRepositoryProofAgent(api as any, fixtures("local"));
    expect(api.post).not.toHaveBeenCalled(); expect(api.patch).toHaveBeenCalledOnce();
  });
});
