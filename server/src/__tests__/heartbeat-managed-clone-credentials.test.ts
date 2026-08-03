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

  it("names the company-secret credential when an authenticated clone fails", async () => {
    const missingRepo = path.join(os.tmpdir(), "paperclip-definitely-missing", "repo.git");
    const resolveGitAuth = vi.fn(async () => ({
      // Empty configArgs keep this offline: the failure comes from the missing local path,
      // the message must still attribute the credential that was in play.
      configArgs: [],
      env: { [GIT_CREDENTIAL_TOKEN_ENV_KEY]: "token", GIT_TERMINAL_PROMPT: "0" },
      source: "company_secret" as const,
      secretName: "GH_TOKEN",
    }));
    await expect(ensureManagedProjectWorkspace({
      companyId: "company-authfail",
      projectId: "project-1",
      repoUrl: missingRepo,
      resolveGitAuth,
    })).rejects.toThrow(/the GH_TOKEN company-secret GitHub credential/);
  });

  it("does not mention credentials when an unauthenticated clone fails for non-auth reasons", async () => {
    // The Settings → Secrets hint is reserved for auth-shaped failures (covered in
    // git-credentials.test.ts); a plain missing-repo failure must not suggest credentials.
    const missingRepo = path.join(os.tmpdir(), "paperclip-definitely-missing", "repo.git");
    const error = await ensureManagedProjectWorkspace({
      companyId: "company-noauthfail",
      projectId: "project-1",
      repoUrl: missingRepo,
    }).then(
      () => { throw new Error("expected the clone to fail"); },
      (err: unknown) => err as Error,
    );
    expect(error.message).toContain("Failed to prepare managed checkout");
    expect(error.message).not.toContain("company secret");
  });

  it("removes the partially created directory when the clone fails", async () => {
    const missingRepo = path.join(os.tmpdir(), "paperclip-definitely-missing", "repo.git");
    const companyId = "company-cleanup";
    const projectId = "project-1";
    await expect(ensureManagedProjectWorkspace({
      companyId,
      projectId,
      repoUrl: missingRepo,
    })).rejects.toThrow();
    // Filesystem-path repo "URLs" derive no repo name, so the managed dir is the _default slot.
    const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    await expect(fs.stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps using a pre-existing non-git directory as-is without attempting a clone", async () => {
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
      expect(result.warning).toContain("Using it as-is");
      await expect(fs.readFile(path.join(cwd, "keep.txt"), "utf8")).resolves.toBe("operator data\n");
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
