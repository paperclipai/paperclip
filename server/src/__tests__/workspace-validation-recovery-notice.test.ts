import { describe, expect, it } from "vitest";
import {
  buildWorkspaceValidationRecoveryNoticeSeed,
  workspaceValidationNextAction,
} from "../services/recovery/stranded-notice.js";

const GENERIC = "The task's workspace could not be used, so the agent did not start. Press Retry to start it again.";

describe("workspace validation recovery text", () => {
  it("explains a repository address mismatch and says Retry alone will not fix it", () => {
    const payload = { reason: "persisted_workspace_source_conflict", reasonCode: "source_repository_mismatch" };
    const text = workspaceValidationNextAction(payload);
    // Repair restores the RECORDED URL: changing the project URL to the
    // folder's origin would leave the recorded URL unmatched.
    expect(text).toContain("Set the project's repository URL back to the URL this workspace recorded");
    expect(text).toContain("make the folder's git origin (`git remote get-url origin`) equal to it");
    expect(text).toContain("save any work in this workspace first");
    expect(text).toContain("Retrying without one of these changes fails the same way");
    expect(text).not.toContain("Press Retry to start it again.");
    // The notice's next-action row must not fall back to a bare "Press Retry".
    expect(buildWorkspaceValidationRecoveryNoticeSeed(payload)).toMatchObject({
      body: text, nextAction: text, title: "Workspace validation failed", tone: "danger",
    });
  });

  it("explains any other unverifiable original repository instead of the generic text", () => {
    const text = workspaceValidationNextAction({
      reason: "persisted_workspace_source_conflict",
      reasonCode: "source_repository_unavailable",
    });
    expect(text).toContain("original repository could not be found or verified");
    expect(text).not.toBe(GENERIC);
  });

  it("keeps the existing branch and materialization messages", () => {
    expect(workspaceValidationNextAction({ reason: "git_worktree_branch_incoherence" }))
      .toBe("The task's workspace no longer matches its branch, so the agent did not start. Press Retry to start it again.");
    expect(workspaceValidationNextAction({ reason: "git_worktree_base_materialization_failed" }))
      .toContain("could not copy the project's repository");
  });

  it("falls back to the generic text when the reason is unknown or missing", () => {
    expect(workspaceValidationNextAction(null)).toBe(GENERIC);
    expect(workspaceValidationNextAction({ reason: "configured_workspace_unavailable" })).toBe(GENERIC);
    expect(buildWorkspaceValidationRecoveryNoticeSeed()).toMatchObject({ body: GENERIC, nextAction: GENERIC });
  });
});
