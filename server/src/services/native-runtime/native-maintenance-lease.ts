/** Keep a bounded lease alive during asynchronous history scans/copies. Never
 * queue renewals, revive an expired lease, or conceal a failed ownership check. */
export function startNativeMaintenanceLeaseRenewal(renew: () => Promise<void>, intervalMs = 15_000, options: { renewalTimeoutMs?: number } = {}) {
  let pending: Promise<void> | null = null, failure: unknown, stopped = false;
  const cancellation = new AbortController();
  const attempt = async () => {
    if (options.renewalTimeoutMs === undefined) return renew();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([renew(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("native_maintenance_lease_renewal_timeout")), options.renewalTimeoutMs);
        timeout.unref();
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  };
  const timer = setInterval(() => {
    if (stopped || pending || failure) return;
    pending = Promise.resolve().then(attempt).catch(error => {
      failure = error ?? new Error("native_cleanup_maintenance_lease_lost");
      cancellation.abort(failure);
    }).finally(() => { pending = null; });
  }, intervalMs);
  timer.unref();
  return {
    signal: cancellation.signal,
    /** Transaction-local fences must not await a renewal that may itself be
     * waiting for that transaction's row lock. They still check actual owner
     * and expiry in their own transaction before publishing. */
    assertKnown() { if (failure) throw failure; },
    async assert() { await pending; if (failure) throw failure; },
    async stop() { stopped = true; clearInterval(timer); await pending; },
  };
}
