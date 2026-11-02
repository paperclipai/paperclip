/**
 * Attention delegates: lets a company name agents that decide some board-level operational attention items
 * on the board's behalf.
 *
 * Talks to: `activity_log`, where decisions are stored as `attention.delegate_decision` rows on the issue;
 * `issue_recovery_actions`; `issues`; and the blocker graph from `issueService.list`.
 * Called by: `attentionService.list` (services/attention.ts), which drops delegated occurrences from the
 * feed, and by the `POST /companies/:companyId/attention/delegate-decisions` and recovery-resolve routes
 * (routes/issues.ts).
 * Triggered when: a board user loads the attention feed, or a delegate agent records or resolves a decision.
 *
 * Why it exists: recovery actions escalated to the board have no owning agent, and a stalled blocker tree
 * stays on the queue until it is live again. An item an agent has already handled therefore stays on every
 * board user's queue, and the only alternative is a per-user hide that expires or is undone by activity.
 *
 * Off by default. Configured with `PAPERCLIP_ATTENTION_DELEGATES='{"<companyId>":["<agentId>"]}'`.
 * Only an allowlist can be delegated:
 * - board-owned recovery of the listed kinds;
 * - stalled `blocker:` trees whose unblock step is neither human-owned nor a grant, spend or access step.
 * A decision covers only the current occurrence of an item, for a mandatory hold of at most 7 days.
 * A recovery occurrence is identified by the action row and its escalation time. A blocker occurrence is
 * identified by the terminal blocker, the sorted set of blocked issues and their latest blocked transition. It
 * also ends if any issue in the tree starts a run after the decision: the tree went live, so a later stall is
 * new.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, max, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import type { AttentionDelegateDecision, AttentionItem } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { issueService } from "./issues.js";

const ATTENTION_DELEGATES_ENV = "PAPERCLIP_ATTENTION_DELEGATES";
export const ATTENTION_DELEGATE_DECISION_ACTION = "attention.delegate_decision";
export const ATTENTION_DELEGATE_MAX_HOLD_MS = 7 * 24 * 60 * 60 * 1_000;
const QUERY_CHUNK_SIZE = 500;
const OPEN_RECOVERY_STATUSES = ["active", "escalated"];
const HUMAN_RECOVERY_OWNER_TYPES = ["user", "board"];

const DELEGATABLE_RECOVERY_KINDS = new Set([
  "missing_disposition",
  "deliberate_wait_without_target",
  "stranded_assigned_issue",
  "active_run_watchdog",
  "issue_graph_liveness",
]);
/** Causes, kinds and unblock steps matching this stay with humans even when the kind is allowlisted. */
const NON_DELEGATABLE_TEXT =
  /secret|credential|config|auth|token|permission|access|grant|approv|budget|spend|pay|purchase|billing|invoice|cost|money|tool|question|legal/i;
/** Verbs that hand an item back to the humans instead of settling it. */
const DELEGATE_RETURN_VERBS = new Set(["escalate_owner", "reopen"]);

/** One delegatable occurrence: the issue its decisions are recorded on, its identity, and when it began. */
export interface DelegatableOccurrence {
  sourceKind: "recovery_action" | "blocker_attention";
  issueId: string;
  occurrenceStartedAt: string;
  /** Stored with the decision and compared on read; any change means a new occurrence. */
  occurrenceKey: string;
  /** Issues whose runs after the decision end it (blocker trees only). */
  liveCheckIssueIds?: string[];
}

type UnblockDescriptor = { owner?: unknown; action?: unknown } | null | undefined;

interface RecoveryRowLike {
  ownerType: string;
  kind: string;
  cause: string | null;
  sourceIssueId?: string;
  fingerprint?: string;
  createdAt: Date | string;
  evidence?: unknown;
}

interface BlockedIssueLike {
  id: string;
  updatedAt: Date | string;
  blockedTransitionAt?: Date | string | null;
  unblockDescriptor?: UnblockDescriptor;
  blockerAttention?: { state?: string; blockingTreeLive?: boolean; terminalBlockerIssueId?: string | null } | null;
}

export interface BlockerOccurrence {
  /** Latest blocked transition in the tree; a newly blocked issue moves it forward. */
  latest: number;
  blockedIssueIds: string[];
  descriptors: UnblockDescriptor[];
}

function timestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function chunks<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += QUERY_CHUNK_SIZE) out.push(values.slice(i, i + QUERY_CHUNK_SIZE));
  return out;
}

let configCache: { raw: string | undefined; byCompany: Map<string, string[]> } = { raw: undefined, byCompany: new Map() };

/** Parses the delegate config once per distinct value; a malformed value disables delegation and warns once. */
function delegateConfig(): Map<string, string[]> {
  const raw = process.env[ATTENTION_DELEGATES_ENV] ?? "";
  if (raw === configCache.raw) return configCache.byCompany;
  const byCompany = new Map<string, string[]>();
  if (raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected an object mapping companyId to an array of agent ids");
      }
      for (const [companyId, ids] of Object.entries(parsed)) {
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length === 0)) {
          throw new Error(`company ${companyId}: expected an array of agent id strings`);
        }
        if (ids.length > 0) byCompany.set(companyId, ids as string[]);
      }
    } catch (err) {
      byCompany.clear();
      logger.warn(
        { reason: err instanceof Error ? err.message : String(err) },
        `${ATTENTION_DELEGATES_ENV} is malformed; attention delegation is disabled`,
      );
    }
  }
  configCache = { raw, byCompany };
  return byCompany;
}

/** The configured delegate agent ids for a company; empty when delegation is off. */
export function attentionDelegateAgentIds(companyId: string | null | undefined): string[] {
  return (companyId && delegateConfig().get(companyId)) || [];
}

/** True when the company has at least one configured delegate. */
export function attentionDelegationEnabled(companyId: string | null | undefined): boolean {
  return attentionDelegateAgentIds(companyId).length > 0;
}

/** True when `agentId` is a configured delegate of `companyId`. */
export function isAttentionDelegate(companyId: string | null | undefined, agentId: string | null | undefined): boolean {
  return Boolean(agentId) && attentionDelegateAgentIds(companyId).includes(agentId as string);
}

/** Board-owned recovery of an allowlisted kind whose kind and cause are not sensitive. User-owned recovery never qualifies. */
export function isDelegatableRecovery(row: Pick<RecoveryRowLike, "ownerType" | "kind" | "cause"> | null | undefined): boolean {
  return Boolean(row)
    && row!.ownerType === "board"
    && DELEGATABLE_RECOVERY_KINDS.has(row!.kind)
    && !NON_DELEGATABLE_TEXT.test(`${row!.kind} ${row!.cause ?? ""}`);
}

/** True when an unblock step is owned by the board or a user, or is a grant, spend or access step. */
export function isHumanOrSensitiveUnblock(descriptor: UnblockDescriptor): boolean {
  if (!descriptor || typeof descriptor !== "object") return false;
  const owner = descriptor.owner;
  if (owner === "board" || (owner && typeof owner === "object" && "userId" in owner)) return true;
  return NON_DELEGATABLE_TEXT.test(readString(descriptor.action) ?? "");
}

/** A recovery occurrence starts when the action row is created, or again when its retry budget runs out. */
export function recoveryOccurrenceStart(row: Pick<RecoveryRowLike, "createdAt" | "evidence">): string {
  const exhaustedAt = readString(readRecord(readRecord(row.evidence).recoveryBudget).exhaustedAt);
  return new Date(Math.max(timestamp(row.createdAt), timestamp(exhaustedAt))).toISOString();
}

/** Groups stalled, non-live blocked issues by terminal blocker, with the tree's blocked set and latest blocked transition. */
export function stalledBlockerOccurrences(blockedIssues: BlockedIssueLike[]): Map<string, BlockerOccurrence> {
  const byTerminal = new Map<string, BlockerOccurrence>();
  for (const issue of blockedIssues) {
    const attention = issue.blockerAttention;
    if ((attention?.state !== "stalled" && attention?.state !== "needs_attention") || attention.blockingTreeLive) continue;
    const terminalIssueId = attention.terminalBlockerIssueId ?? issue.id;
    const current = byTerminal.get(terminalIssueId) ?? { latest: 0, blockedIssueIds: [], descriptors: [] };
    current.latest = Math.max(current.latest, timestamp(issue.blockedTransitionAt ?? issue.updatedAt));
    current.blockedIssueIds.push(issue.id);
    current.descriptors.push(issue.unblockDescriptor ?? null);
    byTerminal.set(terminalIssueId, current);
  }
  return byTerminal;
}

/** The delegation entry for a blocker occurrence, or null when any unblock step on it must stay with humans. */
export function blockerDelegation(
  terminalIssueId: string,
  occurrence: BlockerOccurrence | undefined,
  terminalDescriptor: UnblockDescriptor,
): DelegatableOccurrence | null {
  if (!occurrence || isHumanOrSensitiveUnblock(terminalDescriptor) || occurrence.descriptors.some(isHumanOrSensitiveUnblock)) {
    return null;
  }
  const occurrenceStartedAt = new Date(occurrence.latest).toISOString();
  const blockedIssueIds = [...new Set(occurrence.blockedIssueIds)].sort();
  return {
    sourceKind: "blocker_attention",
    issueId: terminalIssueId,
    occurrenceStartedAt,
    occurrenceKey: `blocker:${createHash("sha256").update(`${terminalIssueId}|${blockedIssueIds.join(",")}|${occurrenceStartedAt}`).digest("hex").slice(0, 32)}`,
    liveCheckIssueIds: [terminalIssueId, ...blockedIssueIds],
  };
}

/** The occurrence identity of a recovery action: the row, plus when its current escalation began. */
export function recoveryOccurrence(row: RecoveryRowLike & { id: string; sourceIssueId: string }): DelegatableOccurrence {
  const occurrenceStartedAt = recoveryOccurrenceStart(row);
  return { sourceKind: "recovery_action", issueId: row.sourceIssueId, occurrenceStartedAt, occurrenceKey: `recovery:${row.id}:${occurrenceStartedAt}` };
}

/** The unblock descriptor of each issue id that exists in the company. */
export async function unblockDescriptorMap(db: Db, companyId: string, issueIds: string[]): Promise<Map<string, UnblockDescriptor>> {
  const byId = new Map<string, UnblockDescriptor>();
  for (const chunk of chunks([...new Set(issueIds)])) {
    const rows = await db
      .select({ id: issues.id, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, chunk)));
    for (const row of rows) byId.set(row.id, (row.unblockDescriptor as UnblockDescriptor) ?? null);
  }
  return byId;
}

/**
 * Resolves an attention dismissal key to the live, delegatable occurrence it names.
 * Returns null when no live item has the key, and `{ ineligible }` when one exists but must stay with humans.
 */
export async function findDelegatableAttentionItem(
  db: Db,
  companyId: string,
  itemKey: string,
  actor: AuthorizationActor | null,
): Promise<DelegatableOccurrence | { ineligible: string; issueId: string } | null> {
  if (itemKey.startsWith("attention:recovery:")) {
    const sourceIssueId = itemKey.split(":")[3];
    if (!sourceIssueId) return null;
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
        inArray(issueRecoveryActions.status, OPEN_RECOVERY_STATUSES),
        inArray(issueRecoveryActions.ownerType, HUMAN_RECOVERY_OWNER_TYPES),
      ));
    const row = rows.find((r) => `attention:recovery:${r.kind}:${r.sourceIssueId}:${r.cause}:${r.fingerprint}` === itemKey);
    if (!row) return null;
    if (!isDelegatableRecovery(row)) {
      return { ineligible: `recovery ${row.kind}/${row.cause} owned by ${row.ownerType} is not delegatable`, issueId: sourceIssueId };
    }
    return recoveryOccurrence(row);
  }
  if (itemKey.startsWith("attention:blocker:")) {
    const terminalIssueId = itemKey.slice("attention:blocker:".length);
    const readCondition = actor ? await issueReadSqlCondition(db, actor) : sql<boolean>`true`;
    const blockedIssues = await issueService(db).list(companyId, { status: "blocked", includeBlockedBy: true, readCondition });
    const occurrence = stalledBlockerOccurrences(blockedIssues as unknown as BlockedIssueLike[]).get(terminalIssueId);
    if (!occurrence) return null;
    const descriptors = await unblockDescriptorMap(db, companyId, [terminalIssueId]);
    if (!descriptors.has(terminalIssueId)) return null;
    return blockerDelegation(terminalIssueId, occurrence, descriptors.get(terminalIssueId))
      ?? { ineligible: "an unblock step on this tree is human-owned or a grant, spend or access step", issueId: terminalIssueId };
  }
  return null;
}

/** Newest decision per item key, recorded on the given issues during the last hold window, by board users or current delegates. */
async function delegateDecisionsForIssues(db: Db, companyId: string, issueIds: string[], now: number) {
  const delegateIds = attentionDelegateAgentIds(companyId);
  const byKey = new Map<string, AttentionDelegateDecision>();
  for (const chunk of chunks(issueIds)) {
    // Served by activity_log_entity_type_id_idx (entity_type, entity_id); no new index is needed.
    const rows = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        agentId: activityLog.agentId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityType, "issue"),
        inArray(activityLog.entityId, chunk),
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, ATTENTION_DELEGATE_DECISION_ACTION),
        gt(activityLog.createdAt, new Date(now - ATTENTION_DELEGATE_MAX_HOLD_MS)),
      ));
    for (const row of rows) {
      const details = readRecord(row.details);
      const itemKey = readString(details.itemKey);
      if (!itemKey) continue;
      if (row.actorType !== "user" && !(row.agentId && delegateIds.includes(row.agentId))) continue;
      const decidedAt = new Date(row.createdAt).toISOString();
      const current = byKey.get(itemKey);
      if (current && timestamp(current.decidedAt) >= timestamp(decidedAt)) continue;
      byKey.set(itemKey, {
        verb: readString(details.verb) ?? "",
        reason: readString(details.reason),
        holdUntil: readString(details.holdUntil),
        occurrenceKey: readString(details.occurrenceKey),
        decidedByType: row.actorType,
        decidedById: row.actorId,
        decidedAt,
      });
    }
  }
  return byKey;
}

/** Latest run creation time per issue since `since`, served by heartbeat_runs_company_issue_created_idx. */
async function latestRunByIssue(db: Db, companyId: string, issueIds: string[], since: number): Promise<Map<string, number>> {
  const byIssue = new Map<string, number>();
  for (const chunk of chunks([...new Set(issueIds)])) {
    const rows = await db
      .select({ issueId: heartbeatRuns.issueId, latest: max(heartbeatRuns.createdAt) })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.issueId, chunk), gt(heartbeatRuns.createdAt, new Date(since))))
      .groupBy(heartbeatRuns.issueId);
    for (const row of rows) if (row.issueId) byIssue.set(row.issueId, timestamp(row.latest));
  }
  return byIssue;
}

/**
 * The decision that keeps this occurrence off the board queue, or null. It must name this occurrence's key,
 * postdate its start, be within its capped hold, and (for blocker trees) predate any run in the tree.
 */
export function activeDelegateDecision(
  decision: AttentionDelegateDecision | null | undefined,
  occurrence: Pick<DelegatableOccurrence, "occurrenceStartedAt" | "occurrenceKey"> | null | undefined,
  now: number,
  lastLiveAt = 0,
): AttentionDelegateDecision | null {
  if (!decision || !occurrence || !decision.verb || DELEGATE_RETURN_VERBS.has(decision.verb)) return null;
  if (!decision.occurrenceKey || decision.occurrenceKey !== occurrence.occurrenceKey) return null;
  if (!decision.holdUntil) return null;
  const decidedAt = timestamp(decision.decidedAt);
  const holdEnds = Math.min(timestamp(decision.holdUntil), decidedAt + ATTENTION_DELEGATE_MAX_HOLD_MS);
  if (holdEnds <= now) return null;
  if (decidedAt < timestamp(occurrence.occurrenceStartedAt)) return null;
  if (lastLiveAt > decidedAt) return null;
  return decision;
}

/**
 * Removes delegated occurrences from `items` in place. With includeDismissed they stay and carry
 * `delegateDecision`. Only keys present in `eligible` are considered, so decisions are fetched for the issues
 * of those candidates only.
 */
export async function applyDelegateDecisions(
  db: Db,
  companyId: string,
  items: AttentionItem[],
  eligible: Map<string, DelegatableOccurrence>,
  now: number,
  includeDismissed: boolean,
): Promise<void> {
  const candidates = items.filter((item) => eligible.has(item.dismissalKey));
  if (candidates.length === 0) return;
  const issueIds = [...new Set(candidates.map((item) => eligible.get(item.dismissalKey)!.issueId))];
  const decisions = await delegateDecisionsForIssues(db, companyId, issueIds, now);
  // Live check only for blocker trees that would otherwise stay hidden.
  const liveIds = candidates.flatMap((item) => {
    const occurrence = eligible.get(item.dismissalKey)!;
    return occurrence.liveCheckIssueIds && activeDelegateDecision(decisions.get(item.dismissalKey), occurrence, now)
      ? occurrence.liveCheckIssueIds
      : [];
  });
  const latestRuns = liveIds.length > 0
    ? await latestRunByIssue(db, companyId, liveIds, now - ATTENTION_DELEGATE_MAX_HOLD_MS)
    : new Map<string, number>();
  const kept: AttentionItem[] = [];
  for (const item of items) {
    const occurrence = eligible.get(item.dismissalKey);
    const lastLiveAt = Math.max(0, ...(occurrence?.liveCheckIssueIds ?? []).map((id) => latestRuns.get(id) ?? 0));
    const decision = occurrence ? activeDelegateDecision(decisions.get(item.dismissalKey), occurrence, now, lastLiveAt) : null;
    if (decision && !includeDismissed) continue;
    kept.push(decision ? { ...item, delegateDecision: decision } : item);
  }
  items.splice(0, items.length, ...kept);
}
