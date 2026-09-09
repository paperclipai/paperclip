export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  /**
   * True failures for the day, excluding process-loss/restart kills that were
   * later recovered by a successful retry (those are surfaced in `recovered`).
   */
  failed: number;
  /**
   * Runs that terminated in a failure state (failed/timed_out) but whose retry
   * chain eventually succeeded — e.g. restart-killed runs that recovered. Kept
   * out of `failed` so the headline failure count reflects true, unrecovered
   * failures.
   */
  recovered: number;
  other: number;
  total: number;
  /**
   * Per-error-code breakdown of the (true) `failed` count for the day, so a
   * spike can be attributed to an error class (e.g. `process_lost`,
   * `provider_quota`, `workspace_validation_failed`). Recovered runs are not
   * included here. Runs with no error code are bucketed under `unknown`.
   */
  failedByErrorCode: Record<string, number>;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    /**
     * Sum of provider-reported cost amounts (cost_status `reported`) for the
     * company's current UTC month. Unpriced observations are excluded whatever
     * amount they carry, so this is a priced subtotal, not a total bill; see
     * `monthUnpricedCount` before presenting it as complete.
     */
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
    /**
     * Cost observations (cost_events rows) in the current UTC month whose
     * status is `reported`, i.e. the provider reported an amount. A positive
     * count with `monthSpendCents === 0` is a genuine reported zero, not a
     * missing measurement.
     */
    monthReportedCount: number;
    /**
     * Cost observations in the current UTC month whose status is `unpriced`:
     * token usage was observed but no provider price was reported. Their
     * recorded amount, if any, is excluded from `monthSpendCents`, so any value
     * above zero means the subtotal does not account for all observed usage.
     * Both counts at zero means no cost usage was reported at all — not a
     * complete zero bill.
     */
    monthUnpricedCount: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}
