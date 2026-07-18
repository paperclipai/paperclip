import { describe, expect, it } from "vitest";
import { resolveIssueChatThreadPreset } from "./chat-thread-presets";

describe("resolveIssueChatThreadPreset", () => {
  it("treats an omitted preset exactly like the task preset", () => {
    expect(resolveIssueChatThreadPreset()).toEqual(resolveIssueChatThreadPreset("task"));
  });

  it("defaults to the current task thread behavior", () => {
    expect(resolveIssueChatThreadPreset()).toMatchObject({
      preset: "task",
      density: "comfortable",
      workingIndicator: "expanded",
      variant: "full",
      showComposer: true,
      showJumpToLatest: true,
      suppressIssueStatusNotices: false,
      enableReassign: false,
      showBackgroundWorkChildren: true,
      composerSubmitKey: "mod-enter",
      composerSingleLine: false,
    });
  });

  it("keeps task defaults variant-aware", () => {
    expect(resolveIssueChatThreadPreset("task", { variant: "embedded" })).toMatchObject({
      variant: "embedded",
      showJumpToLatest: false,
      emptyMessage: "No run output yet.",
    });
  });

  it("maps the assistant preset to the lightweight chat defaults", () => {
    expect(resolveIssueChatThreadPreset("assistant")).toMatchObject({
      preset: "assistant",
      // Comfortable = issue-chat message rendering (own messages right/blue).
      density: "comfortable",
      workingIndicator: "collapsed",
      variant: "full",
      showComposer: true,
      showJumpToLatest: false,
      suppressIssueStatusNotices: true,
      enableReassign: false,
      showBackgroundWorkChildren: false,
      composerSubmitKey: "mod-enter",
      composerSingleLine: false,
    });
  });

  it("lets explicit props override preset defaults", () => {
    expect(resolveIssueChatThreadPreset("assistant", {
      showJumpToLatest: true,
      suppressIssueStatusNotices: false,
      showBackgroundWorkChildren: true,
      showComposer: false,
      enableReassign: true,
      emptyMessage: "Custom empty state",
    })).toMatchObject({
      showJumpToLatest: true,
      suppressIssueStatusNotices: false,
      showBackgroundWorkChildren: true,
      showComposer: false,
      enableReassign: true,
      emptyMessage: "Custom empty state",
    });
  });
});
