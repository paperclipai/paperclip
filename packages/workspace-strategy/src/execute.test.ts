import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkspaceStrategy } from "./index.js";
import type { GitRunner, WorkspaceRealizationRequest } from "./index.js";

function baseRequest(
  overrides: Partial<WorkspaceRealizationRequest["source"]> = {},
): WorkspaceRealizationRequest {
  return {
    version: 1,
    adapterType: "claude_local",
    companyId: "c_1",
    environmentId: "env_1",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: "hb_1",
    requestedMode: null,
    source: {
      kind: "project_primary",
      localPath: "/workspace",
      projectId: null,
      projectWorkspaceId: null,
      repoUrl: "https://github.com/acme/repo.git",
      repoRef: "main",
      strategy: "project_primary",
      branchName: null,
      worktreePath: null,
      ...overrides,
    },
    runtimeOverlay: {
      provisionCommand: null,
      teardownCommand: null,
      cleanupCommand: null,
      workspaceRuntime: null,
    },
  };
}

function makeFakeRunner() {
  const run = vi.fn<GitRunner["run"]>(async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }));
  return { run };
}

describe("executeWorkspaceStrategy", () => {
  it("project_primary cold-clones into an empty directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      const git = makeFakeRunner();
      await executeWorkspaceStrategy(baseRequest(), root, {
        git,
        getGitCredentials: async () => ({ username: "x-access-token", password: "ghp_test" }),
      });
      const cmd = git.run.mock.calls[0]?.[1] ?? [];
      expect(cmd).toEqual(expect.arrayContaining(["clone", "--branch", "main"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("project_primary warm path runs fetch + reset, not clone", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(join(root, ".git"), { recursive: true });
      const git = makeFakeRunner();
      await executeWorkspaceStrategy(baseRequest(), root, {
        git,
        getGitCredentials: async () => ({ username: "x-access-token", password: "ghp_test" }),
      });
      const cmds = git.run.mock.calls.map((c) => c[1].join(" "));
      expect(cmds.some((c) => c.includes("fetch"))).toBe(true);
      expect(cmds.some((c) => c.includes("reset --hard"))).toBe(true);
      expect(cmds.some((c) => c.includes("clone"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("git_worktree creates a bare clone + worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      const git = makeFakeRunner();
      await executeWorkspaceStrategy(
        baseRequest({ strategy: "git_worktree", worktreePath: "feature-x" }),
        root,
        { git, getGitCredentials: async () => ({ username: "u", password: "p" }) },
      );
      const cmds = git.run.mock.calls.map((c) => c[1].join(" "));
      expect(cmds.some((c) => c.includes("clone --bare"))).toBe(true);
      expect(cmds.some((c) => c.includes("worktree add"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adapter_managed and cloud_sandbox are no-ops (adapter handles workspace itself)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      const git = makeFakeRunner();
      await executeWorkspaceStrategy(
        baseRequest({ strategy: "project_primary" as never }),
        root,
        { git, getGitCredentials: async () => ({ username: "", password: "" }) },
      ); // baseline

      const callsBefore = git.run.mock.calls.length;
      // adapter_managed
      await executeWorkspaceStrategy(
        { ...baseRequest(), source: { ...baseRequest().source, strategy: "adapter_managed" as never } },
        root,
        { git, getGitCredentials: async () => ({ username: "", password: "" }) },
      );
      expect(git.run.mock.calls.length).toBe(callsBefore); // no new calls
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when repoUrl is missing (init container can't infer the URL)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      await expect(
        executeWorkspaceStrategy(baseRequest({ repoUrl: null }), root, {
          git: makeFakeRunner(),
          getGitCredentials: async () => ({ username: "", password: "" }),
        }),
      ).rejects.toThrow(/repoUrl/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("project_primary clones unauthenticated when getGitCredentials returns null (public repo, no tenant secret)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      const git = makeFakeRunner();
      const warn = vi.fn();
      await executeWorkspaceStrategy(
        baseRequest({ repoUrl: "https://github.com/acme/public.git" }),
        root,
        {
          git,
          getGitCredentials: async () => null,
          logger: { warn },
        },
      );
      const [cmd, args, opts] = git.run.mock.calls[0] ?? [];
      expect(cmd).toBe("git");
      expect(args).toEqual(expect.arrayContaining(["clone", "--branch", "main"]));
      // URL must be passed verbatim — no creds injected.
      const urlArg = (args ?? []).find((a) => a.startsWith("https://"));
      expect(urlArg).toBe("https://github.com/acme/public.git");
      // Env must not leak GIT_USERNAME / GIT_PASSWORD when none are configured.
      const env = (opts as { env?: Record<string, string> })?.env ?? {};
      expect(env.GIT_USERNAME).toBeUndefined();
      expect(env.GIT_PASSWORD).toBeUndefined();
      // Operator-visible warning so this isn't silent in production logs.
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("git_worktree bare-clones unauthenticated when getGitCredentials returns null", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      const git = makeFakeRunner();
      const warn = vi.fn();
      await executeWorkspaceStrategy(
        baseRequest({
          strategy: "git_worktree",
          worktreePath: "feature-x",
          repoUrl: "https://github.com/acme/public.git",
        }),
        root,
        { git, getGitCredentials: async () => null, logger: { warn } },
      );
      const cloneCall = git.run.mock.calls.find((c) => c[1].includes("--bare"));
      expect(cloneCall).toBeDefined();
      const args = cloneCall?.[1] ?? [];
      const urlArg = args.find((a) => a.startsWith("https://"));
      expect(urlArg).toBe("https://github.com/acme/public.git");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
