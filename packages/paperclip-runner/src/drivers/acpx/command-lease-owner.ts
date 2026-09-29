import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";

/** Keep each launch single-use while owning replacements for transient ACP controls. */
export function createAcpxCommandLeaseOwner(
  initial: VerifiedAcpxCommandLease,
  openCommand: () => Promise<VerifiedAcpxCommandLease>,
) {
  const leases = new Set([initial]);
  let current = initial;
  let consumed = false;
  let closing = false;
  let refresh: Promise<void> | null = null;
  const command: VerifiedAcpxCommandLease = {
    spawn(...args) {
      if (closing) throw new Error("Verified ACPX command owner is closing");
      consumed = true;
      return current.spawn(...args);
    },
    async close() {
      closing = true;
      // Late acquisitions remain owned. Retry every lease whose close fails.
      await refresh?.catch(() => undefined);
      const failures: unknown[] = [];
      for (const lease of leases) {
        try {
          await lease.close();
          leases.delete(lease);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "ACPX command leases did not close");
    },
  };
  return {
    command,
    async refreshConsumedCommand(): Promise<void> {
      if (closing) throw new Error("Verified ACPX command owner is closing");
      if (!consumed) return;
      if (!refresh) {
        refresh = Promise.resolve()
          .then(openCommand)
          .then((replacement) => {
            leases.add(replacement);
            if (closing) throw new Error("Verified ACPX command owner closed during refresh");
            current = replacement;
            consumed = false;
          });
      }
      const pending = refresh;
      try {
        await pending;
      } finally {
        if (refresh === pending) refresh = null;
      }
    },
  };
}
