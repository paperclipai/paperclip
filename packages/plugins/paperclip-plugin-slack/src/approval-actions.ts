import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "./constants.js";
import { postMessage, updateMessage } from "./slack-api.js";

/**
 * Phase 1 approval interactions: resolve a Slack-posted approval card via
 * reaction (✅/❌) or thread command (!approve/!reject/!revise).
 *
 * Authorization note: Slack validates the event signature, then this plugin
 * checks `config.approvalReactorSlackIds` before calling the host-owned
 * `approvals.resolve` RPC. The Slack user id is persisted as audit metadata
 * (`decidedByUserId: slack:<id>`); the public board-only approvals API is not
 * called from the plugin worker.
 */

export type ApprovalDecision = "approve" | "reject" | "revise";

const DECISION_ENDPOINT: Record<ApprovalDecision, string> = {
  approve: "approve",
  reject: "reject",
  revise: "request-revision",
};

const DECISION_PAST: Record<ApprovalDecision, string> = {
  approve: "approved",
  reject: "rejected",
  revise: "revision requested",
};

const DECISION_EMOJI: Record<ApprovalDecision, string> = {
  approve: ":white_check_mark:",
  reject: ":x:",
  revise: ":pencil2:",
};

function formatSlackUser(slackUserId: string): string {
  return slackUserId ? `<@${slackUserId}>` : "Unknown Slack user";
}

function approvalUrl(paperclipBaseUrl: string, approvalId: string): string {
  return `${paperclipBaseUrl.replace(/\/+$/, "")}/approvals/${approvalId}`;
}

function resolutionMessage(params: {
  paperclipBaseUrl: string;
  approvalId: string;
  decision: ApprovalDecision;
  slackUserId: string;
  when: string;
  reason?: string;
}) {
  const { paperclipBaseUrl, approvalId, decision, slackUserId, when, reason } =
    params;
  const actor = formatSlackUser(slackUserId);
  const reasonText = reason ? `\n> ${reason}` : "";
  const statusText = `${DECISION_EMOJI[decision]} *Approval ${DECISION_PAST[decision]}* by ${actor} · ${when}${reasonText}`;
  return {
    text: `Approval ${DECISION_PAST[decision]} by ${slackUserId || "unknown user"}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: statusText },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Approval: \`${approvalId}\`` }],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Approval" },
            url: approvalUrl(paperclipBaseUrl, approvalId),
            action_id: "approval_view",
          },
        ],
      },
    ],
  };
}

function undoMessage(params: {
  paperclipBaseUrl: string;
  approvalId: string;
  decision: ApprovalDecision;
  slackUserId: string;
}) {
  const { paperclipBaseUrl, approvalId, decision, slackUserId } = params;
  const actor = formatSlackUser(slackUserId);
  return {
    text: `Slack approval lock cleared by ${slackUserId || "unknown user"}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:leftwards_arrow_with_hook: ${actor} removed the resolving reaction within the grace window. The Slack interaction lock was cleared; the server-side approval was not reverted and remains ${DECISION_PAST[decision]}.`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Approval: \`${approvalId}\`` }],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Approval" },
            url: approvalUrl(paperclipBaseUrl, approvalId),
            action_id: "approval_view",
          },
        ],
      },
    ],
  };
}

/** Grace window (ms) within which removing the resolving reaction can undo. */
export const UNDO_GRACE_MS = 30_000;

interface ResolvedLock {
  decision: ApprovalDecision;
  by: string;
  at: string; // ISO
}

type ResolveCtx = Pick<
  PluginContext,
  "http" | "logger" | "state" | "metrics" | "rpc"
>;

type HostApprovalResolution = {
  applied?: boolean;
  status?: string;
};

export async function resolvePaperclipApproval(
  ctx: Pick<PluginContext, "rpc">,
  params: {
    companyId: string;
    approvalId: string;
    decision: ApprovalDecision;
    slackUserId: string;
    reason?: string;
  },
): Promise<HostApprovalResolution> {
  return ctx.rpc.call<HostApprovalResolution>("approvals.resolve", {
    companyId: params.companyId,
    approvalId: params.approvalId,
    decision: params.decision,
    decidedByUserId: `slack:${params.slackUserId}`,
    decisionNote: params.reason ?? null,
  });
}

export interface ResolveApprovalParams {
  companyId: string;
  approvalId: string;
  decision: ApprovalDecision;
  /** Slack user id of the actor (already allowlist-checked by the caller). */
  slackUserId: string;
  /** Channel + ts of the original approval card (for the status-echo edit). */
  channel: string;
  ts: string;
  /** Required for `revise`; optional note for approve/reject. */
  reason?: string;
  /** Thread ts to post no-op / confirmation notes into (defaults to `ts`). */
  threadTs?: string;
  paperclipBaseUrl: string;
}

/**
 * Resolve an approval. Idempotent: the first valid decision locks the approval;
 * later calls are no-ops that post a short thread note. On success, edits the
 * original card to show actor + outcome + time.
 */
export async function resolveApproval(
  ctx: ResolveCtx,
  token: string,
  params: ResolveApprovalParams,
): Promise<{ ok: boolean; alreadyResolved?: boolean; error?: string }> {
  const {
    companyId,
    approvalId,
    decision,
    slackUserId,
    channel,
    ts,
    reason,
    threadTs,
    paperclipBaseUrl,
  } = params;

  const scope = { scopeKind: "company" as const, scopeId: companyId };
  const lockRef = { ...scope, stateKey: STATE_KEYS.approvalResolved(approvalId) };

  // --- Idempotency lock: first valid decision wins ---
  const existing = (await ctx.state.get(lockRef)) as ResolvedLock | null;
  if (existing) {
    await postMessage(ctx, token, channel, {
      text: `:lock: Approval already ${DECISION_PAST[existing.decision]} by ${formatSlackUser(existing.by)} — ignoring this action.`,
    }, { threadTs: threadTs ?? ts });
    return { ok: false, alreadyResolved: true };
  }
  await ctx.state.set(lockRef, {
    decision,
    by: slackUserId,
    at: new Date().toISOString(),
  } satisfies ResolvedLock);

  try {
    const body = await resolvePaperclipApproval(ctx, {
      companyId,
      approvalId,
      decision,
      slackUserId,
      reason,
    });
    if (body?.applied === false) {
      await ctx.state.delete(lockRef);
      ctx.logger.info("Approval action was already resolved server-side", {
        approvalId,
        status: body.status,
      });
      await postMessage(ctx, token, channel, {
        text: `:information_source: Approval \`${approvalId}\` was already resolved server-side; no Slack card change was made.`,
      }, { threadTs: threadTs ?? ts });
      return { ok: false, alreadyResolved: true };
    }
  } catch (err) {
    await ctx.state.delete(lockRef);
    ctx.logger.warn("Approval action failed", { approvalId, decision, err });
    await postMessage(ctx, token, channel, {
      text: `:warning: Couldn't ${decision} approval \`${approvalId}\`. No change made.`,
    }, { threadTs: threadTs ?? ts });
    return { ok: false, error: "resolve_failed" };
  }

  // --- Status echo: edit the original card with actor + outcome + time ---
  const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  await updateMessage(
    ctx,
    token,
    channel,
    ts,
    resolutionMessage({
      paperclipBaseUrl,
      approvalId,
      decision,
      slackUserId,
      when,
      reason,
    }),
  );

  await ctx.metrics.write("slack.approvals.decided", 1, {
    decision: DECISION_ENDPOINT[decision],
    source: "slack_interaction",
  });

  return { ok: true };
}

/**
 * Best-effort undo: if `slackUserId` removed the reaction that resolved this
 * approval within the grace window, clear the lock and note it. We do NOT call a
 * server "unresolve" endpoint (none exists); we only reverse our local lock and
 * tell the channel. If the server already applied the decision irreversibly,
 * that is surfaced honestly rather than pretending to revert.
 */
export async function tryUndoResolution(
  ctx: ResolveCtx,
  token: string,
  params: {
    companyId: string;
    approvalId: string;
    decision: ApprovalDecision;
    slackUserId: string;
    channel: string;
    ts: string;
    paperclipBaseUrl: string;
  },
): Promise<{ undone: boolean }> {
  const {
    companyId,
    approvalId,
    decision,
    slackUserId,
    channel,
    ts,
    paperclipBaseUrl,
  } = params;
  const scope = { scopeKind: "company" as const, scopeId: companyId };
  const lockRef = { ...scope, stateKey: STATE_KEYS.approvalResolved(approvalId) };

  const lock = (await ctx.state.get(lockRef)) as ResolvedLock | null;
  if (!lock) return { undone: false };
  if (lock.decision !== decision || lock.by !== slackUserId) {
    return { undone: false };
  }
  const age = Date.now() - Date.parse(lock.at);
  if (!Number.isFinite(age) || age > UNDO_GRACE_MS) {
    await postMessage(ctx, token, channel, {
      text: `:information_source: Too late to undo the ${DECISION_PAST[decision]} on this approval (grace window passed). It remains ${DECISION_PAST[decision]} server-side.`,
    }, { threadTs: ts });
    return { undone: false };
  }
  await ctx.state.delete(lockRef);
  await updateMessage(
    ctx,
    token,
    channel,
    ts,
    undoMessage({ paperclipBaseUrl, approvalId, decision, slackUserId }),
  );
  await ctx.metrics.write("slack.approvals.undone", 1, { decision });
  return { undone: true };
}

/** Map an approval-card reaction emoji name to a decision (or null). */
export function emojiToDecision(name: string): ApprovalDecision | null {
  if (name === "white_check_mark" || name === "heavy_check_mark") return "approve";
  if (name === "x" || name === "no_entry" || name === "no_entry_sign") return "reject";
  return null;
}

/**
 * Parse an approval thread reply into a decision + reason.
 * `!approve [note]`, `!reject [reason]`, `!revise <reason>`, `!status`.
 * Non-command replies are normal Slack conversation and do not mutate approvals.
 */
export function parseThreadCommand(
  text: string,
):
  | { kind: "decision"; decision: ApprovalDecision; reason?: string }
  | { kind: "status" }
  | { kind: "usage"; message: string }
  | { kind: "ignore" } {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "ignore" };

  if (!trimmed.startsWith("!")) {
    return { kind: "ignore" };
  }

  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const reason = rest.join(" ").trim();
  switch (cmd.toLowerCase()) {
    case "approve":
      return { kind: "decision", decision: "approve", reason: reason || undefined };
    case "reject":
      return { kind: "decision", decision: "reject", reason: reason || undefined };
    case "revise":
    case "revise-request":
    case "request-changes":
      if (!reason) {
        return { kind: "usage", message: "Usage: `!revise <reason>` — a reason is required." };
      }
      return { kind: "decision", decision: "revise", reason };
    case "status":
      return { kind: "status" };
    default:
      return {
        kind: "usage",
        message: "Unknown command. Use `!approve [note]`, `!reject [reason]`, `!revise <reason>`, or `!status`.",
      };
  }
}
