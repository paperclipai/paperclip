import { describe, expect, it, vi } from "vitest";
import {
  broadcastBeforeRun,
  type BeforeRunGatePlugin,
  type BeforeRunParams,
  type BeforeRunResult,
} from "../services/plugin-worker-manager.js";

const params: BeforeRunParams = {
  runId: "run-1",
  agentId: "agent-1",
  issueId: "issue-1",
  companyId: "company-1",
  invocationSource: "user_initiated",
};

function makeGate(
  result: BeforeRunResult,
  pluginId = "plugin-a",
): BeforeRunGatePlugin {
  return {
    pluginId,
    callBeforeRun: vi.fn().mockResolvedValue(result),
  };
}

describe("broadcastBeforeRun", () => {
  it("returns allow when no gate plugins registered", async () => {
    const result = await broadcastBeforeRun([], params);
    expect(result).toEqual({ veto: false });
  });

  it("returns allow when all gates return veto: false", async () => {
    const gates = [makeGate({ veto: false }, "a"), makeGate({ veto: false }, "b")];
    const result = await broadcastBeforeRun(gates, params);
    expect(result).toEqual({ veto: false });
  });

  it("returns first veto encountered (in order) with vetoPluginId", async () => {
    const gates = [
      makeGate({ veto: false }, "a"),
      makeGate({ veto: true, reason: "blocked by b" }, "b"),
      makeGate({ veto: true, reason: "blocked by c" }, "c"),
    ];
    const result = await broadcastBeforeRun(gates, params);
    expect(result).toEqual({ veto: true, reason: "blocked by b", vetoPluginId: "b" });
  });

  it("stops calling subsequent gates after first veto", async () => {
    const gateA = makeGate({ veto: false }, "a");
    const gateB = makeGate({ veto: true, reason: "stop" }, "b");
    const gateC = makeGate({ veto: false }, "c");
    await broadcastBeforeRun([gateA, gateB, gateC], params);
    expect(gateC.callBeforeRun).not.toHaveBeenCalled();
  });

  it("truncates veto reason to 500 chars", async () => {
    const longReason = "x".repeat(600);
    const gates = [makeGate({ veto: true, reason: longReason }, "a")];
    const result = await broadcastBeforeRun(gates, params);
    expect(result).toEqual({ veto: true, reason: "x".repeat(500), vetoPluginId: "a" });
  });

  it("fails open when gate throws (returns veto: false)", async () => {
    const gate: BeforeRunGatePlugin = {
      pluginId: "failing-plugin",
      callBeforeRun: vi.fn().mockRejectedValue(new Error("handler crashed")),
    };
    const result = await broadcastBeforeRun([gate], params);
    expect(result).toEqual({ veto: false });
  });

  it("fails open when gate returns null (malformed response)", async () => {
    const gate: BeforeRunGatePlugin = {
      pluginId: "malformed-plugin",
      callBeforeRun: vi.fn().mockResolvedValue(null as unknown as BeforeRunResult),
    };
    const result = await broadcastBeforeRun([gate], params);
    expect(result).toEqual({ veto: false });
  });

  it("fails open when gate returns veto:true without reason (malformed)", async () => {
    const gate: BeforeRunGatePlugin = {
      pluginId: "malformed-plugin",
      callBeforeRun: vi.fn().mockResolvedValue({ veto: true } as unknown as BeforeRunResult),
    };
    const result = await broadcastBeforeRun([gate], params);
    expect(result).toEqual({ veto: false });
  });
});
