// Horizon Scan Action Executor (§2, VOG-5810)
// Performs API side-effects for detected anomalies.
// Idempotency: 24h dedup window keyed on <anomalyType>:<issueId|agentId>.

import type { Anomaly } from "./horizon-scan.js";

// ────────────────────────────────────────────────
// Dedup store — injectable for testing
// ────────────────────────────────────────────────

// NOTE: in-memory dedup — resets on process restart. For v1 this is acceptable;
// a persistent hs_dedup_log table is planned for Week 3 (VOG-6113).
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export interface DedupStore {
  has(key: string): boolean;
  set(key: string, expiresAt: number): void;
  /** Purge expired entries. */
  prune(now?: Date): void;
}

export function createInMemoryDedupStore(): DedupStore {
  const store = new Map<string, number>();
  return {
    has(key) {
      const exp = store.get(key);
      if (exp === undefined) return false;
      if (Date.now() > exp) {
        store.delete(key);
        return false;
      }
      return true;
    },
    set(key, expiresAt) {
      store.set(key, expiresAt);
    },
    prune(now = new Date()) {
      const ts = now.getTime();
      for (const [k, exp] of store) {
        if (ts > exp) store.delete(k);
      }
    },
  };
}

function dedupKey(anomaly: Anomaly): string {
  const scope = anomaly.issueId ?? anomaly.agentId ?? "global";
  return `${anomaly.type}:${scope}`;
}

// ────────────────────────────────────────────────
// API client interface — injectable for testing
// ────────────────────────────────────────────────

export interface ActionApiClient {
  /** Post a comment on an issue. */
  postComment(issueId: string, body: string): Promise<void>;
  /** Create a child issue assigned to the CTO agent. */
  createChildIssue(params: {
    companyId: string;
    parentId?: string;
    title: string;
    assigneeAgentId: string;
    goalId?: string;
  }): Promise<string>;
  /** Request platform-ops to send a Feishu DM. */
  sendFeishuDM(message: string): Promise<void>;
}

export function createHttpApiClient(
  apiUrl: string,
  apiKey: string,
  runId: string,
): ActionApiClient {
  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "X-Paperclip-Run-Id": runId,
    "Content-Type": "application/json",
  };

  return {
    async postComment(issueId, body) {
      const res = await fetch(`${apiUrl}/api/issues/${issueId}/comments`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`postComment failed: ${res.status}`);
    },

    async createChildIssue({ companyId, parentId, title, assigneeAgentId, goalId }) {
      const res = await fetch(`${apiUrl}/api/companies/${companyId}/issues`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          title,
          parentId,
          assigneeAgentId,
          goalId,
          status: "todo",
          priority: "critical",
        }),
      });
      if (!res.ok) throw new Error(`createChildIssue failed: ${res.status}`);
      const data = (await res.json()) as { id: string };
      return data.id;
    },

    async sendFeishuDM(message) {
      // Delegate to platform-ops agent via remote-trigger pattern.
      // platform-ops reads FEISHU_DM_MESSAGE from the trigger payload.
      const res = await fetch(`${apiUrl}/api/agents/me/self-wake`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          delaySeconds: 60,
          reason: "feishu_dm_request",
          payload: { feishu_dm_message: message },
          idempotencyKey: `feishu-dm:${Date.now()}`,
        }),
      });
      if (!res.ok) throw new Error(`sendFeishuDM wake failed: ${res.status}`);
    },
  };
}

// ────────────────────────────────────────────────
// Action executor
// ────────────────────────────────────────────────

export interface ExecutorContext {
  companyId: string;
  ctoAgentId: string;
  goalId?: string;
  /** ID of the issue being scanned (used as parentId for child issues). */
  scanSourceIssueId?: string;
  dedup: DedupStore;
  api: ActionApiClient;
  now?: Date;
}

export interface ActionResult {
  anomalyType: string;
  issueId?: string;
  agentId?: string;
  action: string;
  skipped?: boolean;
  reason?: string;
}

export async function executeActions(
  anomalies: Anomaly[],
  ctx: ExecutorContext,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const now = ctx.now ?? new Date();

  for (const anomaly of anomalies) {
    const key = dedupKey(anomaly);
    if (ctx.dedup.has(key)) {
      results.push({
        anomalyType: anomaly.type,
        issueId: anomaly.issueId,
        agentId: anomaly.agentId,
        action: "deduped",
        skipped: true,
        reason: "within 24h window",
      });
      continue;
    }

    ctx.dedup.set(key, now.getTime() + DEDUP_TTL_MS);
    const result = await dispatchAction(anomaly, ctx);
    results.push(result);
  }

  return results;
}

async function dispatchAction(
  anomaly: Anomaly,
  ctx: ExecutorContext,
): Promise<ActionResult> {
  const base = {
    anomalyType: anomaly.type,
    issueId: anomaly.issueId,
    agentId: anomaly.agentId,
  };

  switch (anomaly.type) {
    case "P0_STALLED": {
      await ctx.api.postComment(
        anomaly.issueId!,
        `[URGENT] CEO Horizon Scan: P0 issue stalled >${anomaly.stalledHours?.toFixed(1)}h，请立即更新状态。`,
      );
      return { ...base, action: "posted_urgent_comment" };
    }

    case "P1_STALLED": {
      await ctx.api.postComment(
        anomaly.issueId!,
        `[NOTICE] CEO Horizon Scan: P1 issue stalled >${anomaly.stalledHours?.toFixed(1)}h，请更新进度。`,
      );
      return { ...base, action: "posted_notice_comment" };
    }

    case "BLOCKER_CHAIN": {
      const title = `[URGENT] Blocker chain 解除 — issue ${anomaly.issueId}`;
      await ctx.api.createChildIssue({
        companyId: ctx.companyId,
        parentId: ctx.scanSourceIssueId,
        title,
        assigneeAgentId: ctx.ctoAgentId,
        goalId: ctx.goalId,
      });
      return { ...base, action: "created_cto_child_issue" };
    }

    case "REVIEW_STALLED": {
      await ctx.api.postComment(
        anomaly.issueId!,
        `[HORIZON SCAN] 本 issue in_review 超过 ${(anomaly.details?.["idleMinutes"] as number | undefined)?.toFixed(0)}min 无互动，请 reviewer 反馈。`,
      );
      return { ...base, action: "posted_reviewer_ping" };
    }

    case "BOARD_WAIT_LONG": {
      const idleMin = (anomaly.details?.["idleMinutes"] as number | undefined)?.toFixed(0);
      await ctx.api.sendFeishuDM(
        `⏳ Horizon Scan: issue ${anomaly.issueId} 等待板长批复超过 ${idleMin}min，请处理。`,
      );
      return { ...base, action: "sent_feishu_dm_to_board" };
    }

    case "ENGINEER_ISSUE_STALLED_24H": {
      const hours = anomaly.stalledHours?.toFixed(1);
      const today = new Date().toISOString().slice(0, 10);
      await ctx.api.postComment(
        anomaly.issueId!,
        `[URGENT] CEO Horizon Scan ${today}: 本 issue 超过 ${hours}h 无更新，请更新进度或标 blocked\n[@${anomaly.agentId}](agent://${anomaly.agentId})`,
      );
      return { ...base, action: "posted_engineer_stall_comment" };
    }

    case "ENGINEER_ALL_STALLED_48H": {
      const count = anomaly.details?.["issueCount"];
      await Promise.all([
        ctx.api.sendFeishuDM(
          `⚠️ Horizon Scan: agent ${anomaly.agentId} 全部 ${count} 个 active issue stalled ≥48h，请介入。`,
        ),
        ctx.api.createChildIssue({
          companyId: ctx.companyId,
          parentId: ctx.scanSourceIssueId,
          title: `[URGENT] Engineer ${anomaly.agentId} 全部 issue stalled 48h+`,
          assigneeAgentId: ctx.ctoAgentId,
          goalId: ctx.goalId,
        }),
      ]);
      return { ...base, action: "feishu_dm_and_cto_child_issue" };
    }

    case "REVIEW_ZOMBIE_72H": {
      await ctx.api.postComment(
        anomaly.issueId!,
        `[REVIEW-ZOMBIE] 本 issue in_review > ${anomaly.stalledHours?.toFixed(0)}h，请决定: ship 还是重开 in_progress`,
      );
      return { ...base, action: "posted_review_zombie_comment" };
    }

    case "ENGINEER_IDLE": {
      // Logged as INFO; actual notification goes to VOG-2922 board DM mirror.
      // Action left to CEO skill for context-aware routing.
      return { ...base, action: "logged_idle" };
    }

    case "MEMORY_VIOLATED": {
      await ctx.api.createChildIssue({
        companyId: ctx.companyId,
        title: `[MEMORY] Memory violation 修正 — agent ${anomaly.agentId ?? "unknown"}`,
        assigneeAgentId: anomaly.agentId ?? ctx.ctoAgentId,
        goalId: ctx.goalId,
      });
      return { ...base, action: "created_memory_fix_issue" };
    }

    default: {
      return { ...base, action: "unhandled", skipped: true };
    }
  }
}
