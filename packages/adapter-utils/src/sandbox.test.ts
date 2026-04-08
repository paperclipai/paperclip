import { describe, it, expect, beforeEach } from "vitest";
import { wrapWithSandbox, resetBwrapCache, type SandboxConfig } from "./sandbox.js";

function baseSandboxConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    enabled: true,
    instanceRoot: "/home/test/.paperclip/instances/default",
    agentWorkspace: "/home/test/.paperclip/instances/default/workspaces/agent-abc",
    cwd: "/home/test/.paperclip/instances/default/workspaces/agent-abc",
    ...overrides,
  };
}

describe("wrapWithSandbox", () => {
  beforeEach(() => {
    resetBwrapCache();
  });

  it("returns original command when sandbox is disabled", () => {
    const result = wrapWithSandbox(
      baseSandboxConfig({ enabled: false }),
      "claude",
      ["--print", "-"],
    );
    expect(result.command).toBe("claude");
    expect(result.args).toEqual(["--print", "-"]);
  });

  it("returns original command with warning when bwrap is unavailable and fallback is warn", () => {
    const warnings: string[] = [];
    const result = wrapWithSandbox(
      baseSandboxConfig({ fallback: "warn" }),
      "claude",
      ["--print", "-"],
      { onWarn: (msg) => warnings.push(msg) },
    );
    // bwrap likely not available in test environment
    if (result.command === "claude") {
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("bwrap not found");
    }
    // If bwrap IS available, it should wrap
    if (result.command === "bwrap") {
      expect(result.args).toContain("claude");
    }
  });

  it("throws when bwrap is unavailable and fallback is refuse", () => {
    // This test only makes sense if bwrap is NOT installed
    const result = (() => {
      try {
        return wrapWithSandbox(
          baseSandboxConfig({ fallback: "refuse" }),
          "claude",
          ["--print", "-"],
        );
      } catch (err) {
        return err;
      }
    })();

    if (result instanceof Error) {
      expect(result.message).toContain("bwrap is not installed");
    }
    // If bwrap IS installed, the test succeeds (no error thrown)
  });
});

describe("bwrap args structure", () => {
  // These tests verify the args array structure directly by calling wrapWithSandbox
  // when bwrap is available. If bwrap is not available, they are effectively skipped.
  // In CI, bwrap should be installed.

  beforeEach(() => {
    resetBwrapCache();
  });

  it("includes ro-bind for root filesystem", () => {
    const result = wrapWithSandbox(
      baseSandboxConfig(),
      "claude",
      ["--print"],
    );
    if (result.command !== "bwrap") return; // skip if no bwrap
    expect(result.args).toContain("--ro-bind");
    const roBindIdx = result.args.indexOf("--ro-bind");
    expect(result.args[roBindIdx + 1]).toBe("/");
    expect(result.args[roBindIdx + 2]).toBe("/");
  });

  it("hides secrets, db, and workspaces with tmpfs", () => {
    const result = wrapWithSandbox(
      baseSandboxConfig(),
      "claude",
      ["--print"],
    );
    if (result.command !== "bwrap") return;

    const tmpfsIndexes: number[] = [];
    result.args.forEach((arg, i) => {
      if (arg === "--tmpfs") tmpfsIndexes.push(i);
    });
    const tmpfsPaths = tmpfsIndexes.map((i) => result.args[i + 1]);

    expect(tmpfsPaths).toContain("/home/test/.paperclip/instances/default/secrets");
    expect(tmpfsPaths).toContain("/home/test/.paperclip/instances/default/db");
    expect(tmpfsPaths).toContain("/home/test/.paperclip/instances/default/workspaces");
    expect(tmpfsPaths).toContain("/tmp");
  });

  it("re-mounts agent workspace read-write", () => {
    const result = wrapWithSandbox(
      baseSandboxConfig(),
      "claude",
      ["--print"],
    );
    if (result.command !== "bwrap") return;

    const bindIndexes: number[] = [];
    result.args.forEach((arg, i) => {
      if (arg === "--bind") bindIndexes.push(i);
    });
    const bindPaths = bindIndexes.map((i) => result.args[i + 1]);
    expect(bindPaths).toContain(
      "/home/test/.paperclip/instances/default/workspaces/agent-abc",
    );
  });

  it("mounts separate cwd when it differs from agentWorkspace", () => {
    const result = wrapWithSandbox(
      baseSandboxConfig({
        cwd: "/home/test/.paperclip/instances/default/projects/my-project",
      }),
      "claude",
      ["--print"],
    );
    if (result.command !== "bwrap") return;

    const bindIndexes: number[] = [];
    result.args.forEach((arg, i) => {
      if (arg === "--bind") bindIndexes.push(i);
    });
    const bindPaths = bindIndexes.map((i) => result.args[i + 1]);
    expect(bindPaths).toContain(
      "/home/test/.paperclip/instances/default/projects/my-project",
    );
    expect(bindPaths).toContain(
      "/home/test/.paperclip/instances/default/workspaces/agent-abc",
    );
  });

  it("includes additional ro paths", () => {
    const result = wrapWithSandbox(
      baseSandboxConfig({
        additionalRoPaths: ["/tmp/paperclip-skills-abc123"],
      }),
      "claude",
      ["--print"],
    );
    if (result.command !== "bwrap") return;

    // Find all --ro-bind pairs
    const roPaths: string[] = [];
    result.args.forEach((arg, i) => {
      if (arg === "--ro-bind") roPaths.push(result.args[i + 1]!);
    });
    expect(roPaths).toContain("/tmp/paperclip-skills-abc123");
  });

  it("includes additional rw paths", () => {
    const result = wrapWithSandbox(
      baseSandboxConfig({
        additionalRwPaths: ["/tmp/git-worktree-xyz"],
      }),
      "claude",
      ["--print"],
    );
    if (result.command !== "bwrap") return;

    const bindPaths: string[] = [];
    result.args.forEach((arg, i) => {
      if (arg === "--bind") bindPaths.push(result.args[i + 1]!);
    });
    expect(bindPaths).toContain("/tmp/git-worktree-xyz");
  });

  it("wraps the original command after -- separator", () => {
    const result = wrapWithSandbox(
      baseSandboxConfig(),
      "claude",
      ["--print", "-"],
    );
    if (result.command !== "bwrap") return;

    const separatorIdx = result.args.indexOf("--");
    expect(separatorIdx).toBeGreaterThan(0);
    expect(result.args[separatorIdx + 1]).toBe("claude");
    expect(result.args[separatorIdx + 2]).toBe("--print");
    expect(result.args[separatorIdx + 3]).toBe("-");
  });

  it("includes PID namespace isolation and die-with-parent", () => {
    const result = wrapWithSandbox(
      baseSandboxConfig(),
      "claude",
      ["--print"],
    );
    if (result.command !== "bwrap") return;
    expect(result.args).toContain("--unshare-pid");
    expect(result.args).toContain("--die-with-parent");
  });
});
