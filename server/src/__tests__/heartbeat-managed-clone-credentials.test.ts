import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureManagedProjectWorkspace, prepareProjectRepositoryWorkspaces } from "../services/heartbeat.ts";
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
  it("materializes every repository-only project row inside the task workspace and reuses local edits", async () => {
    const first = await createLocalSourceRepo();
    const second = await createLocalSourceRepo();
    try {
      const anchor = await ensureManagedProjectWorkspace({ companyId: "repo-only", projectId: "two", repoUrl: first });
      await execFile("git", ["checkout", "-b", "project-branch"], { cwd: second });
      const resolveGitAuth = vi.fn(async () => null);
      const input = {
        cwd: anchor.cwd, anchorRepoUrl: first, resolveGitAuth,
        workspaces: [
          { id: "first", repoUrl: first, repoRef: null },
          { id: "duplicate-first", repoUrl: first, repoRef: null },
          { id: "second", repoUrl: second, repoRef: "project-branch" },
        ],
      };
      const additional = await prepareProjectRepositoryWorkspaces(input);
      expect(additional).toHaveLength(1);
      expect(additional[0]!.workspaceId).toBe("second");
      expect(path.relative(anchor.cwd, additional[0]!.cwd)).toMatch(/^\.paperclip-repositories\//);
      expect((await execFile("git", ["branch", "--show-current"], { cwd: additional[0]!.cwd })).stdout.trim()).toBe("project-branch");
      expect(resolveGitAuth).toHaveBeenCalledWith(second);
      await fs.writeFile(path.join(additional[0]!.cwd, "README.md"), "work in progress");
      expect(await prepareProjectRepositoryWorkspaces(input)).toEqual(additional);
      expect(await fs.readFile(path.join(additional[0]!.cwd, "README.md"), "utf8")).toBe("work in progress");
      expect((await execFile("git", ["status", "--porcelain"], { cwd: anchor.cwd })).stdout).toBe("");
    } finally {
      await Promise.all([first, second].map((cwd) => fs.rm(cwd, { recursive: true, force: true })));
    }
  });

  it("fails task preparation when any attached repository cannot be cloned", async () => {
    const first = await createLocalSourceRepo();
    try {
      const anchor = await ensureManagedProjectWorkspace({ companyId: "repo-failure", projectId: "two", repoUrl: first });
      await expect(prepareProjectRepositoryWorkspaces({
        cwd: anchor.cwd, anchorRepoUrl: first,
        workspaces: [{ id: "missing", repoUrl: path.join(first, "missing.git"), repoRef: null }],
      })).rejects.toThrow("Failed to prepare managed checkout");
    } finally {
      await fs.rm(first, { recursive: true, force: true });
    }
  });

  it("seeds a configured second local checkout with its uncommitted work and ignores", async () => {
    const first = await createLocalSourceRepo();
    const second = await createLocalSourceRepo();
    try {
      const anchor = await ensureManagedProjectWorkspace({ companyId: "local-project", projectId: "two", repoUrl: first });
      await fs.writeFile(path.join(second, "README.md"), "local changes");
      await fs.writeFile(path.join(second, ".gitignore"), "secret.txt\n");
      await fs.writeFile(path.join(second, "secret.txt"), "private");
      const [repo] = await prepareProjectRepositoryWorkspaces({
        cwd: anchor.cwd, anchorRepoUrl: first,
        workspaces: [{ id: "second", cwd: second, repoUrl: "https://github.com/example/backend.git", repoRef: null }],
      });
      expect(await fs.readFile(path.join(repo!.cwd, "README.md"), "utf8")).toBe("local changes");
      await expect(fs.stat(path.join(repo!.cwd, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await execFile("git", ["remote", "get-url", "origin"], { cwd: repo!.cwd })).stdout.trim()).toBe("https://github.com/example/backend.git");
    } finally {
      await Promise.all([first, second].map((cwd) => fs.rm(cwd, { recursive: true, force: true })));
    }
  });
  it("keeps different repositories with the same name separate within one project", async () => {
    const first = await createLocalSourceRepo();
    const second = await createLocalSourceRepo();
    try {
      const results = await Promise.all([first, second].map((repoUrl) => ensureManagedProjectWorkspace({
        companyId: "company-multiple", projectId: "project-multiple", repoUrl,
      })));
      expect(results[0]!.cwd).not.toBe(results[1]!.cwd);
      for (let i = 0; i < results.length; i++) {
        const origin = await execFile("git", ["remote", "get-url", "origin"], { cwd: results[i]!.cwd });
        expect(origin.stdout.trim()).toBe([first, second][i]);
      }
    } finally {
      await Promise.all([first, second].map((cwd) => fs.rm(cwd, { recursive: true, force: true })));
    }
  });
  it("rechecks the repository when another process wins the checkout rename", async () => {
    const first = await createLocalSourceRepo();
    const second = await createLocalSourceRepo();
    const companyId = "cross-process-race";
    const projectId = "same-name";
    const sharedCwd = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    try {
      // A different process does not share managedCheckoutMaterializations. Publish
      // its completed checkout after this caller chose its destination, before rename.
      const resolveGitAuth = vi.fn(async () => {
        if (!(await fs.stat(sharedCwd).catch(() => null))) {
          await execFile("git", ["clone", second, sharedCwd]);
        }
        return null;
      });
      const result = await ensureManagedProjectWorkspace({ companyId, projectId, repoUrl: first, resolveGitAuth });
      expect((await execFile("git", ["remote", "get-url", "origin"], { cwd: result.cwd })).stdout.trim()).toBe(first);
      expect((await execFile("git", ["remote", "get-url", "origin"], { cwd: sharedCwd })).stdout.trim()).toBe(second);
      expect(result.cwd).not.toBe(sharedCwd);
    } finally {
      await Promise.all([first, second].map((cwd) => fs.rm(cwd, { recursive: true, force: true })));
    }
  });

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

  it("does not blame the credential when an authenticated clone fails for non-auth reasons", async () => {
    // The failure here is a missing local path, not an auth rejection — the error must not
    // claim the credential "was rejected". Attribution for genuinely auth-shaped failures is
    // covered by the describeGitAuthFailure unit tests in git-credentials.test.ts.
    const missingRepo = path.join(os.tmpdir(), "paperclip-definitely-missing", "repo.git");
    const resolveGitAuth = vi.fn(async () => ({
      configArgs: [],
      env: { [GIT_CREDENTIAL_TOKEN_ENV_KEY]: "token", GIT_TERMINAL_PROMPT: "0" },
      source: "company_secret" as const,
      secretName: "GH_TOKEN",
    }));
    const error = await ensureManagedProjectWorkspace({
      companyId: "company-authfail",
      projectId: "project-1",
      repoUrl: missingRepo,
      resolveGitAuth,
    }).then(
      () => { throw new Error("expected the clone to fail"); },
      (err: unknown) => err as Error,
    );
    expect(error.message).toContain("Failed to prepare managed checkout");
    expect(error.message).not.toContain("GH_TOKEN company-secret GitHub credential");
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

  it("leaves neither the target nor temp directories behind when the clone fails", async () => {
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
    const siblings = await fs.readdir(path.dirname(cwd));
    expect(siblings.filter((name) => name.includes(".clone-"))).toEqual([]);
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
