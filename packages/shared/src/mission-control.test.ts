import { describe, expect, it } from "vitest";
import { issueExecutionPolicySchema } from "./validators/issue.js";
import {
  MISSION_CONTROL_AUTONOMOUS_LOOP_DECISIONS,
  MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
  MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS,
  MISSION_CONTROL_VALIDATOR_VERDICTS,
  classifyMissionControlActionRisk,
  evaluateMissionControlAutonomousLoopGate,
  evaluateMissionControlCompletionGate,
  evaluateMissionControlSideEffectApproval,
  missionControlAutonomousLoopPolicySchema,
  missionControlCeoLoopDecisionSchema,
  missionControlIssuePolicySchema,
  missionControlSideEffectApprovalEnvelopeSchema,
  missionControlValidatorReportSchema,
  missionControlWorkerHandoffSchema,
  shouldTreatIssueArtifactsAsSubstantive,
  summarizeMissionControlScorecard,
} from "./mission-control.js";

describe("mission-control workflow contracts", () => {
  it("defines the required mission documents for a validated mission loop", () => {
    expect(MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS).toEqual([
      "validation-contract",
      "worker-handoff",
      "validator-report",
    ]);
  });

  it("defines the CEO autonomous loop policy and decision contract", () => {
    expect(MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY).toBe("ceo-loop-decision");
    expect(MISSION_CONTROL_AUTONOMOUS_LOOP_DECISIONS).toEqual([
      "next_iteration",
      "goal_reached",
      "blocked",
      "approval_required",
      "failed",
    ]);

    const policy = missionControlAutonomousLoopPolicySchema.parse({
      enabled: true,
      controller: "CEO",
      goal: "Ship an autonomous creator traffic operations workflow",
      startedAt: "2026-05-11T08:00:00.000Z",
      iteration: 1,
      maxIterations: 5,
      maxRuntimeHours: 24,
    });

    expect(policy.requireValidatorPass).toBe(true);
    expect(policy.reportToUserOnlyOn).toEqual(expect.arrayContaining(["goal_reached", "approval_required"]));
    expect(policy.ceoCanApprove).toEqual(expect.arrayContaining(["local_code_changes", "dry_runs"]));
    expect(policy.userApprovalRequired).toEqual(expect.arrayContaining(["live_external_action", "production_deploy"]));

    expect(
      missionControlCeoLoopDecisionSchema.parse({
        version: 1,
        iteration: 1,
        decision: "next_iteration",
        rationale: "Validation passed; continue with the next safe internal task.",
        nextTask: {
          title: "Add validator template",
          acceptanceCriteria: ["validator-report document is produced"],
          safeToRunWithoutUserApproval: true,
        },
      }).nextTask?.safeToRunWithoutUserApproval,
    ).toBe(true);
  });

  it("accepts PASS / REQUEST_CHANGES / ESCALATE validator reports", () => {
    expect(MISSION_CONTROL_VALIDATOR_VERDICTS).toEqual(["PASS", "REQUEST_CHANGES", "ESCALATE"]);

    expect(
      missionControlValidatorReportSchema.parse({
        version: 1,
        verdict: "PASS",
        completionScore: 9,
        criteriaChecked: ["tests passed", "artifact verified"],
        evidence: ["pnpm vitest packages/shared/src/mission-control.test.ts"],
        blockingIssues: [],
      }),
    ).toMatchObject({ verdict: "PASS", completionScore: 9 });
  });

  it("requires auditable worker handoff evidence", () => {
    expect(() =>
      missionControlWorkerHandoffSchema.parse({
        version: 1,
        completed: ["implemented feature"],
        commands: [],
        checks: [],
        risks: [],
      }),
    ).toThrow();

    expect(
      missionControlWorkerHandoffSchema.parse({
        version: 1,
        completed: ["implemented feature"],
        notDone: [],
        commands: ["pnpm test"],
        sources: ["LET-94 final blueprint"],
        artifacts: ["branch feat/paperclip-mission-control-gates"],
        checks: ["targeted tests pass"],
        risks: [],
        nextStep: "validator review",
        confidence: 0.85,
      }).confidence,
    ).toBe(0.85);
  });
});

describe("mission-control completion gate", () => {
  it("accepts mission-control policy inside the existing issue execution policy", () => {
    expect(
      issueExecutionPolicySchema.parse({
        mode: "normal",
        missionControl: { enabled: true, riskClass: "high" },
      }).missionControl,
    ).toMatchObject({ enabled: true, riskClass: "high" });
  });

  it("blocks mission-controlled issues until required artifacts and PASS verdict exist", () => {
    const policy = missionControlIssuePolicySchema.parse({
      enabled: true,
      riskClass: "high",
    });

    const blocked = evaluateMissionControlCompletionGate({
      issue: { priority: "high", executionPolicy: { missionControl: policy } },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        { key: "worker-handoff", body: "completed/checks" },
      ],
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.missingDocumentKeys).toEqual(["validator-report"]);
    expect(blocked.requiredApprovalGate).toBe("board");
  });

  it("allows completion when the validator report is PASS", () => {
    const allowed = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        executionPolicy: {
          missionControl: { enabled: true, riskClass: "high" },
        },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          body: JSON.stringify({
            version: 1,
            verdict: "PASS",
            completionScore: 9,
            criteriaChecked: ["criteria checked"],
            evidence: ["test output"],
            blockingIssues: [],
          }),
        },
      ],
    });

    expect(allowed.allowed).toBe(true);
    expect(allowed.validatorVerdict).toBe("PASS");
  });

  it("blocks autonomous loop completion until the CEO decision reaches the goal", () => {
    const executionPolicy = {
      missionControl: missionControlIssuePolicySchema.parse({
        enabled: true,
        riskClass: "high",
        autonomousLoop: {
          enabled: true,
          controller: "CEO",
          goal: "Build the autonomous creator traffic workflow",
          startedAt: "2026-05-11T08:00:00.000Z",
          iteration: 2,
          maxIterations: 5,
          maxRuntimeHours: 24,
        },
      }),
    };
    const baseDocuments = [
      { key: "validation-contract", body: "objective/pass criteria" },
      { key: "worker-handoff", body: "completed/checks" },
      {
        key: "validator-report",
        body: JSON.stringify({
          version: 1,
          verdict: "PASS",
          completionScore: 9,
          criteriaChecked: ["criteria checked"],
          evidence: ["test output"],
          blockingIssues: [],
        }),
      },
    ];

    const missingDecision = evaluateMissionControlCompletionGate({
      issue: { priority: "high", executionPolicy },
      documents: baseDocuments,
    });
    expect(missingDecision.allowed).toBe(false);
    expect(missingDecision.missingDocumentKeys).toEqual([MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY]);

    const nextIteration = evaluateMissionControlCompletionGate({
      issue: { priority: "high", executionPolicy },
      documents: [
        ...baseDocuments,
        {
          key: MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
          body: JSON.stringify({
            version: 1,
            iteration: 2,
            decision: "next_iteration",
            rationale: "Need another internal implementation cycle.",
            nextTask: {
              title: "Wire server gate checks",
              acceptanceCriteria: ["server tests pass"],
              safeToRunWithoutUserApproval: true,
            },
          }),
        },
      ],
    });
    expect(nextIteration).toMatchObject({
      allowed: false,
      reason: "autonomous_loop_not_complete",
      ceoLoopDecision: { decision: "next_iteration" },
    });

    const goalReached = evaluateMissionControlCompletionGate({
      issue: { priority: "high", executionPolicy },
      documents: [
        ...baseDocuments,
        {
          key: MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
          body: JSON.stringify({
            version: 1,
            iteration: 2,
            decision: "goal_reached",
            rationale: "Validator passed and all pass criteria are satisfied.",
          }),
        },
      ],
    });
    expect(goalReached).toMatchObject({
      allowed: true,
      reason: "allowed",
      ceoLoopDecision: { decision: "goal_reached" },
    });
  });

  it("turns autonomous loop iteration and runtime limits into hard gates", () => {
    const executionPolicy = {
      missionControl: missionControlIssuePolicySchema.parse({
        enabled: true,
        riskClass: "high",
        autonomousLoop: {
          enabled: true,
          controller: "CEO",
          goal: "Build the autonomous creator traffic workflow",
          startedAt: "2026-05-11T08:00:00.000Z",
          iteration: 5,
          maxIterations: 5,
          maxRuntimeHours: 1,
        },
      }),
    };

    expect(
      evaluateMissionControlAutonomousLoopGate({
        issue: { priority: "high", executionPolicy },
        documents: [
          {
            key: MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
            body: JSON.stringify({
              version: 1,
              iteration: 5,
              decision: "next_iteration",
              rationale: "Need more work.",
              nextTask: {
                title: "Another autonomous cycle",
                acceptanceCriteria: ["new evidence exists"],
                safeToRunWithoutUserApproval: true,
              },
            }),
          },
        ],
        now: "2026-05-11T09:30:00.000Z",
      }),
    ).toMatchObject({ allowed: false, reason: "runtime_exceeded", requiredApprovalGate: "board" });
  });

  it("rejects stale autonomous loop decisions before creating another iteration", () => {
    const executionPolicy = {
      missionControl: missionControlIssuePolicySchema.parse({
        enabled: true,
        riskClass: "high",
        autonomousLoop: {
          enabled: true,
          controller: "CEO",
          goal: "Build the autonomous creator traffic workflow",
          startedAt: "2026-05-11T08:00:00.000Z",
          iteration: 3,
          maxIterations: 5,
          maxRuntimeHours: 24,
        },
      }),
    };

    expect(
      evaluateMissionControlAutonomousLoopGate({
        issue: { priority: "high", executionPolicy },
        documents: [
          {
            key: MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
            body: JSON.stringify({
              version: 1,
              iteration: 2,
              decision: "next_iteration",
              rationale: "This decision was generated for the previous loop iteration.",
              nextTask: {
                title: "Repeat stale child work",
                acceptanceCriteria: ["should not create a new child from stale state"],
                safeToRunWithoutUserApproval: true,
              },
            }),
          },
        ],
        now: "2026-05-11T09:30:00.000Z",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "ceo_loop_iteration_mismatch",
      requiredApprovalGate: "board",
      ceoLoopDecision: { iteration: 2, decision: "next_iteration" },
    });
  });

  it("does not block legacy issues unless missionControl is enabled", () => {
    expect(
      evaluateMissionControlCompletionGate({
        issue: { priority: "high", executionPolicy: null },
        documents: [],
      }).allowed,
    ).toBe(true);
  });
});

describe("mission-control risk policy", () => {
  it("maps live external and destructive actions to hard approval gates", () => {
    expect(classifyMissionControlActionRisk({ tool: "telegram", action: "send_dm" })).toMatchObject({
      level: "external_live",
      requiredApprovalGate: "board",
    });
    expect(classifyMissionControlActionRisk({ tool: "terminal", action: "rm -rf /tmp/demo" })).toMatchObject({
      level: "destructive",
      requiredApprovalGate: "board",
    });
  });

  it("keeps local tests and read-only Paperclip inspection autonomous", () => {
    expect(classifyMissionControlActionRisk({ tool: "terminal", action: "pnpm test" })).toMatchObject({
      level: "local_only",
      requiredApprovalGate: "none",
    });
    expect(classifyMissionControlActionRisk({ tool: "paperclip", action: "read issue" })).toMatchObject({
      level: "paperclip_only",
      requiredApprovalGate: "none",
    });
  });

  it("requires a live side-effect approval envelope for gated actions", () => {
    const actionRisk = classifyMissionControlActionRisk({ tool: "telegram", action: "send_dm" });
    const approvedEnvelope = missionControlSideEffectApprovalEnvelopeSchema.parse({
      version: 1,
      tool: "telegram",
      action: "send_dm",
      actionRiskLevel: actionRisk.level,
      requiredApprovalGate: "board",
      status: "approved",
      approvedByUserId: "user-1",
      approvedAt: "2026-05-10T12:00:00.000Z",
      expiresAt: "2026-05-10T13:00:00.000Z",
      dryRunEvidence: ["preview message reviewed"],
      constraints: ["only this dialog"],
    });

    expect(
      evaluateMissionControlSideEffectApproval({
        actionRisk,
        envelopes: [],
        now: "2026-05-10T12:30:00.000Z",
      }),
    ).toMatchObject({ allowed: false, reason: "missing_approval", requiredApprovalGate: "board" });

    expect(
      evaluateMissionControlSideEffectApproval({
        actionRisk,
        envelopes: [approvedEnvelope],
        now: "2026-05-10T12:30:00.000Z",
      }),
    ).toMatchObject({ allowed: true, reason: "approved", requiredApprovalGate: "board" });
  });

  it("does not reuse a side-effect approval envelope for a different action", () => {
    const actionRisk = classifyMissionControlActionRisk({ tool: "telegram", action: "send_dm" });
    const wrongActionEnvelope = missionControlSideEffectApprovalEnvelopeSchema.parse({
      version: 1,
      tool: "stripe",
      action: "charge",
      actionRiskLevel: "external_live",
      requiredApprovalGate: "board",
      status: "approved",
      approvedByUserId: "user-1",
      approvedAt: "2026-05-10T12:00:00.000Z",
      expiresAt: "2026-05-10T13:00:00.000Z",
      dryRunEvidence: ["stripe charge preview reviewed"],
      constraints: ["one invoice only"],
    });

    expect(
      evaluateMissionControlSideEffectApproval({
        actionRisk,
        envelopes: [wrongActionEnvelope],
        now: "2026-05-10T12:30:00.000Z",
      }),
    ).toMatchObject({ allowed: false, reason: "missing_approval", requiredApprovalGate: "board" });
  });
});

describe("mission-control scorecards and artifact-first liveness", () => {
  it("computes accepted-output quality instead of activity volume", () => {
    expect(
      summarizeMissionControlScorecard([
        { verdict: "PASS", reworkCount: 0, costCents: 100 },
        { verdict: "REQUEST_CHANGES", reworkCount: 1, costCents: 200 },
        { verdict: "ESCALATE", reworkCount: 2, costCents: 300 },
      ]),
    ).toMatchObject({
      total: 3,
      accepted: 1,
      firstPassAcceptanceRate: 1 / 3,
      requestChangesRate: 1 / 3,
      escalateRate: 1 / 3,
      totalCostCents: 600,
    });
  });

  it("treats substantive final artifacts as liveness evidence even if status is stale", () => {
    expect(
      shouldTreatIssueArtifactsAsSubstantive({
        status: "in_progress",
        runStatus: "running",
        documents: [{ key: "final-orchestration-blueprint", body: "x".repeat(3500) }],
        comments: [],
      }),
    ).toMatchObject({ substantive: true, reason: "substantive_document" });
  });
});
