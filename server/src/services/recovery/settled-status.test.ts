import { describe, expect, it } from "vitest";
import { strandedRecoverySettledStatus } from "./service.js";

// TES-2107. A recovery that only records "this run did not finish" must leave
// the task actionable. Blocking it produced a hold with no blocker and no
// unblock descriptor, which nothing could clear and no heartbeat could see.
describe("strandedRecoverySettledStatus", () => {
  it.each([
    "stranded_assigned_issue",
    "process_lost",
    "successful_run_missing_state",
    "codex_output_inactivity_monitor",
    "native_session_interrupted",
    "native_runner_process_exited",
    "provider_transport_failed",
    "provider_frame_too_large",
  ] as const)("returns %s to todo", (cause) => {
    expect(
      strandedRecoverySettledStatus({ cause, blockerIssueIds: [], ownerCanRun: true }),
    ).toBe("todo");
  });

  it.each([
    "workspace_validation_failed",
    "configuration_incomplete",
    "provider_quota",
    "execution_review_participant_recovery",
    "deliberate_wait_without_target",
  ] as const)("holds %s at blocked", (cause) => {
    expect(
      strandedRecoverySettledStatus({ cause, blockerIssueIds: [], ownerCanRun: true }),
    ).toBe("blocked");
  });

  it("lets a first-class blocker outrank an otherwise actionable cause", () => {
    expect(
      strandedRecoverySettledStatus({
        cause: "successful_run_missing_state",
        blockerIssueIds: ["issue-1"],
        ownerCanRun: true,
      }),
    ).toBe("blocked");
  });

  // `todo` would promise a pickup nothing can deliver: a paused, terminated or
  // budget-stopped owner is the one case where the work really is held.
  it("holds an actionable cause at blocked when the owner cannot run", () => {
    expect(
      strandedRecoverySettledStatus({
        cause: "stranded_assigned_issue",
        blockerIssueIds: [],
        ownerCanRun: false,
      }),
    ).toBe("blocked");
  });
});
