import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { agentTaskSessions, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { resolveManagedClaudeTranscriptsDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { resolveClaudeRuntimeSettings } from "@paperclipai/adapter-claude-local";

export const MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS = 60 * 60 * 1000;
export const MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DEFAULT_DAYS = 7;

const TASK_FILE = "task.json";
const PROJECTS_DIR = "projects";
const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPE_PATTERN = /^[0-9a-f]{16}$/;
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPIRED_PREFIX = ".expired-";
const RETIRING_PREFIX = ".retiring-";
const LIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"];
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];

export function managedClaudeTranscriptRetentionEnabled(): boolean {
  return process.env.PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED === "true";
}

let onScopeRetained: (() => void) | null = null;

export async function retainManagedClaudeTranscripts(input: {
  runtime: { home?: string; sessionIdentity: string; config?: Record<string, unknown> } | undefined;
  adapterType: string;
  companyId: string;
  agentId: string;
  taskKey: string | null;
  target: AdapterExecutionTarget | null | undefined;
}): Promise<{ home: string; transcriptDir: string } | undefined> {
  const { runtime, taskKey } = input;
  if (!runtime?.home || !taskKey || input.adapterType !== "claude_local" || (input.target && input.target.kind !== "local")) return undefined;
  const config = runtime.config ?? {};
  const env = config.env && typeof config.env === "object" ? config.env as Record<string, unknown> : {};
  const instanceDays = Number(process.env.PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DAYS);
  const settings = resolveClaudeRuntimeSettings(config, env, {
    retentionEnabled: managedClaudeTranscriptRetentionEnabled(),
    retentionDays: Number.isFinite(instanceDays) && instanceDays >= 1 ? Math.floor(instanceDays) : 7,
  });
  if (!settings.transcriptRetentionEnabled) return undefined;
  const overrides = config.managedAiHomeOverrides as Record<string, unknown> | undefined;
  if (overrides?.claudeConfigDir === true) return undefined;
  try {
    const scopeDir = resolveManagedClaudeTranscriptsDir(input.companyId, input.agentId, runtime.sessionIdentity, taskKey);
    const projectsDir = path.join(scopeDir, PROJECTS_DIR);
    await fs.mkdir(projectsDir, { recursive: true, mode: 0o700 });
    const realProjectsDir = await fs.realpath(projectsDir);
    await fs.writeFile(path.join(scopeDir, TASK_FILE), JSON.stringify({ taskKey, retentionDays: settings.transcriptRetentionDays }), { mode: 0o600 });
    await fs.symlink(realProjectsDir, path.join(runtime.home, "provider", PROJECTS_DIR), process.platform === "win32" ? "junction" : "dir");
    onScopeRetained?.();
    return { home: runtime.home, transcriptDir: realProjectsDir };
  } catch (err) {
    logger.warn({ err, agentId: input.agentId }, "Could not retain Claude transcripts; this run will not be resumable");
    return undefined;
  }
}

export type ManagedClaudeTranscriptExpirationOptions = {
  retentionDays?: number;
  maxEntries?: number;
  now?: Date;
  instanceRoot?: string;
  shouldContinue?: () => boolean;
};

export type ManagedClaudeTranscriptExpirationResult = {
  checked: number;
  expired: number;
  clearedTaskSessions: number;
  failed: number;
  truncated: boolean;
  skipped: Record<string, number>;
  nextDueAt: number | null;
};

type Owner = { companyId: string; agentId: string };
type ScopeTask = { taskKey: string; lastUsed: Date; retentionDays?: number };
type Scope = Owner & { dir: string; task: ScopeTask | null };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function isRealDirectory(target: string): Promise<boolean> {
  const stat = await fs.lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

async function readTaskKey(scopeDir: string): Promise<ScopeTask | null> {
  const file = path.join(scopeDir, TASK_FILE);
  const stat = await fs.lstat(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!stat?.isFile() || stat.size > 4096) return null;
  const contents = await fs.readFile(file, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (contents === null) return null;
  try {
    const { taskKey, retentionDays } = JSON.parse(contents) as { taskKey?: unknown; retentionDays?: unknown };
    return typeof taskKey === "string" && taskKey ? {
      taskKey, lastUsed: stat.mtime,
      ...(typeof retentionDays === "number" && Number.isInteger(retentionDays) && retentionDays >= 1 ? { retentionDays } : {}),
    } : null;
  } catch {
    return null;
  }
}

async function readdirIfPresent(target: string): Promise<string[]> {
  return fs.readdir(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
}

async function listTranscriptDirs(root: string): Promise<Owner[]> {
  const found: Owner[] = [];
  const companiesDir = path.join(root, "companies");
  for (const companyId of (await readdirIfPresent(companiesDir)).filter((id) => ID_PATTERN.test(id))) {
    const agentsDir = path.join(companiesDir, companyId, "agents");
    for (const agentId of (await readdirIfPresent(agentsDir)).filter((id) => ID_PATTERN.test(id))) {
      found.push({ companyId, agentId });
    }
  }
  return found;
}

function transcriptsDirOf(root: string, owner: Owner): string {
  return path.join(root, "companies", owner.companyId, "agents", owner.agentId, "claude-transcripts");
}

async function settleLeftovers(transcriptsDir: string) {
  for (const name of await readdirIfPresent(transcriptsDir)) {
    const target = path.join(transcriptsDir, name);
    if (name.startsWith(RETIRING_PREFIX)) {
      const [scope, id] = name.slice(RETIRING_PREFIX.length).split(".");
      if (!SCOPE_PATTERN.test(scope ?? "") || !UUID_PATTERN.test(id ?? "")) continue;
      const original = path.join(transcriptsDir, scope!);
      if (await isRealDirectory(original)) await fs.rm(target, { recursive: true, force: true });
      else await fs.rename(target, original);
    } else if (name.startsWith(EXPIRED_PREFIX) && UUID_PATTERN.test(name.slice(EXPIRED_PREFIX.length))) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
}

function liveRunCondition(scope: Scope, taskKey: string) {
  return and(
    eq(heartbeatRuns.companyId, scope.companyId),
    eq(heartbeatRuns.agentId, scope.agentId),
    ...(UUID_PATTERN.test(taskKey) ? [eq(heartbeatRuns.issueId, taskKey)] : []),
    or(inArray(heartbeatRuns.status, LIVE_RUN_STATUSES), isNull(heartbeatRuns.finishedAt)),
  );
}

type RetentionBlocker = { reason: string; dueAt?: number };

async function retentionBlocker(tx: Tx, scope: Scope, taskKey: string, cutoff: Date, retentionDays: number): Promise<RetentionBlocker | null> {
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)));
  if (!agent) return null;
  if (UUID_PATTERN.test(taskKey)) {
    const [issue] = await tx
      .select({ status: issues.status, completedAt: issues.completedAt, cancelledAt: issues.cancelledAt, updatedAt: issues.updatedAt })
      .from(issues)
      .where(and(eq(issues.id, taskKey), eq(issues.companyId, scope.companyId)))
      .for("share");
    if (issue) {
      if (!CLOSED_ISSUE_STATUSES.includes(issue.status)) return { reason: "issue_open" };
      const closedAt = issue.completedAt ?? issue.cancelledAt;
      if (!closedAt) {
        const updatedAt = new Date(issue.updatedAt);
        if (updatedAt >= cutoff) return { reason: "recently_closed", dueAt: updatedAt.getTime() + retentionDays * DAY_MS };
      }
      if (closedAt && new Date(closedAt) >= cutoff) return { reason: "recently_closed", dueAt: new Date(closedAt).getTime() + retentionDays * DAY_MS };
    }
  }
  return (await hasLiveRun(tx, scope, taskKey)) ? { reason: "live_run" } : null;
}

async function hasLiveRun(db: Db | Tx, scope: Scope, taskKey: string): Promise<boolean> {
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(liveRunCondition(scope, taskKey)).limit(1);
  return Boolean(run);
}

export function managedClaudeTranscriptExpirationService(db: Db, defaults: ManagedClaudeTranscriptExpirationOptions = {}) {
  let sweepDueAt: number | null = null;
  let sweepScopes: Scope[] | null = null;
  const completedScopes = new Set<string>();
  let rescanVersion = 0;
  let scannedRescanVersion = -1;

  async function expireScope(
    scope: Scope,
    now: number,
    defaultRetentionDays: number,
    sessionInUse: boolean,
    result: ManagedClaudeTranscriptExpirationResult,
  ) {
    const skip = (blocker: RetentionBlocker) => {
      result.skipped[blocker.reason] = (result.skipped[blocker.reason] ?? 0) + 1;
      if (blocker.dueAt != null && (result.nextDueAt === null || blocker.dueAt < result.nextDueAt)) result.nextDueAt = blocker.dueAt;
    };
    const currentTask = await readTaskKey(scope.dir);
    const retentionDays = currentTask?.retentionDays ?? defaultRetentionDays;
    const cutoff = new Date(now - retentionDays * DAY_MS);
    scope = { ...scope, task: currentTask };
    if (!currentTask) return skip({ reason: "task_unknown" });
    if (currentTask.lastUsed >= cutoff) return skip({ reason: "recently_used" });
    if (!(await isRealDirectory(scope.dir))) return skip({ reason: "unsafe_path" });

    const id = randomUUID();
    const transcriptsDir = path.dirname(scope.dir);
    const retiring = path.join(transcriptsDir, `${RETIRING_PREFIX}${path.basename(scope.dir)}.${id}`);
    let retired = false;
    let blocker: RetentionBlocker | null;
    try {
      blocker = await db.transaction(async (tx) => {
        const found = await retentionBlocker(tx, scope, currentTask.taskKey, cutoff, retentionDays);
        if (found) return found;
        await fs.rename(scope.dir, retiring);
        retired = true;
        if (await hasLiveRun(tx, scope, currentTask.taskKey)) return { reason: "live_run" };
        if (sessionInUse || await hasRecentSiblingScope(scope, currentTask.taskKey, cutoff)) return null;
        const cleared = await tx
          .delete(agentTaskSessions)
          .where(and(
            eq(agentTaskSessions.companyId, scope.companyId),
            eq(agentTaskSessions.agentId, scope.agentId),
            eq(agentTaskSessions.adapterType, "claude_local"),
            eq(agentTaskSessions.taskKey, currentTask.taskKey),
          ))
          .returning({ id: agentTaskSessions.id });
        result.clearedTaskSessions += cleared.length;
        return null;
      });
    } catch (err) {
      if (retired) await fs.rename(retiring, scope.dir);
      throw err;
    }
    if (blocker) {
      if (retired) await fs.rename(retiring, scope.dir);
      return skip(blocker);
    }
    const trash = path.join(transcriptsDir, `${EXPIRED_PREFIX}${id}`);
    await fs.rename(retiring, trash);
    await fs.rm(trash, { recursive: true, force: true });
    result.expired++;
  }

  async function tick(options: ManagedClaudeTranscriptExpirationOptions = {}) {
    const retentionDays = Math.max(1, options.retentionDays ?? defaults.retentionDays ?? MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DEFAULT_DAYS);
    const maxEntries = Math.max(1, options.maxEntries ?? defaults.maxEntries ?? 200);
    const shouldContinue = options.shouldContinue ?? defaults.shouldContinue ?? (() => true);
    const root = path.resolve(options.instanceRoot ?? defaults.instanceRoot ?? resolvePaperclipInstanceRoot());
    const now = (options.now ?? defaults.now ?? new Date()).getTime();
    const result: ManagedClaudeTranscriptExpirationResult = {
      checked: 0, expired: 0, clearedTaskSessions: 0, failed: 0, truncated: false, skipped: {}, nextDueAt: null,
    };

    if (!sweepScopes || scannedRescanVersion < rescanVersion) {
      const scanVersion = rescanVersion;
      if (sweepScopes && scannedRescanVersion < scanVersion) completedScopes.clear();
      const scopes = new Map((sweepScopes ?? []).map((scope) => [scope.dir, scope]));
      for (const owner of await listTranscriptDirs(root)) {
        const transcriptsDir = transcriptsDirOf(root, owner);
        await settleLeftovers(transcriptsDir);
        for (const name of await readdirIfPresent(transcriptsDir)) {
          if (!SCOPE_PATTERN.test(name)) continue;
          const dir = path.join(transcriptsDir, name);
          scopes.set(dir, { ...owner, dir, task: await readTaskKey(dir) });
        }
      }
      sweepScopes = [...scopes.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
      scannedRescanVersion = scanVersion;
    }
    const scopes = sweepScopes;
    const notYetDue = scopes.filter((scope) => scope.task && scope.task.lastUsed.getTime() >= now - (scope.task.retentionDays ?? retentionDays) * DAY_MS);
    const inUse = new Set(notYetDue.map((scope) => `${path.dirname(scope.dir)}\0${scope.task!.taskKey}`));
    for (const scope of notYetDue) {
      const due = scope.task!.lastUsed.getTime() + (scope.task!.retentionDays ?? retentionDays) * DAY_MS;
      if (result.nextDueAt === null || due < result.nextDueAt) result.nextDueAt = due;
    }
    const pending = scopes.filter((scope) => !completedScopes.has(scope.dir));
    for (const scope of pending) {
      if (!shouldContinue() || result.checked >= maxEntries) {
        result.truncated = true;
        break;
      }
      result.checked++;
      completedScopes.add(scope.dir);
      try {
        const sessionInUse = Boolean(scope.task) && inUse.has(`${path.dirname(scope.dir)}\0${scope.task!.taskKey}`);
        await expireScope(scope, now, retentionDays, sessionInUse, result);
      } catch (err) {
        result.failed++;
        logger.warn({ err, agentId: scope.agentId }, "managed Claude transcript expiration skipped a task");
      }
    }
    if (result.failed > 0) result.nextDueAt = earliest(result.nextDueAt, now + MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS);
    sweepDueAt = earliest(sweepDueAt, result.nextDueAt);
    if (scannedRescanVersion < rescanVersion) {
      result.truncated = true;
      result.nextDueAt = now + 1000;
      return result;
    }
    if (!result.truncated) {
      result.nextDueAt = sweepDueAt;
      sweepDueAt = null;
      sweepScopes = null;
      completedScopes.clear();
    }
    return result;
  }

  return { tick, requestRescan: () => { rescanVersion += 1; } };
}

async function hasRecentSiblingScope(scope: Scope, taskKey: string, cutoff: Date): Promise<boolean> {
  const transcriptsDir = path.dirname(scope.dir);
  for (const name of await readdirIfPresent(transcriptsDir)) {
    if (!SCOPE_PATTERN.test(name)) continue;
    const siblingDir = path.join(transcriptsDir, name);
    if (siblingDir === scope.dir) continue;
    const siblingTask = await readTaskKey(siblingDir);
    if (siblingTask?.taskKey === taskKey && siblingTask.lastUsed >= cutoff) return true;
  }
  return false;
}

function earliest(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

export function registerManagedClaudeTranscriptCleanupWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof managedClaudeTranscriptExpirationService>, "tick"> &
    Partial<Pick<ReturnType<typeof managedClaudeTranscriptExpirationService>, "requestRescan">>,
  onResult: (result: ManagedClaudeTranscriptExpirationResult) => void,
) {
  let next: number | null = null;
  const worker = coordinator.register(DELIVERY_QUEUES.managedClaudeTranscriptCleanup, {
    retryMs: MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS,
    pausePassiveMaintenance: true,
    run: async () => {
      const result = await service.tick();
      onResult(result);
      next = result.truncated ? Date.now() + 1000 : result.nextDueAt;
    },
    hasPending: async () => false,
    onSettled: () => service.requestRescan?.(),
    nextRunAt: () => next,
  });
  onScopeRetained = () => {
    service.requestRescan?.();
    worker.wake();
  };
  return worker;
}
