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

// A freshly retained scope is new work the cleanup worker does not know about
// yet. Set once at startup by registerManagedClaudeTranscriptCleanupWork, so a
// worker that went idle (nothing to expire) wakes instead of staying asleep
// until some unrelated event happens to touch it.
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
  /** Earliest time a known scope becomes due, or null with nothing left to wait on. */
  nextDueAt: number | null;
};

type Owner = { companyId: string; agentId: string };
type Scope = Owner & { dir: string; task: { taskKey: string; lastUsed: Date } | null };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function isRealDirectory(target: string): Promise<boolean> {
  const stat = await fs.lstat(target).catch(() => null);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

async function readTaskKey(scopeDir: string): Promise<{ taskKey: string; lastUsed: Date } | null> {
  try {
    const file = path.join(scopeDir, TASK_FILE);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 4096) return null;
    const { taskKey } = JSON.parse(await fs.readFile(file, "utf8")) as { taskKey?: unknown };
    return typeof taskKey === "string" && taskKey ? { taskKey, lastUsed: stat.mtime } : null;
  } catch {
    return null;
  }
}

async function listTranscriptDirs(root: string): Promise<Owner[]> {
  const found: Owner[] = [];
  const companiesDir = path.join(root, "companies");
  for (const companyId of (await fs.readdir(companiesDir).catch(() => [] as string[])).filter((id) => ID_PATTERN.test(id))) {
    const agentsDir = path.join(companiesDir, companyId, "agents");
    for (const agentId of (await fs.readdir(agentsDir).catch(() => [] as string[])).filter((id) => ID_PATTERN.test(id))) {
      found.push({ companyId, agentId });
    }
  }
  return found;
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

// `dueAt` is set only when the blocker will lift on its own at a known time
// (a closed issue's retention window), so the caller can schedule the next
// pass instead of relying solely on another scope's deadline to wake it.
type RetentionBlocker = { reason: string; dueAt?: number };

async function retentionBlocker(tx: Tx, scope: Scope, taskKey: string, cutoff: Date, retentionDays: number): Promise<RetentionBlocker | null> {
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
      if (!CLOSED_ISSUE_STATUSES.includes(issue.status)) return { reason: "issue_open" };
      const closedAt = issue.completedAt ?? issue.cancelledAt;
      if (!closedAt) return { reason: "recently_closed" };
      if (new Date(closedAt) >= cutoff) return { reason: "recently_closed", dueAt: new Date(closedAt).getTime() + retentionDays * DAY_MS };
    }
  }
  return (await hasLiveRun(tx, scope, taskKey)) ? { reason: "live_run" } : null;
}

async function hasLiveRun(db: Db | Tx, scope: Scope, taskKey: string): Promise<boolean> {
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(liveRunCondition(scope, taskKey)).limit(1);
  return Boolean(run);
}

export function managedClaudeTranscriptExpirationService(db: Db, defaults: ManagedClaudeTranscriptExpirationOptions = {}) {
  let cursor: string | null = null;

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
        if (await hasLiveRun(tx, scope, task.taskKey)) return { reason: "live_run" };
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
    const cutoff = new Date((options.now ?? defaults.now ?? new Date()).getTime() - retentionDays * DAY_MS);
    const result: ManagedClaudeTranscriptExpirationResult = {
      checked: 0, expired: 0, clearedTaskSessions: 0, failed: 0, truncated: false, skipped: {}, nextDueAt: null,
    };

    const scopes: Scope[] = [];
    for (const owner of await listTranscriptDirs(root)) {
      const transcriptsDir = transcriptsDirOf(root, owner);
      await settleLeftovers(transcriptsDir).catch((err) => logger.warn({ err }, "managed Claude transcript cleanup skipped leftovers"));
      for (const name of await fs.readdir(transcriptsDir).catch(() => [] as string[])) {
        if (!SCOPE_PATTERN.test(name)) continue;
        const dir = path.join(transcriptsDir, name);
        scopes.push({ ...owner, dir, task: await readTaskKey(dir) });
      }
    }
    const notYetDue = scopes.filter((scope) => scope.task && scope.task.lastUsed >= cutoff);
    const inUse = new Set(notYetDue.map((scope) => `${path.dirname(scope.dir)}\0${scope.task!.taskKey}`));
    // An open issue or a live run has no predictable due time; those scopes
    // are swept opportunistically whenever this fires for another reason.
    // A recently-closed issue's own due time is set below, once expireScope
    // re-reads it inside the transaction.
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
    if (!result.truncated) cursor = null;
    return result;
  }

  return { tick };
}

export function registerManagedClaudeTranscriptCleanupWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof managedClaudeTranscriptExpirationService>,
  onResult: (result: ManagedClaudeTranscriptExpirationResult) => void,
) {
  let next: number | null = null;
  const worker = coordinator.register(DELIVERY_QUEUES.managedClaudeTranscriptCleanup, {
    retryMs: MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS,
    run: async () => {
      const result = await service.tick();
      onResult(result);
      // A failed directory is retried on the next full pass (the cursor
      // resets whenever the pass was not truncated), so a transient error
      // must not leave `next` on a distant or absent deadline.
      const retryAt = result.failed > 0 ? Date.now() + MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS : null;
      const dueAt = retryAt === null ? result.nextDueAt : result.nextDueAt === null ? retryAt : Math.min(result.nextDueAt, retryAt);
      // A truncated pass has more of the current batch to go; come straight
      // back rather than waiting for the next real deadline.
      next = result.truncated ? Date.now() + 1000 : dueAt;
    },
    hasPending: async () => false,
    nextRunAt: () => next,
  });
  // The coordinator preserves a wake received while a pass is already
  // running, so every retained scope can forward here unconditionally.
  onScopeRetained = () => worker.wake();
  return worker;
}
