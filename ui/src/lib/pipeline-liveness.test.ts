import { describe, expect, it } from "vitest";
import type { PipelineCaseLiveness } from "@paperclipai/shared";
import {
  derivePipelineLivenessBanner,
  shouldDisableRerunForPermission,
} from "./pipeline-liveness";

function liveness(overrides: Partial<PipelineCaseLiveness>): PipelineCaseLiveness {
  return {
    state: "attention",
    reason: "no_action_path",
    message: "stub",
    ...overrides,
  } as PipelineCaseLiveness;
}

describe("derivePipelineLivenessBanner", () => {
  it("returns null for non-stuck states", () => {
    for (const reason of [
      "terminal",
      "lease_active",
      "linked_issue_active",
      "linked_issue_waiting",
      "children_waiting",
      "review_waiting",
    ] as const) {
      expect(derivePipelineLivenessBanner(liveness({ reason }))).toBeNull();
    }
    expect(derivePipelineLivenessBanner(null)).toBeNull();
    expect(derivePipelineLivenessBanner(undefined)).toBeNull();
  });

  it("renders an amber blocked banner with a blocking-issue link", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        state: "blocked",
        reason: "linked_issue_blocked",
        message: "Linked automation issue is blocked.",
        issue: { id: "auto-1", identifier: "PAP-900", title: "Build the thing", status: "blocked" },
        blocker: { issueId: "blk-1", title: "Waiting on legal", status: "in_progress" },
      }),
    );
    expect(view).not.toBeNull();
    expect(view!.tone).toBe("blocked");
    expect(view!.showRetry).toBe(false);
    expect(view!.blockerLink).toEqual({ issueId: "blk-1", title: "Waiting on legal" });
    expect(view!.automationLink).toEqual({ issueId: "auto-1", identifier: "PAP-900", title: "Build the thing" });
    expect(view!.helperNote).toMatch(/automatically/i);
  });

  it("renders a purple permission banner and surfaces the permission key", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        state: "blocked",
        reason: "permission_preflight_failed",
        message: "Pipeline automation is blocked until the assignee can write to the target pipeline.",
        automation: {
          automationId: "auto-2",
          fingerprint: "case-1:stage-1:auto-2:target-pipe:agent-9:pipelines:write",
        },
      }),
    );
    expect(view!.tone).toBe("permission");
    expect(view!.permissionKey).toBe("pipelines:write");
    expect(view!.showRetry).toBe(false);
  });

  it("renders an indigo ready-to-retry banner for restored permission", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        state: "attention",
        reason: "automation_failed",
        message: "Pipeline automation permission has been restored; retry the failed automation ledger.",
        automation: { automationId: "auto-3" },
      }),
    );
    expect(view!.tone).toBe("retry");
    expect(view!.showRetry).toBe(true);
    expect(view!.retryKind).toBe("automation");
    expect(view!.retryLabel).toBe("Retry now");
  });

  it("renders an attention banner with a stage-rerun retry for generic failure", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        state: "attention",
        reason: "automation_failed",
        message: "Pipeline automation failed and needs retry or recovery.",
        automation: { automationId: null },
      }),
    );
    expect(view!.tone).toBe("attention");
    expect(view!.showRetry).toBe(true);
    expect(view!.retryKind).toBe("stage");
  });

  it("counts missing breakdown pieces in the body", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        state: "blocked",
        reason: "breakdown_incomplete",
        message: "Breakdown evidence does not match created child cases.",
        breakdown: { missingRequestKeys: ["a", "b"] },
      }),
    );
    expect(view!.tone).toBe("blocked");
    expect(view!.body).toMatch(/2 expected pieces are still missing/);
  });

  it("treats no_action_path as a stuck attention banner with a retry", () => {
    const view = derivePipelineLivenessBanner(liveness({ reason: "no_action_path" }));
    expect(view!.tone).toBe("attention");
    expect(view!.showRetry).toBe(true);
    expect(view!.retryKind).toBe("stage");
  });

  it("uses prosumer copy for no_action_path, never the raw server vocabulary (PAP-11259)", () => {
    const view = derivePipelineLivenessBanner(
      liveness({
        reason: "no_action_path",
        message: "No lease, linked work, blocker, automation retry, review, or breakdown action path is visible.",
      }),
    );
    expect(view!.title).toBe("This item is stuck");
    expect(view!.body).not.toMatch(/lease|linked work|action path/i);
    expect(view!.body).toMatch(/Re-run the stage/);
  });
});

describe("shouldDisableRerunForPermission", () => {
  it("disables only for the permission preflight reason", () => {
    expect(shouldDisableRerunForPermission(liveness({ reason: "permission_preflight_failed" }))).toBe(true);
    expect(shouldDisableRerunForPermission(liveness({ reason: "automation_failed" }))).toBe(false);
    expect(shouldDisableRerunForPermission(null)).toBe(false);
  });
});
