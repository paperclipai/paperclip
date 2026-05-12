import { describe, expect, it } from "vitest";
import type {
  BeforeRunParams,
  BeforeRunResult,
  PluginRunsClient,
  PluginContext,
} from "../types.js";

describe("WS-1 SDK types", () => {
  it("BeforeRunParams has required fields", () => {
    const p: BeforeRunParams = {
      runId: "run-1",
      agentId: "agent-1",
      issueId: null,
      companyId: "company-1",
      invocationSource: "automation",
    };
    expect(p.runId).toBe("run-1");
    expect(p.issueId).toBeNull();
  });

  it("BeforeRunResult veto:false is valid", () => {
    const r: BeforeRunResult = { veto: false };
    expect(r.veto).toBe(false);
  });

  it("BeforeRunResult veto:true requires reason string", () => {
    const r: BeforeRunResult = { veto: true, reason: "pool full" };
    expect(r.veto).toBe(true);
    if (r.veto) expect(r.reason).toBe("pool full");
  });

  it("PluginContext has a runs property", () => {
    type HasRuns = Pick<PluginContext, "runs">;
    const check: HasRuns = {
      runs: {
        onBeforeRun: (_handler) => {},
      },
    };
    expect(typeof check.runs.onBeforeRun).toBe("function");
  });

  it("PluginRunsClient.onBeforeRun accepts async handler", () => {
    const client: PluginRunsClient = {
      onBeforeRun: (_handler) => {},
    };
    const handler = async (_p: BeforeRunParams): Promise<BeforeRunResult> => ({ veto: false });
    expect(() => client.onBeforeRun(handler)).not.toThrow();
  });
});
