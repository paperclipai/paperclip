import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureManagedRepositoriesIgnored } from "../services/managed-repository-checkout.js";
import { assertGitWorktreeBaseWorkspaceReady } from "../services/heartbeat/workspaces.js";

const boundary = "fatal: not a git repository (or any parent up to mount point /mounted workspace)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).";

describe("Git mount-boundary absence classification", () => {
  it("allows managed exclusions to fall back for a complete boundary diagnostic", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-boundary-"));
    try {
      await fs.mkdir(path.join(cwd, ".git"));
      await fs.mkdir(path.join(cwd, "bin"));
      await fs.writeFile(path.join(cwd, "bin", "git"), `#!/bin/sh\nprintf '%s' '${boundary}\n' >&2\nexit 128\n`, { mode: 0o755 });
      vi.stubEnv("PATH", path.join(cwd, "bin"));
      for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) vi.stubEnv(key, "");
      await expect(ensureManagedRepositoriesIgnored(cwd, { plainTaskDirectory: true })).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { stderr: boundary, accepted: true },
    { stderr: boundary.replace("/mounted workspace", "/"), accepted: true },
    { stderr: boundary.replaceAll("\n", "\r\n"), accepted: true },
    { stderr: boundary + "\n", accepted: true },
    { stderr: boundary.replaceAll("\n", "\r\n") + "\r\n", accepted: true },
    { stderr: boundary.split("\n")[0], accepted: false },
    { stderr: boundary.split("\n")[1], accepted: false },
    { stderr: boundary + "\nfatal: I/O error\n", accepted: false },
    { stderr: boundary + "\n\n", accepted: false },
    { stderr: "prefix\n" + boundary, accepted: false },
    { stderr: boundary.replace("not set", "set"), accepted: false },
    { stderr: boundary.replace("/mounted workspace", ""), accepted: false },
    { stderr: boundary.replace("/mounted workspace", "/mounted\ninjected"), accepted: false },
    { stderr: boundary.replace("/mounted workspace", "/mounted\rinjected"), accepted: false },
    { stderr: "fatal: cannot open .git: Permission denied\n", accepted: false },
    { stderr: "fatal: detected dubious ownership in repository\n", accepted: false },
    { stderr: "fatal: bad object HEAD\n", accepted: false },
    { stderr: boundary, accepted: false, code: 1 },
    { stderr: boundary, accepted: false, override: true },
    { stderr: boundary, accepted: false, killed: true },
  ])("classifies complete absence in both callers: %j", async ({ stderr, accepted, code = 128, override = false, killed = false }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-boundary-"));
    const cwd = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    try {
      await fs.mkdir(cwd);
      await fs.mkdir(bin);
      await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\nprintf '%s' '${stderr}' >&2\n${killed ? "kill -TERM $$" : `exit ${code}`}\n`, { mode: 0o755 });
      vi.stubEnv("PATH", bin);
      for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) vi.stubEnv(key, "");
      if (override) vi.stubEnv("GIT_DIR", path.join(root, "override"));
      const input: Parameters<typeof assertGitWorktreeBaseWorkspaceReady>[0] = {
        requestedExecutionWorkspaceMode: "isolated_workspace",
        config: { workspaceStrategy: { type: "git_worktree" } },
        issue: { id: "issue-1", identifier: null, projectId: "project-1", projectWorkspaceId: "workspace-1" },
        base: { baseCwd: cwd, source: "project_primary", projectId: "project-1", workspaceId: "workspace-1", repoUrl: null, repoRef: null },
        anchor: { localPathOnlyWorkspace: true, baseCwdFallback: false, materializationFailures: [] },
      };
      const failure = await assertGitWorktreeBaseWorkspaceReady(input).catch((error) => error);
      expect(failure.code).toBe("workspace_validation_failed");
      expect(failure.resultJson.workspaceValidation.configurationReason).toBe(accepted ? "local_path_requires_git_checkout" : undefined);
      await fs.mkdir(path.join(cwd, ".git"));
      const metadataFailure = await assertGitWorktreeBaseWorkspaceReady(input).catch((error) => error);
      expect(metadataFailure.resultJson.workspaceValidation.configurationReason).toBeUndefined();
      const ignore = ensureManagedRepositoriesIgnored(cwd, { plainTaskDirectory: true });
      if (accepted) await expect(ignore).resolves.toBeUndefined();
      else await expect(ignore).rejects.toBeInstanceOf(Error);
      await expect(ensureManagedRepositoriesIgnored(cwd)).rejects.toBeInstanceOf(Error);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
