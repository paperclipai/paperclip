import { describe, expect, it } from "vitest";
import {
  classifyRunLiveness,
  type RunLivenessClassificationInput,
} from "../../server/src/services/run-liveness.js";
import { decideLegacyContinuation, legacyDispositionEpisode } from "../../server/src/services/recovery/legacy-continuation.js";
import { arbitrateNativeStatus } from "../../server/src/services/native-runtime/status-arbiter.js";
import type { NativeEvidenceAssessment } from "../../server/src/services/native-runtime/evidence-classifier.js";
import { narratives } from "./narratives.js";
import { observe } from "./observe.js";

const future = "I will inspect the repository and run tests.";
const legacyBase: RunLivenessClassificationInput = {
  runStatus: "succeeded",
  issue: {
    status: "in_progress",
    title: "Implement export",
    description: null,
  },
  resultJson: { summary: future },
};
type DecisionInput = Parameters<typeof decideLegacyContinuation>[0];
function continuation(
  input: RunLivenessClassificationInput,
  overrides: Partial<DecisionInput> = {},
) {
  const classification = classifyRunLiveness(input);
  const decision = decideLegacyContinuation({
    run: {
      id: "run",
      companyId: "company",
      agentId: "agent",
      status: input.runStatus,
      runtimeMode: "legacy",
    } as DecisionInput["run"],
    issue: {
      id: "issue",
      companyId: "company",
      status: input.issue!.status,
      assigneeAgentId: "agent",
    },
    agent: { id: "agent", companyId: "company", status: "idle" },
    episode: legacyDispositionEpisode({ id: "run", continuationAttempt: input.continuationAttempt ?? 0 }),
    gates: { stopped: false, paused: false, budgetBlocked: false, pendingWait: false,
      activeExecution: false, ownedLifecycle: false, conversation: false, agentInvokable: true },
    ...overrides,
  });
  // Compare the authority-bearing repair instruction and key as well as action.
  // Only diagnostic classification is excluded from the equality check.
  const effect =
    decision.kind === "enqueue"
      ? {
          kind: decision.kind,
          nextAttempt: decision.nextAttempt,
          idempotencyKey: decision.idempotencyKey,
          instruction: decision.instruction,
        }
      : { kind: decision.kind };
  return { classification, decision, effect };
}

const channels = {
  summary: (text: string): RunLivenessClassificationInput => ({
    ...legacyBase,
    resultJson: { summary: text },
  }),
  result: (text: string): RunLivenessClassificationInput => ({
    ...legacyBase,
    resultJson: { result: text },
  }),
  comment: (text: string): RunLivenessClassificationInput => ({
    ...legacyBase,
    resultJson: null,
    issueCommentBodies: [text],
  }),
  continuation: (text: string): RunLivenessClassificationInput => ({
    ...legacyBase,
    resultJson: null,
    continuationSummaryBody: text,
  }),
  stdout: (text: string): RunLivenessClassificationInput => ({
    ...legacyBase,
    resultJson: null,
    stdoutExcerpt: text,
  }),
  stderr: (text: string): RunLivenessClassificationInput => ({
    ...legacyBase,
    resultJson: null,
    stderrExcerpt: text,
  }),
};

describe("LCA narrative authority baseline", () => {
  for (const [channel, build] of Object.entries(channels)) {
    it.each(narratives)(
      "LCA-02 LCA-09 legacy " +
        channel +
        " / %s preserves continuation effects",
      (variant, text) => {
        const before = continuation(build(future));
        const after = continuation(build(text));
        observe("LCA-02", `legacy:${channel}:${variant}`, { before, after });
        expect(before.effect.kind).toBe("enqueue");
        expect(after.effect).toEqual(before.effect);
      },
    );
  }
  it.each(["report", "plan", "research"])(
    "LCA-05 legacy title %s is not work-mode authority",
    (word) => {
      const before = continuation(legacyBase);
      const after = continuation({
        ...legacyBase,
        issue: { ...legacyBase.issue!, title: `Implement ${word} export` },
      });
      observe("LCA-05", word, { before, after });
      expect(after.effect).toEqual(before.effect);
      expect(after.classification).toEqual(before.classification);
    },
  );
  it("LCA-05 legacy description is not work-mode authority", () => {
    const before = continuation(legacyBase);
    const after = continuation({
      ...legacyBase,
      issue: { ...legacyBase.issue!, description: "Create a report exporter." },
    });
    observe("LCA-05", "description", { before, after });
    expect(after.effect).toEqual(before.effect);
    expect(after.classification).toEqual(before.classification);
  });
  it("LCA-09 additional commentary cannot manufacture progress or reset an attempt", () => {
    const before = continuation({ ...legacyBase, continuationAttempt: 2 });
    const after = continuation({
      ...legacyBase,
      continuationAttempt: 2,
      issueCommentBodies: [future],
      evidence: { issueCommentsCreated: 1 },
    });
    observe("LCA-09", "comment-only", { before, after });
    expect(after.effect).toEqual(before.effect);
    expect(after.classification.continuationAttempt).toBe(2);
  });
  it.each(["done", "blocked", "in_review", "cancelled"])(
    "LCA-01 LCA-04 real status %s changes admission with identical prose",
    (status) => {
      expect(continuation(legacyBase).effect.kind).toBe("enqueue");
      expect(
        continuation({ ...legacyBase, issue: { ...legacyBase.issue!, status } })
          .effect.kind,
      ).toBe("skip");
    },
  );
  it.each([
    ["budget", { gate: "budgetBlocked" }],
    ["duplicate", { gate: "activeExecution" }],
    [
      "wrong-company",
      { agent: { id: "agent", companyId: "other", status: "idle" } },
    ],
    [
      "paused-agent",
      { agent: { id: "agent", companyId: "company", status: "paused" } },
    ],
  ] as const)(
    "LCA-10 LCA-12 legacy gate %s survives encouraging prose",
    (variant, overrides) => {
      const actual = continuation(legacyBase, "gate" in overrides ? {
      gates: { stopped: false, paused: false, budgetBlocked: false, pendingWait: false,
        activeExecution: false, ownedLifecycle: false, conversation: false, agentInvokable: true,
        [overrides.gate]: true },
    } : overrides);
      observe("LCA-10", variant, actual);
      expect(actual.effect.kind).toBe("skip");
    },
  );
  it("LCA-09 exhausted recovery remains exhausted", () => {
    expect(
      continuation({ ...legacyBase, continuationAttempt: 2 }).effect.kind,
    ).toBe("exhausted");
  });
});

function assessment(
  overrides: Partial<NativeEvidenceAssessment> = {},
): NativeEvidenceAssessment {
  return {
    objectiveClaimSatisfied: true,
    objectiveSatisfied: true,
    allCriteriaSatisfied: true,
    verificationPassed: true,
    hasFailedVerification: false,
    hasBlockingRemainingWork: false,
    reportedDisposition: "done",
    summary: "Complete",
    contractRevisionMatches: true,
    criterionAssessments: [],
    verificationAssessments: [],
    verificationCaveats: [],
    acceptedEvidenceRefs: ["event:2"],
    missingRequirements: [],
    rejectedEvidence: [],
    unverifiableEvidence: [],
    blocker: null,
    continuation: null,
    attentionRequests: [],
    ignoredAttentionRequests: [],
    ...overrides,
  };
}
type NativeInput = Parameters<typeof arbitrateNativeStatus>[0];
const nativeBase: NativeInput = {
  assessment: assessment(),
  terminalState: "succeeded",
  workspaceFinalizeStatus: "succeeded",
  agentId: "agent",
  priorIssueStatus: "in_progress",
};
const nativeStates: Array<[string, Partial<NativeInput>, string]> = [
  ["LCA-01 complete", {}, "done"],
  [
    "LCA-04 approval",
    { governanceGate: { kind: "approval", id: "approval" } },
    "in_review",
  ],
  [
    "LCA-03 question",
    { governanceGate: { kind: "interaction", id: "question" } },
    "in_review",
  ],
  [
    "LCA-02 continue",
    {
      assessment: assessment({
        reportedDisposition: "yielded",
        continuation: {
          kind: "same_agent",
          summary: "Continue",
          idempotencyKey: "next",
        },
      }),
    },
    "in_progress",
  ],
  [
    "LCA-13 review",
    {
      assessment: assessment({
        reportedDisposition: "needs_review",
        attentionRequests: [
          {
            kind: "approval",
            summary: "Review",
            ownerClass: "human",
            targetAgentId: null,
            sourceIndex: 0,
            sourceKind: "approval",
            legacy: false,
          },
        ],
      }),
      reviewOwnerUserId: "owner",
    },
    "in_review",
  ],
  [
    "LCA-04 blocker",
    {
      assessment: assessment({
        reportedDisposition: "blocked",
        blocker: {
          boardOwned: true,
          scope: "task_wide",
          unblockAction: "Grant access",
        },
      }),
    },
    "blocked",
  ],
  [
    "LCA-07 monitor",
    {
      assessment: assessment({
        reportedDisposition: "yielded",
        continuation: {
          kind: "monitor",
          summary: "Wait",
          idempotencyKey: "monitor",
        },
      }),
    },
    "in_progress",
  ],
  [
    "LCA-08 conversation",
    {
      boardResponseWaitAuthorized: true,
      assessment: assessment({
        reportedDisposition: "yielded",
        continuation: {
          kind: "response_wake",
          summary: "Wait",
          idempotencyKey: "reply",
        },
      }),
    },
    "in_progress",
  ],
  ["LCA-11 late failure", { terminalState: "failed" }, "in_progress"],
  ["LCA-10 stopped", { terminalState: "cancelled" }, "in_progress"],
  ["LCA-12 already closed", { priorIssueStatus: "done" }, "done"],
  [
    "LCA-09 missing evidence",
    {
      assessment: assessment({
        objectiveSatisfied: false,
        allCriteriaSatisfied: false,
        verificationPassed: false,
        acceptedEvidenceRefs: [],
        missingRequirements: ["objective"],
      }),
    },
    "in_progress",
  ],
];
// Compare authoritative effects, allowing explanatory strings to vary.
function authority(decision: ReturnType<typeof arbitrateNativeStatus>) {
  return {
    ...decision,
    effects: decision.effects.map((effect) => {
      const { summary, prompt, detailsMarkdown, reason, nextAction, ...rest } =
        effect as typeof effect & Record<string, unknown>;
      return rest;
    }),
  };
}
describe("LCA native authority pairs", () => {
  for (const [scenario, overrides, status] of nativeStates) {
    it.each(narratives)(scenario + " / %s", (variant, text) => {
      const input = { ...nativeBase, ...overrides };
      const before = arbitrateNativeStatus(input);
      const after = arbitrateNativeStatus({
        ...input,
        assessment: { ...input.assessment, summary: text },
      });
      observe(scenario.split(" ")[0], `native:${scenario}:${variant}`, {
        before,
        after,
      });
      expect(after.toStatus).toBe(status);
      expect(authority(after)).toEqual(authority(before));
    });
  }
  it("LCA-04 resolving the real approval changes authority with identical prose", () => {
    expect(
      arbitrateNativeStatus({
        ...nativeBase,
        governanceGate: { kind: "approval", id: "approval" },
      }).toStatus,
    ).toBe("in_review");
    expect(arbitrateNativeStatus(nativeBase).toStatus).toBe("done");
  });
  it("LCA-02 explicit continuation changes effects with identical prose", () => {
    const done = arbitrateNativeStatus(nativeBase);
    const continued = arbitrateNativeStatus({
      ...nativeBase,
      assessment: assessment({
        reportedDisposition: "yielded",
        continuation: {
          kind: "same_agent",
          summary: "Continue",
          idempotencyKey: "next",
        },
      }),
    });
    expect(done.effects.some((e) => e.kind === "enqueue_continuation")).toBe(
      false,
    );
    expect(
      continued.effects.some((e) => e.kind === "enqueue_continuation"),
    ).toBe(true);
  });
});
