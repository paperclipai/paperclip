import { describe, expect, it } from "vitest";

import {
  assertCanStartAgentWithReadiness,
  adapterReadinessService,
  evaluateAdapterReadiness,
  shouldBlockAgentExecutionForReadiness,
} from "../services/adapter-readiness/index.js";

function createSelectSequenceDb(rowSets: unknown[][]) {
  let selectCalls = 0;

  return {
    get selectCalls() {
      return selectCalls;
    },
    select: () => {
      const rows = rowSets[selectCalls] ?? [];
      selectCalls += 1;

      return {
        from: () => ({
          where: () => ({
            limit: async () => rows,
            orderBy: () => ({
              limit: async () => rows,
            }),
          }),
        }),
      };
    },
  };
}

describe("adapter readiness", () => {
  it("blocks execution when basic readiness fails", () => {
    const result = evaluateAdapterReadiness({
      adapterType: "codex_local",
      cliFound: false,
      authOk: false,
      modelOk: false,
      workspaceOk: true,
      helloRunOk: false,
      operationalWarnings: [],
      fixtureReady: false,
      strictMode: false,
    });

    expect(result.status).toBe("blocked");
    expect(result.basicReady).toBe(false);
    expect(result.reasonCodes).toContain("binary_missing");
    expect(result.reasonCodes).toContain("fixture_run_missing");
    expect(result.executionBlocked).toBe(true);
    expect(shouldBlockAgentExecutionForReadiness(result)).toBe(true);
  });

  it("warns on operational gaps unless strict mode is enabled", () => {
    const warning = evaluateAdapterReadiness({
      adapterType: "claude_local",
      cliFound: true,
      authOk: true,
      modelOk: true,
      workspaceOk: true,
      helloRunOk: true,
      operationalWarnings: ["quota_unknown"],
      fixtureReady: false,
      strictMode: false,
    });
    expect(warning.status).toBe("warning");
    expect(warning.executionBlocked).toBe(false);
    expect(shouldBlockAgentExecutionForReadiness(warning)).toBe(false);

    const strict = evaluateAdapterReadiness({
      adapterType: "claude_local",
      cliFound: true,
      authOk: true,
      modelOk: true,
      workspaceOk: true,
      helloRunOk: true,
      operationalWarnings: ["quota_unknown"],
      fixtureReady: false,
      strictMode: true,
    });
    expect(strict.status).toBe("blocked");
    expect(strict.executionBlocked).toBe(true);
    expect(shouldBlockAgentExecutionForReadiness(strict)).toBe(true);
  });

  it("explains fixture-only readiness warnings", () => {
    const result = evaluateAdapterReadiness({
      adapterType: "agy_local",
      cliFound: true,
      authOk: true,
      modelOk: true,
      workspaceOk: true,
      helloRunOk: true,
      operationalWarnings: [],
      fixtureReady: false,
      strictMode: false,
    });

    expect(result.status).toBe("warning");
    expect(result.basicReady).toBe(true);
    expect(result.operationalReady).toBe(true);
    expect(result.reasonCodes).toEqual(["fixture_run_missing"]);
    expect(result.executionBlocked).toBe(false);
  });

  it("does not treat a registration-only hello run as a failed hello run", () => {
    const result = evaluateAdapterReadiness({
      adapterType: "codex_local",
      cliFound: true,
      authOk: true,
      modelOk: true,
      workspaceOk: true,
      helloRunOk: null,
      operationalWarnings: [],
      fixtureReady: false,
      strictMode: false,
    });

    expect(result.basicReady).toBe(true);
    expect(result.status).toBe("warning");
    expect(result.reasonCodes).toEqual(["fixture_run_missing"]);
    expect(result.executionBlocked).toBe(false);
  });

  it("throws a stable error when readiness blocks execution", () => {
    expect(() =>
      assertCanStartAgentWithReadiness({
        basicReady: false,
        operationalReady: false,
        strictMode: false,
        reasonCodes: ["binary_missing"],
      }),
    ).toThrow("Adapter readiness blocks execution: binary_missing");
  });

  it("rejects probes when the requested adapter does not match the agent", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: "agent-1",
                companyId: "company-1",
                adapterType: "claude_local",
                adapterConfig: {},
                role: "engineer",
                title: "Engineer",
                capabilities: null,
              },
            ],
          }),
        }),
      }),
      insert: () => {
        throw new Error("insert should not be called");
      },
    };

    await expect(
      adapterReadinessService(db as never).probeAgent("company-1", "agent-1", {
        adapterType: "codex_local",
        strictMode: false,
        checkedByUserId: "user-1",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Probe adapter type does not match agent adapter type",
    });
  });

  it("rejects latest readiness reads when the agent is not in the requested company", async () => {
    const db = createSelectSequenceDb([[]]);

    await expect(
      adapterReadinessService(db as never).getLatestForAgent("company-1", "cross-company-agent"),
    ).rejects.toMatchObject({
      status: 404,
      message: "Agent not found",
    });
    expect(db.selectCalls).toBe(1);
  });

  it("returns null for owned agents that do not have non-expired readiness evidence", async () => {
    const db = createSelectSequenceDb([[{ id: "agent-1" }], []]);

    await expect(
      adapterReadinessService(db as never).getLatestForAgent("company-1", "agent-1"),
    ).resolves.toBeNull();
    expect(db.selectCalls).toBe(2);
  });
});
