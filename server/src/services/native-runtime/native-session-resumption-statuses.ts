/** Task statuses from which a native same-run resume may be claimed. The task
 * interruption read model shares this set with resumption admission so it
 * never advertises a resume the scheduler would refuse. */
export const NATIVE_SESSION_RESUMPTION_ISSUE_STATUSES = ["todo", "in_progress", "in_review"] as const;
