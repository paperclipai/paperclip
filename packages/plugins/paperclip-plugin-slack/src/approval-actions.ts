import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "./constants.js";
import { postMessage, updateMessage } from "./slack-api.js";

/**
 * Phase 1 approval interactions: resolve a Slack-posted approval card via
 * reaction (✅/❌) or thread command (!approve/!reject/!revise) or a freeform
 * thread reply (treated as a revision comment).
 *
 * Two-phase reaction resolve (BLO-8861)
 * -------------------------------------
 * A reaction is an easy-to-misfire gesture, so ✅/❌ does NOT commit the
 * decision to the host immediately. Instead it *stages* a pending decision and
 * starts an undo grace window:
 *   - reaction_added  → write a durable pending record + show a "pending, undo
 *     within Ns" card. No `approvals.resolve` call is made yet, so the approval
 *     stays genuinely unresolved during the window.
 *   - reaction_removed within grace → delete the pending record. The approval
 *     was never committed, so this is a true revert (not just a local unlock).
 *   - reaction_removed after grace, or the `commit-pending-approvals` cron →
 *     commit the decision via `approvals.resolve` and edit the card to the
 *     final resolved state.
 *
 * Thread `!`-commands and freeform replies are *explicit* typed intent, so they
 * commit immediately (no grace window). `revise` (whether `!revise <reason>` or
 * a freeform reply) is a non-terminal revision comment: it posts the reason to
 * the host but does NOT lock the approval, leaving it open for a later
 * approve/reject.
 *
 * Authorization note: Slack validates the event signature, then this plugin
 * checks the approver allowlist before calling the host-owned
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

const DECISION_GERUND: Record<ApprovalDecision, string> = {
  approve: "approve",
  reject: "reject",
  revise: "request revision on",
};

const DECISION_EMOJI: Record<ApprovalDecision, string> = {
  approve: ":white_check_mark:",
  reject: ":x:",
  revise: ":pencil2:",
};

/** Grace window (ms) within which removing the resolving reaction undoes it. */
export const UNDO_GRACE_MS = 30_000;

function formatSlackUser(slackUserId: string): string {
  return slackUserId ? `<@${slackUserId}>` : "Unknown Slack user";
}

function approvalUrl(paperclipBaseUrl: string, approvalId: string): string {
  return `${paperclipBaseUrl.replace(/\/+$/, "")}/approvals/${approvalId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function whenLabel(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function viewApprovalAction(paperclipBaseUrl: string, approvalId: string) {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View Approval" },
        url: approvalUrl(paperclipBaseUrl, approvalId),
        action_id: "approval_view",
      },
    ],
  };
}

function approvalContext(approvalId: string) {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: `Approval: \`${approvalId}\`` }],
  };
}

/** Final card shown once a decision is committed to the host. */
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
      { type: "section", text: { type: "mrkdwn", text: statusText } },
      approvalContext(approvalId),
      viewApprovalAction(paperclipBaseUrl, approvalId),
    ],
  };
}

/** Interim card shown while a reaction decision is pending (undoable). */
function pendingMessage(params: {
  paperclipBaseUrl: string;
  approvalId: string;
  decision: ApprovalDecision;
  slackUserId: string;
}) {
  const { paperclipBaseUrl, approvalId, decision, slackUserId } = params;
  const actor = formatSlackUser(slackUserId);
  const seconds = Math.round(UNDO_GRACE_MS / 1000);
  const statusText = `:hourglass_flowing_sand: *Pending ${DECISION_PAST[decision]}* by ${actor} — not committed yet. Remove your ${DECISION_EMOJI[decision]} reaction within ${seconds}s to cancel.`;
  return {
    text: `Approval pending ${DECISION_PAST[decision]} by ${slackUserId || "unknown user"} (undo within ${seconds}s)`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: statusText } },
      approvalContext(approvalId),
      viewApprovalAction(paperclipBaseUrl, approvalId),
    ],
  };
}

/** Card shown when a pending reaction decision is cancelled within grace. */
function cancelledMessage(params: {
  paperclipBaseUrl: string;
  approvalId: string;
  decision: ApprovalDecision;
  slackUserId: string;
}) {
  const { paperclipBaseUrl, approvalId, decision, slackUserId } = params;
  const actor = formatSlackUser(slackUserId);
  return {
    text: `Pending approval ${DECISION_PAST[decision]} cancelled by ${slackUserId || "unknown user"}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:leftwards_arrow_with_hook: ${actor} removed the ${DECISION_EMOJI[decision]} reaction within the grace window. The pending *${DECISION_PAST[decision]}* was cancelled — the approval was never committed and remains *unresolved*.`,
        },
      },
      approvalContext(approvalId),
      viewApprovalAction(paperclipBaseUrl, approvalId),
    ],
  };
}

interface ResolvedLock {
  decision: ApprovalDecision;
  by: string;
  at: string; // ISO
}

interface PendingDecision {
  decision: ApprovalDecision;
  by: string;
  at: string; // ISO
  channel: string;
  ts: string;
  reason?: string;
}

type ResolveCtx = Pick<
  PluginContext,
  "http" | "logger" | "state" | "metrics" | "rpc"
>;

type HostApprovalResolution = {
  applied?: boolean;
  status?: string;
};

type CompanyScope = { scopeKind: "company"; scopeId: string };

function scopeFor(companyId: string): CompanyScope {
  return { scopeKind: "company", scopeId: companyId };
}

function lockRef(companyId: string, approvalId: string) {
  return { ...scopeFor(companyId), stateKey: STATE_KEYS.approvalResolved(approvalId) };
}

function pendingRef(companyId: string, approvalId: string) {
  return { ...scopeFor(companyId), stateKey: STATE_KEYS.approvalPending(approvalId) };
}

function pendingIndexRef(companyId: string) {
  return { ...scopeFor(companyId), stateKey: STATE_KEYS.approvalPendingIndex };
}

async function readPendingIndex(
  ctx: ResolveCtx,
  companyId: string,
): Promise<string[]> {
  const raw = await ctx.state.get(pendingIndexRef(companyId));
  return Array.isArray(raw) ? (raw as string[]) : [];
}

async function addToPendingIndex(
  ctx: ResolveCtx,
  companyId: string,
  approvalId: string,
): Promise<void> {
  const idx = await readPendingIndex(ctx, companyId);
  if (!idx.includes(approvalId)) {
    await ctx.state.set(pendingIndexRef(companyId), [...idx, approvalId]);
  }
}

async function removeFromPendingIndex(
  ctx: ResolveCtx,
  companyId: string,
  approvalId: string,
): Promise<void> {
  const idx = await readPendingIndex(ctx, companyId);
  if (idx.includes(approvalId)) {
    await ctx.state.set(
      pendingIndexRef(companyId),
      idx.filter((id) => id !== approvalId),
    );
  }
}

async function readClaims(
  ctx: ResolveCtx,
  companyId: string,
  approvalId: string,
): Promise<{ committed: ResolvedLock | null; pending: PendingDecision | null }> {
  const committed = (await ctx.state.get(
    lockRef(companyId, approvalId),
  )) as ResolvedLock | null;
  const pending = (await ctx.state.get(
    pendingRef(companyId, approvalId),
  )) as PendingDecision | null;
  return { committed, pending };
}

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

export interface CommitApprovalParams {
  companyId: string;
  approvalId: string;
  /** Reaction decisions are always approve/reject (revise is thread-only). */
  decision: ApprovalDecision;
  /** Slack user id of the actor (already allowlist-checked by the caller). */
  slackUserId: string;
  /** Channel + ts of the original approval card (for the status-echo edit). */
  channel: string;
  ts: string;
  reason?: string;
  /** Thread ts to post no-op / confirmation notes into (defaults to `ts`). */
  threadTs?: string;
  paperclipBaseUrl: string;
}

/**
 * Commit a terminal approve/reject to the host. Idempotent: the first committed
 * decision wins; later calls are no-ops that post a short thread note. On
 * success, deletes any staged pending record and edits the original card to
 * show actor + outcome + time.
 */
export async function commitApproval(
  ctx: ResolveCtx,
  token: string,
  params: CommitApprovalParams,
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

  const lref = lockRef(companyId, approvalId);

  // --- Idempotency lock: first committed decision wins ---
  const existing = (await ctx.state.get(lref)) as ResolvedLock | null;
  if (existing) {
    await postMessage(
      ctx,
      token,
      channel,
      {
        text: `:lock: Approval already ${DECISION_PAST[existing.decision]} by ${formatSlackUser(existing.by)} — ignoring this action.`,
      },
      { threadTs: threadTs ?? ts },
    );
    return { ok: false, alreadyResolved: true };
  }
  await ctx.state.set(lref, {
    decision,
    by: slackUserId,
    at: nowIso(),
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
      await ctx.state.delete(lref);
      ctx.logger.info("Approval action was already resolved server-side", {
        approvalId,
        status: body.status,
      });
      await postMessage(
        ctx,
        token,
        channel,
        {
          text: `:information_source: Approval \`${approvalId}\` was already resolved server-side; no Slack card change was made.`,
        },
        { threadTs: threadTs ?? ts },
      );
      // The host already owns the final state; drop our staging bookkeeping.
      await ctx.state.delete(pendingRef(companyId, approvalId));
      await removeFromPendingIndex(ctx, companyId, approvalId);
      return { ok: false, alreadyResolved: true };
    }
  } catch (err) {
    await ctx.state.delete(lref);
    ctx.logger.warn("Approval action failed", { approvalId, decision, err });
    await postMessage(
      ctx,
      token,
      channel,
      { text: `:warning: Couldn't ${DECISION_GERUND[decision]} approval \`${approvalId}\`. No change made.` },
      { threadTs: threadTs ?? ts },
    );
    return { ok: false, error: "resolve_failed" };
  }

  // Commit succeeded — clear any staged pending decision for this approval.
  await ctx.state.delete(pendingRef(companyId, approvalId));
  await removeFromPendingIndex(ctx, companyId, approvalId);

  // --- Status echo: edit the original card with actor + outcome + time ---
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
      when: whenLabel(),
      reason,
    }),
  );

  await ctx.metrics.write("slack.approvals.decided", 1, {
    decision: DECISION_ENDPOINT[decision],
    source: "slack_interaction",
  });

  return { ok: true };
}

export interface StagePendingParams {
  companyId: string;
  approvalId: string;
  decision: ApprovalDecision; // approve | reject (reaction-driven)
  slackUserId: string;
  channel: string;
  ts: string;
  /** Result of the approver allowlist check (caller-supplied). */
  authorized: boolean;
  paperclipBaseUrl: string;
}

/**
 * Stage a reaction decision without committing it. Writes a durable pending
 * record + index entry and edits the card to a "pending, undo within Ns" state.
 * The host is NOT called here — the approval stays unresolved until the grace
 * window elapses (committed by `commitDuePendingApprovals` or by an after-grace
 * reaction removal).
 *
 * Guardrails preserved:
 *  - unauthorized reactor → no state change, no host call, "not authorized" note;
 *  - idempotency → if the approval is already committed or already has a pending
 *    decision, this is a no-op with a posted note (handles the ✅-then-❌ race).
 */
export async function stagePendingReaction(
  ctx: ResolveCtx,
  token: string,
  params: StagePendingParams,
): Promise<{
  staged: boolean;
  unauthorized?: boolean;
  alreadyResolved?: boolean;
  alreadyPending?: boolean;
}> {
  const {
    companyId,
    approvalId,
    decision,
    slackUserId,
    channel,
    ts,
    authorized,
    paperclipBaseUrl,
  } = params;

  if (!authorized) {
    await postMessage(
      ctx,
      token,
      channel,
      {
        text: `:warning: ${formatSlackUser(slackUserId)} is not on the approval allowlist — reaction ignored.`,
      },
      { threadTs: ts },
    );
    return { staged: false, unauthorized: true };
  }

  const { committed, pending } = await readClaims(ctx, companyId, approvalId);
  if (committed) {
    await postMessage(
      ctx,
      token,
      channel,
      {
        text: `:lock: Approval already ${DECISION_PAST[committed.decision]} by ${formatSlackUser(committed.by)} — ignoring this reaction.`,
      },
      { threadTs: ts },
    );
    return { staged: false, alreadyResolved: true };
  }
  if (pending) {
    await postMessage(
      ctx,
      token,
      channel,
      {
        text: `:hourglass_flowing_sand: A *${DECISION_PAST[pending.decision]}* by ${formatSlackUser(pending.by)} is already pending in its undo window — ignoring this reaction.`,
      },
      { threadTs: ts },
    );
    return { staged: false, alreadyPending: true };
  }

  await ctx.state.set(pendingRef(companyId, approvalId), {
    decision,
    by: slackUserId,
    at: nowIso(),
    channel,
    ts,
  } satisfies PendingDecision);
  await addToPendingIndex(ctx, companyId, approvalId);

  await updateMessage(
    ctx,
    token,
    channel,
    ts,
    pendingMessage({ paperclipBaseUrl, approvalId, decision, slackUserId }),
  );

  await ctx.metrics.write("slack.approvals.staged", 1, {
    decision: DECISION_ENDPOINT[decision],
    source: "slack_interaction",
  });

  return { staged: true };
}

export interface ReactionRemovedParams {
  companyId: string;
  approvalId: string;
  decision: ApprovalDecision;
  slackUserId: string;
  channel: string;
  ts: string;
  paperclipBaseUrl: string;
}

/**
 * Handle removal of a resolving reaction.
 *  - pending + within grace → cancel (delete pending; the approval was never
 *    committed and stays unresolved);
 *  - pending + after grace → commit now, then post a too-late note;
 *  - already committed → post a too-late no-op note (decision stays intact);
 *  - nothing staged / not the staging actor → no-op.
 */
export async function handleReactionRemoved(
  ctx: ResolveCtx,
  token: string,
  params: ReactionRemovedParams,
): Promise<{ undone: boolean; committed: boolean }> {
  const {
    companyId,
    approvalId,
    decision,
    slackUserId,
    channel,
    ts,
    paperclipBaseUrl,
  } = params;

  const { committed, pending } = await readClaims(ctx, companyId, approvalId);

  if (
    pending &&
    pending.decision === decision &&
    pending.by === slackUserId
  ) {
    const age = Date.now() - Date.parse(pending.at);
    if (Number.isFinite(age) && age <= UNDO_GRACE_MS) {
      await ctx.state.delete(pendingRef(companyId, approvalId));
      await removeFromPendingIndex(ctx, companyId, approvalId);
      await updateMessage(
        ctx,
        token,
        channel,
        ts,
        cancelledMessage({ paperclipBaseUrl, approvalId, decision, slackUserId }),
      );
      await ctx.metrics.write("slack.approvals.undone", 1, { decision });
      return { undone: true, committed: false };
    }
    // Grace already elapsed but the commit job has not run yet: the removal is
    // too late to undo, so honor the decision by committing it now.
    await commitApproval(ctx, token, {
      companyId,
      approvalId,
      decision,
      slackUserId: pending.by,
      channel,
      ts,
      reason: pending.reason,
      paperclipBaseUrl,
    });
    await postMessage(
      ctx,
      token,
      channel,
      {
        text: `:information_source: Too late to undo — the grace window had passed, so this approval was committed as *${DECISION_PAST[decision]}* server-side.`,
      },
      { threadTs: ts },
    );
    return { undone: false, committed: true };
  }

  if (committed && committed.decision === decision) {
    await postMessage(
      ctx,
      token,
      channel,
      {
        text: `:information_source: Too late to undo the *${DECISION_PAST[decision]}* on this approval (grace window passed). It remains ${DECISION_PAST[decision]} server-side.`,
      },
      { threadTs: ts },
    );
    return { undone: false, committed: true };
  }

  return { undone: false, committed: false };
}

/**
 * Commit every pending reaction decision whose grace window has elapsed. Run by
 * the `commit-pending-approvals` cron (every minute). Enumerates the per-company
 * pending index — no state prefix scan required.
 */
export async function commitDuePendingApprovals(
  ctx: ResolveCtx,
  token: string,
  params: { companyId: string; paperclipBaseUrl: string; now?: number },
): Promise<{ committed: number; pending: number }> {
  const { companyId, paperclipBaseUrl } = params;
  const now = params.now ?? Date.now();
  const idx = await readPendingIndex(ctx, companyId);
  let committed = 0;
  let stillPending = 0;

  for (const approvalId of idx) {
    const pending = (await ctx.state.get(
      pendingRef(companyId, approvalId),
    )) as PendingDecision | null;
    if (!pending) {
      // Stale index entry (cancelled/committed elsewhere) — prune it.
      await removeFromPendingIndex(ctx, companyId, approvalId);
      continue;
    }
    const age = now - Date.parse(pending.at);
    if (!Number.isFinite(age) || age <= UNDO_GRACE_MS) {
      stillPending += 1;
      continue;
    }
    const res = await commitApproval(ctx, token, {
      companyId,
      approvalId,
      decision: pending.decision,
      slackUserId: pending.by,
      channel: pending.channel,
      ts: pending.ts,
      reason: pending.reason,
      paperclipBaseUrl,
    });
    if (res.ok || res.alreadyResolved) {
      committed += 1;
    } else {
      // Commit failed (host unavailable): leave the pending record in place so
      // a later cron tick retries rather than silently dropping the decision.
      stillPending += 1;
    }
  }

  return { committed, pending: stillPending };
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
 * Resolve an approval from an *explicit* thread command (`!approve`/`!reject`/
 * `!revise`). Explicit commands commit immediately (no reaction grace window):
 *  - approve/reject → terminal commit via {@link commitApproval} (respects the
 *    idempotency lock and any in-flight pending reaction);
 *  - revise → non-terminal revision comment (see {@link requestRevision}).
 */
export async function resolveApproval(
  ctx: ResolveCtx,
  token: string,
  params: ResolveApprovalParams,
): Promise<{ ok: boolean; alreadyResolved?: boolean; error?: string }> {
  if (params.decision === "revise") {
    return requestRevision(ctx, token, {
      companyId: params.companyId,
      approvalId: params.approvalId,
      slackUserId: params.slackUserId,
      channel: params.channel,
      ts: params.ts,
      reason: params.reason ?? "",
      threadTs: params.threadTs,
      paperclipBaseUrl: params.paperclipBaseUrl,
    });
  }

  // A reaction may have staged a pending decision; first action wins.
  const { committed, pending } = await readClaims(
    ctx,
    params.companyId,
    params.approvalId,
  );
  if (!committed && pending) {
    await postMessage(
      ctx,
      token,
      params.channel,
      {
        text: `:hourglass_flowing_sand: A *${DECISION_PAST[pending.decision]}* reaction by ${formatSlackUser(pending.by)} is in its undo window — ignoring this command. Remove the reaction to cancel it, or wait for it to commit.`,
      },
      { threadTs: params.threadTs ?? params.ts },
    );
    return { ok: false, alreadyResolved: true };
  }

  return commitApproval(ctx, token, {
    companyId: params.companyId,
    approvalId: params.approvalId,
    decision: params.decision,
    slackUserId: params.slackUserId,
    channel: params.channel,
    ts: params.ts,
    reason: params.reason,
    threadTs: params.threadTs,
    paperclipBaseUrl: params.paperclipBaseUrl,
  });
}

export interface RequestRevisionParams {
  companyId: string;
  approvalId: string;
  slackUserId: string;
  channel: string;
  ts: string;
  reason: string;
  threadTs?: string;
  paperclipBaseUrl: string;
}

/**
 * Send a revision comment to the host (`approvals.resolve` decision=`revise`).
 * Non-terminal: it does NOT set the resolved lock and does NOT rewrite the card
 * to a resolved state, so the approval stays open for a later approve/reject.
 * If the approval is already terminally committed, this is a no-op note.
 */
export async function requestRevision(
  ctx: ResolveCtx,
  token: string,
  params: RequestRevisionParams,
): Promise<{ ok: boolean; alreadyResolved?: boolean; error?: string }> {
  const {
    companyId,
    approvalId,
    slackUserId,
    channel,
    ts,
    reason,
    threadTs,
    paperclipBaseUrl,
  } = params;

  const committed = (await ctx.state.get(
    lockRef(companyId, approvalId),
  )) as ResolvedLock | null;
  if (committed) {
    await postMessage(
      ctx,
      token,
      channel,
      {
        text: `:lock: Approval already ${DECISION_PAST[committed.decision]} by ${formatSlackUser(committed.by)} — revision comment ignored.`,
      },
      { threadTs: threadTs ?? ts },
    );
    return { ok: false, alreadyResolved: true };
  }

  try {
    const body = await resolvePaperclipApproval(ctx, {
      companyId,
      approvalId,
      decision: "revise",
      slackUserId,
      reason,
    });
    if (body?.applied === false) {
      ctx.logger.info("Revision request was a no-op server-side", {
        approvalId,
        status: body.status,
      });
      await postMessage(
        ctx,
        token,
        channel,
        {
          text: `:information_source: Approval \`${approvalId}\` could not take a revision comment in its current state.`,
        },
        { threadTs: threadTs ?? ts },
      );
      return { ok: false, alreadyResolved: true };
    }
  } catch (err) {
    ctx.logger.warn("Revision request failed", { approvalId, err });
    await postMessage(
      ctx,
      token,
      channel,
      { text: `:warning: Couldn't post the revision comment on approval \`${approvalId}\`. No change made.` },
      { threadTs: threadTs ?? ts },
    );
    return { ok: false, error: "revise_failed" };
  }

  await postMessage(
    ctx,
    token,
    channel,
    {
      text: `${DECISION_EMOJI.revise} Revision requested by ${formatSlackUser(slackUserId)}:\n> ${reason}`,
    },
    { threadTs: threadTs ?? ts },
  );
  await ctx.metrics.write("slack.approvals.decided", 1, {
    decision: DECISION_ENDPOINT.revise,
    source: "slack_interaction",
  });
  return { ok: true };
}

/** Map an approval-card reaction emoji name to a decision (or null). */
export function emojiToDecision(name: string): ApprovalDecision | null {
  if (name === "white_check_mark" || name === "heavy_check_mark") return "approve";
  if (name === "x" || name === "no_entry" || name === "no_entry_sign") return "reject";
  return null;
}

/**
 * Parse an approval thread reply.
 *  - `!approve [note]`, `!reject [reason]`, `!revise <reason>` (reason required),
 *    `!status` → structured commands;
 *  - any other non-empty reply (no `!` prefix) → `freeform_revision`: the reply
 *    body becomes a revision comment (per BLO-8568). The caller decides whether
 *    to act on it (authorized approver + still-unresolved approval).
 */
export function parseThreadCommand(
  text: string,
):
  | { kind: "decision"; decision: ApprovalDecision; reason?: string }
  | { kind: "status" }
  | { kind: "usage"; message: string }
  | { kind: "freeform_revision"; reason: string }
  | { kind: "ignore" } {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "ignore" };

  if (!trimmed.startsWith("!")) {
    return { kind: "freeform_revision", reason: trimmed };
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
