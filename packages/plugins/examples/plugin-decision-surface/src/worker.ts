import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DATA_KEYS, TOOL_NAMES } from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Approval = {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedAt: string;
  requestedByAgentId: string | null;
};

type BlockedIssue = {
  id: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  updatedAt: Date | string;
};

type DecisionItem =
  | { kind: "approval"; companyId: string; data: Approval }
  | { kind: "blocked_issue"; companyId: string; data: BlockedIssue };

type DecisionsResult = {
  items: DecisionItem[];
  totalApprovals: number;
  totalBlockedIssues: number;
  fetchedAt: string;
};

const QUEUE_STATE_KEY = "queue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchApprovals(
  ctx: PluginContext,
  companyId: string,
  apiUrl: string,
  apiKey: string,
): Promise<Approval[]> {
  try {
    const res = await ctx.http.fetch(
      `${apiUrl}/api/companies/${companyId}/approvals?status=pending&limit=50`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as Approval[] | { approvals?: Approval[] };
    if (Array.isArray(data)) return data;
    return data.approvals ?? [];
  } catch {
    return [];
  }
}

async function fetchBlockedIssues(ctx: PluginContext, companyId: string): Promise<BlockedIssue[]> {
  try {
    const issues = await ctx.issues.list({ companyId, status: "blocked", limit: 50, offset: 0 });
    return issues.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      assigneeAgentId: issue.assigneeAgentId ?? null,
      updatedAt: issue.updatedAt,
    }));
  } catch {
    return [];
  }
}

async function buildDecisionsResult(
  ctx: PluginContext,
  companyId: string,
  apiUrl: string,
  apiKey: string,
): Promise<DecisionsResult> {
  const [approvals, blockedIssues] = await Promise.all([
    fetchApprovals(ctx, companyId, apiUrl, apiKey),
    fetchBlockedIssues(ctx, companyId),
  ]);
  const items: DecisionItem[] = [
    ...approvals.map((a): DecisionItem => ({ kind: "approval", companyId, data: a })),
    ...blockedIssues.map((i): DecisionItem => ({ kind: "blocked_issue", companyId, data: i })),
  ];
  const result: DecisionsResult = {
    items,
    totalApprovals: approvals.length,
    totalBlockedIssues: blockedIssues.length,
    fetchedAt: new Date().toISOString(),
  };
  await ctx.state.set({ scopeKind: "instance", stateKey: QUEUE_STATE_KEY }, result);
  return result;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("decision-surface plugin setup");

    const apiUrl = process.env["PAPERCLIP_API_URL"] ?? "http://127.0.0.1:3100";
    const apiKey = process.env["PAPERCLIP_API_KEY"] ?? "";

    // ------------------------------------------------------------------
    // Agent tool: decisions
    // ------------------------------------------------------------------
    ctx.tools.register(
      TOOL_NAMES.DECISIONS,
      {
        displayName: "Decisions",
        description:
          "Return all items requiring board or human action: pending CEO-strategy approvals and blocked agent issues. Use this to triage blockers.",
        parametersSchema: {
          type: "object",
          properties: {
            companyId: { type: "string", description: "Company to query. Omit to use context company." },
          },
          required: [],
        },
      },
      async (params, runCtx) => {
        const cid = (params as { companyId?: string }).companyId ?? runCtx.companyId;
        if (!cid) return { content: "companyId is required", data: null };
        const result = await buildDecisionsResult(ctx, cid, apiUrl, apiKey);
        return { content: JSON.stringify(result, null, 2), data: result };
      },
    );

    // ------------------------------------------------------------------
    // Agent tool: unblock_issue
    // ------------------------------------------------------------------
    ctx.tools.register(
      TOOL_NAMES.UNBLOCK_ISSUE,
      {
        displayName: "Unblock Issue",
        description: "Move a blocked issue back to todo and post a comment explaining what cleared the blocker.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string", description: "UUID or identifier of the blocked issue." },
            companyId: { type: "string", description: "Company that owns the issue." },
            reason: { type: "string", description: "Short explanation of what cleared the blocker." },
          },
          required: ["issueId", "companyId", "reason"],
        },
      },
      async (params) => {
        const { issueId, companyId, reason } = params as {
          issueId: string;
          companyId: string;
          reason: string;
        };
        try {
          await ctx.issues.update(issueId, { status: "todo" }, companyId);
          await ctx.issues.createComment(issueId, `Unblocked: ${reason}`, companyId);
          return { content: `Issue ${issueId} unblocked.`, data: { issueId, status: "todo" } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Failed to unblock ${issueId}: ${msg}`, data: null };
        }
      },
    );

    // ------------------------------------------------------------------
    // UI action: unblock_issue (for the dashboard widget / page button)
    // ------------------------------------------------------------------
    ctx.actions.register(TOOL_NAMES.UNBLOCK_ISSUE, async (params) => {
      const { issueId, companyId, reason } = params as {
        issueId: string;
        companyId: string;
        reason: string;
      };
      await ctx.issues.update(issueId, { status: "todo" }, companyId);
      await ctx.issues.createComment(issueId, `Unblocked: ${reason}`, companyId);
      return { issueId, status: "todo" };
    });

    // ------------------------------------------------------------------
    // Data endpoint for the UI widget / page
    // ------------------------------------------------------------------
    ctx.data.register(DATA_KEYS.QUEUE, async (params) => {
      const companyId = (params as { companyId?: string } | undefined)?.companyId;
      if (!companyId) {
        return (
          (await ctx.state.get({ scopeKind: "instance", stateKey: QUEUE_STATE_KEY })) ?? {
            items: [],
            totalApprovals: 0,
            totalBlockedIssues: 0,
            fetchedAt: null,
          }
        );
      }
      return await buildDecisionsResult(ctx, companyId, apiUrl, apiKey);
    });

    // ------------------------------------------------------------------
    // Event: approval.decided → auto-unblock linked issues
    // ------------------------------------------------------------------
    ctx.events.on("approval.decided", async (event) => {
      const { companyId, entityId: approvalId } = event;
      ctx.logger.info("approval decided — checking linked issues", { approvalId, companyId });
      try {
        const res = await ctx.http.fetch(
          `${apiUrl}/api/approvals/${approvalId}/issues`,
          { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
        );
        if (!res.ok) return;
        const linked = (await res.json()) as Array<{ id: string; status: string }>;
        for (const issue of linked.filter((i) => i.status === "blocked")) {
          await ctx.issues.update(issue.id, { status: "todo" }, companyId);
          await ctx.issues.createComment(
            issue.id,
            `Approval \`${approvalId}\` was decided. Auto-unblocked by decision-surface plugin.`,
            companyId,
          );
          ctx.logger.info("auto-unblocked issue", { issueId: issue.id, approvalId });
        }
      } catch (err) {
        ctx.logger.error("failed to auto-unblock after approval", {
          approvalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    ctx.logger.info("decision-surface plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Decision Surface plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
