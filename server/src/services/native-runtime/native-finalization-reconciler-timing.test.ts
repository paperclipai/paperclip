import { describe, expect, it, vi } from "vitest";

const timing = vi.hoisted(() => ({
  phase: vi.fn(),
  candidates: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("./native-reconciliation-timing.js", () => ({
  createNativeReconciliationPassTiming: () => timing,
}));
vi.mock("./native-workspace-export-recovery.js", () => ({
  recoverLegacyUnsafeWorkspaceExports: vi.fn(async () => undefined),
}));
vi.mock("./obsolete-policy-reviews.js", () => ({
  dismissObsoleteNativePolicyReviews: vi.fn(async () => undefined),
}));
vi.mock("./automatic-completion-reviews.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./automatic-completion-reviews.js")>()),
  dismissAutomaticCompletionReviews: vi.fn(async () => {
    throw new Error("review lookup failed");
  }),
}));

const { reconcileNativeFinalizations } = await import("./native-finalization-reconciler.js");

describe("native finalization reconciliation timing", () => {
  it("omits migrated policy cleanup from periodic reconciliation", async () => {
    timing.phase.mockClear();
    await expect(reconcileNativeFinalizations({} as never, undefined, { skipObsoletePolicyReviews: true })).rejects.toThrow("review lookup failed");
    expect(timing.phase.mock.calls.map(([phase]) => phase)).toEqual(["legacy_workspace_exports", "automatic_completion_reviews"]);
    timing.phase.mockClear(); timing.finish.mockClear();
  });

  it("omits automatic review discovery when its worker owns that duty", async () => {
    timing.phase.mockClear();
    const db = { select: vi.fn(() => { throw new Error("candidate scan reached"); }) };
    await expect(reconcileNativeFinalizations(db as never, ["run"], { skipAutomaticCompletionReviews: true })).rejects.toThrow("candidate scan reached");
    expect(timing.phase.mock.calls.map(([phase]) => phase)).toEqual(["legacy_workspace_exports", "obsolete_policy_reviews", "candidate_scan"]);
    timing.phase.mockClear(); timing.finish.mockClear();
  });

  it("records the phases and a failed outcome when a pass fails, and rethrows", async () => {
    await expect(reconcileNativeFinalizations({} as never)).rejects.toThrow("review lookup failed");

    expect(timing.phase.mock.calls.map(([phase]) => phase)).toEqual([
      "legacy_workspace_exports",
      "obsolete_policy_reviews",
      "automatic_completion_reviews",
    ]);
    expect(timing.finish).toHaveBeenCalledExactlyOnceWith({ outcome: "failed", scoped: false });
  });
});
