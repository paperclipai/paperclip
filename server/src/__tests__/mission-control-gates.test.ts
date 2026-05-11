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
          { key: "validator-report", body: "Verdict: REQUEST_CHANGES" },
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
        { key: "validator-report", body: "Verdict: PASS" },
      ],
    });

    expect(gate).toMatchObject({
      allowed: true,
      enabled: true,
      validatorVerdict: "PASS",
      reason: "allowed",
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
