import { describe, expect, it } from "vitest";

import {
  SemanticConformanceMismatchError,
  runSemanticConformanceKit,
  type SemanticConformanceAdapter,
  type SemanticConformanceObservation,
} from "./semantic-conformance.js";

const allowed: SemanticConformanceObservation = {
  authorization: { outcome: "allowed" },
  state: { task: { status: "done" } },
  effects: [{ kind: "issue_status", status: "done" }],
  audit: [{ action: "finish_task" }],
};

function adapter(
  id: string,
  observation: SemanticConformanceObservation,
  kind?: SemanticConformanceAdapter["kind"],
): SemanticConformanceAdapter {
  return { id, kind, execute: async () => structuredClone(observation) };
}

describe("semantic conformance kit", () => {
  it("accepts normalized mock/real observations independent of object key order", async () => {
    const report = await runSemanticConformanceKit({
      vectors: [{ id: "finish", operationId: "finish_task", input: { summary: "done" } }],
      adapters: [
        adapter("mock", allowed),
        adapter("real", {
          audit: [{ action: "finish_task" }],
          effects: [{ status: "done", kind: "issue_status" }],
          state: { task: { status: "done" } },
          authorization: { outcome: "allowed" },
        }),
      ],
    });
    expect(report.schema).toBe("paperclip.semantic-conformance-report.v1");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.adapterIds).toEqual(["mock", "real"]);
    expect(report.rows[0]?.observations).toEqual({ mock: allowed, real: allowed });
  });

  it("names the production binding and exact normalized path when it diverges", async () => {
    const failure = runSemanticConformanceKit({
      vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
      adapters: [
        adapter("mock", allowed, "mock"),
        adapter("real", { ...allowed, authorization: { outcome: "denied", code: "forbidden" } }, "production_binding"),
      ],
    });
    await expect(failure).rejects.toMatchObject({
      suspectedSource: "production_binding",
      diffs: [{ path: "$.authorization.code" }, { path: "$.authorization.outcome" }],
    });
    await expect(failure).rejects.toBeInstanceOf(SemanticConformanceMismatchError);
  });

  it("names the contract when adapters agree on the wrong semantics", async () => {
    const failure = runSemanticConformanceKit({
      vectors: [{
        id: "finish",
        operationId: "finish_task",
        input: {},
        expected: { ...allowed, state: { task: { status: "in_review" } } },
      }],
      adapters: [adapter("mock", allowed, "mock"), adapter("real", allowed, "production_binding")],
    });
    await expect(failure).rejects.toMatchObject({
      suspectedSource: "contract",
      diffs: [{ path: "$.state.task.status", expected: "in_review", actual: "done" }],
    });
  });

  it("names the mock when the production binding matches the contract", async () => {
    const denied = { ...allowed, authorization: { outcome: "denied" as const, code: "stale_mock" } };
    const failure = runSemanticConformanceKit({
      vectors: [{ id: "finish", operationId: "finish_task", input: {}, expected: allowed }],
      adapters: [
        adapter("mock", denied, "mock"),
        adapter("real", allowed, "production_binding"),
      ],
    });
    await expect(failure).rejects.toMatchObject({
      suspectedSource: "mock",
    });
    await expect(failure).rejects.toHaveProperty("diffs.1.path", "$.authorization.outcome");
  });
});
