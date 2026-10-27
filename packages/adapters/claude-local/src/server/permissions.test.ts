import { describe, expect, it } from "vitest";
import { buildClaudeExecutionPermissionArgs, buildClaudeProbePermissionArgs, claudeSandboxPermissionEnv } from "./permissions.js";

describe("Claude full-auto permission args", () => {
  for (const [name, build] of [["execution", buildClaudeExecutionPermissionArgs], ["probe", buildClaudeProbePermissionArgs]] as const) {
    it.each([
      { targetIsRemote: false, localProcessUid: 1000 },
      { targetIsRemote: true, localProcessUid: 1000 },
      { targetIsRemote: false, localProcessUid: 0 },
      { targetIsRemote: true, localProcessUid: 0 },
    ])(`${name} requests full bypass for %j`, (target) => {
      expect(build({ ...target, dangerouslySkipPermissions: true }))
        .toEqual(["--dangerously-skip-permissions"]);
      expect(build({ ...target, dangerouslySkipPermissions: false })).toEqual([]);
    });
  }

  it("identifies managed sandboxes for Claude's root launch check only when full auto is enabled", () => {
    expect(claudeSandboxPermissionEnv({ dangerouslySkipPermissions: true, targetIsSandbox: true })).toEqual({ IS_SANDBOX: "1" });
    expect(claudeSandboxPermissionEnv({ dangerouslySkipPermissions: false, targetIsSandbox: true })).toEqual({});
    expect(claudeSandboxPermissionEnv({ dangerouslySkipPermissions: true, targetIsSandbox: false })).toEqual({});
  });
});
