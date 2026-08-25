import { describe, expect, it } from "vitest";
import { buildClaudeExecutionPermissionArgs, buildClaudeProbePermissionArgs } from "./permissions.js";

const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

describe("claude-local remote permission args", () => {
  it("uses the canonical Bash tool grant for remote execution", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("uses the canonical Bash tool grant for remote probes", () => {
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("does not use Bash(*) because Claude Code treats Bash grants as command-prefix patterns", () => {
    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
    });

    expect(allowedTools.split(" ")).toContain("Bash");
    expect(allowedTools).not.toContain("Bash(*)");
  });

  it("uses a restricted deny-by-default tool manifest for blind_judge", () => {
    const args = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: false,
      targetIsRemote: true,
      runtimeToolPolicy: {
        profile: "blind_judge",
        enforcement: "required",
        allow: [],
        deny: ["network.outbound", "mcp.server:*", "connector:*", "plugin:*"],
        restricted: true,
        source: "agent_runtime_config",
        unsupported: [],
        paperclipReadIssueIds: [],
      },
    });
    const tools = args[args.indexOf("--tools") + 1] ?? "";
    const allowedTools = args[args.indexOf("--allowedTools") + 1] ?? "";
    const disallowedTools = args[args.indexOf("--disallowedTools") + 1] ?? "";

    expect(args).toEqual(expect.arrayContaining([
      "--setting-sources",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--tools",
      "--allowedTools",
      "--disallowedTools",
      "--permission-mode",
      "dontAsk",
    ]));
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(tools).toBe("Edit Glob Grep Read TodoWrite Write");
    expect(allowedTools).toBe(tools);
    expect(allowedTools.split(" ")).not.toContain("Bash");
    expect(allowedTools.split(" ")).not.toContain("ToolSearch");
    expect(allowedTools.split(" ")).not.toContain("Skill");
    expect(allowedTools.split(" ")).not.toContain("Task");
    expect(allowedTools.split(" ")).not.toContain("PushNotification");
    expect(allowedTools.split(" ")).not.toContain("RemoteTrigger");
    expect(disallowedTools.split(" ")).toEqual(expect.arrayContaining([
      "Agent",
      "AskUserQuestion",
      "Bash",
      "Skill",
      "Task",
      "ToolSearch",
      "WebFetch",
      "WebSearch",
    ]));
  });

  it("exposes only scoped Paperclip tools for local best-effort blind_judge runs", () => {
    const args = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: false,
      runtimeToolPolicy: {
        profile: "blind_judge",
        enforcement: "best_effort",
        allow: [],
        deny: ["network.outbound", "mcp.server:*", "connector:*", "plugin:*"],
        restricted: true,
        source: "agent_runtime_config",
        unsupported: [],
        paperclipReadIssueIds: ["RES-3"],
      },
    });
    const allowedTools = args[args.indexOf("--allowedTools") + 1] ?? "";
    const mcpConfig = JSON.parse(args[args.indexOf("--mcp-config") + 1] ?? "{}") as {
      mcpServers?: { paperclip?: { command?: string; args?: string[]; env?: Record<string, string> } };
    };

    expect(allowedTools.split(" ")).toEqual(expect.arrayContaining([
      "Read",
      "mcp__paperclip__paperclipGetDocument",
      "mcp__paperclip__paperclipListDocumentRevisions",
      "mcp__paperclip__paperclipComputeSha256",
      "mcp__paperclip__paperclipAddCurrentTaskComment",
      "mcp__paperclip__paperclipSetCurrentTaskVerdict",
    ]));
    expect(allowedTools).not.toContain("paperclipApiRequest");
    expect(mcpConfig.mcpServers?.paperclip?.command).toBe(process.execPath);
    expect(mcpConfig.mcpServers?.paperclip?.args?.[0]).toContain("mcp-server/dist/blind-judge-stdio.js");
    expect(mcpConfig.mcpServers?.paperclip?.env).toMatchObject({
      PAPERCLIP_MCP_TOOL_PROFILE: "blind_judge",
      PAPERCLIP_MCP_ALLOWED_READ_ISSUE_IDS: "RES-3",
    });
  });

  it("does not pass permission flags when skip-permissions is disabled", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
  });

  it("uses dangerously-skip-permissions for non-root local execution", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("uses dangerously-skip-permissions for non-root local probes", () => {
    expect(
      buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("uses allowedTools for local root execution because Claude refuses dangerously-skip-permissions as root", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 0,
      }),
    ).toEqual(["--allowedTools", SANDBOX_ALLOWED_TOOLS]);
  });

  it("uses allowedTools for local root probes because Claude refuses dangerously-skip-permissions as root", () => {
    expect(
      buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 0,
      }),
    ).toEqual(["--allowedTools", SANDBOX_ALLOWED_TOOLS]);
  });
});
