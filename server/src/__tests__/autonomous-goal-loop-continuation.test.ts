import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
  buildAutonomousGoalLoopContinuationPlan,
  buildAutonomousGoalLoopState,
} from "../services/autonomous-goal-loop-continuation.ts";

const validatorAgentId = "agent-validator";

const parentIssue = {
  id: "parent-issue-1",
  companyId: "company-1",
  projectId: "project-1",
  goalId: "goal-1",
  title: "Ship autonomous creator traffic ops workflow",
  priority: "high",
  status: "in_progress",
  assigneeAgentId: "agent-ceo",
  assigneeUserId: null,
  requestDepth: 0,
  executionPolicy: {
    missionControl: {
      enabled: true,
      riskClass: "high",
      requiredDocumentKeys: ["validation-contract", "worker-handoff", "validator-report"],
      acceptedValidatorVerdicts: ["PASS"],
      liveActionGate: "board",
      destructiveActionGate: "board",
      autonomousLoop: {
        enabled: true,
        controller: "CEO",
        goal: "Ship autonomous creator traffic ops workflow",
        startedAt: "2026-05-11T08:00:00.000Z",
        iteration: 1,
        maxIterations: 5,
        maxRuntimeHours: 24,
      },
    },
  },
};

function missionDocsWithDecision(
  decision: Record<string, unknown>,
  options: { decisionUpdatedAt?: string } = {},
) {
  return [
    { key: "validation-contract", body: "objective/pass criteria" },
    { key: "worker-handoff", body: "completed/checks" },
    {
      key: "validator-report",
      body: "Verdict: PASS",
      createdByAgentId: validatorAgentId,
      updatedByAgentId: validatorAgentId,
    },
    {
      key: "ceo-loop-decision",
      body: JSON.stringify(decision),
      updatedAt: options.decisionUpdatedAt ?? "2026-05-11T09:00:00.000Z",
    },
  ];
}

describe("autonomous goal loop continuation planning", () => {
  it("plans one safe child issue for a validated next_iteration decision", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; continue with one more safe internal cycle.",
        nextTask: {
          title: "Add scheduler handoff smoke coverage",
          description: "Cover the automatic child creation path with a safe local test.",
          acceptanceCriteria: [
            "Child task is created from ceo-loop-decision",
            "Parent is blocked by the child until it completes",
          ],
          assigneeHint: "reuse the CEO/lead agent unless a specific worker is selected later",
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan.action).toBe("create_child");
    if (plan.action !== "create_child") throw new Error("expected create_child plan");
    expect(plan.originKind).toBe(AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND);
    expect(plan.originId).toBe(parentIssue.id);
    expect(plan.originFingerprint).toBe("iteration:1");
    expect(plan.childInput).toMatchObject({
      title: "[Loop 2] Add scheduler handoff smoke coverage",
      status: "todo",
      priority: "high",
      assigneeAgentId: "agent-ceo",
      assigneeUserId: null,
      blockParentUntilDone: true,
      acceptanceCriteria: [
        "Child task is created from ceo-loop-decision",
        "Parent is blocked by the child until it completes",
      ],
      originKind: AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
      originId: parentIssue.id,
      originFingerprint: "iteration:1",
    });
    expect(plan.childInput.description).toContain("Validation passed; continue with one more safe internal cycle.");
    expect(plan.childInput.description).toContain("safe internal autonomous-loop continuation");
    expect(plan.childInput.executionPolicy).toMatchObject({
      missionControl: {
        enabled: true,
        riskClass: "high",
        requiredDocumentKeys: ["validation-contract", "worker-handoff", "validator-report"],
        acceptedValidatorVerdicts: ["PASS"],
        autonomousLoop: null,
      },
    });
  });

  it("blocks CEO-safe next tasks when deterministic scan detects user-gated actions", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims this is safe to run autonomously.",
        nextTask: {
          title: "Deploy public campaign",
          description: "Deploy to production, merge into main, and post to Telegram after deleting stale accounts.",
          acceptanceCriteria: [
            "Purchase the required account credits before launch",
            "Rotate secret keys and change proxy settings for the campaign account",
          ],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("allows passive master artifact workflow merges without board escalation", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the release-manager lane can do the non-deploy merge.",
        nextTask: {
          title: "Merge PR #75 into master after internal QA approval",
          description: [
            "Squash merge the green PR into master after QA PASS, Claude Ship, and clean CI.",
            "Push-to-master workflows are classified as passive_ci_artifacts only: verify_canary checks, docker artifact build, and refresh-lockfile internal PR maintenance.",
            "No production deploy, npm publish, live flag, spend, secret rotation, migration, or service restart is authorized by this step.",
            "The npm canary publish job remains default-off unless a separate explicit operator gate enables it.",
          ].join(" "),
          acceptanceCriteria: [
            "PR is merged only after green CI and internal review evidence is present",
            "Only passive CI artifact/check workflows run on master push",
            "Any deploy, publish, restart, spend, secret, live-flag, or migration action remains board-gated",
          ],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "Claude Reviewer Ship", "green GitHub checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "create_child",
      reason: "next_iteration",
      reportToUser: false,
    });
  });

  it("blocks passive artifact merges when policy does not let the CEO approve passive artifacts", () => {
    const issue = {
      ...parentIssue,
      executionPolicy: {
        ...parentIssue.executionPolicy,
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            ceoCanApprove: ["research", "specs", "local_code_changes", "tests", "paperclip_comments", "dry_runs"],
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the release-manager lane can do the non-deploy merge.",
        nextTask: {
          title: "Merge PR #75 into master after internal QA approval",
          description: "Squash merge the green PR into master for passive_ci_artifacts after QA PASS and green CI.",
          acceptanceCriteria: ["Only passive CI artifact/check workflows run on master push"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "Claude Reviewer Ship", "green GitHub checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks passive artifact wording when it lacks internal review and green CI evidence", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO says passive_ci_artifacts are safe.",
        nextTask: {
          title: "Merge PR #76 into master",
          description: "This is not passive_ci_artifacts-approved yet; merge into master before QA signs off.",
          acceptanceCriteria: ["Master branch receives the commit"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["green checks pending"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks actual publish commands even when a nearby clause says no production deploy", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #77 into master as passive_ci_artifacts",
          description: "QA PASS and green CI are present. No production deploy is authorized, but publish canary to npm from master.",
          acceptanceCriteria: ["The npm canary package is published"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it.each([
    "QA PASS and green CI are present. No production deploy is authorized, publish canary to npm from master.",
    "QA PASS and green CI are present. No production deploy is authorized and publish canary to npm from master.",
    "QA PASS and green CI are present. No production deploy is authorized and publish canary to npm is allowed.",
    "QA PASS and green CI are present. No production deploy is authorized and set publish_canary=true is enabled.",
    "QA PASS and green CI are present. No production deploy, publish canary to npm is allowed.",
    "QA PASS and green CI are present. No production deploy, set publish_canary=true is enabled.",
    "QA PASS and green CI are present. No production deploy, publish canary to npm is authorized.",
    "QA PASS and green CI are present. No production deploy, run prod database migration is authorized.",
    "QA PASS and green CI are present. No production deploy, set publish_canary=true is authorized.",
    "QA PASS and green CI are present. No production deploy, set live flag ENABLE_PROD=true is authorized.",
    "QA PASS and green CI are present. Publish canary to npm from master and production deploy remains board-gated.",
    "QA PASS and green CI are present. Merge into master for passive_ci_artifacts and set publish_canary=true remains default-off.",
  ])("blocks gated actions hidden behind disclaimer punctuation: %s", (description) => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #77 into master as passive_ci_artifacts",
          description,
          acceptanceCriteria: ["The npm canary package is published"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it.each([
    "QA PASS and green CI are present. No production deploy, npm publish is authorized.",
    "QA PASS and green CI are present. No production deploy, publish_canary is enabled.",
    "QA PASS and green CI are present. No production deploy, production database migration is complete.",
    "QA PASS and green CI are present. No production deploy, production restart is authorized.",
    "QA PASS and green CI are present. No production deploy, live flag is enabled.",
  ])("blocks noun-led authorized side effects hidden behind disclaimer punctuation: %s", (description) => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #77 into master as passive_ci_artifacts",
          description,
          acceptanceCriteria: ["Only passive CI artifact/check workflows run on master push"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it.each([
    "The npm canary package is published",
    "The production live flag is enabled",
    "The production service is restarted",
    "The prod database migration is complete",
    "The API secret is rotated",
    "The proxy settings are changed",
  ])("blocks result-state side effects in acceptance criteria: %s", (acceptanceCriterion) => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #77 into master as passive_ci_artifacts",
          description: "QA PASS and green CI are present. Merge into master for passive_ci_artifacts only.",
          acceptanceCriteria: [acceptanceCriterion],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks publish actions followed by default-off guard wording", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #77 into master as passive_ci_artifacts",
          description: "QA PASS and green CI are present. Publish canary to npm from master and then note the canary publish job remains default-off unless a separate operator gate enables it.",
          acceptanceCriteria: ["The npm canary package is published"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks publish flag enablement even without explicit npm publish wording", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #77 into master as passive_ci_artifacts",
          description: "QA PASS and green CI are present. Merge into master for passive_ci_artifacts, then set publish_canary=true.",
          acceptanceCriteria: ["The canary publish gate is enabled"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it.each([
    "QA PASS and green CI are present. Merge into master for passive_ci_artifacts, then enable the canary publish flag.",
    "QA PASS and green CI are present. Merge into master for passive_ci_artifacts, then turn on npm canary publish gate.",
  ])("blocks textual publish gate enablement: %s", (description) => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #77 into master as passive_ci_artifacts",
          description,
          acceptanceCriteria: ["The canary publish gate is enabled"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks generic default-off internal maintenance merges without explicit passive CI artifact wording", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is internal maintenance.",
        nextTask: {
          title: "Merge PR #77 into master for default-off internal maintenance",
          description: "QA PASS and green CI are present. Merge into master for default-off internal maintenance only.",
          acceptanceCriteria: ["Master branch receives the commit"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it.each([
    "QA PASS and green CI are present. Merge into master for passive internal maintenance check only.",
    "QA PASS and green CI are present. Merge into master for passive maintenance workflow only.",
  ])("blocks generic passive check/workflow wording without explicit CI artifact wording: %s", (description) => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive maintenance.",
        nextTask: {
          title: "Merge PR #77 into master for passive maintenance",
          description,
          acceptanceCriteria: ["Master branch receives the commit"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it.each([
    "QA PASS and green CI are present. Merge into master for passive_ci_artifacts, then run prod database migration.",
    "QA PASS and green CI are present. Merge into master for passive_ci_artifacts, then run the database migration in production.",
  ])("blocks production migration side effects in passive artifact merges: %s", (description) => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #77 into master as passive_ci_artifacts",
          description,
          acceptanceCriteria: ["The production database migration is complete"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks live production feature flags even when the merge is described as passive", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #78 into master as passive_ci_artifacts",
          description: "QA PASS and green CI are present. Merge into master as passive_ci_artifacts, then set live flag ENABLE_PROD=true.",
          acceptanceCriteria: ["The production live flag is enabled"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["QA PASS", "green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks passive artifact merges when green checks are still pending", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #79 into master as passive_ci_artifacts",
          description: "Internal review complete and green checks pending; merge into master for passive_ci_artifacts only.",
          acceptanceCriteria: ["Master branch receives the commit"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["internal review complete", "green checks pending"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it.each([
    ["not green CI", ["QA PASS", "not green CI"]],
    ["CI not green", ["QA PASS", "CI not green"]],
    ["not QA PASS", ["not QA PASS", "green checks"]],
    ["Claude did not ship", ["green checks", "Claude Reviewer did not ship"]],
    ["internal review did not approve", ["green checks", "internal review did not approve"]],
  ])("blocks passive artifact merges with negated evidence: %s", (_label, evidence) => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the release branch is passive.",
        nextTask: {
          title: "Merge PR #79 into master as passive_ci_artifacts",
          description: "Merge into master for passive_ci_artifacts only.",
          acceptanceCriteria: ["Master branch receives the commit"],
          safeToRunWithoutUserApproval: true,
        },
        evidence,
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks urgent production deploy wording instead of treating 'without' as a disclaimer", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; continue the release quickly.",
        nextTask: {
          title: "Without delay, deploy to production",
          description: "Merge into master and deploy to production immediately after CI completes.",
          acceptanceCriteria: ["Production is updated"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("still blocks master merges that trigger live publish/deploy side effects", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims this release merge is safe.",
        nextTask: {
          title: "Merge PR #82 into master and publish canary",
          description: "Merge into master, set publish_canary=true, publish the npm canary, push the release tag, and restart production Paperclip.",
          acceptanceCriteria: [
            "The canary package is published to npm",
            "The production service is restarted after the merge",
          ],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["green checks"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("blocks direct currency spend even when no budget noun is present", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims this payment is safe.",
        nextTask: {
          title: "Pay vendor amount",
          description: "Pay $500 to the vendor and store the receipt internally.",
          acceptanceCriteria: ["Receipt is linked back to the parent issue"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_self_attestation_conflict",
      reportToUser: true,
    });
  });

  it("does not treat ordinary lowercase 'of' near post as an external-platform gate", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; continue with an internal summary.",
        nextTask: {
          title: "Post summary of findings internally",
          description: "Post summary of findings to the internal Paperclip issue comment thread.",
          acceptanceCriteria: ["Internal Paperclip summary of findings is available for review"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "create_child",
      reason: "next_iteration",
    });
  });

  it("blocks continuation when the parent assignee wrote the validator report", () => {
    const docs = missionDocsWithDecision({
      version: 1,
      iteration: 1,
      decision: "next_iteration",
      rationale: "Self-validation must not continue the loop.",
      nextTask: {
        title: "Unsafe continuation",
        acceptanceCriteria: ["Should not be created"],
        safeToRunWithoutUserApproval: true,
      },
      evidence: ["validator-report PASS"],
    }).map((doc) =>
      doc.key === "validator-report"
        ? {
            ...doc,
            createdByAgentId: parentIssue.assigneeAgentId,
            updatedByAgentId: parentIssue.assigneeAgentId,
          }
        : doc,
    );

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: docs,
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan.action).toBe("blocked");
    expect(plan.reason).toBe("validator_self_attested");
    expect(plan.gate.validatorVerdict).toBe("PASS");
  });

  it("does not create a child when required mission-control artifacts are missing", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: [
        { key: "validator-report", body: "Verdict: PASS" },
        {
          key: "ceo-loop-decision",
          body: JSON.stringify({
            version: 1,
            iteration: 1,
            decision: "next_iteration",
            rationale: "Try to continue too early.",
            nextTask: {
              title: "Premature child",
              acceptanceCriteria: ["Should not be created"],
              safeToRunWithoutUserApproval: true,
            },
            evidence: ["incomplete"],
          }),
        },
      ],
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "wait",
      reason: "missing_documents",
      reportToUser: false,
    });
  });

  it("stops for user-visible limits instead of creating another iteration child", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: {
        ...parentIssue,
        executionPolicy: {
          missionControl: {
            ...parentIssue.executionPolicy.missionControl,
            autonomousLoop: {
              ...parentIssue.executionPolicy.missionControl.autonomousLoop,
              iteration: 5,
              maxIterations: 5,
            },
          },
        },
      },
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 5,
        decision: "next_iteration",
        rationale: "Continue after hitting the limit.",
        nextTask: {
          title: "Over limit task",
          acceptanceCriteria: ["Should not be created"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "iteration_exceeded",
      reportToUser: true,
    });
  });

  it("reports approval_required decisions without creating child work", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "approval_required",
        rationale: "Next step requires a production deploy.",
        hardGate: {
          required: true,
          category: "production_deploy",
          reason: "Needs explicit user approval before deploy.",
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "approval_required",
      reportToUser: true,
    });
  });

  it("reports partial completion instead of creating child work", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "partial_completion",
        rationale: "The core implementation shipped, but product scope needs a human handoff.",
        nextTask: {
          title: "Review remaining product scope",
          acceptanceCriteria: ["Owner chooses the final launch scope"],
          assigneeHint: "product owner",
          safeToRunWithoutUserApproval: false,
        },
        evidence: ["core implementation merged to the feature branch"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "report",
      reason: "partial_completion",
      reportToUser: true,
    });
  });

  it("routes goal revision decisions to user approval instead of child work", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "goal_revision",
        revisedGoal: "Ship a smaller observability-first loop before enabling recovery actions.",
        rationale: "The current goal is too broad for the available iteration budget.",
        evidence: ["scope review"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "approval_required",
      reportToUser: true,
    });
  });

  it("blocks autonomous continuation at configured periodic user checkpoints", () => {
    const checkpointIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 2,
            userApprovalEveryNIterations: 2,
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: checkpointIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 2,
        decision: "next_iteration",
        rationale: "Continue after the periodic user checkpoint.",
        nextTask: {
          title: "Continue safe internal implementation",
          acceptanceCriteria: ["Checkpoint blocks first"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "periodic_checkpoint_required",
      reportToUser: true,
    });
  });

  it("surfaces periodic checkpoints as user-owned supervisor attention", () => {
    const checkpointIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 2,
            userApprovalEveryNIterations: 2,
          },
        },
      },
    };

    const state = buildAutonomousGoalLoopState({
      issue: checkpointIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 2,
        decision: "next_iteration",
        rationale: "Continue after the periodic user checkpoint.",
        nextTask: {
          title: "Continue safe internal implementation",
          acceptanceCriteria: ["Checkpoint blocks first"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      childIssues: [],
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(state).toMatchObject({
      enabled: true,
      status: "approval_required",
      supervisor: {
        attentionRequired: true,
        reason: "periodic_checkpoint_required",
        recoveryAction: "request_user_approval",
        owner: "user",
        userVisible: true,
      },
    });
  });

  it("blocks older decisions whose iteration no longer matches the loop policy", () => {
    const staleIterationIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 2,
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: staleIterationIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "This decision was generated before the current loop iteration.",
        nextTask: {
          title: "Repeat stale implementation slice",
          acceptanceCriteria: ["should not be created"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_loop_decision_stale",
      reportToUser: false,
    });
  });

  it("blocks future decisions whose iteration is ahead of the loop policy", () => {
    const futureIterationIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 1,
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: futureIterationIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 2,
        decision: "goal_reached",
        rationale: "This goal reached decision belongs to a future loop iteration.",
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_loop_decision_from_future",
      reportToUser: false,
    });
  });

  it("blocks same-iteration decisions that age past the loop freshness policy", () => {
    const freshnessBoundIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            maxDecisionAgeMinutes: 30,
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: freshnessBoundIssue,
      documents: missionDocsWithDecision(
        {
          version: 1,
          iteration: 1,
          decision: "next_iteration",
          decisionWrittenAt: "2026-05-11T08:00:00.000Z",
          rationale: "This same-iteration next step is too old to trust.",
          nextTask: {
            title: "Create too-old child",
            acceptanceCriteria: ["should not be created from stale decision age"],
            safeToRunWithoutUserApproval: true,
          },
          evidence: ["validator-report PASS"],
        },
        { decisionUpdatedAt: "2026-05-11T08:00:00.000Z" },
      ),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_loop_decision_stale",
      reportToUser: false,
    });
  });

  it("keeps stale terminal decisions internal instead of reporting them as goal reached", () => {
    const staleIterationIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 2,
          },
        },
      },
    };

    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: staleIterationIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "goal_reached",
        rationale: "This goal reached decision was generated for a stale iteration.",
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "ceo_loop_decision_stale",
      reportToUser: false,
    });
  });

  it("reports failed decisions instead of creating child work", () => {
    const plan = buildAutonomousGoalLoopContinuationPlan({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "failed",
        rationale: "Repeated validator failures made the autonomous loop unsafe to continue.",
        evidence: ["validator-report PASS"],
      }),
      now: "2026-05-11T09:00:00.000Z",
    });

    expect(plan).toMatchObject({
      action: "blocked",
      reason: "autonomous_loop_not_complete",
      reportToUser: true,
    });
  });

  it("builds an observable loop state with planner and supervisor scaffolding", () => {
    const state = buildAutonomousGoalLoopState({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; launch another safe internal slice.",
        nextTask: {
          title: "Expose loop state panel",
          acceptanceCriteria: ["Issue detail shows loop state"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      childIssues: [
        {
          id: "child-1",
          parentId: "parent-issue-1",
          identifier: "PAP-2",
          title: "[Loop 2] Expose loop state panel",
          status: "in_progress",
          originKind: AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
          originId: "parent-issue-1",
          originFingerprint: "iteration:1",
          blockedBy: [],
          createdAt: new Date("2026-05-11T09:01:00.000Z"),
          updatedAt: new Date("2026-05-11T09:05:00.000Z"),
        },
      ],
      now: "2026-05-11T09:10:00.000Z",
    });

    expect(state).toMatchObject({
      enabled: true,
      status: "executing",
      goal: "Ship autonomous creator traffic ops workflow",
      iteration: 1,
      maxIterations: 5,
      progressLabel: "1 / 5",
      currentDecision: {
        iteration: 1,
        decision: "next_iteration",
        nextTaskTitle: "Expose loop state panel",
      },
      planner: {
        mode: "single_child",
        supportsParallelChildren: false,
        nextTaskTitle: "Expose loop state panel",
      },
      supervisor: {
        attentionRequired: false,
        recoveryAction: "none",
      },
    });
    expect(state.iterations).toEqual([
      expect.objectContaining({
        iteration: 2,
        issueId: "child-1",
        identifier: "PAP-2",
        status: "in_progress",
      }),
    ]);
    expect(state.observability.chain).toEqual([
      expect.objectContaining({ kind: "goal", issueId: "parent-issue-1" }),
      expect.objectContaining({ kind: "iteration", issueId: "child-1", iteration: 2 }),
    ]);
  });

  it("marks CEO self-attestation conflicts as user-visible blocked loop states", () => {
    const state = buildAutonomousGoalLoopState({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; the CEO claims the next step is safe.",
        nextTask: {
          title: "Release social campaign",
          description: "Publish to X and deploy to production without waiting for the board.",
          acceptanceCriteria: ["Protected branch merge is complete"],
          safeToRunWithoutUserApproval: true,
        },
        evidence: ["validator-report PASS"],
      }),
      childIssues: [],
      now: "2026-05-11T10:00:00.000Z",
    });

    expect(state).toMatchObject({
      enabled: true,
      status: "blocked",
      supervisor: {
        attentionRequired: true,
        reason: "ceo_self_attestation_conflict",
        recoveryAction: "request_user_approval",
        owner: "user",
        userVisible: true,
      },
    });
    expect(state.supervisor).not.toHaveProperty("metricKey");
  });

  it("renders stale approval decisions as an internal repair state", () => {
    const staleIterationIssue = {
      ...parentIssue,
      executionPolicy: {
        missionControl: {
          ...parentIssue.executionPolicy.missionControl,
          autonomousLoop: {
            ...parentIssue.executionPolicy.missionControl.autonomousLoop,
            iteration: 2,
          },
        },
      },
    };

    const state = buildAutonomousGoalLoopState({
      issue: staleIterationIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "approval_required",
        rationale: "This approval request belongs to a previous loop iteration.",
        hardGate: {
          required: true,
          category: "production_deploy",
          reason: "Production deploy is user-gated.",
        },
        evidence: ["validator-report PASS"],
      }),
      childIssues: [],
      now: "2026-05-11T10:00:00.000Z",
    });

    expect(state).toMatchObject({
      enabled: true,
      status: "failed",
      supervisor: {
        attentionRequired: true,
        reason: "ceo_loop_decision_stale",
        recoveryAction: "repair_loop_decision",
        owner: "operator",
        userVisible: false,
      },
    });
    expect(state.supervisor).not.toHaveProperty("metricKey");
  });

  it("marks approval and blocked loop states for supervisor attention", () => {
    const state = buildAutonomousGoalLoopState({
      issue: parentIssue,
      documents: missionDocsWithDecision({
        version: 1,
        iteration: 1,
        decision: "approval_required",
        rationale: "Need explicit approval before production deploy.",
        hardGate: {
          required: true,
          category: "production_deploy",
          reason: "Production deploy is user-gated.",
        },
        evidence: ["validator-report PASS"],
      }),
      childIssues: [],
      now: "2026-05-11T10:00:00.000Z",
    });

    expect(state).toMatchObject({
      enabled: true,
      status: "approval_required",
      supervisor: {
        attentionRequired: true,
        reason: "approval_required",
        recoveryAction: "request_user_approval",
        userVisible: true,
      },
    });
  });
});
