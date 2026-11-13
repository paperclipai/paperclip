import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { toolInvocations, type Db } from "@paperclipai/db";
import {
  normalizeToolCallProgress,
  type LiveEventType,
  type ToolCallProgress,
  type ToolCallProgressSnapshot,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { assignedToolName } from "./native-runtime/assigned-mcp-tools.js";

/**
 * Live progress for a connected-app tool call that an agent run made.
 *
 * The provider streams MCP `notifications/progress` on the call's response.
 * Each update is published to the run's viewers at most every
 * PUBLISH_INTERVAL_MS (the latest one wins) and saved on the invocation at
 * most every SAVE_INTERVAL_MS, so a reload mid-call shows the latest state.
 * Nothing here is awaited by the call: the result is never delayed.
 */
export const TOOL_CALL_PROGRESS_PUBLISH_INTERVAL_MS = 250;
export const TOOL_CALL_PROGRESS_SAVE_INTERVAL_MS = 1_000;
export const TOOL_CALL_PROGRESS_EVENT: LiveEventType = "heartbeat.run.tool_progress";
/** Progress older than this is not shown after a reload (the call is long gone). */
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;

export interface ToolCallProgressReporter {
  /** Sent as the request's `_meta.progressToken`. */
  readonly token: string;
  /** Records a provider update. Never throws, never blocks. */
  report(update: { progress: unknown; total?: unknown; message?: unknown }): void;
  /** The call ended: stop timers and tell viewers to drop the progress. */
  finish(): void;
}

type Publish = (input: { companyId: string; type: LiveEventType; payload: Record<string, unknown> }) => void;
type Save = (progress: ToolCallProgress) => Promise<void>;

/** Leading-edge throttle that keeps only the latest value for its trailing run. */
function latestThrottle<T>(intervalMs: number, run: (value: T) => void) {
  let lastAt = -Infinity;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastAt = Date.now();
    run(value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (timer) return;
      const wait = lastAt + intervalMs - Date.now();
      if (wait <= 0) flush();
      else { timer = setTimeout(flush, wait); timer.unref?.(); }
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

export function createToolCallProgressReporter(input: {
  companyId: string;
  runId: string;
  issueId: string | null;
  agentId: string | null;
  invocationId: string;
  toolName: string;
  startedAt?: Date;
  publish?: Publish;
  save?: Save;
}): ToolCallProgressReporter {
  const publish: Publish = input.publish ?? ((event) => { publishLiveEvent(event); });
  const startedAt = (input.startedAt ?? new Date()).toISOString();
  const token = `paperclip-progress-${randomUUID()}`;
  let finished = false;
  let last: ToolCallProgress | null = null;
  const snapshot = (progress: ToolCallProgress, done: boolean): ToolCallProgressSnapshot => ({
    ...progress, invocationId: input.invocationId, runId: input.runId, toolName: input.toolName,
    nativeToolName: assignedToolName(input.toolName), startedAt, done,
  });
  const send = (value: ToolCallProgressSnapshot) => {
    try {
      publish({
        companyId: input.companyId,
        type: TOOL_CALL_PROGRESS_EVENT,
        payload: { ...value, issueId: input.issueId, agentId: input.agentId },
      });
    } catch (err) {
      logger.debug({ err, invocationId: input.invocationId }, "tool call progress publish failed");
    }
  };
  const live = latestThrottle<ToolCallProgress>(TOOL_CALL_PROGRESS_PUBLISH_INTERVAL_MS, (progress) => send(snapshot(progress, false)));
  // At most one save in flight; while it runs only the newest update waits.
  let saving = false;
  let queuedSave: ToolCallProgress | null = null;
  const save = (progress: ToolCallProgress) => {
    if (!input.save || finished) return;
    if (saving) { queuedSave = progress; return; }
    saving = true;
    input.save(progress)
      .catch((err) => logger.debug({ err, invocationId: input.invocationId }, "tool call progress save failed"))
      .finally(() => {
        saving = false;
        const next = queuedSave;
        queuedSave = null;
        if (next) save(next);
      });
  };
  const saved = latestThrottle<ToolCallProgress>(TOOL_CALL_PROGRESS_SAVE_INTERVAL_MS, save);
  return {
    token,
    report(update) {
      if (finished) return;
      const progress = normalizeToolCallProgress(update);
      // Progress must increase; a lower value is out of order and is dropped.
      if (!progress || (last && progress.progress < last.progress)) return;
      last = progress;
      live.push(progress);
      if (input.save) saved.push(progress);
    },
    finish() {
      if (finished) return;
      finished = true;
      live.cancel();
      saved.cancel();
      queuedSave = null;
      if (last) send(snapshot(last, true));
    },
  };
}

/** Saves a running call's latest progress. A finished call is never touched. */
export function saveToolCallProgress(db: Db, companyId: string, invocationId: string): Save {
  return async (progress) => {
    await db.update(toolInvocations)
      .set({ progress })
      .where(and(eq(toolInvocations.id, invocationId), eq(toolInvocations.companyId, companyId), isNull(toolInvocations.completedAt)));
  };
}

/** Finished calls are reported for this long, so a chat that missed their end learns it. */
const FINISHED_REPORT_MS = 60 * 60_000;

/**
 * The latest progress of a task's running tool calls, for a reload mid-call,
 * plus its recently finished calls marked `done`. A chat drops a call only on
 * `done`: a running call may not have saved its first update yet.
 */
export async function listToolCallProgress(db: Db, companyId: string, issueId: string, now = new Date()): Promise<ToolCallProgressSnapshot[]> {
  const columns = {
    id: toolInvocations.id,
    runId: toolInvocations.runId,
    toolName: toolInvocations.toolName,
    progress: toolInvocations.progress,
    startedAt: toolInvocations.startedAt,
    createdAt: toolInvocations.createdAt,
    completedAt: toolInvocations.completedAt,
  };
  const task = and(eq(toolInvocations.companyId, companyId), eq(toolInvocations.issueId, issueId), isNotNull(toolInvocations.runId));
  const [running, finished] = await Promise.all([
    db.select(columns).from(toolInvocations).where(and(task,
      isNull(toolInvocations.completedAt),
      isNotNull(toolInvocations.progress),
      gte(toolInvocations.createdAt, new Date(now.getTime() - SNAPSHOT_MAX_AGE_MS)),
    )).orderBy(desc(toolInvocations.createdAt)).limit(50),
    db.select(columns).from(toolInvocations).where(and(task,
      gte(toolInvocations.completedAt, new Date(now.getTime() - FINISHED_REPORT_MS)),
    )).orderBy(desc(toolInvocations.completedAt)).limit(50),
  ]);
  return [...running, ...finished].flatMap((row) => {
    const done = row.completedAt !== null;
    const savedAt = row.progress ? Date.parse(String(row.progress.updatedAt)) : NaN;
    const at = done ? row.completedAt! : Number.isFinite(savedAt) ? new Date(savedAt) : now;
    const progress = normalizeToolCallProgress(row.progress ?? (done ? { progress: 0 } : {}), at);
    if (!progress || !row.runId) return [];
    return [{
      ...progress,
      invocationId: row.id,
      runId: row.runId,
      toolName: row.toolName,
      nativeToolName: assignedToolName(row.toolName),
      startedAt: (row.startedAt ?? row.createdAt).toISOString(),
      done,
    }];
  });
}
