import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, issueWorkProducts, projects } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { projectService } from "./projects.js";

const execFile = promisify(execFileCallback);
const log = logger.child({ service: "project-progress-sync" });
const PROJECT_PROGRESS_FILE = ".paperclip/project-progress.md";
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_OUTPUT_MAX_BUFFER = 1024 * 1024;
const COMMAND_OUTPUT_LOG_MAX_CHARS = 8_000;
const DEFAULT_DEBOUNCE_MS = 15_000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const PROGRESS_STATUS_ORDER = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];

type ProjectWithCodebase = NonNullable<Awaited<ReturnType<ReturnType<typeof projectService>["getById"]>>>;

interface CommandResult {
  ok: boolean;
  code: number | string | null;
  stdout: string;
  stderr: string;
}

export interface ProjectProgressSyncResult {
  projectId: string;
  projectName?: string;
  status: "synced" | "skipped" | "failed";
  reason: string;
  progressPath?: string;
  committed?: boolean;
  pushed?: boolean;
  deployed?: boolean;
  deploymentUrl?: string | null;
  message: string;
}

export interface ProjectProgressSyncAllResult {
  scanned: number;
  synced: number;
  skipped: number;
  failed: number;
  deployed: number;
  results: ProjectProgressSyncResult[];
}

const pendingProjectSyncTimers = new Map<string, NodeJS.Timeout>();

function readBooleanEnv(name: string, fallback: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function readNumberEnv(name: string, fallback: number, minimum: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

export function projectProgressGithubSyncEnabled() {
  return readBooleanEnv("PAPERCLIP_PROJECT_PROGRESS_GITHUB_SYNC_ENABLED", true);
}

export function projectProgressVercelAutoDeployEnabled() {
  return readBooleanEnv("PAPERCLIP_PROJECT_VERCEL_AUTO_DEPLOY_ENABLED", true);
}

export function getProjectProgressSyncIntervalMs() {
  return readNumberEnv("PAPERCLIP_PROJECT_PROGRESS_GITHUB_SYNC_INTERVAL_MS", DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
}

function getProjectProgressSyncDebounceMs() {
  return readNumberEnv("PAPERCLIP_PROJECT_PROGRESS_GITHUB_SYNC_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS, 1_000);
}

function shouldDeployProductionByDefault() {
  return readBooleanEnv("PAPERCLIP_PROJECT_VERCEL_AUTO_DEPLOY_PRODUCTION", true);
}

function truncate(value: string) {
  if (value.length <= COMMAND_OUTPUT_LOG_MAX_CHARS) return value;
  return `${value.slice(0, COMMAND_OUTPUT_LOG_MAX_CHARS)}\n...[truncated ${value.length - COMMAND_OUTPUT_LOG_MAX_CHARS} chars]`;
}

function redactSensitive(value: string) {
  let output = value;
  const vercelToken = process.env.VERCEL_TOKEN;
  if (vercelToken) output = output.split(vercelToken).join("[REDACTED_VERCEL_TOKEN]");
  return output
    .replace(/\bvercel_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_VERCEL_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
}

async function runCommand(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  try {
    const result = await execFile(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
    });
    return {
      ok: true,
      code: 0,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    };
  } catch (error) {
    const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string };
    return {
      ok: false,
      code: err.code ?? null,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? err.message,
    };
  }
}

async function pathExists(pathValue: string | null | undefined) {
  if (!pathValue) return false;
  return fs.access(pathValue).then(() => true, () => false);
}

function markdownEscape(value: unknown) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function statusLabel(value: string) {
  return value.replace(/_/g, " ");
}

function buildStatusCountRows(statusCounts: Map<string, number>) {
  const statuses = new Set([...PROGRESS_STATUS_ORDER, ...statusCounts.keys()]);
  return [...statuses]
    .filter((status) => (statusCounts.get(status) ?? 0) > 0 || PROGRESS_STATUS_ORDER.includes(status))
    .map((status) => `| ${markdownEscape(statusLabel(status))} | ${statusCounts.get(status) ?? 0} |`);
}

async function buildProjectProgressMarkdown(db: Db, project: ProjectWithCodebase) {
  const issueRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeName: agents.name,
      updatedAt: issues.updatedAt,
      completedAt: issues.completedAt,
    })
    .from(issues)
    .leftJoin(agents, and(eq(agents.id, issues.assigneeAgentId), eq(agents.companyId, project.companyId)))
    .where(and(eq(issues.companyId, project.companyId), eq(issues.projectId, project.id), isNull(issues.hiddenAt)))
    .orderBy(desc(issues.updatedAt), desc(issues.id));

  const workProductRows = await db
    .select({
      id: issueWorkProducts.id,
      type: issueWorkProducts.type,
      provider: issueWorkProducts.provider,
      title: issueWorkProducts.title,
      status: issueWorkProducts.status,
      url: issueWorkProducts.url,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      updatedAt: issueWorkProducts.updatedAt,
    })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
    .where(and(eq(issueWorkProducts.companyId, project.companyId), eq(issues.companyId, project.companyId), eq(issues.projectId, project.id)))
    .orderBy(desc(issueWorkProducts.updatedAt), desc(issueWorkProducts.id))
    .limit(25);

  const statusCounts = new Map<string, number>();
  for (const issue of issueRows) statusCounts.set(issue.status, (statusCounts.get(issue.status) ?? 0) + 1);
  const totalTracked = issueRows.filter((issue) => issue.status !== "cancelled").length;
  const doneCount = issueRows.filter((issue) => issue.status === "done").length;
  const openCount = issueRows.filter((issue) => !TERMINAL_STATUSES.has(issue.status)).length;
  const blockedCount = issueRows.filter((issue) => issue.status === "blocked").length;
  const progressPercent = totalTracked > 0 ? Math.round((doneCount / totalTracked) * 100) : 0;

  const lines = [
    `# ${markdownEscape(project.name)} — Paperclip Progress`,
    "",
    "This file is generated by Paperclip so project progress is continuously mirrored to the project repository.",
    "Do not edit it by hand; update the project/issues in Paperclip instead.",
    "",
    "## Summary",
    "",
    `- Project status: **${markdownEscape(statusLabel(project.status))}**`,
    `- Progress: **${progressPercent}%** (${doneCount}/${totalTracked} non-cancelled issues done)`,
    `- Open issues: **${openCount}**`,
    `- Blocked issues: **${blockedCount}**`,
    `- Repository: ${project.codebase.repoUrl ? markdownEscape(project.codebase.repoUrl) : "Not connected"}`,
    "",
    "## Status counts",
    "",
    "| Status | Count |",
    "| --- | ---: |",
    ...buildStatusCountRows(statusCounts),
    "",
    "## Issues",
    "",
    "| Issue | Status | Priority | Owner | Updated | Completed |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(issueRows.length > 0
      ? issueRows.map((issue) =>
          `| ${markdownEscape(issue.identifier ?? issue.id)} · ${markdownEscape(issue.title)} | ${markdownEscape(statusLabel(issue.status))} | ${markdownEscape(issue.priority)} | ${markdownEscape(issue.assigneeName ?? "Unassigned")} | ${formatDate(issue.updatedAt)} | ${formatDate(issue.completedAt)} |`,
        )
      : ["| — | — | — | — | — | — |"]),
    "",
    "## Recent work products and deployments",
    "",
    "| Output | Type | Provider | Status | Issue | Updated | URL |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...(workProductRows.length > 0
      ? workProductRows.map((product) =>
          `| ${markdownEscape(product.title)} | ${markdownEscape(statusLabel(product.type))} | ${markdownEscape(product.provider)} | ${markdownEscape(product.status)} | ${markdownEscape(product.issueIdentifier ?? product.issueTitle)} | ${formatDate(product.updatedAt)} | ${product.url ? markdownEscape(product.url) : "—"} |`,
        )
      : ["| — | — | — | — | — | — | — |"]),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

async function writeProgressFile(rootPath: string, content: string) {
  const absolutePath = path.join(rootPath, PROJECT_PROGRESS_FILE);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const previous = await fs.readFile(absolutePath, "utf8").catch(() => null);
  if (previous === content) return { absolutePath, changed: false };
  await fs.writeFile(absolutePath, content, "utf8");
  return { absolutePath, changed: true };
}

async function isGitCheckout(rootPath: string) {
  const result = await runCommand("git", ["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

async function readGitBranch(rootPath: string) {
  const result = await runCommand("git", ["-C", rootPath, "branch", "--show-current"]);
  return result.ok ? result.stdout.trim() || null : null;
}

async function readGitUpstream(rootPath: string) {
  const result = await runCommand("git", ["-C", rootPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  return result.ok ? result.stdout.trim() || null : null;
}

async function readAheadCount(rootPath: string, upstream: string | null) {
  if (!upstream) return null;
  const result = await runCommand("git", ["-C", rootPath, "rev-list", "--count", `${upstream}..HEAD`]);
  if (!result.ok) return null;
  const count = Number(result.stdout.trim());
  return Number.isFinite(count) ? count : null;
}

async function commandExists(command: string) {
  const result = await runCommand("which", [command]);
  return result.ok;
}

async function looksLikeVercelProject(rootPath: string) {
  if (readBooleanEnv("PAPERCLIP_PROJECT_VERCEL_AUTO_DEPLOY_UNLINKED", false)) return true;
  return (
    await pathExists(path.join(rootPath, ".vercel/project.json")) ||
    await pathExists(path.join(rootPath, "vercel.json"))
  );
}

function parseDeploymentUrl(output: string) {
  return [...output.matchAll(/https:\/\/[^\s]+/g)].map((match) => match[0]).at(-1) ?? null;
}

async function logProjectActivity(
  db: Db,
  project: ProjectWithCodebase,
  action: string,
  details: Record<string, unknown>,
) {
  await logActivity(db, {
    companyId: project.companyId,
    actorType: "system",
    actorId: "project-progress-sync",
    action,
    entityType: "project",
    entityId: project.id,
    details,
  }).catch((err) => log.warn({ err, projectId: project.id, action }, "failed to log project progress sync activity"));
}

function failedResult(project: ProjectWithCodebase, reason: string, message: string): ProjectProgressSyncResult {
  return { projectId: project.id, projectName: project.name, status: "failed", reason, message };
}

function skippedResult(project: ProjectWithCodebase, reason: string, message: string): ProjectProgressSyncResult {
  return { projectId: project.id, projectName: project.name, status: "skipped", reason, message };
}

export function projectProgressSyncService(db: Db) {
  const projectsSvc = projectService(db);

  async function deployProjectToVercel(project: ProjectWithCodebase, rootPath: string, reason: string) {
    if (!projectProgressVercelAutoDeployEnabled()) {
      return { deployed: false, skipped: true, message: "Vercel auto-deploy disabled." } as const;
    }
    if (!process.env.VERCEL_TOKEN) {
      return { deployed: false, skipped: true, message: "VERCEL_TOKEN is not configured." } as const;
    }
    if (!(await looksLikeVercelProject(rootPath))) {
      return { deployed: false, skipped: true, message: "Project is not linked/configured for Vercel auto-deploy." } as const;
    }
    if (!(await commandExists("vercel"))) {
      return { deployed: false, skipped: true, message: "Vercel CLI is not installed in this runtime." } as const;
    }

    const production = shouldDeployProductionByDefault();
    const args = ["deploy", "--yes", "--token", process.env.VERCEL_TOKEN, ...(production ? ["--prod"] : [])];
    const result = await runCommand("vercel", args, { cwd: rootPath, env: process.env });
    if (!result.ok) {
      const message = truncate(redactSensitive(result.stderr || result.stdout || "Vercel deploy failed"));
      await logProjectActivity(db, project, "project.vercel_deploy_failed", {
        reason,
        production,
        message,
      });
      return { deployed: false, skipped: false, message } as const;
    }

    const deploymentUrl = parseDeploymentUrl(`${result.stdout}\n${result.stderr}`);
    await logProjectActivity(db, project, "project.vercel_deployed", {
      reason,
      production,
      deploymentUrl,
      source: "project_progress_sync",
    });
    return { deployed: true, skipped: false, deploymentUrl, message: "Vercel deployment started." } as const;
  }

  async function syncProjectProgressToGitHub(
    projectId: string,
    opts: { reason?: string; force?: boolean } = {},
  ): Promise<ProjectProgressSyncResult> {
    const reason = opts.reason ?? "manual";
    if (!opts.force && !projectProgressGithubSyncEnabled()) {
      const project = await projectsSvc.getById(projectId);
      return project
        ? skippedResult(project, reason, "Project progress GitHub sync is disabled.")
        : { projectId, status: "skipped", reason, message: "Project not found." };
    }

    const project = await projectsSvc.getById(projectId);
    if (!project) return { projectId, status: "skipped", reason, message: "Project not found." };
    if (project.archivedAt) return skippedResult(project, reason, "Project is archived.");
    if (!project.codebase.repoUrl) return skippedResult(project, reason, "Project has no GitHub repository configured.");

    const rootPath = project.codebase.effectiveLocalFolder;
    if (!(await pathExists(rootPath))) return skippedResult(project, reason, "Project codebase path is not available on this host.");
    if (!(await isGitCheckout(rootPath))) return skippedResult(project, reason, "Project codebase path is not a Git checkout.");

    const content = await buildProjectProgressMarkdown(db, project);
    const { absolutePath, changed } = await writeProgressFile(rootPath, content);
    const addResult = await runCommand("git", ["-C", rootPath, "add", "-f", "--", PROJECT_PROGRESS_FILE]);
    if (!addResult.ok) {
      const message = truncate(redactSensitive(addResult.stderr || addResult.stdout || "git add failed"));
      await logProjectActivity(db, project, "project.github_progress_sync_failed", { reason, progressPath: absolutePath, message });
      return failedResult(project, reason, message);
    }

    const stagedDiff = await runCommand("git", ["-C", rootPath, "diff", "--cached", "--quiet", "--", PROJECT_PROGRESS_FILE]);
    if (!stagedDiff.ok && stagedDiff.code !== 1) {
      const message = truncate(redactSensitive(stagedDiff.stderr || stagedDiff.stdout || "git diff failed"));
      await logProjectActivity(db, project, "project.github_progress_sync_failed", { reason, progressPath: absolutePath, message });
      return failedResult(project, reason, message);
    }
    const hasStagedProgressChange = !stagedDiff.ok && stagedDiff.code === 1;
    let committed = false;
    if (hasStagedProgressChange) {
      const commitResult = await runCommand("git", ["-C", rootPath, "commit", "-m", "chore: sync Paperclip project progress [skip ci]"], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.PAPERCLIP_PROJECT_PROGRESS_GIT_AUTHOR_NAME ?? "Paperclip Automation",
          GIT_AUTHOR_EMAIL: process.env.PAPERCLIP_PROJECT_PROGRESS_GIT_AUTHOR_EMAIL ?? "paperclip-automation@localhost",
          GIT_COMMITTER_NAME: process.env.PAPERCLIP_PROJECT_PROGRESS_GIT_AUTHOR_NAME ?? "Paperclip Automation",
          GIT_COMMITTER_EMAIL: process.env.PAPERCLIP_PROJECT_PROGRESS_GIT_AUTHOR_EMAIL ?? "paperclip-automation@localhost",
        },
      });
      if (!commitResult.ok) {
        const message = truncate(redactSensitive(commitResult.stderr || commitResult.stdout || "git commit failed"));
        await logProjectActivity(db, project, "project.github_progress_sync_failed", { reason, progressPath: absolutePath, message });
        return failedResult(project, reason, message);
      }
      committed = true;
    }

    const upstream = await readGitUpstream(rootPath);
    const branch = await readGitBranch(rootPath);
    const ahead = await readAheadCount(rootPath, upstream);
    let pushed = false;
    if (committed || (ahead ?? 0) > 0) {
      const pushArgs = upstream ? ["-C", rootPath, "push"] : branch ? ["-C", rootPath, "push", "-u", "origin", "HEAD"] : null;
      if (!pushArgs) {
        const message = "Git checkout is detached; cannot push project progress automatically.";
        await logProjectActivity(db, project, "project.github_progress_sync_failed", { reason, progressPath: absolutePath, message });
        return failedResult(project, reason, message);
      }
      const pushResult = await runCommand("git", pushArgs);
      if (!pushResult.ok) {
        const message = truncate(redactSensitive(pushResult.stderr || pushResult.stdout || "git push failed"));
        await logProjectActivity(db, project, "project.github_progress_sync_failed", { reason, progressPath: absolutePath, message });
        return failedResult(project, reason, message);
      }
      pushed = true;
    }

    const deploy = committed || pushed
      ? await deployProjectToVercel(project, rootPath, reason)
      : { deployed: false, skipped: true, message: "No repository changes to deploy." } as const;
    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    await logProjectActivity(db, project, "project.github_progress_synced", {
      reason,
      progressPath: absolutePath,
      progressFile: PROJECT_PROGRESS_FILE,
      changed,
      committed,
      pushed,
      contentHash,
      vercel: deploy,
    });

    return {
      projectId: project.id,
      projectName: project.name,
      status: "synced",
      reason,
      progressPath: absolutePath,
      committed,
      pushed,
      deployed: deploy.deployed,
      deploymentUrl: "deploymentUrl" in deploy ? deploy.deploymentUrl : null,
      message: committed || pushed
        ? "Project progress was committed and pushed to GitHub."
        : "Project progress is already up to date in GitHub.",
    };
  }

  return {
    syncProjectProgressToGitHub,

    syncAllProjectsProgressToGitHub: async (opts: { reason?: string; force?: boolean } = {}): Promise<ProjectProgressSyncAllResult> => {
      if (!opts.force && !projectProgressGithubSyncEnabled()) {
        return { scanned: 0, synced: 0, skipped: 0, failed: 0, deployed: 0, results: [] };
      }
      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(isNull(projects.archivedAt))
        .orderBy(desc(projects.updatedAt));
      const results: ProjectProgressSyncResult[] = [];
      for (const row of rows) {
        const result = await syncProjectProgressToGitHub(row.id, { reason: opts.reason ?? "scheduled", force: opts.force });
        results.push(result);
      }
      return {
        scanned: rows.length,
        synced: results.filter((result) => result.status === "synced").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        failed: results.filter((result) => result.status === "failed").length,
        deployed: results.filter((result) => result.deployed).length,
        results,
      };
    },
  };
}

export function enqueueProjectProgressSync(db: Db, projectId: string | null | undefined, reason: string) {
  if (!projectId || !projectProgressGithubSyncEnabled()) return;
  const existing = pendingProjectSyncTimers.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingProjectSyncTimers.delete(projectId);
    void projectProgressSyncService(db)
      .syncProjectProgressToGitHub(projectId, { reason })
      .then((result) => {
        if (result.status === "failed") {
          log.warn({ projectId, reason, message: result.message }, "project progress GitHub sync failed");
        } else if (result.status === "synced" && (result.committed || result.pushed || result.deployed)) {
          log.info(
            { projectId, reason, committed: result.committed, pushed: result.pushed, deployed: result.deployed },
            "project progress synced to GitHub",
          );
        }
      })
      .catch((err) => log.warn({ err, projectId, reason }, "project progress GitHub sync crashed"));
  }, getProjectProgressSyncDebounceMs());
  timer.unref?.();
  pendingProjectSyncTimers.set(projectId, timer);
}