import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureManagedProjectWorkspace } from "../services/heartbeat.ts";
import { buildGitAuthInvocation, GIT_CREDENTIAL_TOKEN_ENV_KEY } from "../services/git-credentials.ts";
import { sanitizeRuntimeServiceBaseEnv } from "../services/workspace-runtime.ts";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.ts";

const execFile = promisify(execFileCallback);

let tempHome: string;
let originalHome: string | undefined;

beforeAll(async () => {
  originalHome = process.env.PAPERCLIP_HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-clone-"));
  process.env.PAPERCLIP_HOME = tempHome;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalHome;
  await fs.rm(tempHome, { recursive: true, force: true });
});

async function createLocalSourceRepo() {
  const sourceRepo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-clone-source-"));
  await execFile("git", ["init"], { cwd: sourceRepo });
  await execFile("git", ["config", "user.email", "paperclip@example.com"], { cwd: sourceRepo });
  await execFile("git", ["config", "user.name", "Paperclip Test"], { cwd: sourceRepo });
  await fs.writeFile(path.join(sourceRepo, "README.md"), "hello\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: sourceRepo });
  await execFile("git", ["commit", "-m", "init"], { cwd: sourceRepo });
  return sourceRepo;
}

describe("ensureManagedProjectWorkspace clone credentials", () => {
  it("clones exactly as before when no auth provider is configured", async () => {
    const sourceRepo = await createLocalSourceRepo();
    try {
      const result = await ensureManagedProjectWorkspace({
        companyId: "company-noauth",
        projectId: "project-1",
        repoUrl: sourceRepo,
      });
      expect(result.warning).toBeNull();
      const gitDir = await fs.stat(path.join(result.cwd, ".git"));
      expect(gitDir.isDirectory()).toBe(true);
    } finally {
      await fs.rm(sourceRepo, { recursive: true, force: true });
    }
  });

  it("consults the provider with the repo URL and clones normally when it returns null", async () => {
    const sourceRepo = await createLocalSourceRepo();
    const resolveGitAuth = vi.fn(async () => null);
    try {
      const result = await ensureManagedProjectWorkspace({
        companyId: "company-nullauth",
        projectId: "project-1",
        repoUrl: sourceRepo,
        resolveGitAuth,
      });
      expect(resolveGitAuth).toHaveBeenCalledWith(sourceRepo);
      const gitDir = await fs.stat(path.join(result.cwd, ".git"));
      expect(gitDir.isDirectory()).toBe(true);
    } finally {
      await fs.rm(sourceRepo, { recursive: true, force: true });
    }
  });

  it("falls back without blaming the credential when an authenticated clone cannot access the repo", async () => {
    // A missing local path is treated as a repository-access failure. The fork deliberately
    // keeps an empty managed workspace so the run can proceed with a visible warning; it must
    // not claim that the particular company secret was rejected.
    const missingRepo = path.join(os.tmpdir(), "paperclip-definitely-missing", "repo.git");
    const resolveGitAuth = vi.fn(async () => ({
      configArgs: [],
      env: { [GIT_CREDENTIAL_TOKEN_ENV_KEY]: "token", GIT_TERMINAL_PROMPT: "0" },
      source: "company_secret" as const,
      secretName: "GH_TOKEN",
    }));
    const result = await ensureManagedProjectWorkspace({
      companyId: "company-authfail",
      projectId: "project-1",
      repoUrl: missingRepo,
      resolveGitAuth,
    });
    expect(resolveGitAuth).toHaveBeenCalledWith(missingRepo);
    expect(result.warning).toContain("Could not clone managed project workspace repo");
    expect(result.warning).toContain("could not authenticate or access the repository");
    expect(result.warning).not.toContain("GH_TOKEN company-secret GitHub credential");
    await expect(fs.readdir(result.cwd)).resolves.toEqual([]);
  });

  it("serializes concurrent materializations of the same managed checkout", async () => {
    const sourceRepo = await createLocalSourceRepo();
    try {
      const [first, second] = await Promise.all([
        ensureManagedProjectWorkspace({
          companyId: "company-concurrent",
          projectId: "project-1",
          repoUrl: sourceRepo,
        }),
        ensureManagedProjectWorkspace({
          companyId: "company-concurrent",
          projectId: "project-1",
          repoUrl: sourceRepo,
        }),
      ]);
      expect(first.cwd).toBe(second.cwd);
      expect(first.warning).toBeNull();
      expect(second.warning).toBeNull();
      const gitDir = await fs.stat(path.join(first.cwd, ".git"));
      expect(gitDir.isDirectory()).toBe(true);
      // No temp clone directories left behind next to the target.
      const siblings = await fs.readdir(path.dirname(first.cwd));
      expect(siblings.filter((name) => name.includes(".clone-"))).toEqual([]);
    } finally {
      await fs.rm(sourceRepo, { recursive: true, force: true });
    }
  });

  it("falls back without attributing an unauthenticated access failure to a company secret", async () => {
    const missingRepo = path.join(os.tmpdir(), "paperclip-definitely-missing", "repo.git");
    const result = await ensureManagedProjectWorkspace({
      companyId: "company-noauthfail",
      projectId: "project-1",
      repoUrl: missingRepo,
    });
    expect(result.warning).toContain("Could not clone managed project workspace repo");
    expect(result.warning).not.toContain("company secret");
    await expect(fs.readdir(result.cwd)).resolves.toEqual([]);
  });

  it("leaves a clean fallback workspace and no temp directories when the clone cannot access the repo", async () => {
    const missingRepo = path.join(os.tmpdir(), "paperclip-definitely-missing", "repo.git");
    const companyId = "company-cleanup";
    const projectId = "project-1";
    const result = await ensureManagedProjectWorkspace({
      companyId,
      projectId,
      repoUrl: missingRepo,
    });
    // Filesystem-path repo "URLs" derive no repo name, so the managed dir is the _default slot.
    const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    expect(result.cwd).toBe(cwd);
    expect(result.warning).toContain("Using empty project workspace");
    await expect(fs.readdir(cwd)).resolves.toEqual([]);
    const siblings = await fs.readdir(path.dirname(cwd));
    expect(siblings.filter((name) => name.includes(".clone-"))).toEqual([]);
  });

  it("repairs a pre-existing non-git managed directory without losing its contents", async () => {
    const companyId = "company-existing";
    const projectId = "project-1";
    const sourceRepo = await createLocalSourceRepo();
    try {
      const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId });
      await fs.mkdir(cwd, { recursive: true });
      await fs.writeFile(path.join(cwd, "keep.txt"), "operator data\n", "utf8");
      const result = await ensureManagedProjectWorkspace({
        companyId,
        projectId,
        repoUrl: sourceRepo,
      });
      expect(result.cwd).toBe(cwd);
      expect(result.warning).toContain("Repaired managed project workspace path");
      const gitDir = await fs.stat(path.join(cwd, ".git"));
      expect(gitDir.isDirectory()).toBe(true);
      await expect(fs.readFile(path.join(cwd, "keep.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const siblings = await fs.readdir(path.dirname(cwd));
      const preservedDirectories = siblings.filter((name) => name.startsWith(`${path.basename(cwd)}.invalid-`));
      expect(preservedDirectories).toHaveLength(1);
      await expect(fs.readFile(path.join(path.dirname(cwd), preservedDirectories[0]!, "keep.txt"), "utf8"))
        .resolves.toBe("operator data\n");
    } finally {
      await fs.rm(sourceRepo, { recursive: true, force: true });
    }
  });

  it("keeps the credential env alive through the sanitizer spread order", () => {
    // The clone env is `{ ...sanitize(process.env), GIT_TERMINAL_PROMPT, ...auth.env }`. The
    // sanitizer strips every PAPERCLIP_* key, so the token env must be spread after it.
    const invocation = buildGitAuthInvocation({
      token: "tok",
      source: "company_secret",
      secretName: "GITHUB_TOKEN",
    });
    const cloneEnv = {
      ...sanitizeRuntimeServiceBaseEnv({ ...process.env, [GIT_CREDENTIAL_TOKEN_ENV_KEY]: "stale" }),
      GIT_TERMINAL_PROMPT: "0",
      ...invocation.env,
    };
    expect(cloneEnv[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("tok");
    expect(sanitizeRuntimeServiceBaseEnv({ [GIT_CREDENTIAL_TOKEN_ENV_KEY]: "stale" })[GIT_CREDENTIAL_TOKEN_ENV_KEY])
      .toBeUndefined();
  });
});
