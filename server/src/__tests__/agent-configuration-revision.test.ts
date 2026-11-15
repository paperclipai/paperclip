import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentAppearance } from "@paperclipai/shared";
import { agentConfigurationRevision, restoreAgentConfigurationRedactions } from "../lib/agent-configuration-revision.js";
import { redactAgentAdapterConfig } from "../redaction.js";
import { resolveDefaultSecretsKeyFilePath } from "../home-paths.js";

const agent = {
  id: "11111111-1111-4111-8111-111111111111", name: "Codie", role: "engineer" as const, title: null,
  icon: null, appearance: null, reportsTo: null, capabilities: null, adapterType: "codex_local" as const,
  adapterConfig: { model: "example", env: { API_KEY: "fake-secret" }, apiKey: "fake-adapter-secret" },
  runtimeConfig: {}, defaultEnvironmentId: null, budgetMonthlyCents: 0, metadata: null, permissions: {},
};

describe("agent configuration revisions and redactions", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keys revisions with the private instance secret while detecting hidden credential edits", () => {
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "a".repeat(32));
    const original = agentConfigurationRevision(agent);
    expect(agentConfigurationRevision({ ...agent, adapterConfig: { ...agent.adapterConfig, apiKey: "changed-hidden-secret" } }))
      .not.toBe(original);
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "b".repeat(32));
    expect(agentConfigurationRevision(agent)).not.toBe(original);
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "a".repeat(32));
    expect(agentConfigurationRevision(agent)).toBe(original);
  });

  it("uses a signing key rotated in place without restarting the process", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "agent-yaml-signing-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "");
    try {
      const original = agentConfigurationRevision(agent);
      const keyPath = path.join(path.dirname(resolveDefaultSecretsKeyFilePath()), "decision-signing.key");
      const previous = readFileSync(keyPath, "utf8");
      writeFileSync(keyPath, "rotated-private-key".repeat(4), { mode: 0o600 });
      expect(agentConfigurationRevision(agent)).not.toBe(original);
      writeFileSync(keyPath, previous, { mode: 0o600 });
      expect(agentConfigurationRevision(agent)).toBe(original);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("normalizes raw and presented rows and ignores live bookkeeping", () => {
    expect(agentConfigurationRevision({ ...agent, appearance: resolveAgentAppearance(null, agent.id), permissions: { canCreateAgents: false, canCreateSkills: true } }))
      .toBe(agentConfigurationRevision(agent));
    const runtimeChange = { ...agent, status: "running", spentMonthlyCents: 100, updatedAt: new Date() };
    expect(agentConfigurationRevision(runtimeChange)).toBe(agentConfigurationRevision(agent));
    for (const patch of [{ name: "Renamed" }, { budgetMonthlyCents: 2 }, { adapterConfig: { ...agent.adapterConfig, model: "new" } }]) {
      expect(agentConfigurationRevision({ ...agent, ...patch })).not.toBe(agentConfigurationRevision(agent));
    }
  });

  it("preserves redacted secrets while changing another key and permits explicit removal", () => {
    const displayed = redactAgentAdapterConfig(agent.adapterConfig);
    expect(restoreAgentConfigurationRedactions({ ...displayed, model: "new" }, agent.adapterConfig, displayed))
      .toEqual({ ...agent.adapterConfig, model: "new" });
    expect(restoreAgentConfigurationRedactions({ model: "new" }, agent.adapterConfig, displayed)).toEqual({ model: "new" });
  });

  it("rejects moved and partially edited redactions", () => {
    expect(() => restoreAgentConfigurationRedactions({ other: "***REDACTED***" }, { apiKey: "secret" }, { apiKey: "***REDACTED***" })).toThrow("redacted value");
    expect(() => restoreAgentConfigurationRedactions("Bearer ***REDACTED*** edited", "Bearer secret", "Bearer ***REDACTED***")).toThrow("redacted value");
  });
});
