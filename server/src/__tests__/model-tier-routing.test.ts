import { describe, expect, it } from "vitest";
import {
  applyModelTierSelection,
  selectHeartbeatModelTier,
} from "../services/model-tier-routing.js";

const FULL_PROFILE = {
  default: "sonnet",
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

function configWithProfile(profile: unknown = FULL_PROFILE) {
  return { modelTierProfile: profile, model: "claude-opus-4-7" };
}

describe("selectHeartbeatModelTier", () => {
  it("returns null when the agent has no modelTierProfile", () => {
    const result = selectHeartbeatModelTier({
      config: { model: "claude-opus-4-7" },
      context: {},
      wakePayload: { issue: { status: "in_progress" }, comments: [{ body: "hi" }] },
    });
    expect(result).toBeNull();
  });

  it("returns null when the profile is disabled", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile({ ...FULL_PROFILE, enabled: false }),
      context: {},
      wakePayload: { issue: { status: "in_progress" }, comments: [] },
    });
    expect(result).toBeNull();
  });

  it("routes blocked status with no new comments to haiku (dedup)", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile(),
      context: { wakeReason: "issue_assigned" },
      wakePayload: { issue: { status: "blocked" }, comments: [], commentIds: [] },
    });
    expect(result).toEqual({
      tier: "haiku",
      model: "claude-haiku-4-5",
      reason: "blocked_no_new_context",
    });
  });

  it("routes dependency-blocked interactions to haiku", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile(),
      context: {},
      wakePayload: {
        issue: { status: "in_progress" },
        comments: [{ body: "no-op" }],
        dependencyBlockedInteraction: true,
      },
    });
    expect(result?.tier).toBe("haiku");
    expect(result?.reason).toBe("dependency_blocked_interaction");
  });

  it("routes system retry wakes with no new context to haiku", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile(),
      context: { wakeReason: "transient_failure_retry" },
      wakePayload: {
        issue: { status: "in_progress" },
        reason: "transient_failure_retry",
        comments: [],
        commentIds: [],
      },
    });
    expect(result?.tier).toBe("haiku");
    expect(result?.reason).toBe("system_retry:transient_failure_retry");
  });

  it("routes no-context wakes to haiku", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile(),
      context: {},
      wakePayload: {
        issue: { status: "in_progress" },
        comments: [],
        commentIds: [],
        executionStage: null,
        continuationSummary: null,
      },
    });
    expect(result?.tier).toBe("haiku");
    expect(result?.reason).toBe("no_context_wake");
  });

  it("routes umbrellas with 3+ in-flight children to opus", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile(),
      context: { wakeReason: "issue_commented" },
      wakePayload: {
        issue: { status: "in_progress" },
        comments: [{ body: "ping" }],
        childIssueSummaries: [
          { id: "a", status: "in_progress" },
          { id: "b", status: "todo" },
          { id: "c", status: "in_review" },
          { id: "d", status: "done" },
        ],
      },
    });
    expect(result?.tier).toBe("opus");
    expect(result?.reason).toBe("umbrella_children:3");
    expect(result?.model).toBe("claude-opus-4-7");
  });

  it("does NOT escalate when most children are done/cancelled", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile(),
      context: { wakeReason: "issue_commented" },
      wakePayload: {
        issue: { status: "in_progress" },
        comments: [{ body: "ping" }],
        childIssueSummaries: [
          { id: "a", status: "done" },
          { id: "b", status: "cancelled" },
          { id: "c", status: "in_progress" },
        ],
      },
    });
    expect(result?.tier).toBe("sonnet");
  });

  it("escalates to opus on plan-mode keyword in description", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile(),
      context: {
        wakeReason: "issue_assigned",
        paperclipIssue: { description: "이번 heartbeat에서 mode=plan 으로 설계만 부탁" },
      },
      wakePayload: {
        issue: { status: "in_progress", title: "라우팅 설계" },
        comments: [{ body: "내용" }],
      },
    });
    expect(result?.tier).toBe("opus");
    expect(result?.reason).toBe("plan_mode_keyword");
  });

  it("escalates to opus on Korean plan keywords (기획/설계/검토)", () => {
    for (const kw of ["기획안", "설계 검토", "검토 부탁"]) {
      const result = selectHeartbeatModelTier({
        config: configWithProfile(),
        context: { wakeReason: "issue_commented" },
        wakePayload: {
          issue: { status: "in_progress", title: kw },
          comments: [{ body: "..." }],
        },
      });
      expect(result?.tier).toBe("opus");
      expect(result?.reason).toBe("plan_mode_keyword");
    }
  });

  it("escalates to opus when an execution review/approval stage is active", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile(),
      context: { wakeReason: "execution_review_requested" },
      wakePayload: {
        issue: { status: "in_review" },
        comments: [{ body: "리뷰 부탁드립니다" }],
        executionStage: { currentStageType: "execution_review" },
      },
    });
    expect(result?.tier).toBe("opus");
    expect(result?.reason).toBe("execution_stage");
  });

  it("falls back to sonnet for ordinary in-progress wakes", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile(),
      context: { wakeReason: "issue_commented" },
      wakePayload: {
        issue: { status: "in_progress", title: "단일 파일 버그 수정" },
        comments: [{ body: "이 함수에서 NPE가 발생합니다" }],
      },
    });
    expect(result?.tier).toBe("sonnet");
    expect(result?.reason).toBe("default");
    expect(result?.model).toBe("claude-sonnet-4-6");
  });

  it("falls back to a lower tier model when the requested tier is missing", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile({ default: "sonnet", opus: "claude-opus-4-7" }),
      context: { wakeReason: "issue_commented" },
      wakePayload: {
        issue: { status: "in_progress" },
        comments: [{ body: "..." }],
      },
    });
    expect(result?.tier).toBe("sonnet");
    expect(result?.model).toBe("claude-opus-4-7");
  });

  it("respects an explicit non-default tier in the profile", () => {
    const result = selectHeartbeatModelTier({
      config: configWithProfile({ ...FULL_PROFILE, default: "haiku" }),
      context: { wakeReason: "issue_commented" },
      wakePayload: {
        issue: { status: "in_progress" },
        comments: [{ body: "..." }],
      },
    });
    expect(result?.tier).toBe("haiku");
    expect(result?.model).toBe("claude-haiku-4-5");
  });
});

describe("applyModelTierSelection", () => {
  it("returns the config unchanged when selection is null", () => {
    const config = { model: "claude-opus-4-7" };
    expect(applyModelTierSelection(config, null)).toBe(config);
  });

  it("overrides model and records the selection", () => {
    const out = applyModelTierSelection(
      { model: "claude-opus-4-7", other: "x" },
      { tier: "haiku", model: "claude-haiku-4-5", reason: "blocked_no_new_context" },
    );
    expect(out).toEqual({
      model: "claude-haiku-4-5",
      other: "x",
      modelTierSelection: {
        tier: "haiku",
        model: "claude-haiku-4-5",
        reason: "blocked_no_new_context",
      },
    });
  });

  it("preserves the original model when the selected tier has no resolved model", () => {
    const out = applyModelTierSelection(
      { model: "claude-opus-4-7" },
      { tier: "haiku", model: null, reason: "blocked_no_new_context" },
    );
    expect(out.model).toBe("claude-opus-4-7");
    expect(out.modelTierSelection).toEqual({
      tier: "haiku",
      model: null,
      reason: "blocked_no_new_context",
    });
  });
});
