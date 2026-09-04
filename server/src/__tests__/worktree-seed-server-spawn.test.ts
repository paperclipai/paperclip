import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureWorktreeSeeded,
  readWorktreeSeedManifest,
} from "../../../cli/src/commands/worktree.ts";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const originalConfig = process.env.PAPERCLIP_CONFIG;
const originalWorktreesDir = process.env.PAPERCLIP_WORKTREES_DIR;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function writeConfig(configPath: string, instanceId: string) {
  const instanceRoot = path.dirname(configPath);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-08-19T00:00:00.000Z", source: "configure" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(instanceRoot, "db"),
      embeddedPostgresPort: 54329,
      backup: { enabled: false, intervalMinutes: 60, retentionDays: 30, dir: path.join(instanceRoot, "backups") },
    },
    logging: { mode: "file", logDir: path.join(instanceRoot, "logs") },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(path.dirname(configPath), ".env"),
    `PAPERCLIP_INSTANCE_ID=${instanceId}\n`,
    "utf8",
  );
}

function verifiedSeedResult() {
  return {
    backupSummary: "snapshot.sql",
    snapshotAt: "2026-08-19T00:00:00.000Z",
    migrationRevision: "0223_test.sql",
    pausedScheduledRoutines: 0,
    executionQuarantine: {
      disabledTimerHeartbeats: 0,
      resetRunningAgents: 0,
      quarantinedInProgressIssues: 0,
      unassignedTodoIssues: 0,
      unassignedReviewIssues: 0,
      stoppedProjectWorkspaceRuntimes: 0,
      stoppedExecutionWorkspaceRuntimes: 0,
      stoppedRuntimeServices: 0,
    },
    reboundWorkspaces: [],
    validation: {
      authUserCount: 1,
      credentialAccountCount: 1,
      instanceAdminCount: 1,
      activeMembershipCount: 1,
      companyCount: 1,
      issueCount: 1,
      representativeCompanyId: "00000000-0000-4000-8000-000000000001",
      representativeIssueId: "00000000-0000-4000-8000-000000000002",
      migrationRevision: "0223_test.sql",
    },
  };
}

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.PAPERCLIP_CONFIG;
  else process.env.PAPERCLIP_CONFIG = originalConfig;
  if (originalWorktreesDir === undefined) delete process.env.PAPERCLIP_WORKTREES_DIR;
  else process.env.PAPERCLIP_WORKTREES_DIR = originalWorktreesDir;
  for (const dir of cleanup.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("managed worktree seed source through the server spawn path", () => {
  it("re-derives an ambient-instance manifest written before provisioning", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-server-seed-source-"));
    cleanup.push(tempRoot);
    const repoRoot = path.join(tempRoot, "repo");
    const hooksDir = path.join(tempRoot, "hooks");
    const ambientConfigPath = path.join(tempRoot, "ambient", "config.json");
    const registeredConfigPath = path.join(repoRoot, ".paperclip", "config.json");
    const worktreeHome = path.join(tempRoot, "worktree-home");

    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init", "-q"]);
    await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "README.md"), "server spawn regression\n", "utf8");
    await fs.copyFile(
      fileURLToPath(new URL("../../../scripts/provision-worktree.sh", import.meta.url)),
      path.join(repoRoot, "scripts", "provision-worktree.sh"),
    );
    await fs.chmod(path.join(repoRoot, "scripts", "provision-worktree.sh"), 0o755);
    await runGit(repoRoot, ["add", "README.md", "scripts/provision-worktree.sh"]);
    await runGit(repoRoot, ["commit", "-qm", "Add managed provision script"]);
    await writeConfig(registeredConfigPath, "registered-source");
    await writeConfig(ambientConfigPath, "ambient-instance");
    await fs.mkdir(worktreeHome, { recursive: true });

    // Reproduce the integrated lane's ordering with a checkout hook: an earlier
    // worktree-init-style writer inherits the server environment and leaves a valid
    // target config whose manifest diagnostic points at the ambient instance.
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "post-checkout");
    await fs.writeFile(
      hookPath,
      `#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
if (cwd === ${JSON.stringify(repoRoot)}) process.exit(0);
const stateDir = path.join(cwd, ".paperclip");
const normalized = path.basename(cwd).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
const instanceId = \`${"${(normalized || \"worktree\").slice(0, 48)}"}-\${crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12)}\`;
const targetConfigPath = path.join(stateDir, "config.json");
const instanceRoot = path.join(process.env.PAPERCLIP_WORKTREES_DIR, "instances", instanceId);
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(instanceRoot, { recursive: true });
fs.writeFileSync(targetConfigPath, JSON.stringify({
  $meta: { version: 1, updatedAt: "2026-08-19T00:00:00.000Z", source: "configure" },
  database: {
    mode: "embedded-postgres",
    embeddedPostgresDataDir: path.join(instanceRoot, "db"),
    embeddedPostgresPort: 54330,
    backup: { enabled: false, intervalMinutes: 60, retentionDays: 30, dir: path.join(instanceRoot, "backups") },
  },
  logging: { mode: "file", logDir: path.join(instanceRoot, "logs") },
  server: {
    deploymentMode: "local_trusted",
    exposure: "private",
    host: "127.0.0.1",
    port: 3101,
    allowedHostnames: [],
    serveUi: true,
  },
}, null, 2) + "\\n");
fs.writeFileSync(path.join(stateDir, ".env"), [
  "PAPERCLIP_HOME=" + JSON.stringify(process.env.PAPERCLIP_WORKTREES_DIR),
  "PAPERCLIP_INSTANCE_ID=" + JSON.stringify(instanceId),
  "PAPERCLIP_CONFIG=" + JSON.stringify(targetConfigPath),
  "",
].join("\\n"));
fs.writeFileSync(path.join(stateDir, "seed-manifest.json"), JSON.stringify({
  version: 2,
  source: { instanceId: "ambient-instance", configPath: process.env.PAPERCLIP_CONFIG },
  snapshotAt: null,
  seedMode: "minimal",
  migrationRevision: null,
  targetInstanceId: instanceId,
  phase: "pending",
  state: "pending",
  attemptId: "ambient-writer",
  startedAt: null,
  finishedAt: null,
  diagnostics: [{ phase: "pending", status: "succeeded", at: new Date().toISOString() }],
}, null, 2) + "\\n");
`,
      "utf8",
    );
    await fs.chmod(hookPath, 0o755);
    await runGit(repoRoot, ["config", "core.hooksPath", hooksDir]);

    process.env.PAPERCLIP_CONFIG = ambientConfigPath;
    process.env.PAPERCLIP_WORKTREES_DIR = worktreeHome;
    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "project-workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-17681",
        title: "Recover ambient seed source",
      },
      agent: { id: "agent-1", name: "Coder", companyId: "company-1" },
    });

    expect(readWorktreeSeedManifest(path.join(workspace.cwd, ".paperclip", "config.json"))).toMatchObject({
      source: { instanceId: "ambient-instance", configPath: ambientConfigPath },
      state: "pending",
    });

    await expect(ensureWorktreeSeeded({
      config: path.join(workspace.cwd, ".paperclip", "config.json"),
      registeredBaseWorkspaceCwd: repoRoot,
      registeredProjectWorkspaceId: "project-workspace-1",
      expectedCompanyId: "company-1",
    }, {
      seedDatabase: async () => verifiedSeedResult(),
    })).resolves.toMatchObject({ seeded: true, reason: "seeded" });

    expect(readWorktreeSeedManifest(path.join(workspace.cwd, ".paperclip", "config.json"))).toMatchObject({
      source: { instanceId: "registered-source", configPath: registeredConfigPath },
      state: "verified",
      phase: "complete",
    });
  }, 20_000);
});
