import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issues } from "@paperclipai/db";
import {
  cleanupTerminalIssueWorkspaces,
  matchesTerminalIssueWorkspaceName,
} from "../services/terminal-issue-workspace-cleanup.ts";
import { issueService } from "../services/issues.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const execFileAsync = promisify(execFile);
const cleanupRoots = new Set<string>();
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  await Promise.all([...cleanupRoots].map((root) => fs.rm(root, { recursive: true, force: true })));
  cleanupRoots.clear();
});

async function makeFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-terminal-workspace-cleanup-"));
  cleanupRoots.add(root);
  const workspaceRoot = path.join(root, "workspaces");
  const agentRoot = path.join(workspaceRoot, "agent-one");
  await fs.mkdir(agentRoot, { recursive: true });
  return { root, workspaceRoot, agentRoot };
}

async function mkdirs(parent: string, names: string[]) {
  await Promise.all(names.map((name) => fs.mkdir(path.join(parent, name), { recursive: true })));
}

describe("terminal issue workspace name matching", () => {
  const issue = { identifier: "LIV-321", issueNumber: 321 };

  it.each([
    "liv-321",
    "qa-321",
    "qa-liv-321-bf9271",
    "pr-321",
    "merge-321-final",
  ])("matches %s", (name) => {
    expect(matchesTerminalIssueWorkspaceName(name, issue)).toBe(true);
  });

  it.each([
    "liveslip-liv-321",
    "paperclip-liv-321-parser",
    "liveslip-qa-321",
    "liveslip-qa-321-mobile",
    "liveslip-qa-liv-321-bf9271",
    "liveslip-pr-321",
    "liveslip-merge-321-final",
  ])("matches recognized repository workspace family %s", (name) => {
    expect(matchesTerminalIssueWorkspaceName(name, issue, {
      workspaceFamilies: new Set(["liveslip", "paperclip"]),
    })).toBe(true);
  });

  it.each([
    "liveslip-liv-3210",
    "liveslip-qa-3210",
    "liveslip-pr-1321",
    "artifacts-321",
    "preview-321",
    "archive-LIV-321-old",
    "archive-qa-321-old",
  ])("does not match %s", (name) => {
    expect(matchesTerminalIssueWorkspaceName(name, issue)).toBe(false);
  });

  it("fails closed when the identifier and issue number disagree", () => {
    expect(matchesTerminalIssueWorkspaceName("liveslip-liv-321", {
      identifier: "LIV-321",
      issueNumber: 322,
    })).toBe(false);
    expect(matchesTerminalIssueWorkspaceName("liveslip-liv-322", {
      identifier: "LIV-321",
      issueNumber: 322,
    })).toBe(false);
  });
});

describe("cleanupTerminalIssueWorkspaces", () => {
  it.each(["done", "cancelled"])("removes all observed %s workspace patterns and preserves numeric neighbors", async (status) => {
    const { workspaceRoot, agentRoot } = await makeFixtureRoot();
    const topLevelMatches = [
      "liveslip-liv-321",
      "liveslip-qa-321",
      "liveslip-qa-321-mobile",
      "liveslip-pr-321",
      "liveslip-merge-321",
    ];
    await mkdirs(agentRoot, [
      ...topLevelMatches,
      "liveslip-liv-3210",
      "liveslip-qa-3210",
      "archive-LIV-321-old",
      "archive-qa-321-old",
    ]);
    const checkout = path.join(agentRoot, "liveslip");
    const paperclipCheckout = path.join(agentRoot, "paperclip");
    await mkdirs(agentRoot, ["liveslip", "paperclip"]);
    await mkdirs(checkout, [".git"]);
    await mkdirs(paperclipCheckout, [".git"]);
    await mkdirs(path.join(agentRoot, "archive-LIV-321-old"), [".git"]);
    const ambiguousContainer = path.join(agentRoot, "archive-LIV-321-old", ".cto-worktrees");
    await mkdirs(ambiguousContainer, ["liv-321-unrelated"]);
    const ctoContainer = path.join(checkout, ".cto-worktrees");
    const qaContainer = path.join(checkout, ".qa-worktrees");
    await mkdirs(ctoContainer, ["liv-321-parser", "liv-3210", "otherrepo-LIV-321"]);
    await mkdirs(qaContainer, ["liv-321-review", "liv-3210-review"]);

    const report = await cleanupTerminalIssueWorkspaces({
      issue: { companyId: "company-one", identifier: "LIV-321", issueNumber: 321, status },
      agentIds: ["agent-one"],
      workspaceRoot,
    });

    expect(report).toMatchObject({ matched: 7, removed: 7, skipped: 0, failed: 0 });
    for (const name of topLevelMatches) {
      await expect(fs.stat(path.join(agentRoot, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.stat(path.join(ctoContainer, "liv-321-parser"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(qaContainer, "liv-321-review"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(agentRoot, "liveslip-liv-3210"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(agentRoot, "liveslip-qa-3210"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(agentRoot, "archive-LIV-321-old"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(agentRoot, "archive-qa-321-old"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(ambiguousContainer, "liv-321-unrelated"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(ctoContainer, "liv-3210"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(ctoContainer, "otherrepo-LIV-321"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(qaContainer, "liv-3210-review"))).resolves.toBeDefined();
  });

  it("uses git worktree removal for registered worktrees and is idempotent", async () => {
    const { root, workspaceRoot, agentRoot } = await makeFixtureRoot();
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Paperclip Tests"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "tests@paperclip.local"], { cwd: repo });
    await fs.writeFile(path.join(repo, "README.md"), "fixture\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repo });

    const checkout = path.join(agentRoot, "liveslip");
    const container = path.join(checkout, ".cto-worktrees");
    const linkedWorktree = path.join(container, "liv-321-registered");
    await fs.mkdir(path.join(checkout, ".git"), { recursive: true });
    await fs.mkdir(container, { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", "liv-321", linkedWorktree], { cwd: repo });

    const first = await cleanupTerminalIssueWorkspaces({
      issue: { companyId: "company-one", identifier: "LIV-321", status: "done" },
      agentIds: ["agent-one"],
      workspaceRoot,
    });
    expect(first.entries).toEqual([
      expect.objectContaining({
        path: linkedWorktree,
        outcome: "removed",
        method: "git_worktree_remove",
      }),
    ]);
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(stdout).not.toContain(linkedWorktree);

    const second = await cleanupTerminalIssueWorkspaces({
      issue: { companyId: "company-one", identifier: "LIV-321", status: "done" },
      agentIds: ["agent-one"],
      workspaceRoot,
    });
    expect(second).toMatchObject({ matched: 0, removed: 0, skipped: 0, failed: 0 });
  });

  it("preserves an ambiguous primary checkout without blocking other matches", async () => {
    const { root, workspaceRoot, agentRoot } = await makeFixtureRoot();
    const primaryCheckout = path.join(agentRoot, "paperclip-liv-321");
    await fs.mkdir(primaryCheckout, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: primaryCheckout });
    await execFileAsync("git", ["config", "user.name", "Paperclip Tests"], { cwd: primaryCheckout });
    await execFileAsync("git", ["config", "user.email", "tests@paperclip.local"], { cwd: primaryCheckout });
    await fs.writeFile(path.join(primaryCheckout, "README.md"), "fixture\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: primaryCheckout });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: primaryCheckout });
    const linkedWorktree = path.join(root, "linked-worktree");
    await execFileAsync("git", ["worktree", "add", "-b", "linked", linkedWorktree], { cwd: primaryCheckout });
    await fs.mkdir(path.join(agentRoot, "liveslip", ".git"), { recursive: true });
    await fs.mkdir(path.join(agentRoot, "paperclip", ".git"), { recursive: true });
    const removableScratch = path.join(agentRoot, "liveslip-qa-321-review");
    await fs.mkdir(removableScratch, { recursive: true });

    const report = await cleanupTerminalIssueWorkspaces({
      issue: { companyId: "company-one", identifier: "LIV-321", status: "done" },
      agentIds: ["agent-one"],
      workspaceRoot,
    });

    expect(report).toMatchObject({ matched: 2, removed: 1, skipped: 1, failed: 0 });
    expect(report.entries).toContainEqual(expect.objectContaining({
      path: primaryCheckout,
      outcome: "skipped",
      reason: "primary_checkout_has_linked_worktrees",
    }));
    await expect(fs.stat(primaryCheckout)).resolves.toBeDefined();
    await expect(fs.stat(removableScratch)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove matching paths for active issues", async () => {
    const { workspaceRoot, agentRoot } = await makeFixtureRoot();
    const activePath = path.join(agentRoot, "liveslip-liv-321");
    await fs.mkdir(activePath, { recursive: true });

    const report = await cleanupTerminalIssueWorkspaces({
      issue: { companyId: "company-one", identifier: "LIV-321", status: "in_progress" },
      agentIds: ["agent-one"],
      workspaceRoot,
    });

    expect(report).toMatchObject({ matched: 0, removed: 0 });
    await expect(fs.stat(activePath)).resolves.toBeDefined();
  });

  it("does not traverse agents outside the issue company agent set", async () => {
    const { workspaceRoot, agentRoot } = await makeFixtureRoot();
    const otherAgentRoot = path.join(workspaceRoot, "agent-two");
    const ownCheckout = path.join(agentRoot, "liveslip");
    const ownPath = path.join(agentRoot, "liveslip-liv-321");
    const otherPath = path.join(otherAgentRoot, "liveslip-liv-321");
    await fs.mkdir(path.join(ownCheckout, ".git"), { recursive: true });
    await fs.mkdir(ownPath, { recursive: true });
    await fs.mkdir(otherPath, { recursive: true });

    await cleanupTerminalIssueWorkspaces({
      issue: { companyId: "company-one", identifier: "LIV-321", status: "cancelled" },
      agentIds: ["agent-one"],
      workspaceRoot,
    });

    await expect(fs.stat(ownPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(otherPath)).resolves.toBeDefined();
  });
});

describeEmbeddedPostgres("terminal issue transition workspace cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalHome = process.env.PAPERCLIP_HOME;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-workspace-transition-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
    await tempDb?.cleanup();
  });

  it.each(["done", "cancelled"] as const)("runs cleanup when issueService transitions to %s", async (status) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-terminal-transition-home-"));
    cleanupRoots.add(home);
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "cleanup-test";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fixture company",
      issuePrefix: "LIV",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 321,
      identifier: "LIV-321",
      title: "Terminal cleanup fixture",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const workspacePath = path.join(
      home,
      "instances",
      "cleanup-test",
      "workspaces",
      agentId,
      "liveslip-liv-321",
    );
    const primaryCheckout = path.join(
      home,
      "instances",
      "cleanup-test",
      "workspaces",
      agentId,
      "liveslip",
      ".git",
    );
    await fs.mkdir(primaryCheckout, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });

    await issueService(db).update(issueId, { status });

    await expect(fs.stat(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    const cleanupActivity = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(cleanupActivity).toContainEqual(expect.objectContaining({
      action: "issue.terminal_workspace_cleanup",
      details: expect.objectContaining({ matched: 1, removed: 1, failed: 0 }),
    }));
  });
});
