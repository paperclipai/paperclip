import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, resources } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { githubPullRequestProvider, resourceRuntimeService, validateCredentialRepository } from "../services/resource-runtime.ts";

const execFile = promisify(execFileCallback);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function git(args: string[], cwd?: string) {
  await execFile("git", args, { cwd });
}

describeEmbeddedPostgres("resourceRuntimeService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtureRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resource-runtime-");
    db = createDb(tempDb.connectionString);
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-resource-git-"));
  }, 20_000);

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("checks out a configured ref, mounts files, and publishes edits", async () => {
    const remotePath = path.join(fixtureRoot, "remote.git");
    const seedPath = path.join(fixtureRoot, "seed");
    await git(["init", "--bare", remotePath]);
    await git(["clone", remotePath, seedPath]);
    await git(["config", "user.name", "Fixture"], seedPath);
    await git(["config", "user.email", "fixture@example.com"], seedPath);
    await fs.writeFile(path.join(seedPath, "context.md"), "before\n", "utf8");
    await fs.mkdir(path.join(seedPath, "nested"), { recursive: true });
    await fs.writeFile(path.join(seedPath, "nested", "context.md"), "nested-before\n", "utf8");
    await git(["add", "."], seedPath);
    await git(["commit", "-m", "initial"], seedPath);
    await git(["branch", "-M", "main"], seedPath);
    await git(["push", "origin", "main"], seedPath);
    const initialCommit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: seedPath })).stdout.trim();

    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Git Company",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const resourceId = randomUUID();
    await db.insert(resources).values({
      id: resourceId,
      companyId,
      key: "context",
      type: "git",
      repository: remotePath,
      sourcePath: null,
      defaultRef: "main",
      mountPath: "context",
      credentialRef: null,
      labels: {},
      status: "active",
    });

    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const prepared = await resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-resource-test",
      workspaceRoot,
      manifest: { version: 1, resources: [{ resourceId, mode: "input_output", version: "latest", output: { action: "push", targetRef: "main" } }] },
    });
    expect(prepared).not.toBeNull();
    const mountPath = prepared!.inputVersions[0]!.mountPath;
    expect(mountPath).toBe("context");
    const materializedPath = path.join(workspaceRoot, "resources", mountPath);
    expect((await fs.stat(path.join(materializedPath, ".git"))).isDirectory()).toBe(true);
    await expect(fs.access(path.join(workspaceRoot, ".resources"))).rejects.toThrow();
    expect(await fs.readFile(path.join(materializedPath, "context.md"), "utf8")).toBe("before\n");
    await fs.writeFile(path.join(materializedPath, "context.md"), "after\n", "utf8");

    const published = await prepared!.publish();
    expect(published[0]).toMatchObject({ resourceId, action: "push", status: "pushed", targetRef: "main" });
    expect(prepared!.inputVersions[0]!.published).toBe(true);

    const checkPath = path.join(fixtureRoot, "check");
    await git(["clone", "--branch", "main", remotePath, checkPath]);
    expect(await fs.readFile(path.join(checkPath, "context.md"), "utf8")).toBe("after\n");

    await git(["fetch", "origin", "main"], seedPath);
    await git(["switch", "-c", "feature", "origin/main"], seedPath);
    await fs.writeFile(path.join(seedPath, "feature.md"), "feature-only\n", "utf8");
    await git(["add", "."], seedPath);
    await git(["commit", "-m", "feature change"], seedPath);
    await git(["push", "origin", "feature"], seedPath);
    const sourceResourceId = randomUUID();
    await db.insert(resources).values({
      id: sourceResourceId,
      companyId,
      key: "nested-context",
      type: "git",
      repository: remotePath,
      sourcePath: "nested",
      defaultRef: "main",
      mountPath: "nested-context",
      credentialRef: null,
      labels: {},
      status: "active",
    });
    const mixedRefWorkspace = path.join(fixtureRoot, "mixed-ref-workspace");
    const mixedRefPrepared = await resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-mixed-ref-test",
      workspaceRoot: mixedRefWorkspace,
      manifest: { version: 1, resources: [{ resourceId, mode: "input_output", version: "branch:feature", output: { action: "push", targetRef: "main" } }] },
    });
    await fs.writeFile(path.join(mixedRefWorkspace, "resources", "context", "context.md"), "mixed-ref\n", "utf8");
    await expect(mixedRefPrepared!.publish()).resolves.toMatchObject([{ status: "pushed", targetRef: "main" }]);

    const sourcePathWorkspace = path.join(fixtureRoot, "source-path-rebase-workspace");
    const sourcePathPrepared = await resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-source-path-rebase-test",
      workspaceRoot: sourcePathWorkspace,
      manifest: { version: 1, resources: [{ resourceId: sourceResourceId, mode: "input_output", version: "branch:feature", output: { action: "push", targetRef: "main" } }] },
    });
    await fs.writeFile(path.join(sourcePathWorkspace, "resources", "nested-context", "context.md"), "nested-after-rebase\n", "utf8");
    await expect(sourcePathPrepared!.publish()).resolves.toMatchObject([{ status: "pushed", targetRef: "main" }]);
    const sourcePathCheck = path.join(fixtureRoot, "source-path-rebase-check");
    await git(["clone", "--branch", "main", remotePath, sourcePathCheck]);
    expect(await fs.readFile(path.join(sourcePathCheck, "nested", "context.md"), "utf8")).toBe("nested-after-rebase\n");

    await expect(resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-existing-pr-branch-test",
      workspaceRoot: path.join(fixtureRoot, "existing-pr-branch-workspace"),
      manifest: { version: 1, resources: [{ resourceId, mode: "input_output", output: { action: "pull_request", branch: "feature" } }] },
    })).rejects.toThrow("Git output branch already exists: feature");

    const commitWorkspace = path.join(fixtureRoot, "commit-workspace");
    const commitPrepared = await resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-commit-ref-test",
      workspaceRoot: commitWorkspace,
      manifest: { version: 1, resources: [{ resourceId, mode: "input", version: `commit:${initialCommit}` }] },
    });
    expect(commitPrepared!.inputVersions[0]!.commit).toBe(initialCommit);

    await expect(resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-short-commit-ref-test",
      workspaceRoot: path.join(fixtureRoot, "short-commit-ref-workspace"),
      manifest: { version: 1, resources: [{ resourceId, mode: "input", version: "commit:abcdefg" }] },
    })).rejects.toThrow("Git ref not found");

    await expect(resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-empty-branch-ref-test",
      workspaceRoot: path.join(fixtureRoot, "empty-branch-ref-workspace"),
      manifest: { version: 1, resources: [{ resourceId, mode: "input", version: "branch:" }] },
    })).rejects.toThrow("Git ref cannot be empty");

    const invalidBranchWorkspace = path.join(fixtureRoot, "invalid-branch-workspace");
    await expect(resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-invalid-branch-test",
      workspaceRoot: invalidBranchWorkspace,
      manifest: { version: 1, resources: [{ resourceId, mode: "input_output", output: { action: "pull_request", branch: "feat[scope" } }] },
    })).rejects.toThrow("Invalid Git output branch");

    await expect(resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-invalid-target-ref-test",
      workspaceRoot: path.join(fixtureRoot, "invalid-target-ref-workspace"),
      manifest: { version: 1, resources: [{ resourceId, mode: "input_output", output: { action: "push", targetRef: "feat[scope" } }] },
    })).rejects.toThrow("Invalid Git output branch");

    const collidingResourceId = randomUUID();
    await db.insert(resources).values({
      id: collidingResourceId,
      companyId,
      key: "CONTEXT",
      type: "git",
      repository: remotePath,
      sourcePath: null,
      defaultRef: "main",
      mountPath: "context-upper",
      credentialRef: null,
      labels: {},
      status: "active",
    });
    await expect(resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-environment-collision-test",
      workspaceRoot: path.join(fixtureRoot, "environment-collision-workspace"),
      manifest: { version: 1, resources: [
        { resourceId, mode: "input" },
        { resourceId: collidingResourceId, mode: "input" },
      ] },
    })).rejects.toThrow("Resource environment key is used more than once");

    const noChangeWorkspace = path.join(fixtureRoot, "no-change-workspace");
    const noChangePrepared = await resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-no-change-test",
      workspaceRoot: noChangeWorkspace,
      manifest: { version: 1, resources: [{ resourceId, mode: "input_output", output: { action: "push", targetRef: "main" } }] },
    });
    const noChange = await noChangePrepared!.publish();
    expect(noChange[0]).toMatchObject({ action: "push", status: "no_changes" });

    const noCredentialPrWorkspace = path.join(fixtureRoot, "no-credential-pr-workspace");
    const noCredentialPrPrepared = await resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-no-credential-pr-test",
      workspaceRoot: noCredentialPrWorkspace,
      manifest: { version: 1, resources: [{ resourceId, mode: "input_output", output: { action: "pull_request", branch: "no-credential-pr" } }] },
    });
    await fs.writeFile(path.join(noCredentialPrWorkspace, "resources", "context", "context.md"), "pr-without-credential\n", "utf8");
    await expect(noCredentialPrPrepared!.publish()).rejects.toThrow("Pull request output requires a Resource credential");
    expect((await execFile("git", ["ls-remote", "--heads", remotePath, "refs/heads/no-credential-pr"])).stdout.trim()).toBe("");

    const inputOnlyWorkspace = path.join(fixtureRoot, "input-only-workspace");
    const inputOnlyPrepared = await resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-input-only-output-test",
      workspaceRoot: inputOnlyWorkspace,
      manifest: { version: 1, resources: [{ resourceId, mode: "input", output: { action: "push", targetRef: "main" } }] },
    });
    const inputOnly = await inputOnlyPrepared!.publish();
    expect(inputOnly[0]).toMatchObject({ action: "push", status: "discarded" });

    const deletionWorkspace = path.join(fixtureRoot, "deletion-workspace");
    const deletionPrepared = await resourceRuntimeService(db).prepare({
      companyId,
      runId: "run-divergent-deletion-test",
      workspaceRoot: deletionWorkspace,
      manifest: { version: 1, resources: [{ resourceId, mode: "input_output", version: "branch:feature", output: { action: "push", targetRef: "main" } }] },
    });
    await fs.rm(path.join(deletionWorkspace, "resources", "context", "context.md"));
    await expect(deletionPrepared!.publish()).resolves.toMatchObject([{ status: "pushed", targetRef: "main" }]);
    const deletionCheckPath = path.join(fixtureRoot, "deletion-check");
    await git(["clone", "--branch", "main", remotePath, deletionCheckPath]);
    await expect(fs.access(path.join(deletionCheckPath, "context.md"))).rejects.toThrow();
  });

  it("creates pull requests through the provider without exposing credentials", async () => {
    let request: RequestInit | undefined;
    const provider = githubPullRequestProvider(async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ number: 42, html_url: "https://github.com/acme/repo/pull/42" }), { status: 201 });
    });
    const result = await provider.create({
      repository: "https://github.com/acme/repo.git",
      token: "secret-token",
      head: "bizbox/update",
      base: "main",
      title: "Update",
      body: "Generated",
    });
    expect(result).toEqual({ id: "42", url: "https://github.com/acme/repo/pull/42" });
    expect(String(request?.body)).not.toContain("secret-token");
    expect((request?.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
  });

  it("retries transient GitHub API failures before succeeding", async () => {
    let attempts = 0;
    const provider = githubPullRequestProvider(async () => {
      attempts += 1;
      if (attempts < 3) return new Response("temporarily unavailable", { status: 503 });
      return new Response(JSON.stringify({ number: 43, html_url: "https://github.com/acme/repo/pull/43" }), { status: 201 });
    }, 0);
    await expect(provider.create({
      repository: "https://github.com/acme/repo.git",
      token: "secret-token",
      head: "bizbox/update",
      base: "main",
      title: "Update",
      body: "Generated",
    })).resolves.toEqual({ id: "43", url: "https://github.com/acme/repo/pull/43" });
    expect(attempts).toBe(3);
  });

  it("only allows credential-backed HTTPS Git hosts", () => {
    expect(() => validateCredentialRepository("https://github.com/acme/repo.git")).not.toThrow();
    expect(() => validateCredentialRepository("http://attacker.example/repo.git")).toThrow("require an HTTPS Git repository");
    expect(() => validateCredentialRepository("https://attacker.example/repo.git")).toThrow("host is not allowed");
  });

  it("redacts provider failure details", async () => {
    const provider = githubPullRequestProvider(async () => new Response(JSON.stringify({
      message: "Validation Failed",
      errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists" }],
      token: "secret-token",
    }), { status: 422, headers: { "content-type": "application/json" } }));
    const error = await provider.create({
      repository: "git@github.com:acme/repo.git",
      token: "secret-token",
      head: "branch",
      base: "main",
      title: "Update",
      body: "",
    }).catch((caught) => caught);
    expect(error).toMatchObject({ status: 422 });
    expect(error.message).toContain("GitHub pull request creation failed (HTTP 422)");
    expect(error.message).toContain("Validation Failed");
    expect(error.message).toContain("A pull request already exists");
    expect(error.message).not.toContain("secret-token");
  });
});
