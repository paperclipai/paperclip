/** Router error classes. Distinct types so callers can branch on the cause. */

/** Router could not satisfy the active policy (e.g. Tier 2 without the automation
 *  flag, or outbound sensitivity without a reachable second-pass engine). */
export class RouterPolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterPolicyViolationError';
  }
}

/** The router itself is misconfigured — empty/missing policy, model catalog gap,
 *  unknown task_type, etc. Never raised due to caller input alone; always
 *  indicates a bug or stale configuration. */
export class RouterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterConfigError';
  }
}
