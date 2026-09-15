import { and, eq, gt, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { budgetPolicies } from "@paperclipai/db";
import {
  SUBSCRIPTION_BUDGET_WINDOW_QUOTA_KEYS,
  isSubscriptionBudgetWindowKind,
  type BudgetScopeType,
  type ProviderQuotaResult,
  type QuotaWindow,
  type SubscriptionBudgetWindowKind,
} from "@paperclipai/shared";
import {
  providerSlugForAdapterType,
  readQuotaSnapshot as readSharedQuotaSnapshot,
  type QuotaSnapshotReader,
} from "./quota-windows.js";

/**
 * Subscription window gate.
 *
 * A `subscription_percent` budget policy says: "do not start new runs for this
 * scope while the provider's subscription window (session or week) is at or
 * above N% used". Unlike a `billed_cents` hard stop, crossing the threshold is
 * not an incident and never pauses the scope: the window resets on its own, so
 * the queued run is *deferred* to the reset time and promoted again by the
 * ordinary scheduled-retry loop. Nothing in this path asks the board for help.
 */

/** `heartbeat_runs.scheduled_retry_reason` for a run deferred by this gate. */
export const SUBSCRIPTION_WINDOW_WAIT_RETRY_REASON = "subscription_window_wait";
/** `heartbeat_runs.error_code` for a timer heartbeat skipped by this gate. */
export const SUBSCRIPTION_WINDOW_SKIPPED_ERROR_CODE = "subscription_window_skipped";
/** `heartbeat_runs.error_code` when a run was deferred too many times in a row. */
export const SUBSCRIPTION_WINDOW_WAIT_EXHAUSTED_ERROR_CODE = "subscription_window_wait_exhausted";

/** Wait used when the provider reports no reset time for a saturated window. */
export const SUBSCRIPTION_WINDOW_WAIT_DEFAULT_MS = readPositiveIntEnv(
  "PAPERCLIP_SUBSCRIPTION_WINDOW_WAIT_DEFAULT_MS",
  15 * 60 * 1000,
);
/**
 * Re-check interval while a limited window's usage cannot be read. A limit
 * that cannot be checked holds new runs instead of letting them through: the
 * operator asked for headroom, and dispatching blind is how a limit gets
 * busted. Removing the limit lets runs proceed at the operator's discretion.
 */
export const SUBSCRIPTION_WINDOW_UNKNOWN_WAIT_MS = readPositiveIntEnv(
  "PAPERCLIP_SUBSCRIPTION_WINDOW_UNKNOWN_WAIT_MS",
  5 * 60 * 1000,
);
/**
 * Upper bound on how long one run may keep waiting, measured from its first
 * consecutive deferral by this gate. A weekly window can stay legitimately
 * saturated for seven days, and the Claude CLI fallback reports no reset time
 * at all (so a saturated window is re-checked every default wait), which is
 * why the bound is a duration rather than a count of deferrals. It only trips
 * when the quota snapshot is stale or the account is wedged; the run is then
 * cancelled the way the daily cap cancels a queued run, so the problem becomes
 * visible instead of waiting forever.
 */
export const SUBSCRIPTION_WINDOW_WAIT_MAX_MS = readPositiveIntEnv(
  "PAPERCLIP_SUBSCRIPTION_WINDOW_WAIT_MAX_MS",
  8 * 24 * 60 * 60 * 1000,
);
/** Small margin after the reported reset so the provider has rolled the window. */
const SUBSCRIPTION_WINDOW_RESET_MARGIN_MS = 30 * 1000;

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type SubscriptionWindowPolicy = {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  windowKind: SubscriptionBudgetWindowKind;
  /** Percent of the window that may be used before new runs are deferred. */
  amount: number;
};

export type SubscriptionWindowWait = {
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  windowKind: SubscriptionBudgetWindowKind;
  quotaKey: string;
  provider: string;
  /** Percent used, or null when the run is held because usage could not be read. */
  usedPercent: number | null;
  limitPercent: number;
  /** True when the hold is for unreadable usage rather than a reached limit. */
  usageUnknown: boolean;
  resetsAt: string | null;
  /** When the deferred run should be promoted again. */
  resumeAt: Date;
  reason: string;
};

export type SubscriptionWindowObservation = {
  usedPercent: number | null;
  resetsAt: string | null;
  /** True when the latest provider read failed and this comes from the last successful read. */
  stale: boolean;
  /** ISO timestamp of the provider read behind this observation, null for a raw adapter result. */
  observedAt: string | null;
};

function parseResetsAt(value: string | null | undefined, now: Date): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime() > now.getTime() ? parsed : null;
}

export function findQuotaWindow(
  windows: QuotaWindow[],
  windowKind: SubscriptionBudgetWindowKind,
): QuotaWindow | null {
  const key = SUBSCRIPTION_BUDGET_WINDOW_QUOTA_KEYS[windowKind];
  return windows.find((window) => window.key === key) ?? null;
}

export function observeSubscriptionWindow(
  result: ProviderQuotaResult | null | undefined,
  windowKind: SubscriptionBudgetWindowKind,
): SubscriptionWindowObservation | null {
  if (!result || !result.ok) return null;
  const window = findQuotaWindow(result.windows, windowKind);
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    stale: result.stale === true,
    observedAt: result.observedAt ?? null,
  };
}

/**
 * Pure decision: given the active subscription policies for a dispatch and the
 * provider's quota result, return the wait to apply, or null to proceed.
 *
 * A policy whose window cannot be read (the provider row is missing or not ok,
 * the window is absent, or it carries no utilization) holds the run for
 * `unknownWaitMs` and re-checks; only a scope with no limit stays open. A
 * stale result (the last good read, reused because the latest refresh failed)
 * can only tighten the gate: at or above the limit it defers to the reset as
 * usual, but below the limit it cannot clear the run, because real usage may
 * have crossed the limit since that read, so the run holds for a re-check
 * instead. When several policies block at once, the wait ends at the latest
 * resume time, because every blocking window has to clear before a run can
 * start, so a known saturated window outranks an unknown one.
 */
export function decideSubscriptionWindowWait(input: {
  policies: SubscriptionWindowPolicy[];
  /** The provider's row from the quota snapshot, or null when it has none. */
  result: ProviderQuotaResult | null | undefined;
  provider: string;
  now?: Date;
  defaultWaitMs?: number;
  unknownWaitMs?: number;
}): SubscriptionWindowWait | null {
  const now = input.now ?? new Date();
  const defaultWaitMs = input.defaultWaitMs ?? SUBSCRIPTION_WINDOW_WAIT_DEFAULT_MS;
  const unknownWaitMs = input.unknownWaitMs ?? SUBSCRIPTION_WINDOW_UNKNOWN_WAIT_MS;
  const result = input.result ?? null;
  const windows = result?.ok ? result.windows : null;
  const stale = result?.stale === true;
  let chosen: SubscriptionWindowWait | null = null;

  for (const policy of input.policies) {
    if (policy.amount <= 0) continue;
    const windowLabel = policy.windowKind === "provider_session" ? "session" : "weekly";
    const base = {
      policyId: policy.id,
      scopeType: policy.scopeType,
      scopeId: policy.scopeId,
      windowKind: policy.windowKind,
      quotaKey: SUBSCRIPTION_BUDGET_WINDOW_QUOTA_KEYS[policy.windowKind],
      provider: input.provider,
      limitPercent: policy.amount,
    };
    const window = windows ? findQuotaWindow(windows, policy.windowKind) : null;
    const usedPercent = window?.usedPercent ?? null;
    const staleBelowLimit = stale && usedPercent != null && usedPercent < policy.amount;
    let candidate: SubscriptionWindowWait;
    if (usedPercent == null || staleBelowLimit) {
      const cause =
        windows == null
          ? `provider usage could not be read${result?.error ? ` (${result.error})` : ""}`
          : !window
            ? "the provider did not report this window"
            : usedPercent == null
              ? "the provider reported this window without utilization"
              : `the latest provider read failed${result?.error ? ` (${result.error})` : ""}, and the last good read of ` +
                `${usedPercent}%${result?.observedAt ? ` at ${result.observedAt}` : ""} cannot clear the limit`;
      candidate = {
        ...base,
        usedPercent: null,
        usageUnknown: true,
        resetsAt: null,
        resumeAt: new Date(now.getTime() + unknownWaitMs),
        reason:
          `${input.provider} ${windowLabel} subscription window usage is unknown (${cause}); ` +
          `new runs wait while the ${policy.amount}% limit for the ${policy.scopeType} scope cannot be checked`,
      };
    } else {
      if (usedPercent < policy.amount) continue;
      const resetsAt = parseResetsAt(window!.resetsAt, now);
      candidate = {
        ...base,
        usedPercent,
        usageUnknown: false,
        resetsAt: resetsAt ? resetsAt.toISOString() : null,
        resumeAt: resetsAt
          ? new Date(resetsAt.getTime() + SUBSCRIPTION_WINDOW_RESET_MARGIN_MS)
          : new Date(now.getTime() + defaultWaitMs),
        reason:
          `${input.provider} ${windowLabel} subscription window is at ${usedPercent}% ` +
          `(limit ${policy.amount}% for ${policy.scopeType} scope); ` +
          (resetsAt ? `window resets at ${resetsAt.toISOString()}` : "no reset time reported"),
      };
    }
    if (!chosen || candidate.resumeAt.getTime() > chosen.resumeAt.getTime()) {
      chosen = candidate;
    }
  }

  return chosen;
}

export type SubscriptionWindowWaitBound = {
  /** Latest moment the run may still be waiting before it is cancelled. */
  deadline: Date;
  /** True once `now` has reached the deadline. */
  exhausted: boolean;
  /**
   * The wait's resume time clamped to the deadline, so a bogus far-future
   * reset time cannot hold the run past the bound.
   */
  resumeAt: Date;
};

/**
 * Pure bound on one run's consecutive wait. `waitStartedAt` is the first
 * deferral by this gate in the current chain; retries for unrelated reasons
 * before it do not count.
 */
export function boundSubscriptionWindowWait(input: {
  waitStartedAt: Date;
  resumeAt: Date;
  now?: Date;
  maxWaitMs?: number;
}): SubscriptionWindowWaitBound {
  const now = input.now ?? new Date();
  const maxWaitMs = input.maxWaitMs ?? SUBSCRIPTION_WINDOW_WAIT_MAX_MS;
  const deadline = new Date(input.waitStartedAt.getTime() + maxWaitMs);
  return {
    deadline,
    exhausted: now.getTime() >= deadline.getTime(),
    resumeAt: input.resumeAt.getTime() > deadline.getTime() ? deadline : input.resumeAt,
  };
}

export type SubscriptionWindowGateInput = {
  companyId: string;
  agentId: string;
  adapterType: string;
  projectId?: string | null;
  now?: Date;
};

export function subscriptionWindowGateService(
  db: Db,
  deps: { readQuotaSnapshot?: QuotaSnapshotReader } = {},
) {
  const readQuotaSnapshot = deps.readQuotaSnapshot ?? readSharedQuotaSnapshot;

  async function listPolicies(input: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
  }): Promise<SubscriptionWindowPolicy[]> {
    const scopeConditions = [
      and(eq(budgetPolicies.scopeType, "company"), eq(budgetPolicies.scopeId, input.companyId)),
      and(eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, input.agentId)),
    ];
    if (input.projectId) {
      scopeConditions.push(
        and(eq(budgetPolicies.scopeType, "project"), eq(budgetPolicies.scopeId, input.projectId)),
      );
    }
    const rows = await db
      .select({
        id: budgetPolicies.id,
        scopeType: budgetPolicies.scopeType,
        scopeId: budgetPolicies.scopeId,
        windowKind: budgetPolicies.windowKind,
        amount: budgetPolicies.amount,
      })
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, input.companyId),
          eq(budgetPolicies.isActive, true),
          eq(budgetPolicies.metric, "subscription_percent"),
          gt(budgetPolicies.amount, 0),
          inArray(budgetPolicies.scopeType, ["company", "agent", "project"]),
          or(...scopeConditions),
        ),
      );
    return rows.flatMap((row) =>
      isSubscriptionBudgetWindowKind(row.windowKind)
        ? [{
            id: row.id,
            scopeType: row.scopeType as BudgetScopeType,
            scopeId: row.scopeId,
            windowKind: row.windowKind,
            amount: row.amount,
          }]
        : [],
    );
  }

  return {
    listPolicies,

    /**
     * Returns the wait to apply before starting a run for this agent, or null.
     * A scope with no active limit has nothing to check and proceeds. Under a
     * limit, usage that cannot be read holds the run for a short re-check
     * instead of letting it through (see decideSubscriptionWindowWait).
     */
    evaluate: async (input: SubscriptionWindowGateInput): Promise<SubscriptionWindowWait | null> => {
      const policies = await listPolicies(input);
      if (policies.length === 0) return null;
      const now = input.now ?? new Date();
      const provider = providerSlugForAdapterType(input.adapterType);
      const snapshot = await readQuotaSnapshot({ now });
      const result = snapshot.results.find((row) => row.provider === provider) ?? null;
      return decideSubscriptionWindowWait({ policies, result, provider, now });
    },
  };
}
