import { describe, expect, it } from "vitest";
import { BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS } from "../../server/src/services/heartbeat/retries.js";
import { parseLeaseFaultControl } from "../../server/src/services/environment-lease-fault-injection.js";
import { AUTOMATIC_RETRY_BOUND, ENV_PROVIDER_FAULTS, gradeEnvProviderTask, leaseFaultControl, type EpTaskRecord } from "./env-provider-faults.js";

const base = (overrides: Partial<EpTaskRecord>): EpTaskRecord => ({
  taskId: "t01", nonce: "n", fault: "EP1", issueId: "issue", harnessError: null, runs: [], activeRecoveryActions: [],
  recoveryReads: 3, recoveryReadFailures: 0, rested: null, retryClicked: false, finalStatus: "done", briefOk: true, ...overrides,
});
const failedRun = (id: string, errorCode = "environment_provider_unavailable") => ({ id, status: "failed", errorCode });

describe("EP1 environment-provider faults", () => {
  it("tracks the server's automatic retry bound", () => {
    expect(AUTOMATIC_RETRY_BOUND).toBe(BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS);
  });

  it("writes a control the server seam accepts", () => {
    for (const fault of Object.values(ENV_PROVIDER_FAULTS)) {
      expect(parseLeaseFaultControl(leaseFaultControl(fault, "wave-1"))).toEqual({ token: "wave-1", kind: fault.shape, failures: fault.failures });
    }
  });

  it("passes a task that retried within the bound and completed by itself", () => {
    const grade = gradeEnvProviderTask(base({ runs: [failedRun("a"), failedRun("b"), { id: "c", status: "succeeded", errorCode: null }] }));
    expect(grade.pass).toBe(true);
  });

  it("fails the staging shape: a generic setup failure stranded on a board action", () => {
    const grade = gradeEnvProviderTask(base({ runs: [failedRun("a", "setup_failed")], finalStatus: "blocked", briefOk: false,
      activeRecoveryActions: [{ ownerType: "board", kind: "stranded_assigned_issue", cause: "stranded_assigned_issue" }] }));
    expect(grade.checks.filter(check => !check.pass).map(check => check.name))
      .toEqual(["bounded_retry", "no_board_recovery_action", "completes_without_user", "brief_oracle"]);
  });

  it("fails when recovery actions could not be read", () => {
    const runs = [failedRun("a"), failedRun("b"), { id: "c", status: "succeeded", errorCode: null }];
    expect(gradeEnvProviderTask(base({ runs, recoveryReadFailures: 1 })).checks.find(check => check.name === "recovery_evidence_read")?.pass).toBe(false);
    expect(gradeEnvProviderTask(base({ runs, recoveryReads: 0 })).pass).toBe(false);
  });

  it("requires a never-clearing fault to rest on Retry and finish after it", () => {
    const runs = [failedRun("a"), failedRun("b"), failedRun("c"), { id: "d", status: "succeeded", errorCode: null }];
    expect(gradeEnvProviderTask(base({ fault: "EP1N", runs, rested: { issueStatus: "blocked", canRetry: true, observedRunId: "c" },
      retryClicked: true, activeRecoveryActions: [{ ownerType: "system", kind: "stranded_assigned_issue", cause: "environment_provider_unavailable" }] })).pass)
      .toBe(true);
    expect(gradeEnvProviderTask(base({ fault: "EP1N", runs, rested: { issueStatus: "blocked", canRetry: false, observedRunId: null } })).pass)
      .toBe(false);
  });
});
