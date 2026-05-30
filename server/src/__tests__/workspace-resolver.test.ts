import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  featureFlags,
  issues,
  projects,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS, upsertFeatureFlag } from "../services/feature-flags.ts";
import { resolveWorkspace } from "../services/workspace-resolver.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace-resolver tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo(defaultBranch = "main"): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-resolver-repo-"));
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await git(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "Initial commit"]);
  await git(repoRoot, ["checkout", "-B", defaultBranch]);
  return repoRoot;
}

describeEmbeddedPostgres("WorkspaceResolver", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let engineerAgentId!: string;
  let cmoAgentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-resolver-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(featureFlags);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  async function seedIssue(projectId: string): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      projectId,
      title: "Test issue",
      status: "in_progress",
    });
    return id;
  }

  async function seedCompanyAndAgents() {
    companyId = randomUUID();
    engineerAgentId = randomUUID();
    cmoAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: engineerAgentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: cmoAgentId,
        companyId,
        name: "CMO",
        role: "cmo",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
  }

  async function seedProject(): Promise<string> {
    const id = randomUUID();
    await db.insert(projects).values({
      id,
      companyId,
      name: "Project",
      status: "active",
    });
    return id;
  }

  it("passes through to legacy realize when WORKSPACE_RUNTIME_V2 is off", async () => {
    await seedCompanyAndAgents();
    const projectId = await seedProject();
    const repoRoot = await createTempRepo();

    const resolution = await resolveWorkspace({
      db,
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: { workspaceStrategy: { type: "project_primary" } },
      issue: { id: randomUUID(), identifier: "PAP-100", title: "Test" },
      agent: {
        id: engineerAgentId,
        name: "Coder",
        companyId,
        role: "engineer",
      },
    });

    expect(resolution.source).toBe("legacy_passthrough");
    expect(resolution.usedV2).toBe(false);
    expect(resolution.strategy).toBe("project_primary");
  });

  it("forces git_worktree for engineer when V2 is on (T1)", async () => {
    await seedCompanyAndAgents();
    const projectId = await seedProject();
    const repoRoot = await createTempRepo();
    await upsertFeatureFlag(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      enabled: true,
    });

    const config: Record<string, unknown> = {
      workspaceStrategy: {
        type: "project_primary",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    };
    const resolution = await resolveWorkspace({
      db,
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: "HEAD",
      },
      config,
      issue: { id: randomUUID(), identifier: "PAP-447", title: "Add Worktree" },
      agent: {
        id: engineerAgentId,
        name: "Coder",
        companyId,
        role: "engineer",
      },
    });

    expect(resolution.usedV2).toBe(true);
    expect(resolution.strategy).toBe("git_worktree");
    expect(resolution.source).toBe("policy_v2");
    expect(resolution.realized.branchName).toBe("PAP-447-add-worktree");
    expect(resolution.realized.cwd).toContain(path.join(".paperclip", "worktrees"));
  });

  it("returns project_primary for cmo role even with V2 on (T3)", async () => {
    await seedCompanyAndAgents();
    const projectId = await seedProject();
    const repoRoot = await createTempRepo();
    await upsertFeatureFlag(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      enabled: true,
    });

    const resolution = await resolveWorkspace({
      db,
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: { workspaceStrategy: { type: "project_primary" } },
      issue: { id: randomUUID(), identifier: "PAP-200", title: "CMO Task" },
      agent: {
        id: cmoAgentId,
        name: "CMO",
        companyId,
        role: "cmo",
      },
    });

    expect(resolution.usedV2).toBe(true);
    expect(resolution.strategy).toBe("project_primary");
  });

  it("flags reuse_existing_row when an active row already exists for the issue (T2)", async () => {
    await seedCompanyAndAgents();
    const projectId = await seedProject();
    const repoRoot = await createTempRepo();
    await upsertFeatureFlag(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      enabled: true,
    });

    // Insert an active row directly to simulate a prior resolution.
    const issueId = await seedIssue(projectId);
    const existingId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: existingId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "existing",
      status: "active",
      cwd: repoRoot,
      branchName: "coder/pap-200",
      baseRef: "HEAD",
      providerType: "git_worktree",
    });

    const resolution = await resolveWorkspace({
      db,
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: { workspaceStrategy: { type: "git_worktree" } },
      issue: {
        id: issueId,
        identifier: "PAP-200",
        title: "Existing",
      },
      agent: {
        id: engineerAgentId,
        name: "Coder",
        companyId,
        role: "engineer",
      },
    });

    expect(resolution.source).toBe("reuse_existing_row");
    expect(resolution.reusedExecutionWorkspaceId).toBe(existingId);
  });
});
