import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, projects as projectsTable } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.js";

const execFile = promisify(execFileCallback);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project workspace git-init tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// RENA-54552: `createWorkspace` must git-init a `local_path` workspace directory that has no
// `.git` metadata yet, so the heartbeat.ts `assertGitSensitiveAdapterWorkspaceValid` git-metadata
// check (which requires `.git` whenever a project workspace is expected) does not reject the
// very first run against a freshly registered local folder.
describeEmbeddedPostgres("createWorkspace git init for local_path workspaces", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;
  let originalGitConfigGlobal: string | undefined;
  let gitConfigDir: string;
  let scratchDir: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-workspace-git-init-");
    db = createDb(tempDb.connectionString);
    originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    gitConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-git-init-config-"));
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    await fs.rm(gitConfigDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Isolate `git config --global` writes from the real user gitconfig for every test.
    process.env.GIT_CONFIG_GLOBAL = path.join(gitConfigDir, `${Math.random().toString(36).slice(2)}.gitconfig`);
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-git-init-"));
  });

  afterEach(async () => {
    await db.delete(projectsTable);
    await db.delete(companies);
    await fs.rm(scratchDir, { recursive: true, force: true });
  });

  async function seedProject(): Promise<string> {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: "Git Init Co", issuePrefix: `GIT${prefixCounter}` })
      .returning();
    const projects = projectService(db);
    const project = await projects.create(company.id, { name: "Git Init Project" });
    return project.id;
  }

  it("git-inits a local_path workspace cwd that has no .git metadata", async () => {
    const projectId = await seedProject();
    const projects = projectService(db);

    const workspace = await projects.createWorkspace(projectId, {
      sourceType: "local_path",
      cwd: scratchDir,
    });

    expect(workspace).not.toBeNull();
    expect(workspace?.sourceType).toBe("local_path");
    const gitDirStat = await fs.stat(path.join(scratchDir, ".git"));
    expect(gitDirStat.isDirectory()).toBe(true);
  });

  it("does not touch an existing .git directory", async () => {
    await execFile("git", ["init"], { cwd: scratchDir });
    await execFile("git", ["config", "user.email", "paperclip@example.com"], { cwd: scratchDir });
    await execFile("git", ["config", "user.name", "Paperclip Test"], { cwd: scratchDir });

    const projectId = await seedProject();
    const projects = projectService(db);

    const workspace = await projects.createWorkspace(projectId, {
      sourceType: "local_path",
      cwd: scratchDir,
    });

    expect(workspace).not.toBeNull();
    const email = await execFile("git", ["config", "user.email"], { cwd: scratchDir }).then(
      (out) => out.stdout.trim(),
    );
    expect(email).toBe("paperclip@example.com");
  });

  it("still creates the workspace row when the cwd cannot be git-initialized", async () => {
    const projectId = await seedProject();
    const projects = projectService(db);
    const missingCwd = path.join(scratchDir, "does-not-exist", "nested");

    const workspace = await projects.createWorkspace(projectId, {
      sourceType: "local_path",
      cwd: missingCwd,
    });

    expect(workspace).not.toBeNull();
    expect(workspace?.cwd).toBe(missingCwd);
  });

  it("does not attempt git init for non-local_path source types", async () => {
    const projectId = await seedProject();
    const projects = projectService(db);

    const workspace = await projects.createWorkspace(projectId, {
      sourceType: "git_repo",
      repoUrl: "https://example.invalid/repo.git",
    });

    expect(workspace).not.toBeNull();
    expect(workspace?.sourceType).toBe("git_repo");
  });
});
