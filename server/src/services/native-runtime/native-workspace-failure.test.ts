import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyNativeWorkspaceFailure,
  isWorkspaceGitOperationInProgress,
  workspaceSaveRestCause,
} from "./native-workspace-failure.js";
import { remoteWorkspaceCaptureFailureMessage } from "../remote-workspace-snapshot-archive.js";
import {
  REMOTE_WORKSPACE_SANDBOX_DISK_FULL,
  remoteWorkspaceFailureCause,
} from "../remote-workspace-transport.js";
import {
  createSystemRecovery,
  exhaustedSystemRecoveryAction,
  failSystemRecovery,
  reserveSystemRecoveryAttempt,
  savedFilesUnrecoverable,
  SystemRecoveryFailure,
} from "../system-recovery-state.js";

describe("native workspace failure classification and save-rest policy", () => {
  it("recognizes the exact producer output for an in-progress Git operation through redaction", () => {
    const producerMessage = remoteWorkspaceCaptureFailureMessage({
      message: "remote_workspace_archive_git_operation_in_progress: finish or abort the Git operation before saving the workspace",
    });
    expect(producerMessage).not.toBeNull();
    const redactedCause = remoteWorkspaceFailureCause(new Error(producerMessage!));
    expect(redactedCause).toBe(producerMessage);
    expect(isWorkspaceGitOperationInProgress(new Error(producerMessage!))).toBe(true);
    expect(isWorkspaceGitOperationInProgress(redactedCause)).toBe(true);
    expect(workspaceSaveRestCause(new Error(producerMessage!))).toBe("git_operation_in_progress");
    expect(workspaceSaveRestCause(redactedCause)).toBe("git_operation_in_progress");
    expect(classifyNativeWorkspaceFailure(new Error(producerMessage!))).toEqual({
      code: "workspace_sync_out_failed",
      failureCode: "native_workspace_sync_out_failed",
      permanent: false,
    });
  });

  it("recognizes sandbox disk full and keeps transient or unrelated errors retryable", () => {
    const diskFullCause = remoteWorkspaceFailureCause(new Error(REMOTE_WORKSPACE_SANDBOX_DISK_FULL));
    expect(workspaceSaveRestCause(diskFullCause)).toBe("sandbox_disk_full");
    expect(workspaceSaveRestCause(new Error(REMOTE_WORKSPACE_SANDBOX_DISK_FULL))).toBe("sandbox_disk_full");

    for (const transient of [
      "remote_workspace_archive_changed",
      "remote_workspace_capture_failed: stage=archive code=ECONNRESET",
      "Daytona syncOut directory download failed: timeout",
    ]) {
      expect(isWorkspaceGitOperationInProgress(transient)).toBe(false);
      expect(workspaceSaveRestCause(transient)).toBeNull();
      expect(workspaceSaveRestCause(new Error(transient))).toBeNull();
    }

    expect(classifyNativeWorkspaceFailure(new Error("daytona_sandbox_not_found"))).toEqual({
      code: "workspace_sync_out_unrecoverable",
      failureCode: "native_workspace_sync_out_unrecoverable",
      permanent: true,
    });
  });

  it("renders plain-language recovery copy for an in-progress Git operation rest", () => {
    const gitOp = failSystemRecovery(
      reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), 0)!,
      new SystemRecoveryFailure("export_interrupted", "user_action_required"),
      { now: 0, cause: { label: "git_operation_in_progress", code: null, status: null } },
    );
    expect(gitOp).toMatchObject({ state: "exhausted", attempts: 1, retriesUsed: 0, nextAttemptAt: null });
    expect(savedFilesUnrecoverable(gitOp)).toBe(false);
    const text = exhaustedSystemRecoveryAction(gitOp);
    expect(text).toMatch(/Git operation/i);
    expect(text).toContain("Retry");
    expect(text).not.toContain("git_operation_in_progress");
    expect(text).not.toMatch(/administrator|\bowner\b|board member|inspect the run|environment/i);
  });
});
