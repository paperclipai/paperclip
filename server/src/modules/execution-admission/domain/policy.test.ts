import { describe, expect, it } from "vitest";
import { decideSettlement, MAX_ADMISSION_PROJECTS, prepareAdmissionRecord } from "./admission.js";
import { ABSENT_TASK_EXECUTION_POLICY, applyTaskExecutionPolicyPatch, parseTaskExecutionPolicyPatch, type TaskExecutionPolicy } from "./policy.js";

const configured = (maxConcurrentTasks: number | null): TaskExecutionPolicy => ({ state: "configured", maxConcurrentTasks });
const apply = (current: TaskExecutionPolicy, input: unknown) => {
  const parsed = parseTaskExecutionPolicyPatch(input);
  if (parsed.kind !== "ok") throw new Error(parsed.reason);
  return applyTaskExecutionPolicyPatch(current, parsed.patch);
};

describe("task execution policy", () => {
  it("keeps never-configured distinct from explicit unlimited", () => {
    expect(apply(ABSENT_TASK_EXECUTION_POLICY, null)).toEqual(configured(null));
    expect(apply(ABSENT_TASK_EXECUTION_POLICY, { maxConcurrentTasks: null })).toEqual(configured(null));
    expect(apply(ABSENT_TASK_EXECUTION_POLICY, { maxConcurrentTasks: 3 })).toEqual(configured(3));
  });

  it("preserves the current value for omitted policies and fields", () => {
    for (const current of [ABSENT_TASK_EXECUTION_POLICY, configured(null), configured(2)]) {
      expect(apply(current, undefined)).toBe(current);
      expect(apply(current, {})).toBe(current);
      expect(apply(current, { maxConcurrentTasks: undefined })).toBe(current);
    }
    const two = configured(2);
    expect(apply(two, { maxConcurrentTasks: 2 })).toBe(two);
    const unlimited = configured(null);
    expect(apply(unlimited, null)).toBe(unlimited);
  });

  it("clears or replaces a configured maximum", () => {
    expect(apply(configured(2), null)).toEqual(configured(null));
    expect(apply(configured(2), { maxConcurrentTasks: null })).toEqual(configured(null));
    expect(apply(configured(null), { maxConcurrentTasks: 1 })).toEqual(configured(1));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, "2", true, {}])(
    "rejects maximum %s", value => {
      expect(parseTaskExecutionPolicyPatch({ maxConcurrentTasks: value })).toMatchObject({ kind: "invalid", field: "maxConcurrentTasks" });
    },
  );

  it("rejects malformed policies and unknown fields", () => {
    for (const input of [1, "unlimited", [], { maxConcurrentTasks: 1, perTaskOverride: 3 }]) {
      expect(parseTaskExecutionPolicyPatch(input)).toMatchObject({ kind: "invalid", field: "policy" });
    }
    expect(parseTaskExecutionPolicyPatch({ maxConcurrentTasks: 2_147_483_647 })).toEqual({ kind: "ok", patch: { maxConcurrentTasks: 2_147_483_647 } });
  });
});

describe("admission record", () => {
  const a = "0b9d8e52-6f2e-4bb0-9a4a-1f0a7f2e0a01";
  const b = "7c1f3d9a-2b4e-4d8f-8a6b-3e5c7d9f1b02";
  const c = "f3a2b1c0-9d8e-4f7a-8b6c-5d4e3f2a1b03";

  it("unions the primary with referenced projects in canonical order", () => {
    expect(prepareAdmissionRecord({ primaryProjectId: c, referencedProjectIds: [b, a, b.toUpperCase(), c], contextRevision: " r1 " }))
      .toEqual({ kind: "ok", record: { primaryProjectId: c, projectIds: [a, b, c], contextRevision: "r1" } });
  });

  it("keeps a primaryless set and an empty set without a project bucket", () => {
    expect(prepareAdmissionRecord({ primaryProjectId: null, referencedProjectIds: [b], contextRevision: "r" }))
      .toEqual({ kind: "ok", record: { primaryProjectId: null, projectIds: [b], contextRevision: "r" } });
    expect(prepareAdmissionRecord({ primaryProjectId: null, referencedProjectIds: [], contextRevision: "r" }))
      .toEqual({ kind: "ok", record: { primaryProjectId: null, projectIds: [], contextRevision: "r" } });
  });

  it("rejects invalid references, oversized sets and missing context identity instead of narrowing", () => {
    expect(prepareAdmissionRecord({ primaryProjectId: null, referencedProjectIds: [a, "Design"], contextRevision: "r" }))
      .toEqual({ kind: "invalid_project_id" });
    expect(prepareAdmissionRecord({ primaryProjectId: "", referencedProjectIds: [a], contextRevision: "r" }))
      .toEqual({ kind: "invalid_project_id" });
    const many = Array.from({ length: MAX_ADMISSION_PROJECTS + 1 }, (_, index) =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
    expect(prepareAdmissionRecord({ primaryProjectId: null, referencedProjectIds: many, contextRevision: "r" }))
      .toEqual({ kind: "too_many_projects", count: MAX_ADMISSION_PROJECTS + 1, limit: MAX_ADMISSION_PROJECTS });
    expect(prepareAdmissionRecord({ primaryProjectId: a, referencedProjectIds: [], contextRevision: " " }))
      .toEqual({ kind: "invalid_context_revision" });
    expect(prepareAdmissionRecord({ primaryProjectId: a, referencedProjectIds: [], contextRevision: "x".repeat(257) }))
      .toEqual({ kind: "invalid_context_revision" });
  });

  it("settles once and replays only the same settlement", () => {
    expect(decideSettlement(null, a)).toBe("settle");
    expect(decideSettlement(a, a)).toBe("already_settled");
    expect(decideSettlement(a, b)).toBe("settled_by_other");
  });
});
