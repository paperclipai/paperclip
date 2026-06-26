import { describe, expect, it } from "vitest";
import {
  buildClaudeLocalRunAsInvocation,
  readClaudeLocalRunAsWorkspaceDir,
  resolveClaudeLocalRunAsWorkspaceDir,
} from "./run-as.js";

describe("buildClaudeLocalRunAsInvocation", () => {
  it("wraps local Claude invocations with sudo for a configured non-root user", () => {
    expect(buildClaudeLocalRunAsInvocation({
      command: "claude",
      args: ["--print", "-", "--dangerously-skip-permissions"],
      config: { localRunAsUser: "claude-worker" },
      targetIsRemote: false,
    })).toEqual({
      command: "sudo",
      args: [
        "-E",
        "-H",
        "-u",
        "claude-worker",
        "--",
        "claude",
        "--print",
        "-",
        "--dangerously-skip-permissions",
      ],
      runAsUser: "claude-worker",
      commandLabel: "sudo -E -H -u claude-worker -- claude",
    });
  });

  it("does not wrap remote executions because the remote target already supplies identity", () => {
    expect(buildClaudeLocalRunAsInvocation({
      command: "claude",
      args: ["--print"],
      config: { localRunAsUser: "claude-worker" },
      targetIsRemote: true,
    })).toEqual({
      command: "claude",
      args: ["--print"],
      runAsUser: null,
      commandLabel: "claude",
    });
  });

  it("rejects shell fragments in the configured user", () => {
    expect(() => buildClaudeLocalRunAsInvocation({
      command: "claude",
      args: [],
      config: { localRunAsUser: "worker; id" },
      targetIsRemote: false,
    })).toThrow(/localRunAsUser/);
  });
});

describe("resolveClaudeLocalRunAsWorkspaceDir", () => {
  it("defaults to <home>/paperclip-workspace when unconfigured", () => {
    expect(resolveClaudeLocalRunAsWorkspaceDir({
      config: {},
      runAsUser: "claude-worker",
      homeDir: "/home/claude-worker",
    })).toEqual({ dir: "/home/claude-worker/paperclip-workspace", error: null });
  });

  it("uses an explicit localRunAsWorkspaceDir when provided", () => {
    expect(resolveClaudeLocalRunAsWorkspaceDir({
      config: { localRunAsWorkspaceDir: "/srv/claude/work" },
      runAsUser: "claude-worker",
      homeDir: "/home/claude-worker",
    })).toEqual({ dir: "/srv/claude/work", error: null });
  });

  it("refuses root-owned paths to preserve source safety", () => {
    const result = resolveClaudeLocalRunAsWorkspaceDir({
      config: { localRunAsWorkspaceDir: "/root/paperclip" },
      runAsUser: "claude-worker",
      homeDir: "/home/claude-worker",
    });
    expect(result.dir).toBe("/root/paperclip");
    expect(result.error).toMatch(/root-owned/);
  });

  it("rejects relative workspace dirs", () => {
    const result = resolveClaudeLocalRunAsWorkspaceDir({
      config: { localRunAsWorkspaceDir: "relative/dir" },
      runAsUser: "claude-worker",
      homeDir: "/home/claude-worker",
    });
    expect(result.error).toMatch(/absolute/);
  });

  it("errors when neither config nor home directory is known", () => {
    const result = resolveClaudeLocalRunAsWorkspaceDir({
      config: {},
      runAsUser: "claude-worker",
      homeDir: "",
    });
    expect(result.error).toMatch(/Could not resolve/);
  });
});

describe("readClaudeLocalRunAsWorkspaceDir", () => {
  it("reads and trims the configured dir", () => {
    expect(readClaudeLocalRunAsWorkspaceDir({ localRunAsWorkspaceDir: "  /home/x/ws  " })).toBe("/home/x/ws");
  });

  it("returns null when unset", () => {
    expect(readClaudeLocalRunAsWorkspaceDir({})).toBeNull();
  });
});
