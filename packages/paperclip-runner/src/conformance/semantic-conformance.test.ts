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
): SemanticConformanceAdapter {
  return { id, execute: async () => structuredClone(observation) };
}

describe("semantic conformance kit", () => {
  it("accepts equivalent observations independent of object key order", async () => {
    const report = await runSemanticConformanceKit({
      vectors: [
        {
          id: "finish",
          operationId: "finish_task",
          input: { summary: "done" },
        },
      ],
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
  });

  it("fails explicitly when adapters diverge", async () => {
    await expect(
      runSemanticConformanceKit({
        vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
        adapters: [
          adapter("mock", allowed),
          adapter("real", {
            ...allowed,
            authorization: { outcome: "denied", code: "forbidden" },
          }),
        ],
      }),
    ).rejects.toBeInstanceOf(SemanticConformanceMismatchError);
  });

  it("requires at least two adapters", async () => {
    await expect(
      runSemanticConformanceKit({
        vectors: [],
        adapters: [adapter("only", allowed)],
      }),
    ).rejects.toThrow("semantic_conformance_requires_two_adapters");
  });

  it("requires unique adapter identities", async () => {
    await expect(
      runSemanticConformanceKit({
        vectors: [],
        adapters: [
          adapter("duplicate", allowed),
          adapter("duplicate", allowed),
        ],
      }),
    ).rejects.toThrow("semantic_conformance_adapter_ids_must_be_unique");
  });

  it("fails closed for non-JSON normalized observations", async () => {
    await expect(
      runSemanticConformanceKit({
        vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
        adapters: [
          adapter("mock", allowed),
          {
            id: "invalid",
            execute: async () =>
              ({
                ...allowed,
                state: new Date(),
              }) as unknown as SemanticConformanceObservation,
          },
        ],
      }),
    ).rejects.toThrow("semantic_conformance_non_json_observation");
  });

  it("fails closed for sparse normalized arrays", async () => {
    const sparseEffects = Array(1);
    await expect(
      runSemanticConformanceKit({
        vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
        adapters: [
          adapter("mock", allowed),
          {
            id: "invalid",
            execute: async () =>
              ({
                ...allowed,
                effects: sparseEffects,
              }) as unknown as SemanticConformanceObservation,
          },
        ],
      }),
    ).rejects.toThrow("semantic_conformance_non_json_observation");
  });
});
