/**
 * Merged-PR reconciler scheduling (BLO-9150 — follow-up to BLO-9117 / #308 / #309).
 *
 * #308 landed the forward webhook (`recordMergedPullRequest`) and the backfill
 * reconciler (`reconcileMergedPullRequests`) but deliberately left repo-discovery
 * and scheduling unwired. #309 added the `forwardOnly` honesty signal on
 * `CoverageReport`. This module is the missing caller: it discovers the repos a
 * company has merged PRs in and runs the backfill reconciler over a trailing
 * window so the no-ref tail is stored — which is what flips `forwardOnly` false
 * and makes the coverage % a measured number instead of a vacuous ~100%.
 *
 * Split for testability:
 *   - `selectReconcilerTargets` — thin DISTINCT query (integration concern).
 *   - `runReconcilerSweep` — pure orchestration (window math, per-repo error
 *     isolation, aggregation), unit-tested with injected fakes.
 *   - `reconcilerSweepTick` — the wiring index.ts schedules.
 */
import type { Db } from "@paperclipai/db";
import { issuePullRequests } from "@paperclipai/db";
import { reconcileMergedPullRequests } from "./issue-pull-requests.js";
import { logger as defaultLogger } from "../middleware/logger.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ReconcilerTarget {
  companyId: string;
  repoFullName: string;
}

export interface ReconcileResult {
  enumerated: number;
  linked: number;
  unlinked: number;
  enriched: number;
}

export interface SweepResult {
  targets: number;
  ok: number;
  failed: number;
  totals: ReconcileResult;
  window: { since: Date; until: Date };
}

/** Trailing [now - windowDays, now] window. Derived from config, no magic floor. */
export function computeReconcilerWindow(now: Date, windowDays: number): { since: Date; until: Date } {
  return {
    since: new Date(now.getTime() - windowDays * MS_PER_DAY),
    until: now,
  };
}

/**
 * Discover the (company, repo) pairs to reconcile from rows we've already
 * forward-captured. Bootstrap source — a repo with zero forward-captured PRs is
 * not yet discovered (acceptable: the first matched PR seeds it, the reconciler
 * then backfills the tail). A complete source would enumerate GitHub App
 * installation repos; deferred until that limitation bites.
 */
export async function selectReconcilerTargets(db: Db): Promise<ReconcilerTarget[]> {
  const rows = await db
    .selectDistinct({
      companyId: issuePullRequests.companyId,
      repoFullName: issuePullRequests.repoFullName,
    })
    .from(issuePullRequests);
  return rows.map((r) => ({ companyId: r.companyId, repoFullName: r.repoFullName }));
}

type ReconcileFn = (
  target: ReconcilerTarget,
  window: { since: Date; until: Date },
) => Promise<ReconcileResult>;

/**
 * Pure orchestration: reconcile every target over one window. A single repo
 * throwing (rate limit, 404 on a private repo without a token) is isolated —
 * it increments `failed` and the sweep continues, so one bad repo never starves
 * the rest.
 */
export async function runReconcilerSweep(input: {
  targets: ReconcilerTarget[];
  now: Date;
  windowDays: number;
  reconcile: ReconcileFn;
  onError?: (target: ReconcilerTarget, err: unknown) => void;
}): Promise<SweepResult> {
  const window = computeReconcilerWindow(input.now, input.windowDays);
  const totals: ReconcileResult = { enumerated: 0, linked: 0, unlinked: 0, enriched: 0 };
  let ok = 0;
  let failed = 0;

  for (const target of input.targets) {
    try {
      const r = await input.reconcile(target, window);
      totals.enumerated += r.enumerated;
      totals.linked += r.linked;
      totals.unlinked += r.unlinked;
      totals.enriched += r.enriched;
      ok += 1;
    } catch (err) {
      failed += 1;
      input.onError?.(target, err);
    }
  }

  return { targets: input.targets.length, ok, failed, totals, window };
}

/** One reconciler pass: discover targets, sweep them, log the rollup. */
export async function reconcilerSweepTick(
  db: Db,
  input: {
    windowDays: number;
    token: string | null;
    enrichLoc: boolean;
    now?: Date;
    logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  },
): Promise<SweepResult> {
  const log = input.logger ?? defaultLogger;
  const now = input.now ?? new Date();
  const targets = await selectReconcilerTargets(db);

  if (targets.length === 0) {
    log.info({ targets: 0 }, "pr-reconciler: no merged-PR repos discovered yet; nothing to reconcile");
    return {
      targets: 0,
      ok: 0,
      failed: 0,
      totals: { enumerated: 0, linked: 0, unlinked: 0, enriched: 0 },
      window: computeReconcilerWindow(now, input.windowDays),
    };
  }

  const result = await runReconcilerSweep({
    targets,
    now,
    windowDays: input.windowDays,
    reconcile: (target, window) =>
      reconcileMergedPullRequests(db, {
        companyId: target.companyId,
        repoFullName: target.repoFullName,
        since: window.since,
        until: window.until,
        token: input.token,
        enrichLoc: input.enrichLoc,
      }),
    onError: (target, err) =>
      log.warn({ err, ...target }, "pr-reconciler: repo reconcile failed (isolated)"),
  });

  log.info(
    {
      targets: result.targets,
      ok: result.ok,
      failed: result.failed,
      ...result.totals,
      windowDays: input.windowDays,
    },
    "pr-reconciler: sweep complete",
  );
  return result;
}
