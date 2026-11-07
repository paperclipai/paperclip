import { describe, expect, it } from "vitest";
import { executionRecoverySettlementNote } from "./execution-recovery-resolution.js";

describe("executionRecoverySettlementNote", () => {
  it("names a restart-recovery hold instead of asking for a workspace repair", () => {
    const note = executionRecoverySettlementNote({ current: true, cause: "native_restart_recovery_blocked",
      workspaceRestoreFailed: true });
    expect(note).not.toContain("Workspace repair required");
    expect(note).toContain("after a server restart");
  });

  it("keeps the workspace repair note for other holds with a restore failure", () => {
    expect(executionRecoverySettlementNote({ current: true, cause: "execution_finalization_deadline_exceeded",
      workspaceRestoreFailed: true })).toContain("Workspace repair required");
    expect(executionRecoverySettlementNote({ current: true, cause: "execution_finalization_deadline_exceeded",
      workspaceRestoreFailed: false })).toContain("Automatic recovery stopped. Recorded work is preserved");
    expect(executionRecoverySettlementNote({ current: false, cause: "native_restart_recovery_blocked",
      workspaceRestoreFailed: true })).toContain("Recovery closed");
  });
});
