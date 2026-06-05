/**
 * Issue efficiency + windowed adapter rollup (BLO-9117 / BLO-9102 Diff 2).
 *
 * The decisive fleet metric is $ per merged authored-LOC by adapter. The two
 * joins that make it computable now exist: cost↔issue (cost_events) and
 * issue↔merged-PR (issue_pull_requests). This module assembles them.
 *
 * The apportionment + coverage math lives in PURE functions (no DB) so the two
 * failure modes the acceptance criteria call out are deterministically tested:
 *   - data-wall #4 (double-counting): a multi-adapter issue's authored-LOC must
 *     sum across adapters to the issue total, never be counted once per adapter.
 *   - data-wall #2 (silent tail drop): the rollup must report an explicit
 *     unattributed-merged-PR coverage %, with the denominator counting PRs
 *     across all GitHub identities (issue_pull_requests has no author column,
 *     so this is structural).
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, heartbeatRuns, issuePullRequests, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";

/** Sentinel adapter bucket for output that can't be attributed to a real
 * adapter (an issue with merged authored-LOC but no recorded token usage).
 * Surfaced, never dropped — keeping the apportionment invariant exact. */
export const UNATTRIBUTED_ADAPTER = "__unattributed__";

export type CostSource = "metered" | "list_estimate" | "mixed" | null;

export interface AdapterUsage {
  adapterType: string;
  outputTokens: number;
  costCents: number;
  costSource?: CostSource;
}

export interface ApportionedAdapter {
  adapterType: string;
  outputTokens: number;
  /** adapter outputTokens / issue total outputTokens (the apportionment basis). */
  outputTokenShare: number;
  costCents: number;
  /** issueAuthoredLoc × share — sums across adapters to issueAuthoredLoc. */
  authoredLoc: number;
  /** issueMergedPrCount × share — sums across adapters to the PR count. */
  mergedPrShare: number;
}

export interface PerIssueApportionInput {
  issueId: string;
  adapters: AdapterUsage[];
  authoredLoc: number;
  mergedPrCount: number;
}

/**
 * Apportion an issue's authored-LOC and merged-PR count across its executor
 * adapters by output-token-share. The weight is output tokens when any adapter
 * has them; otherwise cost cents (an adapter can bill input-only); otherwise the
 * whole issue falls into the UNATTRIBUTED bucket. In every branch the per-adapter
 * authoredLoc sums to `authoredLoc` exactly (modulo float rounding), so a
 * multi-adapter issue is apportioned, never double-counted.
 */
export function apportionIssueAcrossAdapters(input: PerIssueApportionInput): ApportionedAdapter[] {
  const adapters = input.adapters;
  if (adapters.length === 0) {
    return [
      {
        adapterType: UNATTRIBUTED_ADAPTER,
        outputTokens: 0,
        outputTokenShare: 1,
        costCents: 0,
        authoredLoc: input.authoredLoc,
        mergedPrShare: input.mergedPrCount,
      },
    ];
  }

  const totalOutput = adapters.reduce((sum, a) => sum + Math.max(0, a.outputTokens), 0);
  const totalCost = adapters.reduce((sum, a) => sum + Math.max(0, a.costCents), 0);
  const weightOf = (a: AdapterUsage) =>
    totalOutput > 0 ? Math.max(0, a.outputTokens) : totalCost > 0 ? Math.max(0, a.costCents) : 0;
  const totalWeight = adapters.reduce((sum, a) => sum + weightOf(a), 0);

  if (totalWeight <= 0) {
    // No usage signal at all — attribute the whole issue to UNATTRIBUTED so the
    // authored-LOC is surfaced rather than silently lost, but keep the real
    // adapters' (zero-cost) rows for visibility.
    const real = adapters.map((a) => ({
      adapterType: a.adapterType,
      outputTokens: a.outputTokens,
      outputTokenShare: 0,
      costCents: a.costCents,
      authoredLoc: 0,
      mergedPrShare: 0,
    }));
    return [
      ...real,
      {
        adapterType: UNATTRIBUTED_ADAPTER,
        outputTokens: 0,
        outputTokenShare: 1,
        costCents: 0,
        authoredLoc: input.authoredLoc,
        mergedPrShare: input.mergedPrCount,
      },
    ];
  }

  return adapters.map((a) => {
    const share = weightOf(a) / totalWeight;
    return {
      adapterType: a.adapterType,
      outputTokens: a.outputTokens,
      outputTokenShare: share,
      costCents: a.costCents,
      authoredLoc: input.authoredLoc * share,
      mergedPrShare: input.mergedPrCount * share,
    };
  });
}

export interface RollupAdapterRow {
  adapterType: string;
  costCents: number;
  outputTokens: number;
  authoredLoc: number;
  mergedPrShare: number;
  /** costCents / authoredLoc; null when authoredLoc is 0 (avoid divide-by-zero). */
  costCentsPerAuthoredLoc: number | null;
  /** costCents / mergedPrShare; null when mergedPrShare is 0. */
  costCentsPerMergedPr: number | null;
}

export interface CoverageReport {
  totalMergedPrs: number;
  refLinkedMergedPrs: number;
  unattributedMergedPrs: number;
  /** refLinked / total, 0..1; 1 when there are no PRs. */
  coverage: number;
  /**
   * Evidence that the no-ref tail has actually been enumerated for the window:
   * at least one unattributed (issueId=null) row, or a row whose linkSource is
   * the backfill 'reconciler'. The FORWARD webhook only ever stores ref-linked
   * rows (it persists a link only for matched issues), so a window populated by
   * forward-capture alone has no tail and `coverage` reads a vacuous ~100%.
   */
  reconciledTailObserved: boolean;
  /**
   * !reconciledTailObserved with PRs present: `coverage` reflects
   * forward-captured (ref-linked) PRs ONLY and is almost certainly an
   * overstatement — run `reconcileMergedPullRequests` over the window before
   * treating `coverage` as the true ref-linked fraction. This is the option-(C)
   * honesty signal: a 100% here means "not yet measured", not "fully linked".
   */
  forwardOnly: boolean;
}

/**
 * Honest option-(C) coverage. The denominator is every merged PR in the window
 * regardless of author (issue_pull_requests has no author column), so no
 * identity bucket is silently excluded. A null issueId is the unattributed tail.
 *
 * `forwardOnly` flags the case the reviewer flagged: with only forward-capture
 * (no reconciler run), every stored row is by-construction ref-linked, so a raw
 * `coverage` of ~1.0 would mask the 85%-unlinked reality this metric exists to
 * surface. linkSource lets us detect a reconciler-populated window.
 */
export function coverageForWindow(
  prs: Array<{ issueId: string | null; linkSource?: string | null }>,
): CoverageReport {
  const totalMergedPrs = prs.length;
  const refLinkedMergedPrs = prs.filter((p) => p.issueId != null).length;
  const unattributedMergedPrs = totalMergedPrs - refLinkedMergedPrs;
  const reconciledTailObserved = prs.some(
    (p) => p.issueId == null || p.linkSource === "reconciler",
  );
  return {
    totalMergedPrs,
    refLinkedMergedPrs,
    unattributedMergedPrs,
    coverage: totalMergedPrs === 0 ? 1 : refLinkedMergedPrs / totalMergedPrs,
    reconciledTailObserved,
    forwardOnly: totalMergedPrs > 0 && !reconciledTailObserved,
  };
}

/** Aggregate per-issue apportioned results into per-adapter rollup rows. */
export function rollupApportioned(perIssue: PerIssueApportionInput[]): RollupAdapterRow[] {
  const byAdapter = new Map<string, { costCents: number; outputTokens: number; authoredLoc: number; mergedPrShare: number }>();
  for (const issue of perIssue) {
    for (const a of apportionIssueAcrossAdapters(issue)) {
      const acc = byAdapter.get(a.adapterType) ?? { costCents: 0, outputTokens: 0, authoredLoc: 0, mergedPrShare: 0 };
      acc.costCents += a.costCents;
      acc.outputTokens += a.outputTokens;
      acc.authoredLoc += a.authoredLoc;
      acc.mergedPrShare += a.mergedPrShare;
      byAdapter.set(a.adapterType, acc);
    }
  }
  return [...byAdapter.entries()]
    .map(([adapterType, acc]) => ({
      adapterType,
      costCents: acc.costCents,
      outputTokens: acc.outputTokens,
      authoredLoc: acc.authoredLoc,
      mergedPrShare: acc.mergedPrShare,
      costCentsPerAuthoredLoc: acc.authoredLoc > 0 ? acc.costCents / acc.authoredLoc : null,
      costCentsPerMergedPr: acc.mergedPrShare > 0 ? acc.costCents / acc.mergedPrShare : null,
    }))
    .sort((a, b) => b.costCents - a.costCents);
}

/** Reduce a distinct costSource set to a single label (metered|list_estimate|mixed|null). */
export function reduceCostSource(values: Array<string | null | undefined>): CostSource {
  const distinct = [...new Set(values.filter((v): v is string => v != null && v.length > 0))];
  if (distinct.length === 0) return null;
  if (distinct.length === 1) return distinct[0] as CostSource;
  return "mixed";
}

// ---------------------------------------------------------------------------
// DB-facing assembly
// ---------------------------------------------------------------------------

export interface IssueEfficiency {
  issueId: string;
  identifier: string | null;
  adapters: Array<{ adapterType: string; outputTokens: number; outputTokenShare: number; costCents: number; costSource: CostSource }>;
  mergedPullRequests: Array<{
    repoFullName: string;
    prNumber: number;
    linkSource: string | null;
    mergedAt: Date | null;
    authoredLoc: number | null;
    rawLoc: number | null;
    locEnriched: boolean;
  }>;
  authoredLoc: number;
  rawLoc: number;
  costCents: number;
  costSource: CostSource;
}

/**
 * Per-issue, per-adapter token + cost totals from cost_events (adapter =
 * agents.adapterType via costEvents.agentId — the executor, not the assignee).
 *
 * NOTE (intentional): cost is summed over ALL of an issue's cost_events, NOT
 * clipped to the rollup's merged-PR window. So windowed $/authored-LOC divides
 * window-bounded authored-LOC by the issue's full lifetime cost. This is
 * deliberate — an issue's merged output should be charged its full cost — but
 * it means the numerator (cost) and denominator (LOC) are not both
 * window-clipped. Don't "fix" this into double-window-clipping without intent.
 */
async function adapterUsageForIssues(
  db: Db,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, AdapterUsage[]>> {
  const byIssue = new Map<string, AdapterUsage[]>();
  if (issueIds.length === 0) return byIssue;
  const rows = await db
    .select({
      issueId: costEvents.issueId,
      adapterType: agents.adapterType,
      outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
      costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      costSources: sql<Array<string | null>>`array_agg(distinct ${heartbeatRuns.usageJson} ->> 'costSource')`,
    })
    .from(costEvents)
    .innerJoin(agents, eq(costEvents.agentId, agents.id))
    .leftJoin(heartbeatRuns, eq(costEvents.heartbeatRunId, heartbeatRuns.id))
    .where(and(eq(costEvents.companyId, companyId), inArray(costEvents.issueId, issueIds)))
    .groupBy(costEvents.issueId, agents.adapterType);

  for (const row of rows) {
    if (!row.issueId) continue;
    const list = byIssue.get(row.issueId) ?? [];
    list.push({
      adapterType: row.adapterType,
      outputTokens: Number(row.outputTokens),
      costCents: Number(row.costCents),
      costSource: reduceCostSource(row.costSources ?? []),
    });
    byIssue.set(row.issueId, list);
  }
  return byIssue;
}

function prAuthoredLoc(row: { authoredAdditions: number | null; authoredDeletions: number | null }): number | null {
  if (row.authoredAdditions == null && row.authoredDeletions == null) return null;
  return (row.authoredAdditions ?? 0) + (row.authoredDeletions ?? 0);
}
function prRawLoc(row: { additions: number | null; deletions: number | null }): number | null {
  if (row.additions == null && row.deletions == null) return null;
  return (row.additions ?? 0) + (row.deletions ?? 0);
}

export function issueEfficiencyService(db: Db) {
  return {
    /** AC #1 — per-issue efficiency: adapters+share, merged PRs, authored-LOC, cost+costSource. */
    forIssue: async (companyId: string, issueId: string): Promise<IssueEfficiency> => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      const [adapterMap, prRows] = await Promise.all([
        adapterUsageForIssues(db, companyId, [issueId]),
        db
          .select({
            repoFullName: issuePullRequests.repoFullName,
            prNumber: issuePullRequests.prNumber,
            linkSource: issuePullRequests.linkSource,
            mergedAt: issuePullRequests.mergedAt,
            additions: issuePullRequests.additions,
            deletions: issuePullRequests.deletions,
            authoredAdditions: issuePullRequests.authoredAdditions,
            authoredDeletions: issuePullRequests.authoredDeletions,
            locEnrichedAt: issuePullRequests.locEnrichedAt,
          })
          .from(issuePullRequests)
          .where(and(eq(issuePullRequests.companyId, companyId), eq(issuePullRequests.issueId, issueId))),
      ]);

      const adapters = adapterMap.get(issueId) ?? [];
      const totalOutput = adapters.reduce((s, a) => s + a.outputTokens, 0);
      const totalCostCents = adapters.reduce((s, a) => s + a.costCents, 0);

      const mergedPullRequests = prRows.map((p) => ({
        repoFullName: p.repoFullName,
        prNumber: p.prNumber,
        linkSource: p.linkSource,
        mergedAt: p.mergedAt,
        authoredLoc: prAuthoredLoc(p),
        rawLoc: prRawLoc(p),
        locEnriched: p.locEnrichedAt != null,
      }));
      const authoredLoc = mergedPullRequests.reduce((s, p) => s + (p.authoredLoc ?? 0), 0);
      const rawLoc = mergedPullRequests.reduce((s, p) => s + (p.rawLoc ?? 0), 0);

      return {
        issueId,
        identifier: issue.identifier,
        adapters: adapters.map((a) => ({
          adapterType: a.adapterType,
          outputTokens: a.outputTokens,
          outputTokenShare: totalOutput > 0 ? a.outputTokens / totalOutput : 0,
          costCents: a.costCents,
          costSource: a.costSource ?? null,
        })),
        mergedPullRequests,
        authoredLoc,
        rawLoc,
        costCents: totalCostCents,
        costSource: reduceCostSource(adapters.map((a) => a.costSource ?? null)),
      };
    },

    /** AC #2/#4 — windowed adapter rollup, apportioned + honest coverage %. */
    adapterRollup: async (
      companyId: string,
      range: { from: Date; to: Date },
    ): Promise<{ window: { from: string; to: string }; adapters: RollupAdapterRow[]; coverage: CoverageReport }> => {
      // All merged PRs in the window (any identity) — the coverage denominator.
      const windowPrs = await db
        .select({
          issueId: issuePullRequests.issueId,
          repoFullName: issuePullRequests.repoFullName,
          prNumber: issuePullRequests.prNumber,
          additions: issuePullRequests.additions,
          deletions: issuePullRequests.deletions,
          authoredAdditions: issuePullRequests.authoredAdditions,
          authoredDeletions: issuePullRequests.authoredDeletions,
          linkSource: issuePullRequests.linkSource,
        })
        .from(issuePullRequests)
        .where(
          and(
            eq(issuePullRequests.companyId, companyId),
            gte(issuePullRequests.mergedAt, range.from),
            lte(issuePullRequests.mergedAt, range.to),
          ),
        );

      // linkSource is threaded through so coverage can flag a forward-only
      // window (no reconciler tail) where `coverage` would read a vacuous 100%.
      const coverage = coverageForWindow(
        windowPrs.map((p) => ({ issueId: p.issueId, linkSource: p.linkSource })),
      );

      // Per-issue authored-LOC + PR count (only ref-linked PRs can be apportioned
      // to an issue's adapters; the unattributed tail has no issue/adapters and
      // is accounted for only in coverage, exactly as option (C) prescribes).
      const perIssueAgg = new Map<string, { authoredLoc: number; mergedPrCount: number }>();
      for (const p of windowPrs) {
        if (!p.issueId) continue;
        const acc = perIssueAgg.get(p.issueId) ?? { authoredLoc: 0, mergedPrCount: 0 };
        acc.authoredLoc += (p.authoredAdditions ?? 0) + (p.authoredDeletions ?? 0);
        acc.mergedPrCount += 1;
        perIssueAgg.set(p.issueId, acc);
      }

      const issueIds = [...perIssueAgg.keys()];
      const adapterMap = await adapterUsageForIssues(db, companyId, issueIds);

      const perIssue: PerIssueApportionInput[] = issueIds.map((issueId) => ({
        issueId,
        adapters: adapterMap.get(issueId) ?? [],
        authoredLoc: perIssueAgg.get(issueId)!.authoredLoc,
        mergedPrCount: perIssueAgg.get(issueId)!.mergedPrCount,
      }));

      return {
        window: { from: range.from.toISOString(), to: range.to.toISOString() },
        adapters: rollupApportioned(perIssue),
        coverage,
      };
    },
  };
}
