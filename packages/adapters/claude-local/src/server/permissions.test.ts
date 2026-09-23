import { describe, expect, it } from "vitest";
import { buildClaudeExecutionPermissionArgs, buildClaudeProbePermissionArgs } from "./permissions.js";

const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

const NON_INFRA_DENIED_TOOLS = "mcp__*__exec Bash(rm -rf *)";
const NON_INFRA_WITHOUT_SSH_DENIED_TOOLS = `${NON_INFRA_DENIED_TOOLS} Bash(ssh *)`;

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

  it("does not pass permission flags when skip-permissions is disabled", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
  });

  it("adds the deny-first tool list for a non-infra local role without an SSH mandate", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
        agentRole: "qa",
      }),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--disallowedTools",
      NON_INFRA_WITHOUT_SSH_DENIED_TOOLS,
    ]);
  });

  it("keeps SSH available to non-infra local roles with an ADR-0029 SSH mandate", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
        agentRole: "engineer",
      }),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--disallowedTools",
      NON_INFRA_DENIED_TOOLS,
    ]);
  });

  it("keeps the local infrastructure role on the existing permission path", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
        agentRole: "cto",
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("fails safe when the local role is absent or unknown", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
      }),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--disallowedTools",
      NON_INFRA_WITHOUT_SSH_DENIED_TOOLS,
    ]);
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
        agentRole: "custom-role",
      }),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--disallowedTools",
      NON_INFRA_WITHOUT_SSH_DENIED_TOOLS,
    ]);
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
