import { describe, expect, it } from "vitest";
import type { RouteRule, TaskClass, TaskFacts } from "@paperclipai/shared";
import {
  canRequestAdvisorRound,
  decideRoute,
  evaluateEscalation,
  validateAuthoritySeparation,
  type PolicyProfile,
  type RoutePolicyInput,
} from "./policy.js";

const P = {
  fable51: {
    id: "00000000-0000-4000-8000-000000000001",
    agentId: "a0000000-0000-4000-8000-000000000001",
    providerFamily: "anthropic",
    model: "claude-fable-5-1",
    effort: "low",
    roleCapabilities: ["worker", "advisor", "rescuer"],
    enabled: true,
    maxConcurrentAttempts: 2,
  },
  fable51b: {
    id: "00000000-0000-4000-8000-000000000002",
    agentId: "a0000000-0000-4000-8000-000000000002",
    providerFamily: "anthropic",
    model: "claude-fable-5-1",
    effort: "low",
    roleCapabilities: ["worker", "rescuer"],
    enabled: true,
    maxConcurrentAttempts: 1,
  },
  fable5: {
    id: "00000000-0000-4000-8000-000000000003",
    agentId: "a0000000-0000-4000-8000-000000000003",
    providerFamily: "anthropic",
    model: "claude-fable-5",
    effort: "low",
    roleCapabilities: ["worker", "reviewer", "rescuer"],
    enabled: true,
    maxConcurrentAttempts: 3,
  },
  astra: {
    id: "00000000-0000-4000-8000-000000000004",
    agentId: "a0000000-0000-4000-8000-000000000004",
    providerFamily: "openai",
    model: "gpt-6-astra",
    effort: "low",
    roleCapabilities: ["worker", "reviewer", "rescuer"],
    enabled: true,
    maxConcurrentAttempts: 1,
  },
  sol: {
    id: "00000000-0000-4000-8000-000000000005",
    agentId: "a0000000-0000-4000-8000-000000000005",
    providerFamily: "openai",
    model: "gpt-5.6-sol",
    effort: "high",
    roleCapabilities: ["advisor", "reviewer"],
    enabled: true,
    maxConcurrentAttempts: 1,
  },
  spark: {
    id: "00000000-0000-4000-8000-000000000006",
    agentId: "a0000000-0000-4000-8000-000000000006",
    providerFamily: "meta",
    model: "muse-spark-1.3",
    effort: "low",
    roleCapabilities: ["worker"],
    enabled: true,
    maxConcurrentAttempts: 4,
  },
} satisfies Record<string, PolicyProfile>;

const profiles: PolicyProfile[] = Object.values(P);

function rule(taskClass: TaskClass, overrides: Partial<RouteRule> = {}): RouteRule {
  const base = {
    id: `r-${taskClass}`,
    companyId: "c",
    taskClass,
    workerProfileId: P.fable51.id,
    advisorProfileId: null,
    advisorMode: "none",
    reviewerProfileId: P.astra.id,
    reviewerFallbackProfileId: P.sol.id,
    reviewRequirement: "always",
    reviewerFallbackPolicy: "fallback",
    rescueProfileId: P.astra.id,
    maxAttempts: 2,
    maxWallClockMinutes: 180,
    maxCostCents: null,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies RouteRule;
  return { ...base, ...overrides };
}

const rules: RouteRule[] = [
  rule("feature_standard"),
  rule("feature_critical", { advisorProfileId: P.sol.id, advisorMode: "required", reviewerFallbackProfileId: null, reviewerFallbackPolicy: "fail_closed" }),
  rule("migration", { advisorProfileId: P.sol.id, advisorMode: "optional", reviewerFallbackProfileId: null, reviewerFallbackPolicy: "fail_closed" }),
  rule("bug_fast", { workerProfileId: P.fable5.id, reviewerProfileId: P.sol.id, reviewerFallbackProfileId: P.astra.id, reviewRequirement: "consequential", rescueProfileId: P.fable51.id }),
  rule("bug_invariant", { workerProfileId: P.astra.id, advisorProfileId: P.fable51.id, advisorMode: "optional", reviewerProfileId: P.fable5.id, reviewerFallbackProfileId: P.fable51.id, rescueProfileId: P.fable51.id }),
  rule("security_recovery", { workerProfileId: P.astra.id, advisorProfileId: P.fable51.id, advisorMode: "required", reviewerProfileId: P.fable5.id, reviewerFallbackProfileId: P.fable51.id, rescueProfileId: P.fable51.id }),
  rule("mechanical", { workerProfileId: P.spark.id, reviewerProfileId: P.fable5.id, reviewerFallbackProfileId: P.astra.id, reviewRequirement: "consequential", rescueProfileId: P.fable51.id, maxAttempts: 1 }),
];

function facts(overrides: Partial<TaskFacts> & { taskClass: TaskClass }): TaskFacts {
  return {
    riskFlags: [],
    affectedLayers: ["server"],
    reproductionKnown: true,
    acceptanceDefined: true,
    architecturalDecisionOpen: false,
    consequential: false,
    ...overrides,
  };
}

function decide(overrides: Partial<RoutePolicyInput> & { facts: unknown }) {
  return decideRoute({
    rules,
    profiles,
    activeClaimsByProfile: {},
    blockedProfileIds: [],
    priorWorkerAgentIds: [],
    revisionKind: "initial",
    ...overrides,
  });
}

describe("routing policy: classification", () => {
  it("routes each declared task class to the matrix worker/reviewer/rescue", () => {
    const expectations: Array<[TaskClass, string, string | null, string]> = [
      ["feature_standard", P.fable51.id, P.astra.id, P.astra.id],
      ["feature_critical", P.fable51.id, P.astra.id, P.astra.id],
      ["migration", P.fable51.id, P.astra.id, P.astra.id],
      ["bug_fast", P.fable5.id, null, P.fable51.id],
      ["bug_invariant", P.astra.id, P.fable5.id, P.fable51.id],
      ["security_recovery", P.astra.id, P.fable5.id, P.fable51.id],
      ["mechanical", P.spark.id, null, P.fable51.id],
    ];
    for (const [taskClass, worker, reviewer, rescue] of expectations) {
      const outcome = decide({ facts: facts({ taskClass }) });
      expect(outcome.state, taskClass).toBe("routed");
      expect(outcome.effectiveTaskClass, taskClass).toBe(taskClass);
      expect(outcome.worker?.profileId, taskClass).toBe(worker);
      expect(outcome.reviewer?.profileId ?? null, taskClass).toBe(reviewer);
      expect(outcome.rescue?.profileId, taskClass).toBe(rescue);
    }
  });

  it("is deterministic for identical inputs", () => {
    const a = decide({ facts: facts({ taskClass: "feature_standard", affectedLayers: ["db", "server", "ui"] }) });
    const b = decide({ facts: facts({ taskClass: "feature_standard", affectedLayers: ["db", "server", "ui"] }) });
    expect(a).toEqual(b);
    expect(a.reasonCodes).toContain("cross-layer");
  });

  it("refuses malformed or missing facts instead of defaulting to a cheap route", () => {
    for (const bad of [undefined, null, {}, { taskClass: "mechanical" }, { ...facts({ taskClass: "bug_fast" }), riskFlags: ["sql"] }]) {
      const outcome = decide({ facts: bad });
      expect(outcome.state).toBe("classification-required");
      expect(outcome.worker).toBeNull();
    }
  });

  it("promotes bug_fast to an invariant or security class when risk or unknown reproduction exists", () => {
    expect(decide({ facts: facts({ taskClass: "bug_fast", reproductionKnown: false }) }).effectiveTaskClass).toBe("bug_invariant");
    expect(decide({ facts: facts({ taskClass: "bug_fast", riskFlags: ["concurrency"] }) }).effectiveTaskClass).toBe("bug_invariant");
    const security = decide({ facts: facts({ taskClass: "bug_fast", riskFlags: ["auth"] }) });
    expect(security.effectiveTaskClass).toBe("security_recovery");
    expect(security.worker?.providerFamily).toBe("openai");
    expect(security.reasonCodes).toContain("security-sensitive");
  });

  it("promotes features that touch persistence or authority seams to the critical profile with mandatory review", () => {
    const outcome = decide({ facts: facts({ taskClass: "feature_standard", riskFlags: ["persistence"] }) });
    expect(outcome.effectiveTaskClass).toBe("feature_critical");
    expect(outcome.requireCrossFamilyReview).toBe(true);
    expect(outcome.reasonCodes).toContain("persistent-schema");
  });

  it("never lets mechanical work self-authorize architectural scope", () => {
    expect(decide({ facts: facts({ taskClass: "mechanical", acceptanceDefined: false }) }).state).toBe("classification-required");
    expect(decide({ facts: facts({ taskClass: "mechanical", architecturalDecisionOpen: true }) }).state).toBe("classification-required");
    const promoted = decide({ facts: facts({ taskClass: "mechanical", riskFlags: ["recovery"] }) });
    expect(promoted.effectiveTaskClass).toBe("feature_critical");
    expect(promoted.worker?.profileId).not.toBe(P.spark.id);
  });
});

describe("routing policy: cross-family review", () => {
  it("rejects a same-family reviewer as a family conflict rather than routing", () => {
    const outcome = decide({
      facts: facts({ taskClass: "feature_standard" }),
      rules: [rule("feature_standard", { reviewerProfileId: P.fable5.id, reviewerFallbackProfileId: null })],
    });
    expect(outcome.state).toBe("reviewer-family-conflict");
    expect(outcome.reviewer).toBeNull();
  });

  it("falls back to the configured opposite-family reviewer, but never across the family rule", () => {
    const fallback = decide({
      facts: facts({ taskClass: "feature_standard" }),
      rules: [rule("feature_standard", { reviewerProfileId: P.fable5.id, reviewerFallbackProfileId: P.sol.id })],
    });
    expect(fallback.state).toBe("routed");
    expect(fallback.reviewer?.profileId).toBe(P.sol.id);
    const failClosed = decide({
      facts: facts({ taskClass: "migration" }),
      rules: [rule("migration", { reviewerProfileId: P.fable5.id, reviewerFallbackProfileId: P.sol.id, reviewerFallbackPolicy: "fail_closed" })],
    });
    expect(failClosed.state).toBe("reviewer-family-conflict");
  });

  it("fails closed when review is mandatory and no reviewer is available", () => {
    const outcome = decide({
      facts: facts({ taskClass: "security_recovery" }),
      blockedProfileIds: [P.fable5.id],
    });
    expect(outcome.state).toBe("reviewer-unavailable");
    expect(outcome.worker?.profileId).toBe(P.astra.id);
    expect(outcome.reviewer).toBeNull();
  });

  it("does not require review for a non-consequential fast bug but forces it once scope is consequential", () => {
    expect(decide({ facts: facts({ taskClass: "bug_fast" }) }).requireCrossFamilyReview).toBe(false);
    const consequential = decide({ facts: facts({ taskClass: "bug_fast", consequential: true }) });
    expect(consequential.requireCrossFamilyReview).toBe(true);
    expect(consequential.reviewer?.profileId).toBe(P.sol.id);
  });

  it("cannot waive mandatory review by override or rule", () => {
    const viaRule = decide({
      facts: facts({ taskClass: "migration" }),
      rules: [rule("migration", { reviewRequirement: "none", reviewerProfileId: null, reviewerFallbackProfileId: null })],
    });
    expect(viaRule.state).toBe("reviewer-unavailable");
    const viaOverride = decide({
      facts: facts({ taskClass: "feature_critical" }),
      revisionKind: "override",
      override: { requireCrossFamilyReview: false },
    });
    expect(viaOverride.requireCrossFamilyReview).toBe(true);
  });

  it("rejects an override reviewer from the worker's family", () => {
    const outcome = decide({
      facts: facts({ taskClass: "bug_invariant" }),
      revisionKind: "override",
      override: { reviewerProfileId: P.sol.id },
    });
    expect(outcome.state).toBe("reviewer-family-conflict");
  });
});

describe("routing policy: rescue and authorship", () => {
  it("rescue changes worker family and recomputes an opposite-family reviewer that never authored the work", () => {
    const initial = decide({ facts: facts({ taskClass: "feature_standard" }) });
    const rescue = decide({
      facts: facts({ taskClass: "feature_standard" }),
      revisionKind: "rescue",
      escalationReason: "repeated-failure-fingerprint",
      previous: { revisionKind: "initial", effectiveTaskClass: "feature_standard", facts: initial.facts, worker: initial.worker, requireCrossFamilyReview: true },
      priorWorkerAgentIds: [P.fable51.agentId],
    });
    expect(rescue.state).toBe("routed");
    expect(rescue.worker?.providerFamily).toBe("openai");
    expect(rescue.worker?.profileId).toBe(P.astra.id);
    expect(rescue.reviewer?.providerFamily).toBe("anthropic");
    expect(rescue.reviewer?.agentId).not.toBe(P.fable51.agentId);
    expect(rescue.reasonCodes).toContain("repeated-failure");
  });
  it("a former reviewer who becomes the rescuer is replaced by an opposite-family reviewer", () => {
    const rescue = decide({
      facts: facts({ taskClass: "bug_invariant" }),
      revisionKind: "rescue",
      escalationReason: "architectural-review-rejection",
      previous: {
        revisionKind: "initial",
        effectiveTaskClass: "bug_invariant",
        facts: null,
        worker: { profileId: P.astra.id, agentId: P.astra.agentId, providerFamily: "openai", model: "gpt-6-astra", effort: "low" },
        requireCrossFamilyReview: true,
      },
      priorWorkerAgentIds: [P.astra.agentId],
      rules: [rule("bug_invariant", { workerProfileId: P.astra.id, reviewerProfileId: P.fable51.id, reviewerFallbackProfileId: P.fable5.id, rescueProfileId: P.fable51.id })],
    });
    expect(rescue.state).toBe("routed");
    expect(rescue.worker?.profileId).toBe(P.fable51.id);
    // The rescuer is Anthropic; the rule's Anthropic reviewers are now invalid and the
    // previous OpenAI worker may not review its own work, so Sol is the only reviewer.
    expect(rescue.reviewer?.profileId).toBe(P.sol.id);
    expect(rescue.reasonCodes).toContain("review-rejected");
  });

  it("requires human attention after a rescue has already been attempted", () => {
    const outcome = decide({
      facts: facts({ taskClass: "feature_standard" }),
      revisionKind: "rescue",
      escalationReason: "dirty-terminal-attempt",
      previous: { revisionKind: "rescue", effectiveTaskClass: "feature_standard", facts: null, worker: null, requireCrossFamilyReview: true },
    });
    expect(outcome.state).toBe("escalation-required");
    expect(outcome.escalationReason).toBe("dirty-terminal-attempt");
  });
});

describe("routing policy: pools, capacity, and availability", () => {
  it("selects a compatible pool member with free capacity deterministically", () => {
    const outcome = decide({
      facts: facts({ taskClass: "feature_standard" }),
      activeClaimsByProfile: { [P.fable51.id]: 2 },
    });
    expect(outcome.worker?.profileId).toBe(P.fable51b.id);
    const saturated = decide({
      facts: facts({ taskClass: "feature_standard" }),
      activeClaimsByProfile: { [P.fable51.id]: 2, [P.fable51b.id]: 1 },
    });
    expect(saturated.state).toBe("routed");
    expect(saturated.worker?.profileId).toBe(P.fable51.id);
  });

  it("never selects disabled or budget-blocked workers", () => {
    const disabled = decide({
      facts: facts({ taskClass: "bug_invariant" }),
      profiles: profiles.map((profile) => (profile.id === P.astra.id ? { ...profile, enabled: false } : profile)),
    });
    expect(disabled.state).toBe("no-capable-worker");
    const blocked = decide({ facts: facts({ taskClass: "bug_invariant" }), blockedProfileIds: [P.astra.id] });
    expect(blocked.state).toBe("budget-limited");
    expect(blocked.reasonCodes).toContain("budget-limited");
  });

  it("requires escalation when a required advisor is not available and never lets the worker advise itself", () => {
    const outcome = decide({
      facts: facts({ taskClass: "feature_critical" }),
      rules: [rule("feature_critical", { advisorProfileId: P.fable51.id, advisorMode: "required" })],
    });
    expect(outcome.state).toBe("escalation-required");
    const optional = decide({
      facts: facts({ taskClass: "migration" }),
      rules: [rule("migration", { advisorProfileId: P.fable51.id, advisorMode: "optional" })],
    });
    expect(optional.state).toBe("routed");
    expect(optional.advisor).toBeNull();
    expect(optional.advisorMode).toBe("none");
  });
});

describe("routing policy: escalation and advisor bounds", () => {
  it("treats a single timeout, formatter failure, or compiler error as non-escalating", () => {
    expect(evaluateEscalation({ singleTimeout: true, formatterFailure: true, compilerError: true })).toBeNull();
    expect(evaluateEscalation({ sameFailureFingerprintCount: 1 })).toBeNull();
    expect(evaluateEscalation({ sameFailureFingerprintCount: 2 })).toBe("repeated-failure-fingerprint");
    expect(evaluateEscalation({ architecturalReviewRejected: true })).toBe("architectural-review-rejection");
    expect(evaluateEscalation({ noDurableActionPath: true })).toBe("no-durable-action-path");
  });

  it("allows exactly one ordinary advisor round per attempt", () => {
    const decision = decide({ facts: facts({ taskClass: "migration" }) });
    expect(decision.advisor?.profileId).toBe(P.sol.id);
    expect(canRequestAdvisorRound(decision, 0)).toBe(true);
    expect(canRequestAdvisorRound(decision, 1)).toBe(false);
    expect(canRequestAdvisorRound({ advisorMode: "none", advisor: null }, 0)).toBe(false);
  });

  it("flags any agent holding two authority roles", () => {
    const worker = { profileId: P.fable51.id, agentId: P.fable51.agentId, providerFamily: "anthropic" as const, model: "m", effort: "low" };
    expect(validateAuthoritySeparation({ worker, advisor: worker, reviewer: null })).toContain("worker cannot advise itself");
    expect(validateAuthoritySeparation({ worker, advisor: null, reviewer: { ...worker, providerFamily: "openai" } })).toContain("worker cannot review itself");
    expect(validateAuthoritySeparation({ worker, advisor: null, reviewer: { ...worker, agentId: "x" } })[0]).toMatch(/may not review/);
  });
});
