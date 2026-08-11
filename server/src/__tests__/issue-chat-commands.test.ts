import { describe, expect, it } from "vitest";
import {
  buildGoalChatCommandReplyPresentation,
  buildUnsupportedChatCommandReply,
  isHumanIssueChatCommandComment,
  parseLeadingIssueChatCommand,
} from "../services/issue-chat-commands.js";

describe("issue chat command router helpers", () => {
  it("parses only leading slash commands", () => {
    expect(parseLeadingIssueChatCommand("/goal ship the feature")).toEqual({
      name: "goal",
      args: "ship the feature",
      raw: "/goal ship the feature",
    });
    expect(parseLeadingIssueChatCommand("  /goal status\nignored")).toEqual({
      name: "goal",
      args: "status",
      raw: "/goal status",
    });
    expect(parseLeadingIssueChatCommand("please run /goal ship it")).toBeNull();
  });

  it("only treats undeleted user comments as dispatch-authorized", () => {
    expect(isHumanIssueChatCommandComment({ body: "/goal x", authorType: "user", authorUserId: "user-1" })).toBe(true);
    expect(isHumanIssueChatCommandComment({ body: "/goal x", authorType: "agent", authorUserId: null })).toBe(false);
    expect(isHumanIssueChatCommandComment({ body: "/goal x", authorType: "system", authorUserId: null })).toBe(false);
    expect(isHumanIssueChatCommandComment({ body: "/goal x", authorType: "user", authorUserId: "user-1", deletedAt: new Date() })).toBe(false);
  });

  it("builds fail-loud unsupported /goal replies without prompt passthrough summary", () => {
    const reply = buildUnsupportedChatCommandReply({
      adapterType: "codex_local",
      command: {
        name: "goal",
        raw: "/goal ship it",
        args: "ship it",
        sourceCommentId: "comment-1",
        sourceAuthorType: "user",
      },
    });

    expect(reply.message).toContain("requires a Codex agent using the app-server goal runtime");
    expect(reply.result.exitCode).toBe(0);
    expect(reply.result.summary).toBe("");
    expect(reply.result.resultJson?.chatCommand).toMatchObject({
      name: "goal",
      supported: false,
      sourceCommentId: "comment-1",
    });
  });

  it("tailors the unsupported /goal warning to the assignee's adapter", () => {
    const command = {
      name: "goal",
      raw: "/goal ship it",
      args: "ship it",
      sourceCommentId: "comment-1",
      sourceAuthorType: "user" as const,
    };
    const claude = buildUnsupportedChatCommandReply({ adapterType: "claude_local", command });
    expect(claude.message).toContain("Claude Code goal command");
    expect(claude.message).toContain("adapter settings");

    // Harnesses without any goal support get an explicit not-supported warning
    // instead of enable-it instructions they cannot follow.
    const gemini = buildUnsupportedChatCommandReply({ adapterType: "gemini_local", command });
    expect(gemini.message).toContain("`gemini_local`");
    expect(gemini.message).toContain("not supported");
    expect(gemini.result.resultJson?.chatCommand).toMatchObject({ name: "goal", supported: false });
  });
});

describe("buildGoalChatCommandReplyPresentation", () => {
  it("ignores results that are not supported goal command replies", () => {
    expect(buildGoalChatCommandReplyPresentation(null)).toBeNull();
    expect(buildGoalChatCommandReplyPresentation({ summary: "done" })).toBeNull();
    // The unsupported reply carries `supported: false` and no `action`.
    expect(
      buildGoalChatCommandReplyPresentation({ chatCommand: { name: "goal", supported: false } }),
    ).toBeNull();
    // A different command should not render as a goal card.
    expect(
      buildGoalChatCommandReplyPresentation({ chatCommand: { name: "review", action: "status" } }),
    ).toBeNull();
  });

  it("renders a success card with objective + budget for /goal set", () => {
    const built = buildGoalChatCommandReplyPresentation({
      chatCommand: { name: "goal", action: "set" },
      codexGoal: { objective: "Ship the feature", status: "active", tokenBudget: 500000, tokensUsed: 0 },
      summary: "Goal set: Ship the feature - budget 500,000 tokens",
    });
    expect(built?.presentation).toMatchObject({ kind: "system_notice", tone: "success", title: "Goal set" });
    expect(built?.metadata.sections[0]?.rows).toEqual([
      { type: "key_value", label: "Objective", value: "Ship the feature" },
      { type: "key_value", label: "Status", value: "active" },
      { type: "key_value", label: "Budget", value: "0 / 500,000 tokens" },
    ]);
  });

  it("uses a warning tone when /goal status reports a blocked goal", () => {
    const built = buildGoalChatCommandReplyPresentation({
      chatCommand: { name: "goal", action: "status" },
      codexGoal: { objective: "Ship it", status: "blocked", tokenBudget: null, tokensUsed: 1234 },
    });
    expect(built?.presentation).toMatchObject({ tone: "warning", title: "Goal status" });
    expect(built?.metadata.sections[0]?.rows).toContainEqual({
      type: "key_value",
      label: "Tokens used",
      value: "1,234",
    });
  });

  it("renders a neutral cleared card", () => {
    const built = buildGoalChatCommandReplyPresentation({
      chatCommand: { name: "goal", action: "clear" },
      codexGoal: { objective: "", status: "cleared", tokenBudget: null, tokensUsed: 0 },
    });
    expect(built?.presentation).toMatchObject({ tone: "neutral", title: "Goal cleared" });
  });

  it("renders Claude goal replies through the same card", () => {
    const built = buildGoalChatCommandReplyPresentation({
      chatCommand: { name: "goal", action: "set" },
      claudeGoal: { objective: "all tests pass", status: "complete", tokenBudget: null, tokensUsed: 812 },
      summary: "Goal met: all tests pass",
    });
    expect(built?.presentation).toMatchObject({ kind: "system_notice", tone: "success", title: "Goal set" });
    expect(built?.metadata.sections[0]?.rows).toEqual([
      { type: "key_value", label: "Objective", value: "all tests pass" },
      { type: "key_value", label: "Status", value: "complete" },
      { type: "key_value", label: "Tokens used", value: "812" },
    ]);
  });

  it("uses an info tone for an active Claude goal status", () => {
    const built = buildGoalChatCommandReplyPresentation({
      chatCommand: { name: "goal", action: "status" },
      claudeGoal: { objective: "the build is green", status: "active", tokenBudget: null, tokensUsed: 0 },
    });
    expect(built?.presentation).toMatchObject({ tone: "info", title: "Goal status" });
  });
});
