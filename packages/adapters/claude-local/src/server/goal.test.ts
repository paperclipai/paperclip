import { describe, expect, it } from "vitest";
import {
  CLAUDE_GOAL_OBJECTIVE_MAX_CHARS,
  listClaudeChatCommands,
  parseClaudeGoalChatCommand,
  parseClaudeGoalCliReply,
  readClaudeGoalConfig,
} from "./goal.js";

describe("readClaudeGoalConfig", () => {
  it("defaults to disabled", () => {
    expect(readClaudeGoalConfig({})).toEqual({ enabled: false });
    expect(readClaudeGoalConfig({ goal: {} })).toEqual({ enabled: false });
    expect(readClaudeGoalConfig({ goal: { enabled: "yes" } })).toEqual({ enabled: false });
  });

  it("reads goal.enabled", () => {
    expect(readClaudeGoalConfig({ goal: { enabled: true } })).toEqual({ enabled: true });
  });
});

describe("listClaudeChatCommands", () => {
  it("returns nothing when the goal command is not enabled", () => {
    expect(listClaudeChatCommands({ adapterConfig: {} })).toEqual([]);
    expect(listClaudeChatCommands({ adapterConfig: { goal: { enabled: false } } })).toEqual([]);
  });

  it("advertises /goal when enabled", () => {
    const commands = listClaudeChatCommands({ adapterConfig: { goal: { enabled: true } } });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: "goal" });
    expect(commands[0]!.argHint).toContain("status");
  });
});

describe("parseClaudeGoalChatCommand", () => {
  it("requires an objective", () => {
    const parsed = parseClaudeGoalChatCommand("   ");
    expect(parsed.error).toContain("`/goal`");
    expect(parsed.objective).toBeNull();
  });

  it("parses status", () => {
    expect(parseClaudeGoalChatCommand(" STATUS ")).toEqual({ action: "status", objective: null, error: null });
  });

  it("maps every Claude clear synonym to clear so the reported action matches the CLI behavior", () => {
    for (const keyword of ["clear", "stop", "off", "reset", "none", "cancel", "Clear", "STOP"]) {
      expect(parseClaudeGoalChatCommand(keyword)).toEqual({ action: "clear", objective: null, error: null });
    }
  });

  it("treats everything else as a set objective", () => {
    expect(parseClaudeGoalChatCommand("all unit tests pass")).toEqual({
      action: "set",
      objective: "all unit tests pass",
      error: null,
    });
  });

  it("rejects objectives over the Claude Code length cap", () => {
    const parsed = parseClaudeGoalChatCommand("x".repeat(CLAUDE_GOAL_OBJECTIVE_MAX_CHARS + 1));
    expect(parsed.action).toBe("set");
    expect(parsed.objective).toBeNull();
    expect(parsed.error).toContain(String(CLAUDE_GOAL_OBJECTIVE_MAX_CHARS));
  });
});

describe("parseClaudeGoalCliReply", () => {
  it("parses the no-goal reply, with and without the usage suffix", () => {
    expect(parseClaudeGoalCliReply("No goal set")).toEqual({ kind: "none" });
    expect(parseClaudeGoalCliReply("No goal set. Usage: `/goal <condition>`")).toEqual({ kind: "none" });
  });

  it("parses active goals with an evaluation suffix", () => {
    expect(
      parseClaudeGoalCliReply("Goal active: a file named marker2.txt exists containing the word hello (not yet evaluated)"),
    ).toEqual({
      kind: "active",
      objective: "a file named marker2.txt exists containing the word hello",
      evaluation: "not yet evaluated",
    });
  });

  it("keeps parenthesized conditions intact when no evaluation suffix is present", () => {
    expect(parseClaudeGoalCliReply("Goal active: build passes")).toEqual({
      kind: "active",
      objective: "build passes",
      evaluation: null,
    });
  });

  it("parses cleared and set replies", () => {
    expect(parseClaudeGoalCliReply("Goal cleared: all tests pass")).toEqual({
      kind: "cleared",
      objective: "all tests pass",
    });
    expect(parseClaudeGoalCliReply("Goal set: all tests pass")).toEqual({
      kind: "set",
      objective: "all tests pass",
    });
  });

  it("parses CLI rejections", () => {
    expect(parseClaudeGoalCliReply("Goal condition is limited to 4000 characters (got 4200)")).toMatchObject({
      kind: "rejected",
    });
    expect(
      parseClaudeGoalCliReply("/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again."),
    ).toMatchObject({ kind: "rejected" });
    expect(
      parseClaudeGoalCliReply(
        "/goal can't run while hooks are disabled (disableAllHooks or allowManagedHooksOnly is set in settings or by policy).",
      ),
    ).toMatchObject({ kind: "rejected" });
  });

  it("returns null for text outside the goal reply grammar", () => {
    expect(parseClaudeGoalCliReply("")).toBeNull();
    expect(parseClaudeGoalCliReply("I created marker.txt with the word done.")).toBeNull();
    expect(parseClaudeGoalCliReply("Sure — what goal would you like to set?")).toBeNull();
  });
});
