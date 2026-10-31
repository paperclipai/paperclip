/**
 * Pure helpers for interpreting Paperclip plugin-event payloads.
 *
 * Plugin events spread the activity-log `details` object at the top level of
 * `payload` (there is no `changes` wrapper), so fields like `assigneeAgentId`
 * appear directly on `payload`. Keeping the interpretation here makes it unit
 * testable without standing up a Telegram client.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Given an `issue.updated` event payload, return the new agent-assignee id if
 * this update assigned the issue to an agent — or null otherwise.
 *
 * Encodes the rule the assignment-notification handler depends on:
 *   - read `assigneeAgentId` from the TOP LEVEL of the payload (the event
 *     spreads the PATCH'd fields there; there is no `changes` wrapper);
 *   - require it non-empty — `null` means unassignment and absent means the
 *     update didn't touch assignment, so neither should notify;
 *   - when a `_previous` snapshot is present (some emit paths include one),
 *     skip no-op re-assignments where the value didn't actually change.
 */
export function agentAssigneeChange(payload: unknown): string | null {
  const p = asRecord(payload);
  if (!p) return null;
  const next = asString(p.assigneeAgentId);
  if (!next) return null;
  const previous = asRecord(p._previous);
  if (previous && asString(previous.assigneeAgentId) === next) return null;
  return next;
}
