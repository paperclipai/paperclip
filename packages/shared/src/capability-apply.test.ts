import { describe, expect, it } from "vitest";
import { buildCapabilityApplyPlan, CAPABILITY_APPLY_ERROR_CODES } from "./capability-apply.js";

const baseInput = {
  companyId: "company-1",
  agentId: "agent-1",
  effectiveDelta: {
    mcpServerChanges: [
      {
        kind: "add" as const,
        serverId: "server-abc",
        displayName: "Test MCP Server",
        catalogId: "verified/test",
        transport: "stdio" as const,
        requiredSecretNames: ["SOME_API_KEY"],
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    ],
  },
};

describe("buildCapabilityApplyPlan", () => {
  describe("stable dryRunHash", () => {
    it("produces the same hash regardless of key order in mcpServerChanges", () => {
      const r1 = buildCapabilityApplyPlan(baseInput);
      // Same input, just different JS object property ordering (no effect on JSON.stringify order after canonicalization)
      const r2 = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            {
              transport: "stdio" as const,
              serverId: "server-abc",
              kind: "add" as const,
              displayName: "Test MCP Server",
              catalogId: "verified/test",
              requiredSecretNames: ["SOME_API_KEY"],
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: false,
            },
          ],
        },
      });
      expect(r1.dryRunHash).toBe(r2.dryRunHash);
    });

    it("produces the same hash regardless of requiredSecretNames array order", () => {
      const r1 = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            { ...baseInput.effectiveDelta.mcpServerChanges[0], requiredSecretNames: ["B_KEY", "A_KEY"] },
          ],
        },
      });
      const r2 = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            { ...baseInput.effectiveDelta.mcpServerChanges[0], requiredSecretNames: ["A_KEY", "B_KEY"] },
          ],
        },
      });
      expect(r1.dryRunHash).toBe(r2.dryRunHash);
    });

    it("produces the same hash regardless of mcpServerChanges order (sorted by serverId)", () => {
      const s1 = { kind: "add" as const, serverId: "alpha", displayName: "Alpha", requiredSecretNames: [] };
      const s2 = { kind: "add" as const, serverId: "beta", displayName: "Beta", requiredSecretNames: [] };
      const r1 = buildCapabilityApplyPlan({ ...baseInput, effectiveDelta: { mcpServerChanges: [s1, s2] } });
      const r2 = buildCapabilityApplyPlan({ ...baseInput, effectiveDelta: { mcpServerChanges: [s2, s1] } });
      expect(r1.dryRunHash).toBe(r2.dryRunHash);
    });

    it("produces a different hash when content changes", () => {
      const r1 = buildCapabilityApplyPlan(baseInput);
      const r2 = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [{ ...baseInput.effectiveDelta.mcpServerChanges[0], displayName: "Different Name" }],
        },
      });
      expect(r1.dryRunHash).not.toBe(r2.dryRunHash);
    });

    it("hash is a 32-char hex string", () => {
      const r = buildCapabilityApplyPlan(baseInput);
      expect(r.dryRunHash).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe("governance_critical refusal", () => {
    it("sets hasGovernanceCritical when a step has governance_critical riskClass", () => {
      const r = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            {
              kind: "add" as const,
              serverId: "gov-server",
              displayName: "Gov Server",
              riskClass: "governance_critical",
              requiredSecretNames: [],
            },
          ],
        },
      });
      expect(r.hasGovernanceCritical).toBe(true);
      expect(r.governanceCriticalStepKinds).toContain("add_mcp_server");
    });

    it("does not flag non-governance_critical steps", () => {
      const r = buildCapabilityApplyPlan(baseInput);
      expect(r.hasGovernanceCritical).toBe(false);
      expect(r.governanceCriticalStepKinds).toHaveLength(0);
    });
  });

  describe("step generation", () => {
    it("generates add_mcp_server step for add change", () => {
      const r = buildCapabilityApplyPlan(baseInput);
      expect(r.steps).toHaveLength(1);
      expect(r.steps[0].kind).toBe("add_mcp_server");
      expect(r.steps[0].target.label).toBe("Test MCP Server");
      expect(r.steps[0].target.catalogId).toBe("verified/test");
      expect(r.steps[0].target.namedSecretRefs).toEqual(["SOME_API_KEY"]);
    });

    it("generates remove_mcp_server step as internal_safe", () => {
      const r = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            { kind: "remove" as const, serverId: "server-abc", displayName: "Test MCP Server", requiredSecretNames: [] },
          ],
        },
      });
      expect(r.steps[0].kind).toBe("remove_mcp_server");
      expect(r.steps[0].riskClass).toBe("internal_safe");
    });

    it("generates destructive_or_spend for destructiveHint:true", () => {
      const r = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            { ...baseInput.effectiveDelta.mcpServerChanges[0], destructiveHint: true },
          ],
        },
      });
      expect(r.steps[0].riskClass).toBe("destructive_or_spend");
    });

    it("generates external_readonly for readOnlyHint:true", () => {
      const r = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            { ...baseInput.effectiveDelta.mcpServerChanges[0], readOnlyHint: true, openWorldHint: false },
          ],
        },
      });
      expect(r.steps[0].riskClass).toBe("external_readonly");
    });

    it("generates skill_ref steps as internal_safe", () => {
      const r = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          skillRefChanges: [{ kind: "add" as const, ref: "some-skill" }],
        },
      });
      expect(r.steps[0].kind).toBe("add_skill_ref");
      expect(r.steps[0].riskClass).toBe("internal_safe");
    });

    it("handles empty delta", () => {
      const r = buildCapabilityApplyPlan({ ...baseInput, effectiveDelta: {} });
      expect(r.steps).toHaveLength(0);
      expect(r.hasGovernanceCritical).toBe(false);
    });
  });

  describe("remoteUrl plumbing (LET-402 G.4)", () => {
    it("carries remoteUrl from effectiveDelta into step.target", () => {
      const r = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            {
              ...baseInput.effectiveDelta.mcpServerChanges[0],
              transport: "streamable_http" as const,
              remoteUrl: "https://api.example.com/mcp",
            },
          ],
        },
      });
      expect(r.steps[0].target.remoteUrl).toBe("https://api.example.com/mcp");
      expect(r.steps[0].target.transport).toBe("streamable_http");
    });

    it("includes remoteUrl in dryRunHash so changing it changes the hash", () => {
      const r1 = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            { ...baseInput.effectiveDelta.mcpServerChanges[0], remoteUrl: "https://a.example.com/mcp" },
          ],
        },
      });
      const r2 = buildCapabilityApplyPlan({
        ...baseInput,
        effectiveDelta: {
          mcpServerChanges: [
            { ...baseInput.effectiveDelta.mcpServerChanges[0], remoteUrl: "https://b.example.com/mcp" },
          ],
        },
      });
      expect(r1.dryRunHash).not.toBe(r2.dryRunHash);
    });
  });

  describe("idempotent hash", () => {
    it("calling twice with same input gives same hash (deterministic)", () => {
      const r1 = buildCapabilityApplyPlan(baseInput);
      const r2 = buildCapabilityApplyPlan(baseInput);
      expect(r1.dryRunHash).toBe(r2.dryRunHash);
    });
  });
});
