import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { expectedFinalStatus } from "./grader.js";
import type { OracleArtifacts, TaskRecord } from "./types.js";
import { workloadDefinitions } from "./workloads.js";

const NONCE = "a1b2c3d4";
const brief = `# Brief\nCHAOS-${NONCE}\n- one\n- two\n- three\n`;
const artifacts = (handoff: Partial<NonNullable<OracleArtifacts["handoff"]>> = {}, issueStatus = "in_review"): OracleArtifacts => ({
  issueStatus, documents: { brief }, agentComments: [], files: {}, commands: {}, workspacePath: null,
  handoff: { assigneeAgentId: null, assigneeUserId: "board-user", createdByUserId: "board-user", executionBlocker: false,
    activeRecoveryAction: false, runs: [{ id: "run-1", status: "succeeded", errorCode: null }], ...handoff },
});
const grade = (value: OracleArtifacts) => workloadDefinitions.H2.grade(NONCE, value);
const failed = (value: OracleArtifacts) => grade(value).checks.filter(check => !check.ok).map(check => check.name);

describe("H2: the agent's own hand-off to a person (staging class H)", () => {
  it("passes when the run finished and the person holds the task in review", () => {
    expect(grade(artifacts()).verdict).toBe("pass");
  });

  it("fails the staging shape: the hand-off cancelled its own run and left an execution blocker", () => {
    expect(failed(artifacts({ runs: [{ id: "run-1", status: "cancelled", errorCode: "issue_reassigned" }], executionBlocker: true })))
      .toEqual(["handoff_did_not_cancel_run", "no_execution_blocker"]);
  });

  it("fails when the task did not reach the creator in review", () => {
    expect(failed(artifacts({ assigneeAgentId: "agent-1", assigneeUserId: null }, "in_progress")))
      .toEqual(["issue_in_review", "handed_to_creator"]);
  });

  it("fails when the run history could not be read or is empty", () => {
    expect(failed(artifacts({ runs: null }))).toEqual(["handoff_did_not_cancel_run"]);
    expect(failed(artifacts({ runs: [] }))).toEqual(["handoff_did_not_cancel_run"]);
  });

  it("accepts a run that a restart after the hand-off settled without the task", () => {
    expect(grade(artifacts({ runs: [{ id: "run-1", status: "failed", errorCode: "native_restart_recovery_blocked" }] })).verdict).toBe("pass");
  });

  it("fails when a run never settled", () => {
    expect(failed(artifacts({ runs: [{ id: "run-1", status: "running", errorCode: null }] }))).toEqual(["handoff_did_not_cancel_run"]);
  });

  it("expects the task to rest in review, and runs only when asked for", () => {
    expect(expectedFinalStatus({ plan: { workload: "H2", nonce: NONCE } } as TaskRecord)).toBe("in_review");
    const defaults = parseCommand([]);
    expect(defaults.mode === "wave" && defaults.options.workloads).not.toContain("H2");
    const chosen = parseCommand(["--workloads", "H2", "--adapters", "claude"]);
    expect(chosen.mode === "wave" && chosen.options.workloads).toEqual(["H2"]);
  });
});
