import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { agents, Db, projectWorkspaces } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureManagedProjectWorkspace as legacyEnsureManagedProjectWorkspace,
  WorkspaceValidationFailure as LegacyWorkspaceValidationFailure,
} from "../heartbeat.js";
import { resolveDefaultAgentWorkspaceDir } from "../../home-paths.js";
import {
  createHeartbeatWorkspaceResolver,
  ensureManagedProjectWorkspace,
  WorkspaceValidationFailure,
} from "./workspaces.js";

const runGit = promisify(execFile);
let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-module-"));
  vi.stubEnv("PAPERCLIP_HOME", testRoot);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "workspace-test");
  vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "false");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(testRoot, { recursive: true, force: true });
});

function agent(id = "agent-one") {
  return { id, companyId: "company-one" } as typeof agents.$inferSelect;
}

function workspace(id: string, projectId: string, cwd: string) {
  return {
    id, projectId, companyId: "company-one", cwd,
    repoUrl: null, repoRef: null, sourceType: "local_path",
  } as typeof projectWorkspaces.$inferSelect;
}

// The existing service integration suites cover the SQL and authorization rules.
// These query results exercise the new factory's database binding and call order.
function databaseWithResults(...results: unknown[][]) {
  const select = vi.fn(() => {
    const rows = results.shift() ?? [];
    const query = {
      from: () => query,
      where: () => query,
      orderBy: async () => rows,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  });
  return { db: { select } as unknown as Db, select };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function createRepository(parent: string, text: string) {
  const cwd = path.join(testRoot, parent, "repo");
  await fs.mkdir(cwd, { recursive: true });
  await runGit("git", ["init", cwd]);
  await runGit("git", ["-C", cwd, "config", "user.email", "workspace-test@example.com"]);
  await runGit("git", ["-C", cwd, "config", "user.name", "Workspace Test"]);
  await fs.writeFile(path.join(cwd, "README.md"), text);
  await runGit("git", ["-C", cwd, "add", "README.md"]);
  await runGit("git", ["-C", cwd, "commit", "-m", "initial"]);
  return cwd;
}

describe("heartbeat workspace module", () => {
  it("preserves the legacy error class and checkout entry point", () => {
    expect(LegacyWorkspaceValidationFailure).toBe(WorkspaceValidationFailure);
    expect(legacyEnsureManagedProjectWorkspace).toBe(ensureManagedProjectWorkspace);
    const failure = new WorkspaceValidationFailure("invalid checkout", { reason: "test" });
    expect(failure).toBeInstanceOf(LegacyWorkspaceValidationFailure);
    expect(failure.code).toBe("workspace_validation_failed");
  });

  it("binds each resolver to its own database", async () => {
    const firstCwd = path.join(testRoot, "first");
    const secondCwd = path.join(testRoot, "second");
    await Promise.all([fs.mkdir(firstCwd), fs.mkdir(secondCwd)]);
    const first = databaseWithResults([workspace("workspace-one", "project-one", firstCwd)]);
    const second = databaseWithResults([workspace("workspace-two", "project-two", secondCwd)]);
    const [firstResult, secondResult] = await Promise.all([
      createHeartbeatWorkspaceResolver(first.db).resolveWorkspaceForRun(agent(), { projectId: "project-one" }, null),
      createHeartbeatWorkspaceResolver(second.db).resolveWorkspaceForRun(agent(), { projectId: "project-two" }, null),
    ]);
    expect(firstResult).toMatchObject({ cwd: firstCwd, projectId: "project-one", workspaceId: "workspace-one", source: "project_primary", additionalWorkspaces: [] });
    expect(secondResult).toMatchObject({ cwd: secondCwd, projectId: "project-two", workspaceId: "workspace-two", source: "project_primary", additionalWorkspaces: [] });
    expect(first.select).toHaveBeenCalledTimes(1);
    expect(second.select).toHaveBeenCalledTimes(1);
  });

  it("uses the current issue's project and selected workspace over stale context", async () => {
    const selectedCwd = path.join(testRoot, "selected");
    await fs.mkdir(selectedCwd);
    const database = databaseWithResults(
      [{ projectId: "current-project", projectWorkspaceId: "selected-workspace" }],
      [{ projectId: "current-project" }],
      [workspace("default-workspace", "current-project", path.join(testRoot, "missing")), workspace("selected-workspace", "current-project", selectedCwd)],
    );
    const result = await createHeartbeatWorkspaceResolver(database.db).resolveWorkspaceForRun(
      agent(),
      { issueId: "issue-one", projectId: "stale-project", projectWorkspaceId: "stale-workspace" },
      null,
    );
    expect(result).toMatchObject({ cwd: selectedCwd, projectId: "current-project", workspaceId: "selected-workspace", warnings: [], baseCwdFallback: false });
    expect(database.select).toHaveBeenCalledTimes(3);
  });

  it("fails closed with workspace diagnostics when a configured directory is unavailable", async () => {
    const missingCwd = path.join(testRoot, "missing-configured-workspace");
    const database = databaseWithResults([workspace("selected", "project-one", missingCwd)]);
    await expect(createHeartbeatWorkspaceResolver(database.db).resolveWorkspaceForRun(
      agent(), { projectId: "project-one" }, null,
    )).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: { workspaceValidation: {
        reason: "configured_workspace_unavailable", resolvedProjectId: "project-one", baseCwdFallback: false,
      } },
    });
    expect(await fs.stat(missingCwd).catch(() => null)).toBeNull();
  });

  it("retains materialization diagnostics when a configured repository cannot be cloned", async () => {
    const missingRepo = path.join(testRoot, "missing-repository.git");
    const database = databaseWithResults([{
      ...workspace("selected", "project-one", ""), repoUrl: missingRepo, sourceType: "git_remote",
    }]);
    await expect(createHeartbeatWorkspaceResolver(database.db).resolveWorkspaceForRun(
      agent(), { projectId: "project-one" }, null,
    )).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: { workspaceValidation: {
        reason: "git_worktree_base_materialization_failed",
        materializationFailures: [expect.objectContaining({ projectWorkspaceId: "selected", repoUrl: missingRepo, error: expect.any(String) })],
      } },
    });
  });

  it("retains a valid prior session workspace and falls back when it disappears", async () => {
    const priorCwd = path.join(testRoot, "prior-session");
    await fs.mkdir(priorCwd);
    const database = databaseWithResults();
    const resolver = createHeartbeatWorkspaceResolver(database.db);
    const previousSession = { cwd: priorCwd, workspaceId: "previous-workspace" };
    expect(await resolver.resolveWorkspaceForRun(agent(), {}, previousSession)).toMatchObject({ cwd: priorCwd, source: "task_session", workspaceId: "previous-workspace", warnings: [] });
    await fs.rm(priorCwd, { recursive: true });
    const fallback = await resolver.resolveWorkspaceForRun(agent(), {}, previousSession);
    expect(fallback).toMatchObject({ cwd: resolveDefaultAgentWorkspaceDir(agent().id), source: "agent_home", workspaceId: null });
    expect(fallback.warnings).toEqual([expect.stringContaining("is not available")]);
    expect((await fs.stat(fallback.cwd)).isDirectory()).toBe(true);
    expect(database.select).not.toHaveBeenCalled();
  });

  it("shares one in-flight checkout across legacy and direct module callers", async () => {
    const repoUrl = await createRepository("source", "shared checkout\n");
    const started = deferred();
    const release = deferred();
    const resolveGitAuth = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return null;
    });
    const input = { companyId: "company-one", projectId: "shared-project", repoUrl, resolveGitAuth };
    const attempts = Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? legacyEnsureManagedProjectWorkspace : ensureManagedProjectWorkspace)(input),
    );
    await started.promise;
    release.resolve();
    const results = await Promise.all(attempts);
    expect(resolveGitAuth).toHaveBeenCalledTimes(1);
    expect(new Set(results.map(result => result.cwd)).size).toBe(1);
    expect(await fs.readFile(path.join(results[0]!.cwd, "README.md"), "utf8")).toBe("shared checkout\n");
    expect((await runGit("git", ["-C", results[0]!.cwd, "remote", "get-url", "origin"])).stdout.trim()).toBe(repoUrl);
  });

  it("keeps concurrent repositories with the same basename in separate checkouts", async () => {
    const [firstRepo, secondRepo] = await Promise.all([
      createRepository("first-source", "first repository\n"),
      createRepository("second-source", "second repository\n"),
    ]);
    const [first, second] = await Promise.all([firstRepo, secondRepo].map(repoUrl =>
      ensureManagedProjectWorkspace({ companyId: "company-one", projectId: "shared-project", repoUrl }),
    ));
    expect(first!.cwd).not.toBe(second!.cwd);
    expect(await fs.readFile(path.join(first!.cwd, "README.md"), "utf8")).toBe("first repository\n");
    expect(await fs.readFile(path.join(second!.cwd, "README.md"), "utf8")).toBe("second repository\n");
  });

  it("releases a failed checkout attempt so the next caller can retry", async () => {
    const repoUrl = await createRepository("retry-source", "retry succeeded\n");
    const resolveGitAuth = vi.fn()
      .mockRejectedValueOnce(new Error("credential lookup failed"))
      .mockResolvedValue(null);
    const input = { companyId: "company-one", projectId: "retry-project", repoUrl, resolveGitAuth };
    await expect(ensureManagedProjectWorkspace(input)).rejects.toThrow("credential lookup failed");
    const result = await legacyEnsureManagedProjectWorkspace(input);
    expect(resolveGitAuth).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(result.cwd, "README.md"), "utf8")).toBe("retry succeeded\n");
  });
});
