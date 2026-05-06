import type { Db } from "@paperclipai/db";
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

export interface BookforgeQueueSnapshot {
  counts?: Record<string, number> | null;
  attention?: BookforgeQueueAttention | null;
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

async function readJson(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

export function createBookforgeRuntimeMonitor(
  db: Db,
  opts: {
    companyId: string;
    bookforgeBaseUrl?: string;
    intervalMs?: number;
    logger?: LoggerLike;
  },
) {
  const companyId = opts.companyId;
  const bookforgeBaseUrl = (opts.bookforgeBaseUrl ?? "http://127.0.0.1:5012").replace(/\/$/, "");
  const intervalMs = Math.max(15_000, opts.intervalMs ?? 60_000);
  const logger = opts.logger;
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
      const summary = buildBookforgeQualityHoldSummary(queue);
      if (!summary) return { dispatched: false, skipped: false, reason: "no_quality_hold" };
      if (summary === lastDispatchedSummary) {
        return { dispatched: false, skipped: true, reason: "duplicate_quality_hold" };
      }

      const allAgents = await agents.list(companyId);
      const source = {
        agents: allAgents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
        sourceAgentName: "Bookforge Watchman",
        issueId: queue.attention?.item_id ?? null,
        incidentKind: "canon_continuity",
        severity: "high",
        summary,
        maxFanout: 3,
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
        { companyId, repairIssueId: repairIssue?.id ?? null, targets: result.targets.length },
        "Bookforge runtime monitor dispatched quality-hold incident to Paperclip",
      );
      return { dispatched: true, skipped: false, reason: "quality_hold", repairIssueId: repairIssue?.id ?? null };
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
