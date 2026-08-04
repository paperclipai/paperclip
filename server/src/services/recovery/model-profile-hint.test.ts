import { describe, expect, it } from "vitest";
import {
  recoveryAssigneeAdapterOverrides,
  recoveryModelProfileWorkClass,
  scrubRecoveryModelProfileHints,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";

describe("recovery model profile policy", () => {
  it("allows cheap only for status-only recovery and adds guard context", () => {
    expect(withRecoveryModelProfileHint({ issueId: "issue-1" }, "status_only")).toEqual({
      issueId: "issue-1",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
      modelProfile: "cheap",
    });
    expect(recoveryAssigneeAdapterOverrides("status_only")).toEqual({ modelProfile: "cheap" });
  });

  it("keeps critical recovery on the primary model lane", () => {
    const workClass = recoveryModelProfileWorkClass({ critical: true });

    expect(workClass).toBe("normal_model");
    expect(recoveryAssigneeAdapterOverrides(workClass)).toBeNull();
    expect(withRecoveryModelProfileHint({
      issueId: "critical-recovery",
      modelProfile: "cheap",
    }, workClass)).toEqual({ issueId: "critical-recovery" });
  });

  it("scrubs inherited cheap hints from normal model source-work retries", () => {
    expect(withRecoveryModelProfileHint({
      issueId: "issue-1",
      retryOfRunId: "run-1",
      modelProfile: "cheap",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    }, "normal_model")).toEqual({
      issueId: "issue-1",
      retryOfRunId: "run-1",
    });
  });

  it("can scrub copied downstream source-work contexts without applying a profile", () => {
    expect(scrubRecoveryModelProfileHints({
      taskId: "source-task",
      modelProfile: "cheap",
      paperclipModelProfile: { requested: "cheap" },
      allowDocumentUpdates: false,
    })).toEqual({ taskId: "source-task" });
  });
});
