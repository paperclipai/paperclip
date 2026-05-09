import type { Db } from "@paperclipai/db";
import { readFileSync } from "node:fs";
import { agentService } from "./agents.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import {
  buildBookforgeRepairIssueDraft,
  dispatchBookforgeIncident,
} from "./bookforge-incident-dispatcher.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

type LoggerLike = {
  info?(obj: Record<string, unknown>, msg?: string): void;
  warn?(obj: Record<string, unknown>, msg?: string): void;
  error?(obj: Record<string, unknown>, msg?: string): void;
};

export interface BookforgeQueueAttention {
  state?: string | null;
  chapter?: number | null;
  item_id?: string | null;
  project_name?: string | null;
  yaml?: string | null;
  reason?: string | null;
  next_action?: string | null;
  locked_reason?: string | null;
  locked_strategy?: string | null;
}

export interface BookforgeQueueItem {
  id?: string | null;
  yaml?: string | null;
  project_name?: string | null;
  status?: string | null;
  activity?: string | null;
  chapter?: number | null;
  completed_chapters?: number | null;
  cost_usd?: number | null;
}

export interface BookforgeQueueSnapshot {
  counts?: Record<string, number> | null;
  attention?: BookforgeQueueAttention | null;
  items?: BookforgeQueueItem[] | null;
}

export interface BookforgeWorkerSnapshot {
  running?: boolean | null;
  paused?: boolean | null;
  stop_requested?: boolean | null;
  current_item_id?: string | null;
}

export interface BookforgeApprovedTargetPolicy {
  yaml?: string | null;
  itemId?: string | null;
  projectName?: string | null;
}

function readApprovedTargetFile(filePath: string | null | undefined): BookforgeApprovedTargetPolicy | null {
  const path = clean(filePath);
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      yaml: clean(parsed.yaml as string | null | undefined),
      itemId: clean((parsed.itemId ?? parsed.item_id) as string | null | undefined),
      projectName: clean((parsed.projectName ?? parsed.project_name) as string | null | undefined),
    };
  } catch {
    return null;
  }
}

function mergeApprovedTargetPolicy(
  staticPolicy: BookforgeApprovedTargetPolicy | null | undefined,
  filePolicy: BookforgeApprovedTargetPolicy | null,
): BookforgeApprovedTargetPolicy | null {
  if (!filePolicy) return staticPolicy ?? null;
  return {
    yaml: filePolicy.yaml ?? staticPolicy?.yaml ?? null,
    itemId: filePolicy.itemId ?? staticPolicy?.itemId ?? null,
    projectName: filePolicy.projectName ?? staticPolicy?.projectName ?? null,
  };
}

export interface BookforgeTargetMismatch {
  approvedYaml?: string | null;
  approvedItemId?: string | null;
  approvedProjectName?: string | null;
  liveYaml?: string | null;
  liveItemId?: string | null;
  liveProjectName?: string | null;
  liveStatus?: string | null;
  liveActivity?: string | null;
  liveChapter?: number | null;
  liveCompletedChapters?: number | null;
  liveCostUsd?: number | null;
  reason: string;
}

export function buildBookforgeQualityHoldSummary(queue: BookforgeQueueSnapshot) {
  const attention = queue.attention;
  if (!attention || attention.state !== "quality_hold") return null;
  const project = attention.project_name ?? attention.yaml ?? "unknown project";
  const chapter = attention.chapter ?? "unknown";
  const reason = attention.reason ?? attention.locked_reason ?? "Bookforge quality hold detected.";
  const nextAction = attention.next_action ?? "Repair and verify before resume.";
  return [
    `BOOKFORGE QUALITY HOLD — ${project} chapter ${chapter}`,
    `Queue item: ${attention.item_id ?? "unknown"}`,
    `State: ${attention.state}`,
    `Strategy: ${attention.locked_strategy ?? "unknown"}`,
    `Next action: ${nextAction}`,
    "Reason:",
    reason,
  ].join("\n");
}

function clean(value: string | null | undefined) {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : null;
}

function findQueueItemById(queue: BookforgeQueueSnapshot, itemId: string | null | undefined) {
  const wanted = clean(itemId);
  if (!wanted) return null;
  return (queue.items ?? []).find((item) => clean(item.id) === wanted) ?? null;
}

function findRunningQueueItem(queue: BookforgeQueueSnapshot) {
  return (queue.items ?? []).find((item) => clean(item.status) === "running") ?? null;
}

function matchesApprovedTarget(item: BookforgeQueueItem | null, approved: BookforgeApprovedTargetPolicy) {
  if (!item) return false;
  const approvedItemId = clean(approved.itemId);
  const approvedYaml = clean(approved.yaml);
  const approvedProjectName = clean(approved.projectName);
  return Boolean(
    (approvedItemId && clean(item.id) === approvedItemId) ||
      (approvedYaml && clean(item.yaml) === approvedYaml) ||
      (approvedProjectName && clean(item.project_name) === approvedProjectName),
  );
}

export function findBookforgeApprovedTargetMismatch(
  queue: BookforgeQueueSnapshot,
  worker: BookforgeWorkerSnapshot,
  approved: BookforgeApprovedTargetPolicy | null | undefined,
): BookforgeTargetMismatch | null {
  const approvedYaml = clean(approved?.yaml);
  const approvedItemId = clean(approved?.itemId);
  const approvedProjectName = clean(approved?.projectName);
  if (!approvedYaml && !approvedItemId && !approvedProjectName) return null;
  if (!worker.running || worker.paused || worker.stop_requested) return null;

  const liveItem = findQueueItemById(queue, worker.current_item_id) ?? findRunningQueueItem(queue);
  if (!liveItem) {
    return {
      approvedYaml,
      approvedItemId,
      approvedProjectName,
      liveItemId: clean(worker.current_item_id),
      reason: "worker_running_without_queue_item",
    };
  }
  if (matchesApprovedTarget(liveItem, { yaml: approvedYaml, itemId: approvedItemId, projectName: approvedProjectName })) {
    return null;
  }
  return {
    approvedYaml,
    approvedItemId,
    approvedProjectName,
    liveYaml: clean(liveItem.yaml),
    liveItemId: clean(liveItem.id),
    liveProjectName: clean(liveItem.project_name),
    liveStatus: clean(liveItem.status),
    liveActivity: clean(liveItem.activity),
    liveChapter: liveItem.chapter ?? null,
    liveCompletedChapters: liveItem.completed_chapters ?? null,
    liveCostUsd: liveItem.cost_usd ?? null,
    reason: "approved_target_mismatch",
  };
}

export function buildBookforgeTargetMismatchSummary(mismatch: BookforgeTargetMismatch) {
  return [
    "BOOKFORGE WRONG-BOOK TARGET MISMATCH",
    `Approved target: ${mismatch.approvedYaml ?? mismatch.approvedProjectName ?? mismatch.approvedItemId ?? "unknown"}`,
    `Approved queue item: ${mismatch.approvedItemId ?? "unknown"}`,
    `Live target: ${mismatch.liveYaml ?? mismatch.liveProjectName ?? "unknown"}`,
    `Live queue item: ${mismatch.liveItemId ?? "unknown"}`,
    `Live status: ${mismatch.liveStatus ?? "unknown"}`,
    `Live activity: ${mismatch.liveActivity ?? "unknown"}`,
    `Live chapter: ${mismatch.liveChapter ?? "unknown"}`,
    `Completed chapters: ${mismatch.liveCompletedChapters ?? "unknown"}`,
    `Visible cost USD: ${mismatch.liveCostUsd ?? "unknown"}`,
    `Reason: ${mismatch.reason}`,
    "Paperclip must use the current approved target policy, start a fresh Bookforge incident session, and must not apply stale old-book policy.",
  ].join("\n");
}

async function readJson(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function hasApprovedTargetPolicy(approved: BookforgeApprovedTargetPolicy | null | undefined) {
  return Boolean(clean(approved?.yaml) || clean(approved?.itemId) || clean(approved?.projectName));
}

export function createBookforgeRuntimeMonitor(
  db: Db,
  opts: {
    companyId: string;
    bookforgeBaseUrl?: string;
    intervalMs?: number;
    logger?: LoggerLike;
    approvedTarget?: BookforgeApprovedTargetPolicy | null;
    approvedTargetFile?: string | null;
  },
) {
  const companyId = opts.companyId;
  const bookforgeBaseUrl = (opts.bookforgeBaseUrl ?? "http://127.0.0.1:5012").replace(/\/$/, "");
  const intervalMs = Math.max(15_000, opts.intervalMs ?? 60_000);
  const logger = opts.logger;
  const staticApprovedTarget = opts.approvedTarget ?? null;
  const approvedTargetFile = opts.approvedTargetFile ?? null;
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);
  const issues = issueService(db);
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let lastDispatchedSummary: string | null = null;

  async function pollOnce() {
    if (inFlight) return { dispatched: false, skipped: true, reason: "poll_in_flight" };
    inFlight = true;
    try {
      const queue = await readJson(`${bookforgeBaseUrl}/api/queue`) as BookforgeQueueSnapshot;
      const approvedTarget = mergeApprovedTargetPolicy(staticApprovedTarget, readApprovedTargetFile(approvedTargetFile));
      const worker = hasApprovedTargetPolicy(approvedTarget)
        ? await readJson(`${bookforgeBaseUrl}/api/worker`) as BookforgeWorkerSnapshot
        : null;
      const mismatch = worker ? findBookforgeApprovedTargetMismatch(queue, worker, approvedTarget) : null;
      const summary = mismatch
        ? buildBookforgeTargetMismatchSummary(mismatch)
        : buildBookforgeQualityHoldSummary(queue);
      const incidentKind = mismatch ? "bookforge_wrong_book_target_mismatch" : "canon_continuity";
      const severity = mismatch ? "critical" : "high";
      const maxFanout = mismatch ? 5 : 3;
      if (!summary) return { dispatched: false, skipped: false, reason: "no_actionable_bookforge_incident" };
      if (summary === lastDispatchedSummary) {
        return { dispatched: false, skipped: true, reason: mismatch ? "duplicate_target_mismatch" : "duplicate_quality_hold" };
      }

      const allAgents = await agents.list(companyId);
      const source = {
        agents: allAgents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
        sourceAgentName: "Bookforge Watchman",
        issueId: mismatch?.liveItemId ?? queue.attention?.item_id ?? null,
        incidentKind,
        severity,
        summary,
        maxFanout,
      };
      const result = await dispatchBookforgeIncident({
        ...source,
        wakeup: heartbeat.wakeup,
      });
      const repairIssueDraft = buildBookforgeRepairIssueDraft({ plan: result, source });
      let repairIssue = null;
      if (repairIssueDraft) {
        const existing = await issues.list(companyId, {
          q: repairIssueDraft.title,
          status: "todo,in_progress,in_review,blocked",
          limit: 10,
        });
        repairIssue = existing.find((issue) => issue.title === repairIssueDraft.title) ?? null;
        if (!repairIssue) {
          repairIssue = await issues.create(companyId, {
            title: repairIssueDraft.title,
            description: repairIssueDraft.description,
            priority: repairIssueDraft.priority,
            status: repairIssueDraft.status,
            assigneeAgentId: repairIssueDraft.assigneeAgentId,
            originKind: repairIssueDraft.originKind,
            originId: repairIssueDraft.originId,
          });
        }
        if (repairIssue.status === "todo") {
          await queueIssueAssignmentWakeup({
            heartbeat,
            issue: repairIssue,
            reason: "bookforge_monitor_quality_hold",
            mutation: "bookforge_runtime_monitor",
            contextSource: "bookforge.runtime.monitor",
            requestedByActorType: "system",
            requestedByActorId: null,
            rethrowOnError: true,
          });
        } else {
          logger?.info?.(
            { companyId, repairIssueId: repairIssue.id, status: repairIssue.status },
            "Bookforge runtime monitor found existing repair gate; not re-waking non-todo issue",
          );
        }
      }
      lastDispatchedSummary = summary;
      logger?.warn?.(
        { companyId, repairIssueId: repairIssue?.id ?? null, targets: result.targets.length, incidentKind },
        mismatch
          ? "Bookforge runtime monitor dispatched wrong-target incident to Paperclip"
          : "Bookforge runtime monitor dispatched quality-hold incident to Paperclip",
      );
      return { dispatched: true, skipped: false, reason: mismatch ? "target_mismatch" : "quality_hold", repairIssueId: repairIssue?.id ?? null };
    } finally {
      inFlight = false;
    }
  }

  return {
    pollOnce,
    start() {
      if (timer) return;
      void pollOnce().catch((err) => logger?.error?.({ err }, "Bookforge runtime monitor startup poll failed"));
      timer = setInterval(() => {
        void pollOnce().catch((err) => logger?.error?.({ err }, "Bookforge runtime monitor poll failed"));
      }, intervalMs);
      timer.unref?.();
      logger?.info?.({ companyId, bookforgeBaseUrl, intervalMs }, "Bookforge runtime monitor started");
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
