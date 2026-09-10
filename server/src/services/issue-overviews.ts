/**
 * Read-only board projection for a batch of issues.
 *
 * Every fact here is derived from canonical rows the server already owns
 * (issues, relations, audited status transitions, delivery units/queue/findings,
 * external objects, work products) in a bounded set of batch queries. The
 * projection never calls a forge, never writes, and never reconciles delivery
 * state: freshness is the recorded observation timestamp on the response, not a
 * new provider read.
 *
 * Phase is not status. A `blocked` task keeps the backend `blocked` safety state
 * while the board projects the phase the record supports, chosen by trustworthy
 * chronology: current delivery evidence, otherwise the latest audited
 * non-blocked transition, otherwise an explicit execution stage. When nothing was
 * ever recorded the phase is `null` with `phaseSource: "unknown"` — never hidden,
 * never guessed from prose.
 */
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companyMemberships,
  deliveryFindings,
  deliveryPolicies,
  deliveryQueueEntries,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  externalObjectMentions,
  externalObjects,
  issueRelations,
  issueWorkProducts,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import type {
  DeliveryAutoDeployDisposition,
  DeliveryPhase,
  DeliveryPolicyAuthorizationState,
  ExternalObjectLivenessState,
  IssueDeliveryReadiness,
  IssueExecutionStageType,
  IssueOverview,
  IssueOverviewPullRequest,
  IssueOverviewRef,
  IssueOverviewsResponse,
  IssueStatus,
} from "@paperclipai/shared";
import { ISSUE_STATUSES } from "@paperclipai/shared";
import { repositoryFullName } from "./delivery/policy.js";
import { deriveDeliveryPhase, readUnitMetadata, type DeliveryUnitRow } from "./delivery/units.js";

/** The route rejects a larger request; the service is bounded by the same cap. */
export const ISSUE_OVERVIEW_MAX_IDS = 100;

/** Direct children returned per issue; exact counts are unaffected by this cap. */
export const MAX_CHILD_REFS_PER_ISSUE = 50;

/** Mirrors the delivery controller's terminal unit set. */
const TERMINAL_UNIT_STATUSES = ["merged", "cancelled", "closed_unmerged"] as const;

/** Statuses that end or hold a task rather than describing live work. */
const NON_LIVE_STATUSES = ["done", "cancelled", "blocked"] as const;

const HTTP_URL_PATTERN = /^https?:\/\//i;

/** A repository is named `owner/name`; a URL or a bare name is not one. */
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type IssueRefRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
};

type PullRequestState = IssueOverviewPullRequest["state"];

/**
 * Where a pull-request fact came from. Paperclip's own resolver writes provider
 * observations; a work product is reported by whoever created it, so it is
 * provisional and may never upgrade itself to a merged outcome.
 */
type PullRequestSource = "provider" | "local";

type PullRequestCandidate = {
  /**
   * Host a record names for the repository. It qualifies the repository facet and
   * is never a wildcard: `null` means this record named no host, which is not
   * proof that it shares one with a record that did.
   */
  host: string | null;
  repository: string | null;
  number: number | null;
  url: string | null;
  state: PullRequestState;
  updatedAt: string | null;
  stale: boolean;
  source: PullRequestSource;
  observedAt: number;
};

/** Normalized identity facets, computed once per record. */
type PullRequestFacets = {
  /** Canonical URL, folded for case and trailing slashes; `null` when unrecorded. */
  urlKey: string | null;
  /** `host/repository#number`; `null` until the record names a host. */
  repoKey: string | null;
};

/**
 * Inputs the phase decision reads. All of it is already-resolved evidence; the
 * decision never inspects prose, titles or metadata blobs.
 */
export type IssuePhaseEvidence = {
  /** Latest audited non-blocked transition, if one was recorded. */
  historyStatus: Exclude<IssueStatus, "blocked"> | null;
  /** Retained phase of the delivery unit that currently covers the issue. */
  deliveryPhase: DeliveryPhase | null;
  /** When that delivery evidence was recorded (merge or last unit event). */
  deliveryAt: Date | null;
  /** True when the selected unit is merged — the only claim that goes stale. */
  deliveryMerged: boolean;
  /** Merge time of the selected unit, when it merged. */
  mergedAt: Date | null;
  /**
   * Newest audited transition into a live phase. A reopen after a merge is what
   * separates the merge's cycle from the task's current one.
   */
  lastLiveTransitionAt: Date | null;
  /** Explicit pending execution stage, when one is meaningful. */
  executionStage: IssueExecutionStageType | null;
  /** Whether the board treats the task as blocked at all. */
  blocked?: boolean;
};

/**
 * A merge belongs to one task cycle and only speaks for the current one.
 *
 * A reopen records a live transition after the merge, which is durable proof
 * that a later cycle exists — including when the task has since been closed
 * again, so a re-`done` with the old unit can never masquerade as a fresh merge.
 */
export function isMergeSuperseded(input: {
  mergedAt: Date | null;
  lastLiveTransitionAt: Date | null;
}): boolean {
  if (!input.mergedAt || !input.lastLiveTransitionAt) return false;
  return input.lastLiveTransitionAt.getTime() > input.mergedAt.getTime();
}

export function deriveIssueOverviewPhase(
  status: IssueStatus,
  evidence: IssuePhaseEvidence,
): { phase: Exclude<IssueStatus, "blocked"> | null; source: IssueOverview["phaseSource"] } {
  const blocked = evidence.blocked ?? status === "blocked";
  if (!blocked) {
    // `blocked` is true whenever the status is `blocked`, so reaching here means
    // the status itself is the projected phase.
    return { phase: status as Exclude<IssueStatus, "blocked">, source: "status" };
  }
  const mergeSuperseded = evidence.deliveryMerged
    && isMergeSuperseded({ mergedAt: evidence.mergedAt, lastLiveTransitionAt: evidence.lastLiveTransitionAt });
  // A non-merged unit only speaks for the current cycle while no live phase has
  // happened since it was last observed; otherwise a stale in-review unit would
  // outlive the implementation/review work that replaced it.
  const deliverySuperseded = mergeSuperseded
    || (evidence.lastLiveTransitionAt !== null
      && evidence.deliveryAt !== null
      && evidence.lastLiveTransitionAt.getTime() > evidence.deliveryAt.getTime());
  if (evidence.deliveryPhase && evidence.deliveryPhase !== "not_started" && !deliverySuperseded) {
    return { phase: evidence.deliveryPhase, source: "delivery" };
  }
  if (evidence.historyStatus) {
    return { phase: evidence.historyStatus, source: "history" };
  }
  if (evidence.executionStage) {
    // Both explicit stages run after implementation work has started, so the
    // recorded phase for a pending review/approval gate is `in_review`.
    return { phase: "in_review", source: "execution" };
  }
  return { phase: null, source: "unknown" };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Raw aggregates and JSON-extracted columns lose the column's timestamp mapper,
 * so a driver may hand back an ISO string instead of a `Date`. Normalize at the
 * boundary rather than trusting the declared type.
 */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A pull-request link is rendered as an anchor on the board, so only a plain
 * HTTP(S) URL is passed through. The URL parser silently strips control
 * characters and whitespace — which can turn a hostile scheme into a plausible
 * one — so the raw value is rejected before parsing rather than after.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !HTTP_URL_PATTERN.test(trimmed)) return null;
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Freshness of a recorded observation. Mirrors `visibleLiveness` in
 * `external-objects.ts`: a fresh object past its refresh window is stale.
 */
function observedLiveness(
  object: { liveness: ExternalObjectLivenessState; nextRefreshAt: Date | null },
  now: number,
): ExternalObjectLivenessState {
  if (object.liveness === "fresh" && object.nextRefreshAt && object.nextRefreshAt.getTime() <= now) {
    return "stale";
  }
  return object.liveness;
}

function isNonBlockedStatus(value: string | null): value is Exclude<IssueStatus, "blocked"> {
  return value !== null
    && value !== "blocked"
    && (ISSUE_STATUSES as readonly string[]).includes(value);
}

/** Host of a canonical URL; `null` when the record never named a usable one. */
function hostFacet(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Identity facets of one record, normalized once so the grouping scan compares
 * plain strings instead of re-parsing URLs per pair.
 *
 * The repository facet includes the host because `owner/name#43` on two forges is
 * two pull requests, and it exists only when the record names a host: a record
 * that mentions a repository without one has no proof of sharing an identity, so
 * it stays its own chip rather than bridging records that do.
 */
function pullRequestFacets(input: {
  host: string | null;
  repository: string | null;
  number: number | null;
  url: string | null;
}): PullRequestFacets {
  return {
    urlKey: input.url ? input.url.toLowerCase().replace(/\/+$/, "") : null,
    repoKey: input.host && input.repository && input.number !== null
      ? `${input.host.toLowerCase()}/${input.repository.toLowerCase()}#${input.number}`
      : null,
  };
}

/**
 * Reconciles two records that are already known to describe one pull request.
 *
 * The winner is chosen by what each record can actually prove, not by recency: a
 * provider-observed merge is irreversible and outranks everything; a provider
 * observation outranks a locally reported work product; among equals, a named
 * state outranks `unknown`, then the newer observation wins. So a stale open
 * observation can never undo a later merged receipt, and an agent-reported merge
 * can never override what the provider says.
 *
 * The winner keeps its own evidence — source, state, freshness and timestamp; a
 * newer local timestamp never stamps provider state. Only identity the winner
 * never learned is taken from the other record, and the host travels with the
 * repository it was recorded with so a filled pair stays consistent.
 */
export function choosePullRequest(
  left: PullRequestCandidate,
  right: PullRequestCandidate,
): PullRequestCandidate {
  // Authority as a rank: provider-observed merge (7), provider named state (3),
  // provider unknown (2), local named state (1), local unknown (0).
  const rank = (candidate: PullRequestCandidate) =>
    (candidate.source === "provider" ? 2 : 0)
    + (candidate.source === "provider" && candidate.state === "merged" ? 4 : 0)
    + (candidate.state === "unknown" ? 0 : 1);
  const leftRank = rank(left);
  const rightRank = rank(right);
  const winner = leftRank !== rightRank
    ? leftRank > rightRank ? left : right
    : right.observedAt > left.observedAt ? right : left;
  if (winner.url !== null && winner.number !== null && winner.repository !== null) return winner;

  const other = winner === left ? right : left;
  return {
    ...winner,
    url: winner.url ?? other.url,
    number: winner.number ?? other.number,
    repository: winner.repository ?? other.repository,
    // A repository is only usable identity with the host it was recorded under.
    host: winner.repository !== null ? winner.host : other.host ?? winner.host,
  };
}

/**
 * Joins the records that describe one pull request and reconciles their evidence
 * into a single chip.
 *
 * Facets are transitive, which is the point: a provider observation that knows
 * both the URL and the repository bridges a URL-only record and a record that
 * knows the same repository, so a partially populated record joins the same pull
 * request instead of appearing beside it. Nothing else joins: an unknown host
 * proves nothing about a shared one, and a record that names no URL, repository
 * or number is dropped rather than rendered as a nameless chip.
 */
function dedupePullRequests(candidates: readonly PullRequestCandidate[]): PullRequestCandidate[] {
  type FacetedCandidate = { candidate: PullRequestCandidate; facets: PullRequestFacets };
  const clusters: FacetedCandidate[][] = [];
  for (const candidate of candidates) {
    if (candidate.url === null && (candidate.repository === null || candidate.number === null)) continue;
    const record: FacetedCandidate = { candidate, facets: pullRequestFacets(candidate) };
    const matched = clusters.filter((cluster) => cluster.some((member) =>
      (record.facets.urlKey !== null && member.facets.urlKey === record.facets.urlKey)
      || (record.facets.repoKey !== null && member.facets.repoKey === record.facets.repoKey)));
    if (matched.length === 0) {
      clusters.push([record]);
      continue;
    }
    const [target, ...absorbed] = matched;
    target!.push(record, ...absorbed.flat());
    for (const cluster of absorbed) clusters.splice(clusters.indexOf(cluster), 1);
  }
  return clusters.map((cluster) =>
    cluster.map((member) => member.candidate).reduce((winner, member) => choosePullRequest(winner, member)));
}

/**
 * Repository named by a provider observation. Paperclip's own GitHub resolver
 * records the split `owner`/`repo` pair, while other writers record one
 * `repository` string; both state the same fact, and reading only the split form
 * loses the repository — and with it the identity that joins this observation to
 * the delivery record for the same pull request. Anything that is not a plain
 * `owner/name` is ignored rather than guessed at.
 */
function externalObjectRepository(data: Record<string, unknown>): string | null {
  const owner = asString(data.owner);
  const repo = asString(data.repo);
  if (owner && repo) return `${owner}/${repo}`;
  const repository = asString(data.repository);
  return repository && REPOSITORY_NAME_PATTERN.test(repository) ? repository : null;
}

/**
 * Provider state of a GitHub pull request from its canonical external object.
 * A merge wins over a closed state, and a stale or unreachable observation keeps
 * the last known state instead of degrading it to "no PR".
 */
function externalObjectPullRequest(object: typeof externalObjects.$inferSelect, now: number): {
  state: PullRequestState;
  updatedAt: string | null;
  stale: boolean;
  repository: string | null;
  number: number | null;
} {
  const data = readRecord(object.data) ?? {};
  const statusKey = asString(object.statusKey)?.toLowerCase() ?? null;
  const state = asString(data.state)?.toLowerCase() ?? null;
  const merged = statusKey === "merged" || data.merged === true;
  const closed = !merged && (statusKey === "closed" || state === "closed");
  const draft = !merged && !closed && (statusKey === "draft" || data.draft === true);
  const open = !merged && !closed && !draft && (statusKey === "open" || state === "open");
  const resolvedState: PullRequestState = merged
    ? "merged"
    : closed
    ? "closed"
    : draft
    ? "draft"
    : open
    ? "open"
    : "unknown";
  return {
    state: resolvedState,
    updatedAt: asString(object.remoteVersion)
      ?? iso(object.lastChangedAt)
      ?? iso(object.lastResolvedAt),
    stale: observedLiveness(object, now) !== "fresh",
    repository: externalObjectRepository(data),
    number: asNumber(data.number),
  };
}

/**
 * Pull request as recorded by an issue work product. Nothing here proves who
 * observed the state — Paperclip has no provider provenance for a work product —
 * so every work-product fact is provisional: it stays visible, it is marked
 * stale, and it never overrides a provider observation.
 */
function workProductPullRequest(row: {
  url: string | null;
  externalId: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  updatedAt: Date;
}): {
  state: PullRequestState;
  updatedAt: string;
  repository: string | null;
  number: number | null;
} {
  const metadata = readRecord(row.metadata) ?? {};
  const metadataState = asString(metadata.state)?.toLowerCase() ?? null;
  const status = asString(row.status)?.toLowerCase() ?? "";
  let state: PullRequestState = "unknown";
  if (metadataState === "merged" || metadataState === "closed" || metadataState === "draft" || metadataState === "open") {
    state = metadataState;
  } else if (metadata.draft === true) {
    state = "draft";
  } else if (metadata.draft === false && metadataState === null && status === "open") {
    state = "open";
  } else if (status === "merged") {
    state = "merged";
  } else if (status === "closed") {
    state = "closed";
  } else if (status === "draft") {
    state = "draft";
  } else if (status === "active" || status === "ready_for_review" || status === "approved" || status === "changes_requested") {
    state = "open";
  }
  const externalMatch = /^([\w.-]+\/[\w.-]+)#([0-9]+)$/.exec(row.externalId ?? "");
  return {
    state,
    updatedAt: row.updatedAt.toISOString(),
    repository: asString(metadata.repo) ?? externalMatch?.[1] ?? null,
    number: asNumber(metadata.number) ?? (externalMatch ? Number.parseInt(externalMatch[2]!, 10) : null),
  };
}

/**
 * Pull request as tracked by a delivery unit. A merge or a controller-recorded
 * closed-unmerged result is provider truth; a cancelled unit is not — stopping
 * the unit does not close the pull request.
 */
function deliveryUnitPullRequest(
  unit: DeliveryUnitRow,
  repository: { owner: string; name: string; host: string } | null,
): PullRequestCandidate | null {
  if (!unit.prUrl && unit.prNumber === null) return null;
  const merged = unit.status === "merged" && (unit.mergedAt !== null || unit.mergedSha !== null);
  const closedUnmerged = unit.status === "closed_unmerged";
  const cancelled = unit.status === "cancelled";
  const state: PullRequestState = merged ? "merged" : closedUnmerged ? "closed" : cancelled ? "unknown" : "open";
  const url = safeHttpUrl(unit.prUrl);
  return {
    // The repository row is this unit's declared repository identity; the pull
    // request URL is where the record links, and only hosts it when that is all
    // the record knows.
    host: repository ? repository.host.toLowerCase() : hostFacet(url),
    repository: repository ? repositoryFullName(repository.owner, repository.name) : null,
    number: unit.prNumber,
    url,
    state,
    updatedAt: merged
      ? iso(unit.mergedAt) ?? iso(unit.updatedAt)
      : iso(unit.lastEventAt) ?? iso(unit.updatedAt),
    // A merge is a durable recorded outcome; everything else is provisional.
    stale: !(merged || closedUnmerged),
    source: "provider",
    observedAt: merged ? (unit.mergedAt?.getTime() ?? 0) : (unit.lastEventAt?.getTime() ?? 0) || unit.updatedAt.getTime(),
  };
}

function toOverviewRef(row: IssueRefRow): IssueOverviewRef {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueStatus,
  };
}

function unresolvedBlockerRefs(rows: IssueRefRow[]): IssueOverviewRef[] {
  return rows
    .filter((row) => row.status !== "done")
    .map(toOverviewRef)
    .sort((left, right) => (left.identifier ?? left.title).localeCompare(right.identifier ?? right.title));
}

export interface IssueOverviewService {
  list(companyId: string, issueIds: readonly string[]): Promise<IssueOverviewsResponse>;
}

export function issueOverviewService(db: Db): IssueOverviewService {
  async function list(companyId: string, requestedIds: readonly string[]): Promise<IssueOverviewsResponse> {
    const ids = [...new Set(requestedIds)];
    if (ids.length === 0) return { items: [], observedAt: new Date().toISOString() };

    const issueRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        projectId: issues.projectId,
        parentId: issues.parentId,
        executionState: issues.executionState,
        unblockDescriptor: issues.unblockDescriptor,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
    if (issueRows.length === 0) return { items: [], observedAt: new Date().toISOString() };

    const requestedIssueIds = issueRows.map((row) => row.id);
    const parentIds = [...new Set(issueRows.map((row) => row.parentId).filter((id): id is string => id !== null))];
    const projectIds = [...new Set(issueRows.map((row) => row.projectId).filter((id): id is string => id !== null))];
    const now = Date.now();

    // --- Children -----------------------------------------------------------
    // Per-parent ranking, so one parent with a huge subtree cannot consume the
    // batch and starve the parents after it. Counts stay exact: the reference
    // list is capped, the aggregates are not.
    const rankedChildren = db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        parentId: issues.parentId,
        rank: sql<number>`row_number() over (
          partition by ${issues.parentId} order by ${issues.createdAt} asc, ${issues.id} asc
        )`.as("rank"),
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, requestedIssueIds)))
      .as("ranked_children");

    const [parentRows, childRefRows, childCountRows, projectRows] = await Promise.all([
      parentIds.length === 0
        ? Promise.resolve([] as IssueRefRow[])
        : db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, parentIds))),
      db
        .select({
          id: rankedChildren.id,
          identifier: rankedChildren.identifier,
          title: rankedChildren.title,
          status: rankedChildren.status,
          parentId: rankedChildren.parentId,
        })
        .from(rankedChildren)
        .where(lte(rankedChildren.rank, MAX_CHILD_REFS_PER_ISSUE))
        .orderBy(asc(rankedChildren.parentId), asc(rankedChildren.rank)),
      db
        .select({
          parentId: issues.parentId,
          childCount: sql<number>`count(*)::int`,
          completedChildCount: sql<number>`count(*) filter (where ${issues.status} = 'done')::int`,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, requestedIssueIds)))
        .groupBy(issues.parentId),
      projectIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; name: string; color: string | null }>)
        : db
          .select({ id: projects.id, name: projects.name, color: projects.color })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds))),
    ]);

    // --- Status-transition evidence ----------------------------------------
    // Two bounded aggregates over the audited transitions of the requested
    // issues. Neither reads the full history: the first is a `max`, the second
    // keeps one row per issue.
    const transitionScope = and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.action, "issue.updated"),
      inArray(activityLog.entityId, requestedIssueIds),
      sql`${activityLog.details}->>'status' is not null`,
      sql`coalesce(${activityLog.details}->'_previous'->>'status', '') <> ${activityLog.details}->>'status'`,
    );

    const [lastLiveTransitionRows, latestNonBlockedRows] = await Promise.all([
      db
        .select({
          issueId: activityLog.entityId,
          at: sql<Date | string | null>`max(${activityLog.createdAt}) filter (where ${
            activityLog.details
          }->>'status' not in ('done', 'cancelled', 'blocked'))`,
        })
        .from(activityLog)
        .where(transitionScope)
        .groupBy(activityLog.entityId),
      db
        .selectDistinctOn([activityLog.entityId], {
          issueId: activityLog.entityId,
          status: sql<string | null>`${activityLog.details}->>'status'`,
        })
        .from(activityLog)
        .where(and(transitionScope, sql`${activityLog.details}->>'status' <> 'blocked'`))
        .orderBy(asc(activityLog.entityId), desc(activityLog.createdAt)),
    ]);

    // --- Delivery units -----------------------------------------------------
    const [unitIssueRows, blockerRelationRows] = await Promise.all([
      db
        .select({ issueId: deliveryUnitIssues.issueId, unit: deliveryUnits })
        .from(deliveryUnitIssues)
        .innerJoin(
          deliveryUnits,
          and(
            eq(deliveryUnits.id, deliveryUnitIssues.unitId),
            eq(deliveryUnits.companyId, companyId),
          ),
        )
        .where(and(
          eq(deliveryUnitIssues.companyId, companyId),
          inArray(deliveryUnitIssues.issueId, requestedIssueIds),
        ))
        .orderBy(desc(deliveryUnits.createdAt)),
      // Blocking relations for every requested task: a delivery blocker can make
      // a task blocked without its status being `blocked`, and those tasks need
      // their named blockers just as much.
      db
        .select({
          blockedIssueId: issueRelations.relatedIssueId,
          blockerIssueId: issueRelations.issueId,
        })
        .from(issueRelations)
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, requestedIssueIds),
        )),
    ]);

    const blockerIds = [...new Set(blockerRelationRows.map((row) => row.blockerIssueId))];
    const units = unitIssueRows.map((row) => row.unit);
    const repositoryIds = [...new Set(units.map((unit) => unit.repositoryId))];
    const unitIds = [...new Set(units.map((unit) => unit.id))];
    const policyProjectIds = [...new Set(units.flatMap((unit) => unit.projectId ? [unit.projectId] : []))];

    // --- Queue positions ----------------------------------------------------
    // Positions come from the same ordering the queue itself uses, ranked in SQL
    // over one partition per repository+branch and filtered to the units this
    // batch asked about. Reading a truncated page of queue rows would invent
    // positions for the rows that were dropped.
    const queuePriorityRank = sql`case ${deliveryQueueEntries.priority}
      when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 2 end`;
    const rankedQueue = db
      .select({
        unitId: deliveryQueueEntries.unitId,
        rank: sql<number>`row_number() over (
          partition by ${deliveryQueueEntries.repositoryId}, ${deliveryQueueEntries.targetBranch}
          order by ${queuePriorityRank},
            ${deliveryQueueEntries.readyAt} asc,
            ${deliveryQueueEntries.enqueuedAt} asc,
            ${deliveryQueueEntries.id} asc
        )`.as("rank"),
      })
      .from(deliveryQueueEntries)
      .where(and(
        eq(deliveryQueueEntries.companyId, companyId),
        inArray(deliveryQueueEntries.status, ["queued", "leased"]),
      ))
      .as("ranked_queue");

    const [blockerRows, repositoryRows, findingRows, queueRows, policyRows] = await Promise.all([
      blockerIds.length === 0
        ? Promise.resolve([] as IssueRefRow[])
        : db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, blockerIds))),
      repositoryIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; owner: string; name: string; host: string }>)
        : db
          .select({
            id: deliveryRepositories.id,
            owner: deliveryRepositories.owner,
            name: deliveryRepositories.name,
            host: deliveryRepositories.host,
          })
          .from(deliveryRepositories)
          .where(and(eq(deliveryRepositories.companyId, companyId), inArray(deliveryRepositories.id, repositoryIds))),
      // Open findings of the unit's *current* candidate generation and head
      // only: findings reported for a replaced candidate are history and must
      // not read as the current candidate's unresolved review.
      unitIds.length === 0
        ? Promise.resolve([] as Array<{ unitId: string; count: number }>)
        : db
          .select({ unitId: deliveryFindings.unitId, count: sql<number>`count(*)::int` })
          .from(deliveryFindings)
          .innerJoin(
            deliveryUnits,
            and(
              eq(deliveryUnits.id, deliveryFindings.unitId),
              eq(deliveryUnits.companyId, companyId),
              eq(deliveryUnits.candidateGeneration, deliveryFindings.candidateGeneration),
              eq(deliveryUnits.headSha, deliveryFindings.headSha),
            ),
          )
          .where(and(
            eq(deliveryFindings.companyId, companyId),
            inArray(deliveryFindings.unitId, unitIds),
            // `disputed` still blocks: it is unresolved, not dismissed.
            inArray(deliveryFindings.state, ["open", "disputed"]),
          ))
          .groupBy(deliveryFindings.unitId),
      unitIds.length === 0
        ? Promise.resolve([] as Array<{ unitId: string; rank: number }>)
        : db
          .select({ unitId: rankedQueue.unitId, rank: rankedQueue.rank })
          .from(rankedQueue)
          .where(inArray(rankedQueue.unitId, unitIds)),
      // Standing delivery policy per project: the authorization fact the final
      // gate reads, so the board shows authority state rather than inferring it
      // from prose or from an old pull request.
      policyProjectIds.length === 0
        ? Promise.resolve([] as Array<{
          projectId: string;
          version: number;
          authorization: unknown;
          authorizationInvalidatedAt: Date | null;
          authorizationInvalidatedScope: string[] | null;
          autoDeployDisposition: string;
        }>)
        : db
          .select({
            projectId: deliveryPolicies.projectId,
            version: deliveryPolicies.version,
            authorization: deliveryPolicies.authorization,
            authorizationInvalidatedAt: deliveryPolicies.authorizationInvalidatedAt,
            authorizationInvalidatedScope: deliveryPolicies.authorizationInvalidatedScope,
            autoDeployDisposition: deliveryPolicies.autoDeployDisposition,
          })
          .from(deliveryPolicies)
          .where(and(
            eq(deliveryPolicies.companyId, companyId),
            inArray(deliveryPolicies.projectId, policyProjectIds),
          )),
    ]);

    // `row_number()` comes back as a bigint, which the driver hands over as a
    // string; the contract types this as a number.
    const queuePositionByUnitId = new Map(queueRows.map((row) => [row.unitId, Number(row.rank)]));

    const parentById = new Map(parentRows.map((row) => [row.id, row]));
    const projectById = new Map(projectRows.map((row) => [row.id, row]));
    const blockerById = new Map(blockerRows.map((row) => [row.id, row]));
    const repositoryById = new Map(repositoryRows.map((row) => [row.id, row]));
    const policyByProjectId = new Map(policyRows.map((row) => [row.projectId, row]));
    const openFindingsByUnitId = new Map(findingRows.map((row) => [row.unitId, row.count]));
    const lastLiveTransitionAtByIssueId = new Map(
      lastLiveTransitionRows.map((row) => [row.issueId, toDate(row.at)]),
    );
    const latestNonBlockedStatusByIssueId = new Map(
      latestNonBlockedRows.map((row) => [row.issueId, row.status]),
    );

    const childrenByParentId = new Map<string, IssueRefRow[]>();
    for (const row of childRefRows) {
      if (!row.parentId) continue;
      const bucket = childrenByParentId.get(row.parentId);
      if (bucket) bucket.push(row);
      else childrenByParentId.set(row.parentId, [row]);
    }
    const childCountByParentId = new Map(childCountRows.map((row) => [row.parentId, row]));

    const blockerRefsByBlockedIssueId = new Map<string, IssueRefRow[]>();
    for (const relation of blockerRelationRows) {
      const row = blockerById.get(relation.blockerIssueId);
      if (!row) continue;
      const bucket = blockerRefsByBlockedIssueId.get(relation.blockedIssueId);
      if (bucket) bucket.push(row);
      else blockerRefsByBlockedIssueId.set(relation.blockedIssueId, [row]);
    }

    const unitsByIssueId = new Map<string, DeliveryUnitRow[]>();
    for (const row of unitIssueRows) {
      const bucket = unitsByIssueId.get(row.issueId);
      if (bucket) bucket.push(row.unit);
      else unitsByIssueId.set(row.issueId, [row.unit]);
    }

    // --- Pull requests ------------------------------------------------------
    // One bucket per issue, reconciled into chips once every canonical source
    // has contributed: only then can a record that knows the URL join the record
    // that knows the repository.
    const pullRequestCandidatesByIssueId = new Map<string, PullRequestCandidate[]>();
    const addCandidate = (issueId: string, candidate: PullRequestCandidate) => {
      const bucket = pullRequestCandidatesByIssueId.get(issueId);
      if (bucket) bucket.push(candidate);
      else pullRequestCandidatesByIssueId.set(issueId, [candidate]);
    };

    for (const row of unitIssueRows) {
      const candidate = deliveryUnitPullRequest(
        row.unit,
        repositoryById.get(row.unit.repositoryId) ?? null,
      );
      if (candidate) addCandidate(row.issueId, candidate);
    }

    const [mentionRows, workProductRows] = await Promise.all([
      db
        .select({ issueId: externalObjectMentions.sourceIssueId, object: externalObjects })
        .from(externalObjectMentions)
        .innerJoin(
          externalObjects,
          and(
            eq(externalObjects.id, externalObjectMentions.objectId),
            eq(externalObjects.companyId, companyId),
          ),
        )
        .where(and(
          eq(externalObjectMentions.companyId, companyId),
          eq(externalObjects.objectType, "pull_request"),
          inArray(externalObjectMentions.sourceIssueId, requestedIssueIds),
        )),
      db
        .select({
          issueId: issueWorkProducts.issueId,
          url: issueWorkProducts.url,
          externalId: issueWorkProducts.externalId,
          status: issueWorkProducts.status,
          metadata: issueWorkProducts.metadata,
          updatedAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "pull_request"),
          inArray(issueWorkProducts.issueId, requestedIssueIds),
        )),
    ]);

    for (const row of mentionRows) {
      const evidence = externalObjectPullRequest(row.object, now);
      const url = safeHttpUrl(row.object.sanitizedCanonicalUrl);
      addCandidate(row.issueId, {
        host: hostFacet(url),
        repository: evidence.repository,
        number: evidence.number,
        url,
        state: evidence.state,
        updatedAt: evidence.updatedAt,
        stale: evidence.stale,
        source: "provider",
        observedAt: row.object.lastResolvedAt?.getTime() ?? row.object.lastChangedAt?.getTime() ?? 0,
      });
    }

    for (const row of workProductRows) {
      const evidence = workProductPullRequest(row);
      const url = safeHttpUrl(row.url);
      addCandidate(row.issueId, {
        host: hostFacet(url),
        repository: evidence.repository,
        number: evidence.number,
        url,
        state: evidence.state,
        updatedAt: evidence.updatedAt,
        stale: true,
        source: "local",
        observedAt: row.updatedAt.getTime(),
      });
    }

    // --- Blocked owners -----------------------------------------------------
    // Only a member of this company may be named as an unblock owner, so a
    // descriptor that points at an unrelated account resolves to nothing.
    const descriptorOwnerAgentIds: string[] = [];
    const descriptorOwnerUserIds: string[] = [];
    for (const row of issueRows) {
      const owner = readRecord(readRecord(row.unblockDescriptor)?.owner);
      const agentId = asString(owner?.agentId);
      const userId = asString(owner?.userId);
      if (agentId) descriptorOwnerAgentIds.push(agentId);
      if (userId) descriptorOwnerUserIds.push(userId);
    }
    const [ownerAgentRows, ownerUserRows] = await Promise.all([
      descriptorOwnerAgentIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; name: string }>)
        : db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, descriptorOwnerAgentIds))),
      descriptorOwnerUserIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; name: string }>)
        : db
          .select({ id: authUsers.id, name: authUsers.name })
          .from(authUsers)
          .innerJoin(
            companyMemberships,
            and(
              eq(companyMemberships.principalId, authUsers.id),
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
            ),
          )
          .where(inArray(authUsers.id, descriptorOwnerUserIds)),
    ]);
    const agentNameById = new Map(ownerAgentRows.map((row) => [row.id, row.name]));
    const userNameById = new Map(ownerUserRows.map((row) => [row.id, row.name]));

    const descriptorOwnerLabel = (value: unknown): string | null => {
      const owner = readRecord(value)?.owner;
      if (owner === "board") return "Board";
      const record = readRecord(owner);
      const agentId = asString(record?.agentId);
      if (agentId) return agentNameById.get(agentId) ?? "Agent";
      const userId = asString(record?.userId);
      if (userId) return userNameById.get(userId) ?? "User";
      return null;
    };

    // --- Assemble -----------------------------------------------------------
    const overviewById = new Map<string, IssueOverview>();
    for (const row of issueRows) {
      const status = row.status as IssueStatus;
      const issueUnits = unitsByIssueId.get(row.id) ?? [];
      const selectedUnit = issueUnits.find(
        (unit) => !(TERMINAL_UNIT_STATUSES as readonly string[]).includes(unit.status),
      ) ?? issueUnits[0] ?? null;
      const unitBlocked = selectedUnit?.status === "blocked";
      const blocked = status === "blocked" || unitBlocked;

      const executionState = readRecord(row.executionState);
      const stageType = asString(executionState?.currentStageType);
      const executionStateStatus = asString(executionState?.status);
      const executionStage: IssueExecutionStageType | null =
        (executionStateStatus === "pending" || executionStateStatus === "changes_requested")
        && (stageType === "review" || stageType === "approval")
        ? stageType
        : null;

      const deliveryPhase = selectedUnit ? deriveDeliveryPhase(selectedUnit) : null;
      const deliveryMerged = selectedUnit?.status === "merged";
      const deliveryAt = selectedUnit
        ? selectedUnit.mergedAt
          ?? selectedUnit.lastEventAt
          ?? selectedUnit.updatedAt
        : null;
      const mergedAt = deliveryMerged ? selectedUnit!.mergedAt ?? null : null;
      const lastLiveTransitionAt = lastLiveTransitionAtByIssueId.get(row.id) ?? null;
      const mergeSuperseded = isMergeSuperseded({ mergedAt, lastLiveTransitionAt });

      const nonBlockedHistoryStatus = latestNonBlockedStatusByIssueId.get(row.id) ?? null;
      const { phase, source } = deriveIssueOverviewPhase(status, {
        historyStatus: isNonBlockedStatus(nonBlockedHistoryStatus) ? nonBlockedHistoryStatus : null,
        deliveryPhase,
        deliveryAt,
        deliveryMerged,
        mergedAt,
        lastLiveTransitionAt,
        executionStage,
        blocked,
      });

      const childRowsForIssue = childrenByParentId.get(row.id) ?? [];
      const counts = childCountByParentId.get(row.id);
      const parentRow = row.parentId ? parentById.get(row.parentId) : undefined;

      const blockerRefs = unresolvedBlockerRefs(blockerRefsByBlockedIssueId.get(row.id) ?? []);
      const unitBlocker = unitBlocked ? selectedUnit!.blocker : null;
      let blocker: IssueOverview["blocker"] = null;
      if (blocked) {
        const descriptorAction = asString(readRecord(row.unblockDescriptor)?.action);
        const taskCause = blockerRefs.length > 0 ? `Blocked by ${blockerRefs[0]!.identifier ?? blockerRefs[0]!.title}` : null;
        // A live task relation and the controller's machine blocker are both
        // current facts; the unit blocker is authoritative for the delivery and
        // supersedes the historical unblock descriptor (its message, owner and
        // next action), which was recorded before the unit existed. The
        // descriptor only speaks when neither a blocking task nor a unit
        // blocker exists.
        blocker = {
          message: taskCause
            ?? unitBlocker?.message
            ?? descriptorAction
            ?? "Blocked without a recorded reason",
          ownerLabel: taskCause
            ? null
            : unitBlocker
              ? unitBlocker.owner ?? null
              : descriptorAction ? descriptorOwnerLabel(row.unblockDescriptor) : null,
          nextAction: taskCause
            ? null
            : unitBlocker ? unitBlocker.nextAction ?? null : descriptorAction,
          issues: blockerRefs,
        };
      }

      const candidates = pullRequestCandidatesByIssueId.get(row.id);
      const pullRequests: IssueOverviewPullRequest[] = candidates
        ? dedupePullRequests(candidates)
          .map((candidate) => ({
            url: candidate.url,
            number: candidate.number,
            repository: candidate.repository,
            state: candidate.state,
            updatedAt: candidate.updatedAt,
            stale: candidate.stale,
          }))
          .sort((left, right) =>
            (right.updatedAt ? Date.parse(right.updatedAt) : 0) - (left.updatedAt ? Date.parse(left.updatedAt) : 0)
            || (left.repository ?? "").localeCompare(right.repository ?? "")
            || (left.number ?? 0) - (right.number ?? 0))
        : [];

      const unitMetadata = selectedUnit ? readUnitMetadata(selectedUnit.metadata) : null;
      // A superseded merge is history, not a current candidate: its pull request
      // stays in `pullRequests` and no merged delivery result is claimed here.
      const staleMerge = deliveryMerged && mergeSuperseded;
      const policyRow = selectedUnit?.projectId ? policyByProjectId.get(selectedUnit.projectId) ?? null : null;
      const policyProjection = policyRow
        ? {
          version: policyRow.version,
          authorizationState: (policyRow.authorization
            ? "recorded"
            : policyRow.authorizationInvalidatedAt
              ? "invalidated"
              : "missing") as DeliveryPolicyAuthorizationState,
          authorizationInvalidatedScope: policyRow.authorizationInvalidatedScope ?? [],
          autoDeployDisposition: policyRow.autoDeployDisposition as DeliveryAutoDeployDisposition,
        }
        : null;
      // Readiness is evidence readiness before the final gate: the accepted
      // head standing on the current revision. It never implies that merge or
      // deployment authority exists — that is the policy block above. Both it
      // and the review status describe a *candidate*, so they are computed only
      // when an issue actually has a unit; an issue with no delivery unit has
      // no candidate to be ready or reviewed, and its delivery block is null.
      const acceptedHead = selectedUnit?.acceptedHeadSha ?? null;
      const evidenceGeneration = unitMetadata?.evidenceGeneration ?? null;
      const evidenceCurrent = selectedUnit != null
        && evidenceGeneration != null
        && evidenceGeneration === selectedUnit.candidateGeneration;
      const unitHeadSha = selectedUnit?.headSha ?? null;
      const readiness: IssueDeliveryReadiness = selectedUnit == null || unitHeadSha == null
        ? "not_started"
        : acceptedHead !== null && acceptedHead === unitHeadSha
          ? "accepted"
          : !evidenceCurrent || unitMetadata?.lastReadFailed === true
            ? "unknown"
            : selectedUnit.status === "blocked"
              ? "blocked"
              : "under_review";
      // Review status is fenced by the generation it was read at: an approval
      // recorded for a replaced candidate is history, and a revision whose
      // evidence was never read (or failed to read) shows `unknown`, never a
      // cached pass.
      const reviewStatus = selectedUnit == null || unitHeadSha == null
        ? "none"
        : evidenceCurrent && unitMetadata?.lastReadFailed !== true
          ? unitMetadata?.reviewStatus ?? "none"
          : "unknown";
      const delivery: IssueOverview["delivery"] = selectedUnit && deliveryPhase && !staleMerge
        ? {
          // `merged` names the current delivery outcome the board reads for a
          // merged unit; every other value is the canonical delivery phase.
          phase: deliveryMerged ? "merged" : deliveryPhase,
          artifactReady: Boolean(
            selectedUnit.artifactReady
            && selectedUnit.acceptedHeadSha !== null
            && selectedUnit.acceptedHeadSha === selectedUnit.headSha,
          ),
          candidateGeneration: selectedUnit.candidateGeneration,
          readiness,
          policy: policyProjection,
          reviewStatus,
          blockingFindings: Math.max(
            openFindingsByUnitId.get(selectedUnit.id) ?? 0,
            evidenceCurrent ? unitMetadata?.blockingFindings ?? 0 : 0,
          ),
          queuePosition: queuePositionByUnitId.get(selectedUnit.id) ?? null,
          nextAction: selectedUnit.nextAction ?? selectedUnit.blocker?.nextAction ?? null,
          lastEventAt: iso(selectedUnit.lastEventAt),
          mergedAt: deliveryMerged ? iso(selectedUnit.mergedAt) : null,
        }
        : null;

      const project = row.projectId ? projectById.get(row.projectId) : undefined;
      overviewById.set(row.id, {
        issueId: row.id,
        phase,
        phaseSource: source,
        blocked,
        project: project ? { id: project.id, name: project.name, color: project.color } : null,
        parent: parentRow ? toOverviewRef(parentRow) : null,
        children: childRowsForIssue.map(toOverviewRef),
        childCount: counts?.childCount ?? 0,
        completedChildCount: counts?.completedChildCount ?? 0,
        blocker,
        pullRequests,
        delivery,
      });
    }

    // Requested order, so a caller's batch is stable and easy to diff.
    const items = ids
      .map((issueId) => overviewById.get(issueId))
      .filter((item): item is IssueOverview => item !== undefined);

    return { items, observedAt: new Date().toISOString() };
  }

  return { list };
}
