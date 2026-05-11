import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  assertMissionControlCompletionGate,
  assertMissionControlCompletionTransitionGate,
} from "../services/mission-control-gates.ts";

const missionControlledIssue = {
  id: "issue-1",
  priority: "high",
  executionPolicy: {
    missionControl: {
      enabled: true,
      riskClass: "high",
      requiredDocumentKeys: ["validation-contract", "worker-handoff", "validator-report"],
    },
  },
};

const autonomousLoopIssue = {
  id: "issue-ceo-loop",
  priority: "high",
  executionPolicy: {
    missionControl: {
      enabled: true,
      riskClass: "high",
      requiredDocumentKeys: ["validation-contract", "worker-handoff", "validator-report"],
      autonomousLoop: {
        enabled: true,
        controller: "CEO",
        goal: "Build the autonomous creator traffic workflow",
        startedAt: "2026-05-11T08:00:00.000Z",
        iteration: 2,
        maxIterations: 5,
        maxRuntimeHours: 24,
      },
    },
  },
};

const validatorAgentId = "validator-agent-1";
const workerAgentId = "worker-agent-1";

const validatorPassDocument = {
  key: "validator-report",
  body: "Verdict: PASS",
  createdByAgentId: validatorAgentId,
  updatedByAgentId: validatorAgentId,
};

const completedMissionDocuments = [
  { key: "validation-contract", body: "objective/pass criteria" },
  { key: "worker-handoff", body: "completed/checks" },
  validatorPassDocument,
];

describe("mission-control completion gate service", () => {
  it("throws 422 with actionable blocker details when a mission-controlled issue lacks required artifacts", () => {
    expect(() =>
      assertMissionControlCompletionGate({
        issue: missionControlledIssue,
        documents: [
          { key: "validation-contract", body: "objective/pass criteria" },
          { key: "worker-handoff", body: "completed/checks" },
        ],
      }),
    ).toThrow(HttpError);

    try {
      assertMissionControlCompletionGate({
        issue: missionControlledIssue,
        documents: [
          { key: "validation-contract", body: "objective/pass criteria" },
          { key: "worker-handoff", body: "completed/checks" },
        ],
      });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).message).toBe("Mission-control completion gate blocked issue");
      expect((err as HttpError).details).toMatchObject({
        reason: "missing_documents",
        missingDocumentKeys: ["validator-report"],
        validatorVerdict: null,
        requiredApprovalGate: "board",
      });
    }
  });

  it("throws until the validator-report carries an accepted PASS verdict", () => {
    expect(() =>
      assertMissionControlCompletionGate({
        issue: missionControlledIssue,
        documents: [
          { key: "validation-contract", body: "objective/pass criteria" },
          { key: "worker-handoff", body: "completed/checks" },
          {
            key: "validator-report",
            body: "Verdict: REQUEST_CHANGES",
            createdByAgentId: validatorAgentId,
            updatedByAgentId: validatorAgentId,
          },
        ],
      }),
    ).toThrow(/Mission-control completion gate blocked issue/);
  });

  it("does not let a done transition bypass an existing mission-control gate by disabling the next policy", () => {
    expect(() =>
      assertMissionControlCompletionTransitionGate({
        issue: missionControlledIssue,
        nextExecutionPolicy: { missionControl: { enabled: false } },
        documents: [],
      }),
    ).toThrow(/Mission-control completion gate blocked issue/);
  });

  it("applies a newly enabled mission-control policy when completion and policy update happen together", () => {
    expect(() =>
      assertMissionControlCompletionTransitionGate({
        issue: { id: "legacy-issue", priority: "high", executionPolicy: null },
        nextExecutionPolicy: missionControlledIssue.executionPolicy,
        documents: [],
      }),
    ).toThrow(/Mission-control completion gate blocked issue/);
  });

  it("allows completion when the required artifacts include validator PASS", () => {
    const gate = assertMissionControlCompletionGate({
      issue: missionControlledIssue,
      documents: [
        { key: "validation-contract", body: "objective/pass criteria" },
        { key: "worker-handoff", body: "completed/checks" },
        validatorPassDocument,
      ],
    });

    expect(gate).toMatchObject({
      allowed: true,
      enabled: true,
      validatorVerdict: "PASS",
      reason: "allowed",
    });
  });

  it("blocks completion when the assigned worker wrote the validator-report", () => {
    let selfAttestedError: unknown;
    try {
      assertMissionControlCompletionGate({
        issue: { ...missionControlledIssue, assigneeAgentId: workerAgentId },
        documents: [
          { key: "validation-contract", body: "objective/pass criteria" },
          { key: "worker-handoff", body: "completed/checks" },
          {
            key: "validator-report",
            body: "Verdict: PASS",
            createdByAgentId: workerAgentId,
            updatedByAgentId: workerAgentId,
          },
        ],
      });
    } catch (err) {
      selfAttestedError = err;
    }

    expect(selfAttestedError).toBeInstanceOf(HttpError);
    expect((selfAttestedError as HttpError).details).toMatchObject({
      reason: "validator_self_attested",
      validatorVerdict: "PASS",
      requiredApprovalGate: "board",
    });
  });

  it("surfaces CEO autonomous loop blocker details until the CEO reaches the goal", () => {
    let missingDecisionError: unknown;
    try {
      assertMissionControlCompletionGate({
        issue: autonomousLoopIssue,
        documents: completedMissionDocuments,
      });
    } catch (err) {
      missingDecisionError = err;
    }
    expect(missingDecisionError).toBeInstanceOf(HttpError);
    expect((missingDecisionError as HttpError).details).toMatchObject({
      reason: "missing_ceo_loop_decision",
      missingDocumentKeys: ["ceo-loop-decision"],
      validatorVerdict: "PASS",
      ceoLoopDecision: null,
      requiredApprovalGate: "board",
    });

    let nextIterationError: unknown;
    try {
      assertMissionControlCompletionGate({
        issue: autonomousLoopIssue,
        documents: [
          ...completedMissionDocuments,
          {
            key: "ceo-loop-decision",
            body: JSON.stringify({
              version: 1,
              iteration: 2,
              decision: "next_iteration",
              rationale: "Run one more safe internal cycle.",
              nextTask: {
                title: "Add orchestration prompt contract",
                acceptanceCriteria: ["CEO prompt includes ceo-loop-decision JSON"],
                safeToRunWithoutUserApproval: true,
              },
            }),
          },
        ],
      });
    } catch (err) {
      nextIterationError = err;
    }
    expect(nextIterationError).toBeInstanceOf(HttpError);
    expect((nextIterationError as HttpError).details).toMatchObject({
      reason: "autonomous_loop_not_complete",
      ceoLoopDecision: { decision: "next_iteration" },
      requiredApprovalGate: "none",
    });

    const gate = assertMissionControlCompletionGate({
      issue: autonomousLoopIssue,
      documents: [
        ...completedMissionDocuments,
        {
          key: "ceo-loop-decision",
          body: JSON.stringify({
            version: 1,
            iteration: 2,
            decision: "goal_reached",
            rationale: "Validator passed and the goal is complete.",
          }),
        },
      ],
    });

    expect(gate).toMatchObject({
      allowed: true,
      reason: "allowed",
      ceoLoopDecision: { decision: "goal_reached" },
    });
  });

  it("does not block legacy issues with no missionControl policy", () => {
    const gate = assertMissionControlCompletionGate({
      issue: { id: "legacy-issue", priority: "high", executionPolicy: null },
      documents: [],
    });

    expect(gate).toMatchObject({ allowed: true, enabled: false });
  });
});
