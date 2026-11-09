import { describe, expect, it } from "vitest";
import { withRecoveryContext } from "./status-only-context.js";

describe("withRecoveryContext", () => {
  it("applies status-only mutation guards without selecting a model", () => {
    expect(withRecoveryContext({ issueId: "issue-1" }, "status_only")).toEqual({
      issueId: "issue-1",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    });
  });

  it("removes legacy model hints from all recovery work", () => {
    expect(withRecoveryContext({
      issueId: "issue-1",
      modelProfile: "cheap",
      paperclipModelProfile: { requested: "cheap" },
    }, "normal_model")).toEqual({
      issueId: "issue-1",
    });
  });
});
