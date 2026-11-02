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
  runtime: { home: string; sessionIdentity: string } | undefined;
  adapterType: string;
  companyId: string;
  agentId: string;
  taskKey: string | null;
  target: AdapterExecutionTarget | null | undefined;
}): Promise<string | undefined> {
  const { runtime, taskKey } = input;
  if (!managedClaudeTranscriptRetentionEnabled()) return undefined;
  if (!runtime || !taskKey || input.adapterType !== "claude_local" || (input.target && input.target.kind !== "local")) return undefined;
  try {
    const scopeDir = resolveManagedClaudeTranscriptsDir(input.companyId, input.agentId, runtime.sessionIdentity, taskKey);
    const projectsDir = path.join(scopeDir, PROJECTS_DIR);
    await fs.mkdir(projectsDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(scopeDir, TASK_FILE), JSON.stringify({ taskKey }), { mode: 0o600 });
    await fs.symlink(await fs.realpath(projectsDir), path.join(runtime.home, "provider", PROJECTS_DIR));
    onScopeRetained?.();
    return runtime.home;
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
type Scope = Owner & { dir: string; task: { taskKey: string; lastUsed: Date } | null };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function isRealDirectory(target: string): Promise<boolean> {
  const stat = await fs.lstat(target).catch(() => null);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function readTaskKey(scopeDir: string): Promise<{ taskKey: string; lastUsed: Date } | null> {
  const file = path.join(scopeDir, TASK_FILE);
  const stat = await fs.lstat(file).catch((err) => {
    if (isMissing(err)) return null;
    throw err;
  });
  if (!stat || !stat.isFile() || stat.size > 4096) return null;
  const raw = await fs.readFile(file, "utf8").catch((err) => {
    if (isMissing(err)) return null;
    throw err;
  });
  if (raw === null) return null;
  try {
    const { taskKey } = JSON.parse(raw) as { taskKey?: unknown };
    return typeof taskKey === "string" && taskKey ? { taskKey, lastUsed: stat.mtime } : null;
  } catch {
    return null;
  }
}

async function readdirOrFail(dir: string): Promise<{ names: string[]; failed: boolean }> {
  try {
    return { names: await fs.readdir(dir), failed: false };
  } catch (err) {
    return { names: [], failed: !isMissing(err) };
  }
}

async function listTranscriptDirs(root: string): Promise<{ owners: Owner[]; failed: boolean }> {
  const found: Owner[] = [];
  let failed = false;
  const companies = await readdirOrFail(path.join(root, "companies"));
  failed = failed || companies.failed;
  for (const companyId of companies.names.filter((id) => ID_PATTERN.test(id))) {
    const agents = await readdirOrFail(path.join(root, "companies", companyId, "agents"));
    failed = failed || agents.failed;
    for (const agentId of agents.names.filter((id) => ID_PATTERN.test(id))) {
      found.push({ companyId, agentId });
    }
  }
  return { owners: found, failed };
}

function transcriptsDirOf(root: string, owner: Owner): string {
  return path.join(root, "companies", owner.companyId, "agents", owner.agentId, "claude-transcripts");
}

async function settleLeftovers(transcriptsDir: string) {
  for (const name of await fs.readdir(transcriptsDir).catch(() => [] as string[])) {
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
  const recheckAt = cutoff.getTime() + (retentionDays + 1) * DAY_MS;
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)));
  if (!agent) return null;
  if (UUID_PATTERN.test(taskKey)) {
    const [issue] = await tx
      .select({ status: issues.status, completedAt: issues.completedAt, cancelledAt: issues.cancelledAt })
      .from(issues)
      .where(and(eq(issues.id, taskKey), eq(issues.companyId, scope.companyId)))
      .for("share");
    if (issue) {
      if (!CLOSED_ISSUE_STATUSES.includes(issue.status)) return { reason: "issue_open", dueAt: recheckAt };
      const closedAt = issue.completedAt ?? issue.cancelledAt;
      if (!closedAt) return { reason: "recently_closed", dueAt: recheckAt };
      if (new Date(closedAt) >= cutoff) return { reason: "recently_closed", dueAt: new Date(closedAt).getTime() + retentionDays * DAY_MS };
    }
  }
  return (await hasLiveRun(tx, scope, taskKey)) ? { reason: "live_run", dueAt: recheckAt } : null;
}

async function hasLiveRun(db: Db | Tx, scope: Scope, taskKey: string): Promise<boolean> {
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(liveRunCondition(scope, taskKey)).limit(1);
  return Boolean(run);
}

export function managedClaudeTranscriptExpirationService(db: Db, defaults: ManagedClaudeTranscriptExpirationOptions = {}) {
  let cursor: string | null = null;
  let sweepDueAt: number | null = null;

  async function expireScope(
    scope: Scope,
    cutoff: Date,
    retentionDays: number,
    sessionInUse: boolean,
    result: ManagedClaudeTranscriptExpirationResult,
  ) {
    const skip = (blocker: RetentionBlocker) => {
      result.skipped[blocker.reason] = (result.skipped[blocker.reason] ?? 0) + 1;
      if (blocker.dueAt != null && (result.nextDueAt === null || blocker.dueAt < result.nextDueAt)) result.nextDueAt = blocker.dueAt;
    };
    const { task } = scope;
    if (!task) return skip({ reason: "task_unknown" });
    if (task.lastUsed >= cutoff) return skip({ reason: "recently_used" });
    if (!(await isRealDirectory(scope.dir))) return skip({ reason: "unsafe_path" });

    const id = randomUUID();
    const transcriptsDir = path.dirname(scope.dir);
    const retiring = path.join(transcriptsDir, `${RETIRING_PREFIX}${path.basename(scope.dir)}.${id}`);
    let retired = false;
    let blocker: RetentionBlocker | null;
    try {
      blocker = await db.transaction(async (tx) => {
        const found = await retentionBlocker(tx, scope, task.taskKey, cutoff, retentionDays);
        if (found) return found;
        await fs.rename(scope.dir, retiring);
        retired = true;
        if (await hasLiveRun(tx, scope, task.taskKey)) return { reason: "live_run", dueAt: cutoff.getTime() + (retentionDays + 1) * DAY_MS };
        if (sessionInUse) return null;
        const cleared = await tx
          .delete(agentTaskSessions)
          .where(and(
            eq(agentTaskSessions.companyId, scope.companyId),
            eq(agentTaskSessions.agentId, scope.agentId),
            eq(agentTaskSessions.adapterType, "claude_local"),
            eq(agentTaskSessions.taskKey, task.taskKey),
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
    const cutoff = new Date(now - retentionDays * DAY_MS);
    const result: ManagedClaudeTranscriptExpirationResult = {
      checked: 0, expired: 0, clearedTaskSessions: 0, failed: 0, truncated: false, skipped: {}, nextDueAt: null,
    };

    const scopes: Scope[] = [];
    const { owners, failed: listingFailed } = await listTranscriptDirs(root);
    if (listingFailed) result.failed++;
    for (const owner of owners) {
      const transcriptsDir = transcriptsDirOf(root, owner);
      await settleLeftovers(transcriptsDir).catch((err) => logger.warn({ err }, "managed Claude transcript cleanup skipped leftovers"));
      const { names, failed: scanFailed } = await readdirOrFail(transcriptsDir);
      if (scanFailed) {
        result.failed++;
        logger.warn({ ...owner }, "managed Claude transcript cleanup could not list a transcripts directory");
        continue;
      }
      for (const name of names) {
        if (!SCOPE_PATTERN.test(name)) continue;
        const dir = path.join(transcriptsDir, name);
        try {
          scopes.push({ ...owner, dir, task: await readTaskKey(dir) });
        } catch (err) {
          result.failed++;
          logger.warn({ err, ...owner }, "managed Claude transcript cleanup could not read a task file");
        }
      }
    }
    const notYetDue = scopes.filter((scope) => scope.task && scope.task.lastUsed >= cutoff);
    const inUse = new Set(notYetDue.map((scope) => `${path.dirname(scope.dir)}\0${scope.task!.taskKey}`));
    for (const scope of notYetDue) {
      const due = scope.task!.lastUsed.getTime() + retentionDays * DAY_MS;
      if (result.nextDueAt === null || due < result.nextDueAt) result.nextDueAt = due;
    }
    scopes.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
    const pending = cursor ? scopes.filter((scope) => scope.dir > cursor!) : scopes;
    for (const scope of pending) {
      if (!shouldContinue() || result.checked >= maxEntries) {
        result.truncated = true;
        break;
      }
      result.checked++;
      cursor = scope.dir;
      try {
        const sessionInUse = Boolean(scope.task) && inUse.has(`${path.dirname(scope.dir)}\0${scope.task!.taskKey}`);
        await expireScope(scope, cutoff, retentionDays, sessionInUse, result);
      } catch (err) {
        result.failed++;
        logger.warn({ err, agentId: scope.agentId }, "managed Claude transcript expiration skipped a task");
      }
    }
    if (result.failed > 0) result.nextDueAt = earliest(result.nextDueAt, now + MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS);
    sweepDueAt = earliest(sweepDueAt, result.nextDueAt);
    if (!result.truncated) {
      result.nextDueAt = sweepDueAt;
      cursor = null;
      sweepDueAt = null;
    }
    return result;
  }

  return { tick };
}

function earliest(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

export function registerManagedClaudeTranscriptCleanupWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof managedClaudeTranscriptExpirationService>,
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
    nextRunAt: () => next,
  });
  onScopeRetained = () => worker.wake();
  return worker;
}
