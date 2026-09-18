import { HttpError } from "../../errors.js";

/**
 * A consistency guard rejecting one write (here `assertNoBlockingCycles`
 * throwing HttpError 422 with `code: "blocking_relations_cycle"`) is a data
 * condition about a single issue, not a process fault. Startup recovery logs it
 * and skips that one action: if the rejection escapes, the startup-recovery
 * promise rejects, the boot path aborts, and systemd's Restart=always turns one
 * bad row into a total outage. The `code` is the discriminator, so an unrelated
 * 422 from any other recovery step still fails loudly.
 *
 * This lives in its own module so boot-path callers can import the predicate
 * without pulling the whole recovery service dependency graph.
 */
export function isGuardRejectedRecoveryWrite(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    error.status === 422 &&
    (error.details as { code?: unknown } | undefined)?.code ===
      "blocking_relations_cycle"
  );
}
