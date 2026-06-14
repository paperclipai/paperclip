import { describe, expect, it } from "vitest";
import { routeModelProfile, type ModelRouterSignals } from "../services/model-router.ts";

const base: ModelRouterSignals = {
  wakeReason: null,
  issuePriority: null,
  issueOriginKind: null,
  promptChars: 50,
  hasBlockingErrorHistory: false,
  classifierVerdict: null,
};

describe("routeModelProfile (Phase 1 rules)", () => {
  it("forces Qwen (default) when the issue has blocking error history (anti-loop)", () => {
    const d = routeModelProfile({ ...base, hasBlockingErrorHistory: true, promptChars: 10 });
    expect(d.profile).toBeNull();
    expect(d.reason).toBe("error_history");
    expect(d.needsClassifier).toBe(false);
  });

  it("keeps Qwen for substantive wake reasons", () => {
    const d = routeModelProfile({ ...base, wakeReason: "issue_assigned", promptChars: 10 });
    expect(d.profile).toBeNull();
    expect(d.reason).toBe("substantive_wake_reason");
  });

  it("keeps Qwen for high/urgent priority", () => {
    expect(routeModelProfile({ ...base, issuePriority: "urgent", promptChars: 10 }).profile).toBeNull();
    expect(routeModelProfile({ ...base, issuePriority: "high", promptChars: 10 }).profile).toBeNull();
  });

  it("downgrades to cheap for a short non-substantive task", () => {
    const d = routeModelProfile({ ...base, wakeReason: "routine_tick", promptChars: 80 });
    expect(d.profile).toBe("cheap");
    expect(d.reason).toBe("short_non_substantive");
    expect(d.needsClassifier).toBe(false);
  });

  it("treats a short detector-origin task as trivial via the short-prompt rule", () => {
    const d = routeModelProfile({ ...base, issueOriginKind: "detector", promptChars: 120 });
    expect(d.profile).toBe("cheap");
  });

  it("flags long ambiguous tasks for the classifier and stays on Qwen meanwhile", () => {
    const d = routeModelProfile({ ...base, wakeReason: "issue_comment_mentioned", promptChars: 4000 });
    expect(d.profile).toBeNull();
    expect(d.needsClassifier).toBe(true);
    expect(d.reason).toBe("inconclusive");
  });

  it("uses a provided classifier verdict over needsClassifier", () => {
    expect(routeModelProfile({ ...base, promptChars: 4000, classifierVerdict: "fast" }).profile).toBe("cheap");
    expect(routeModelProfile({ ...base, promptChars: 4000, classifierVerdict: "reasoning" }).profile).toBeNull();
  });
});
