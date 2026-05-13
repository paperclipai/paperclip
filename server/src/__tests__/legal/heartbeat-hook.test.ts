import { describe, it, expect, vi } from "vitest";
import {
  evaluatePreActionGate,
  type PreActionGateLogger,
} from "../../services/legal/heartbeat-hook.js";
import type {
  GateEvaluationContext,
  GateFiring,
  LegalRuntime,
  ProfileDefinition,
  RiskGateDefinition,
} from "../../services/legal/types.js";

function recordingLogger(): PreActionGateLogger & {
  infoCalls: Array<{ payload: Record<string, unknown>; msg: string }>;
  errorCalls: Array<{ payload: Record<string, unknown>; msg: string }>;
} {
  const infoCalls: Array<{ payload: Record<string, unknown>; msg: string }> = [];
  const errorCalls: Array<{ payload: Record<string, unknown>; msg: string }> = [];
  return {
    infoCalls,
    errorCalls,
    info(payload, msg) {
      infoCalls.push({ payload, msg });
    },
    error(payload, msg) {
      errorCalls.push({ payload, msg });
    },
  };
}

function fakeRuntime(opts: {
  firings?: GateFiring[];
  throws?: Error;
}): LegalRuntime & { evaluate: ReturnType<typeof vi.fn> } {
  const evaluate = vi.fn((_ctx: GateEvaluationContext) => {
    if (opts.throws) throw opts.throws;
    return opts.firings ?? [];
  });
  return {
    profile: { profile: "test", display_name: "Test" } as unknown as ProfileDefinition,
    gates: {} as Record<string, RiskGateDefinition>,
    evaluate,
  };
}

describe("evaluatePreActionGate", () => {
  it("is a no-op when legalLayer is undefined (legacy paperclip deploy)", () => {
    const log = recordingLogger();
    const result = evaluatePreActionGate(
      undefined,
      { action: "adapter.invoke", agentId: "agent-1" },
      log,
    );
    expect(result).toEqual([]);
    expect(log.infoCalls).toHaveLength(0);
    expect(log.errorCalls).toHaveLength(0);
  });

  it("calls runtime.evaluate exactly once with the supplied context", () => {
    const log = recordingLogger();
    const runtime = fakeRuntime({ firings: [] });
    evaluatePreActionGate(
      runtime,
      { action: "adapter.invoke", agentId: "agent-1" },
      log,
    );
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
    expect(runtime.evaluate).toHaveBeenCalledWith({
      action: "adapter.invoke",
      agentId: "agent-1",
    });
  });

  it("logs an info line with firingsCount=0 when no gates match", () => {
    const log = recordingLogger();
    evaluatePreActionGate(
      fakeRuntime({ firings: [] }),
      { action: "adapter.invoke", agentId: "agent-1" },
      log,
      { runId: "run-99" },
    );
    expect(log.infoCalls).toHaveLength(1);
    expect(log.infoCalls[0].msg).toContain("pre-action gate evaluation");
    expect(log.infoCalls[0].payload).toMatchObject({
      runId: "run-99",
      agentId: "agent-1",
      action: "adapter.invoke",
      firingsCount: 0,
      firings: [],
    });
  });

  it("logs each firing in the payload when gates fire", () => {
    const log = recordingLogger();
    const firings: GateFiring[] = [
      {
        gateKey: "filing",
        matchedTrigger: "artifact_kind",
        approverRole: "partner",
        autoBlock: true,
        evidenceRequired: ["assigned_attorney_of_record"],
        hardBlocks: [],
      },
      {
        gateKey: "budget-threshold",
        matchedTrigger: "cost_threshold",
        approverRole: "general_counsel",
        autoBlock: false,
        evidenceRequired: [],
        hardBlocks: [],
      },
    ];
    const result = evaluatePreActionGate(
      fakeRuntime({ firings }),
      { action: "file", agentId: "agent-1" },
      log,
      { runId: "run-99" },
    );
    expect(result).toEqual(firings);
    expect(log.infoCalls).toHaveLength(1);
    expect(log.infoCalls[0].payload).toMatchObject({
      runId: "run-99",
      firingsCount: 2,
      firings: [
        { gateKey: "filing", approverRole: "partner", autoBlock: true },
        { gateKey: "budget-threshold", approverRole: "general_counsel", autoBlock: false },
      ],
    });
  });

  it("never throws when runtime.evaluate throws; logs error instead", () => {
    const log = recordingLogger();
    const result = evaluatePreActionGate(
      fakeRuntime({ throws: new Error("malformed gate yaml") }),
      { action: "adapter.invoke", agentId: "agent-1" },
      log,
      { runId: "run-99" },
    );
    expect(result).toEqual([]);
    expect(log.infoCalls).toHaveLength(0);
    expect(log.errorCalls).toHaveLength(1);
    expect(log.errorCalls[0].msg).toContain("threw");
    expect(log.errorCalls[0].payload).toMatchObject({
      runId: "run-99",
      agentId: "agent-1",
      action: "adapter.invoke",
    });
    expect(log.errorCalls[0].payload.err).toBeInstanceOf(Error);
  });
});
