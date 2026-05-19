import { describe, expect, it } from "vitest";
import { issueExecutionPolicySchema } from "./validators/issue.js";
import {
  MISSION_CONTROL_AUTONOMOUS_LOOP_DECISIONS,
  MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
  MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS,
  MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY,
  MISSION_CONTROL_VALIDATOR_VERDICTS,
  classifyMissionControlActionRisk,
  evaluateMissionControlAutonomousLoopGate,
  evaluateMissionControlCompletionGate,
  evaluateMissionControlSideEffectApproval,
  missionControlAutonomousLoopPolicySchema,
  missionControlCeoLoopDecisionSchema,
  missionControlIssuePolicySchema,
  missionControlOrchestrationContractSchema,
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
      "orchestration-contract",
      "worker-handoff",
      "validator-report",
    ]);
  });

  it("validates the orchestration contract for delegated child workstreams", () => {
    expect(MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY).toBe("orchestration-contract");

    const contract = missionControlOrchestrationContractSchema.parse({
      version: 1,
      leadAgentId: "lead-agent-1",
      validatorAgentId: "validator-agent-1",
      reporterAgentId: "reporter-agent-1",
      childWorkstreams: [
        {
          title: "Implement shared mission-control contract",
          objective: "Add a reusable contract for delegated child workstreams.",
          issueId: "child-issue-1",
          assigneeAgentId: "worker-agent-1",
          acceptanceCriteria: ["shared tests pass"],
          requiredArtifacts: ["worker handoff", "test output"],
          handoffDocumentKeys: ["worker-handoff"],
          status: "done",
        },
      ],
    });

    expect(contract.childWorkstreams).toHaveLength(1);
    expect(contract.childWorkstreams[0]?.status).toBe("done");

    expect(() =>
      missionControlOrchestrationContractSchema.parse({
        ...contract,
        childWorkstreams: [],
      }),
    ).toThrow();

    expect(() =>
      missionControlOrchestrationContractSchema.parse({
        ...contract,
        validatorAgentId: "worker-agent-1",
      }),
    ).toThrow();
  });

  it("defines the CEO autonomous loop policy and decision contract", () => {
    expect(MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY).toBe("ceo-loop-decision");
    expect(MISSION_CONTROL_AUTONOMOUS_LOOP_DECISIONS).toEqual([
      "next_iteration",
      "goal_reached",
      "blocked",
      "approval_required",
      "partial_completion",
      "goal_revision",
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
    expect(policy.maxDecisionAgeMinutes).toBe(60);
    expect(policy.userApprovalEveryNIterations).toBeNull();
    expect(policy.reportToUserOnlyOn).toEqual(expect.arrayContaining(["goal_reached", "approval_required"]));
    expect(policy.ceoCanApprove).toEqual(
      expect.arrayContaining(["local_code_changes", "dry_runs", "passive_ci_artifacts"]),
    );
    expect(policy.userApprovalRequired).toEqual(expect.arrayContaining(["live_external_action", "production_deploy"]));

    const decision = missionControlCeoLoopDecisionSchema.parse({
      version: 1,
      iteration: 1,
      decision: "next_iteration",
      decisionWrittenAt: "2026-05-11T08:30:00.000Z",
      rationale: "Validation passed; continue with the next safe internal task.",
      nextTask: {
        title: "Add validator template",
        acceptanceCriteria: ["validator-report document is produced"],
        safeToRunWithoutUserApproval: true,
      },
    });

    expect(decision.nextTask?.safeToRunWithoutUserApproval).toBe(true);
    expect(decision.decisionWrittenAt).toBe("2026-05-11T08:30:00.000Z");
  });

  it("defaults autonomous loop decision freshness while allowing explicit opt-out", () => {
    expect(
      missionControlAutonomousLoopPolicySchema.parse({
        enabled: true,
        goal: "Keep the loop fresh",
        startedAt: "2026-05-11T08:00:00.000Z",
        maxIterations: 5,
        maxRuntimeHours: 24,
      }).maxDecisionAgeMinutes,
    ).toBe(60);

    expect(
      missionControlAutonomousLoopPolicySchema.parse({
        enabled: true,
        goal: "Opt out of decision freshness",
        startedAt: "2026-05-11T08:00:00.000Z",
        maxIterations: 5,
        maxRuntimeHours: 24,
        maxDecisionAgeMinutes: null,
      }).maxDecisionAgeMinutes,
    ).toBeNull();

    expect(
      missionControlAutonomousLoopPolicySchema.parse({
        enabled: true,
        goal: "Preserve existing long freshness caps",
        startedAt: "2026-05-11T08:00:00.000Z",
        maxIterations: 5,
        maxRuntimeHours: 24,
        maxDecisionAgeMinutes: 60 * 24 * 30,
      }).maxDecisionAgeMinutes,
    ).toBe(60 * 24 * 30);

    expect(() =>
      missionControlAutonomousLoopPolicySchema.parse({
        enabled: true,
        goal: "Reject stale freshness caps beyond the legacy maximum",
        startedAt: "2026-05-11T08:00:00.000Z",
        maxIterations: 5,
        maxRuntimeHours: 24,
        maxDecisionAgeMinutes: 60 * 24 * 90 + 1,
      }),
    ).toThrow();
  });

  it("validates partial completion and goal revision CEO decisions", () => {
    expect(
      missionControlCeoLoopDecisionSchema.parse({
        version: 1,
        iteration: 2,
        decision: "partial_completion",
        rationale: "Most work is done, but a human owner must decide the final scope.",
        nextTask: {
          title: "Review remaining launch tradeoffs",
          acceptanceCriteria: ["Owner chooses which launch scope to ship"],
          assigneeHint: "product owner",
          safeToRunWithoutUserApproval: false,
        },
        evidence: ["implementation is partially complete"],
      }).decision,
    ).toBe("partial_completion");

    expect(() =>
      missionControlCeoLoopDecisionSchema.parse({
        version: 1,
        iteration: 2,
        decision: "partial_completion",
        rationale: "Missing the required human handoff.",
        nextTask: {
          title: "Review remaining launch tradeoffs",
          acceptanceCriteria: ["Owner chooses which launch scope to ship"],
          safeToRunWithoutUserApproval: false,
        },
        evidence: ["implementation is partially complete"],
      }),
    ).toThrow();

    expect(
      missionControlCeoLoopDecisionSchema.parse({
        version: 1,
        iteration: 3,
        decision: "goal_revision",
        revisedGoal: "Ship only the read-only observability slice before continuing automation.",
        rationale: "The original target was too broad for the current budget.",
        evidence: ["scope review"],
      }).revisedGoal,
    ).toBe("Ship only the read-only observability slice before continuing automation.");

    expect(() =>
      missionControlCeoLoopDecisionSchema.parse({
        version: 1,
        iteration: 3,
        decision: "goal_revision",
        rationale: "Missing the proposed revised goal.",
        evidence: ["scope review"],
      }),
    ).toThrow();
  });

  it("requires periodic user checkpoints before autonomous continuation", () => {
    const executionPolicy = {
      missionControl: missionControlIssuePolicySchema.parse({
        enabled: true,
        riskClass: "high",
        autonomousLoop: {
          enabled: true,
          goal: "Checkpoint every two iterations",
          startedAt: "2026-05-11T08:00:00.000Z",
          iteration: 2,
          maxIterations: 5,
          maxRuntimeHours: 24,
          userApprovalEveryNIterations: 2,
        },
      }),
    };

    const checkpoint = evaluateMissionControlAutonomousLoopGate({
      issue: { priority: "high", executionPolicy },
      now: "2026-05-11T08:30:00.000Z",
      documents: [
        {
          key: MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
          updatedAt: "2026-05-11T08:25:00.000Z",
          body: JSON.stringify({
            version: 1,
            iteration: 2,
            decision: "next_iteration",
            rationale: "Continue after checkpoint approval.",
            nextTask: {
              title: "Continue implementation",
              acceptanceCriteria: ["checkpoint blocks first"],
              safeToRunWithoutUserApproval: true,
            },
            evidence: ["ready for checkpoint"],
          }),
        },
      ],
    });

    expect(checkpoint).toMatchObject({
      allowed: false,
      requiredApprovalGate: "board",
      reason: "periodic_checkpoint_required",
    });
  });

  it("does not downgrade explicit hard gates at periodic checkpoints", () => {
    const executionPolicy = {
      missionControl: missionControlIssuePolicySchema.parse({
        enabled: true,
        riskClass: "high",
        autonomousLoop: {
          enabled: true,
          goal: "Checkpoint every two iterations",
          startedAt: "2026-05-11T08:00:00.000Z",
          iteration: 2,
          maxIterations: 5,
          maxRuntimeHours: 24,
          userApprovalEveryNIterations: 2,
        },
      }),
    };

    const result = evaluateMissionControlAutonomousLoopGate({
      issue: { priority: "high", executionPolicy },
      now: "2026-05-11T08:30:00.000Z",
      documents: [
        {
          key: MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
          updatedAt: "2026-05-11T08:25:00.000Z",
          body: JSON.stringify({
            version: 1,
            iteration: 2,
            decision: "next_iteration",
            rationale: "Needs explicit user approval before the checkpoint can matter.",
            hardGate: {
              required: true,
              reason: "live external action requires board approval",
              category: "live_external_action",
            },
            nextTask: {
              title: "Launch a live external step",
              acceptanceCriteria: ["board approval is captured first"],
              safeToRunWithoutUserApproval: true,
            },
            evidence: ["live action proposed"],
          }),
        },
      ],
    });

    expect(result).toMatchObject({
      allowed: false,
      requiredApprovalGate: "board",
      reason: "approval_required",
    });
  });

  it("routes goal revision decisions through board approval", () => {
    const executionPolicy = {
      missionControl: missionControlIssuePolicySchema.parse({
        enabled: true,
        riskClass: "high",
        autonomousLoop: {
          enabled: true,
          goal: "Original broad goal",
          startedAt: "2026-05-11T08:00:00.000Z",
          iteration: 3,
          maxIterations: 5,
          maxRuntimeHours: 24,
        },
      }),
    };

    const result = evaluateMissionControlAutonomousLoopGate({
      issue: { priority: "high", executionPolicy },
      now: "2026-05-11T08:30:00.000Z",
      documents: [
        {
          key: MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
          updatedAt: "2026-05-11T08:25:00.000Z",
          body: JSON.stringify({
            version: 1,
            iteration: 3,
            decision: "goal_revision",
            revisedGoal: "Ship a smaller trusted-agent workflow first.",
            rationale: "The original goal needs user-approved rescoping.",
            evidence: ["scope review"],
          }),
        },
      ],
    });

    expect(result).toMatchObject({
      allowed: false,
      requiredApprovalGate: "board",
      reason: "approval_required",
      ceoLoopDecision: { decision: "goal_revision", revisedGoal: "Ship a smaller trusted-agent workflow first." },
    });
  });

  it("accepts PASS / REQUEST_CHANGES / ESCALATE validator reports", () => {
    expect(MISSION_CONTROL_VALIDATOR_VERDICTS).toEqual(["PASS", "REQUEST_CHANGES", "ESCALATE"]);

    expect(
      missionControlValidatorReportSchema.parse({
        version: 1,
        writtenByAgentId: "validator-agent-1",
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


const completedOrchestrationContractDocument = () => ({
  key: MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY,
  body: JSON.stringify({
    version: 1,
    leadAgentId: "lead-agent-1",
    validatorAgentId: "validator-agent-1",
    reporterAgentId: "reporter-agent-1",
    childWorkstreams: [
      {
        title: "Complete delegated worker stream",
        objective: "Provide evidence that delegated worker execution is done.",
        issueId: "child-issue-1",
        assigneeAgentId: "worker-agent-1",
        acceptanceCriteria: ["worker handoff exists"],
        requiredArtifacts: ["worker handoff"],
        handoffDocumentKeys: ["worker-handoff"],
        status: "done",
      },
    ],
  }),
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
    expect(blocked.missingDocumentKeys).toEqual([
      MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY,
      "validator-report",
    ]);
    expect(blocked.requiredApprovalGate).toBe("board");
  });

  it("requires an orchestration contract by default for mission-controlled completion", () => {
    const blocked = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        executionPolicy: { missionControl: missionControlIssuePolicySchema.parse({ enabled: true, riskClass: "high" }) },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          body: JSON.stringify({
            version: 1,
            writtenByAgentId: "validator-agent-1",
            verdict: "PASS",
            completionScore: 9,
            criteriaChecked: ["criteria checked"],
            evidence: ["test output"],
            blockingIssues: [],
          }),
        },
      ],
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("missing_documents");
    expect(blocked.missingDocumentKeys).toEqual([MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY]);
  });

  it("blocks completion when the orchestration contract has unfinished child workstreams", () => {
    const blocked = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        executionPolicy: { missionControl: missionControlIssuePolicySchema.parse({ enabled: true, riskClass: "high" }) },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        {
          key: MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY,
          body: JSON.stringify({
            version: 1,
            leadAgentId: "lead-agent-1",
            validatorAgentId: "validator-agent-1",
            childWorkstreams: [
              {
                title: "Implement server gate",
                objective: "Wire the orchestration contract into completion checks.",
                issueId: "child-issue-1",
                assigneeAgentId: "worker-agent-1",
                acceptanceCriteria: ["server gate tests pass"],
                requiredArtifacts: ["worker handoff"],
                handoffDocumentKeys: ["worker-handoff"],
                status: "delegated",
              },
            ],
          }),
        },
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          body: JSON.stringify({
            version: 1,
            writtenByAgentId: "validator-agent-1",
            verdict: "PASS",
            completionScore: 9,
            criteriaChecked: ["criteria checked"],
            evidence: ["test output"],
            blockingIssues: [],
          }),
        },
      ],
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("orchestration_workstreams_incomplete");
  });

  it("blocks completion when the validator report is not written by the contract validator", () => {
    const blocked = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        executionPolicy: { missionControl: missionControlIssuePolicySchema.parse({ enabled: true, riskClass: "high" }) },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        completedOrchestrationContractDocument(),
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          body: JSON.stringify({
            version: 1,
            writtenByAgentId: "worker-agent-1",
            verdict: "PASS",
            completionScore: 9,
            criteriaChecked: ["criteria checked"],
            evidence: ["test output"],
            blockingIssues: [],
          }),
        },
      ],
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("validator_self_attested");
    expect(blocked.validatorVerdict).toBe("PASS");
  });

  it("requires the reporter final summary document when the orchestration contract names one", () => {
    const blocked = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        executionPolicy: { missionControl: missionControlIssuePolicySchema.parse({ enabled: true, riskClass: "high" }) },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        {
          key: MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY,
          body: JSON.stringify({
            version: 1,
            leadAgentId: "lead-agent-1",
            validatorAgentId: "validator-agent-1",
            reporterAgentId: "reporter-agent-1",
            finalSummaryDocumentKey: "final-summary",
            childWorkstreams: [
              {
                title: "Implement server gate",
                objective: "Wire the orchestration contract into completion checks.",
                issueId: "child-issue-1",
                assigneeAgentId: "worker-agent-1",
                acceptanceCriteria: ["server gate tests pass"],
                requiredArtifacts: ["worker handoff"],
                handoffDocumentKeys: ["worker-handoff"],
                status: "done",
              },
            ],
          }),
        },
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          body: JSON.stringify({
            version: 1,
            writtenByAgentId: "validator-agent-1",
            verdict: "PASS",
            completionScore: 9,
            criteriaChecked: ["criteria checked"],
            evidence: ["test output"],
            blockingIssues: [],
          }),
        },
      ],
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("missing_documents");
    expect(blocked.missingDocumentKeys).toEqual(["final-summary"]);
  });

  it("allows completion when the orchestration contract records completed delegated workstreams", () => {
    const allowed = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        executionPolicy: { missionControl: missionControlIssuePolicySchema.parse({ enabled: true, riskClass: "high" }) },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        {
          key: MISSION_CONTROL_ORCHESTRATION_CONTRACT_DOCUMENT_KEY,
          body: JSON.stringify({
            version: 1,
            leadAgentId: "lead-agent-1",
            validatorAgentId: "validator-agent-1",
            reporterAgentId: "reporter-agent-1",
            childWorkstreams: [
              {
                title: "Implement server gate",
                objective: "Wire the orchestration contract into completion checks.",
                issueId: "child-issue-1",
                assigneeAgentId: "worker-agent-1",
                acceptanceCriteria: ["server gate tests pass"],
                requiredArtifacts: ["worker handoff"],
                handoffDocumentKeys: ["worker-handoff"],
                status: "done",
              },
            ],
          }),
        },
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          body: JSON.stringify({
            version: 1,
            writtenByAgentId: "validator-agent-1",
            verdict: "PASS",
            completionScore: 9,
            criteriaChecked: ["criteria checked"],
            evidence: ["test output"],
            blockingIssues: [],
          }),
        },
      ],
    });

    expect(allowed).toMatchObject({
      allowed: true,
      reason: "allowed",
      validatorVerdict: "PASS",
      orchestrationContract: { childWorkstreams: [{ status: "done" }] },
    });
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
        completedOrchestrationContractDocument(),
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          body: JSON.stringify({
            version: 1,
            writtenByAgentId: "validator-agent-1",
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

  it("prefers structured validator JSON over earlier prose fences", () => {
    const result = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        executionPolicy: {
          missionControl: { enabled: true, riskClass: "high" },
        },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        completedOrchestrationContractDocument(),
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          createdByAgentId: "validator-agent-1",
          updatedByAgentId: "validator-agent-1",
          body: [
            "The test log includes the word PASS, but it is not the verdict.",
            "```text",
            "PASS appears in stdout before the report JSON.",
            "```",
            "```json",
            JSON.stringify({
              version: 1,
              verdict: "REQUEST_CHANGES",
              completionScore: 6,
              criteriaChecked: ["criteria checked"],
              evidence: ["review output"],
              blockingIssues: ["acceptance criteria not met"],
              exactFixIfFailed: "Address the missing acceptance evidence.",
            }),
            "```",
          ].join("\n"),
        },
      ],
    });

    expect(result.allowed).toBe(false);
    expect(result.validatorVerdict).toBe("REQUEST_CHANGES");
    expect(result.reason).toBe("validator_not_passed");
  });

  it("does not infer PASS from negated prose without a verdict line", () => {
    const result = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        executionPolicy: {
          missionControl: { enabled: true, riskClass: "high" },
        },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        completedOrchestrationContractDocument(),
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          createdByAgentId: "validator-agent-1",
          updatedByAgentId: "validator-agent-1",
          body: "The validator says do not PASS this work until the missing evidence is attached.",
        },
      ],
    });

    expect(result.allowed).toBe(false);
    expect(result.validatorVerdict).toBeNull();
    expect(result.reason).toBe("validator_not_passed");
  });

  it("blocks validator reports written by the assigned worker", () => {
    const blocked = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        assigneeAgentId: "worker-agent-1",
        executionPolicy: {
          missionControl: { enabled: true, riskClass: "high" },
        },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        completedOrchestrationContractDocument(),
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          body: JSON.stringify({
            version: 1,
            writtenByAgentId: "worker-agent-1",
            verdict: "PASS",
            completionScore: 9,
            criteriaChecked: ["criteria checked"],
            evidence: ["test output"],
            blockingIssues: [],
          }),
        },
      ],
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("validator_self_attested");
    expect(blocked.validatorVerdict).toBe("PASS");
  });

  it("trusts document writer metadata over body-level validator identity", () => {
    const blocked = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        assigneeAgentId: "worker-agent-1",
        executionPolicy: {
          missionControl: { enabled: true, riskClass: "high" },
        },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        completedOrchestrationContractDocument(),
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          createdByAgentId: "worker-agent-1",
          updatedByAgentId: "worker-agent-1",
          body: JSON.stringify({
            version: 1,
            writtenByAgentId: "validator-agent-1",
            verdict: "PASS",
            completionScore: 9,
            criteriaChecked: ["criteria checked"],
            evidence: ["test output"],
            blockingIssues: [],
          }),
        },
      ],
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("validator_self_attested");
    expect(blocked.validatorVerdict).toBe("PASS");
  });

  it("allows validator reports written by a different agent than the assigned worker", () => {
    const allowed = evaluateMissionControlCompletionGate({
      issue: {
        priority: "high",
        assigneeAgentId: "worker-agent-1",
        executionPolicy: {
          missionControl: { enabled: true, riskClass: "high" },
        },
      },
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        completedOrchestrationContractDocument(),
        { key: "worker-handoff", body: "completed/checks" },
        {
          key: "validator-report",
          body: JSON.stringify({
            version: 1,
            writtenByAgentId: "validator-agent-1",
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
    expect(allowed.reason).toBe("allowed");
  });

  it("parses CEO loop decision JSON after non-json fenced output", () => {
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

    const result = evaluateMissionControlAutonomousLoopGate({
      issue: { priority: "high", executionPolicy },
      documents: [
        {
          key: MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
          updatedAt: "2026-05-11T08:30:00.000Z",
          body: [
            "Review notes before the machine-readable decision:",
            "```text",
            "stdout: previous iteration checks passed",
            "```",
            "```json",
            JSON.stringify({
              version: 1,
              iteration: 2,
              decision: "goal_reached",
              rationale: "Validator passed and all pass criteria are satisfied.",
              evidence: ["final validation evidence"],
            }),
            "```",
          ].join("\n"),
        },
      ],
      validatorVerdict: "PASS",
      now: "2026-05-11T08:45:00.000Z",
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("allowed");
    expect(result.ceoLoopDecision?.decision).toBe("goal_reached");
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
      completedOrchestrationContractDocument(),
      { key: "worker-handoff", body: "completed/checks" },
      {
        key: "validator-report",
        body: JSON.stringify({
          version: 1,
          writtenByAgentId: "validator-agent-1",
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
          updatedAt: "2026-05-11T08:30:00.000Z",
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
      now: "2026-05-11T08:30:00.000Z",
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
          updatedAt: "2026-05-11T08:45:00.000Z",
          body: JSON.stringify({
            version: 1,
            iteration: 2,
            decision: "goal_reached",
            rationale: "Validator passed and all pass criteria are satisfied.",
          }),
        },
      ],
      now: "2026-05-11T08:45:00.000Z",
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
            updatedAt: "2026-05-11T09:00:00.000Z",
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

  it("rejects older autonomous loop decisions before creating another iteration", () => {
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
      reason: "ceo_loop_decision_stale",
      requiredApprovalGate: "board",
      ceoLoopDecision: { iteration: 2, decision: "next_iteration" },
    });
  });

  it("rejects future autonomous loop decisions with a separate repair reason", () => {
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
              iteration: 4,
              decision: "goal_reached",
              rationale: "This decision belongs to a future loop iteration and must not be laundered.",
            }),
          },
        ],
        now: "2026-05-11T09:30:00.000Z",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "ceo_loop_decision_from_future",
      requiredApprovalGate: "board",
      ceoLoopDecision: { iteration: 4, decision: "goal_reached" },
    });
  });

  it("rejects same-iteration CEO decisions that exceed the configured freshness window", () => {
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
          maxDecisionAgeMinutes: 30,
        },
      }),
    };

    expect(
      evaluateMissionControlAutonomousLoopGate({
        issue: { priority: "high", executionPolicy },
        documents: [
          {
            key: MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
            updatedAt: "2026-05-11T08:45:00.000Z",
            body: JSON.stringify({
              version: 1,
              iteration: 3,
              decision: "next_iteration",
              decisionWrittenAt: "2026-05-11T08:45:00.000Z",
              rationale: "This same-iteration decision has aged out.",
              nextTask: {
                title: "Aged-out child work",
                acceptanceCriteria: ["should not create work from stale decision age"],
                safeToRunWithoutUserApproval: true,
              },
            }),
          },
        ],
        now: "2026-05-11T09:30:00.000Z",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "ceo_loop_decision_stale",
      requiredApprovalGate: "board",
      ceoLoopDecision: { iteration: 3, decision: "next_iteration", decisionWrittenAt: "2026-05-11T08:45:00.000Z" },
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
