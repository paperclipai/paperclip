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
