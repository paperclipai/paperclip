import { describe, expect, it } from "vitest";
import { buildClaudeExecutionPermissionArgs, isElevatedExecution } from "./permissions.js";

describe("claude sdk server permission args", () => {
  it("uses dangerous skip permissions for non-elevated execution", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        elevatedExecution: false,
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("falls back to an allowed tools list for elevated execution", () => {
    const args = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      elevatedExecution: true,
    });
    expect(args[0]).toBe("--allowedTools");
    expect(args[1]).toContain("Bash(*)");
    expect(args[1]).toContain("Read");
  });

  it("detects sudo-style elevated environments", () => {
    expect(isElevatedExecution({ SUDO_USER: "root" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isElevatedExecution({ SUDO_UID: "0" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isElevatedExecution({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
