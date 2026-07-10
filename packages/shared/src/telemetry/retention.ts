/**
 * Telemetry retention contract.
 *
 * Defines the retention class for each Paperclip telemetry event and the
 * corresponding retention window in days. This is a housekeeping/cost
 * concern separate from the event schema: it is updated by data-infra
 * and does not require a schema version bump.
 *
 * Retention class definitions
 * ─────────────────────────────────────────────────────────────────────────
 * operational_enum_count
 *   Events that carry only enums, booleans, counts, and coarse buckets.
 *   No token material (I5-clean) and no PII. Retention is a housekeeping
 *   and query-cost concern, not a privacy concern.
 *   Window: 90 days.
 */

/** Retention window in days for each telemetry event class. */
export const RETENTION_DAYS = {
  /**
   * Enum/count/bucket events: no token material, no PII.
   * Retention is a housekeeping and query-cost concern only.
   */
  operational_enum_count: 90,
} as const satisfies Record<string, number>;

/** Identifies which retention class an event belongs to. */
export type RetentionClass = keyof typeof RETENTION_DAYS;

/**
 * Maps first-party event names to their retention class.
 *
 * Key type is intentionally `string` rather than a tighter union because this
 * contract also covers events emitted by external systems (e.g. the Codex CLI)
 * that are not part of the shared generated `PaperclipEventName` type. When an
 * event is promoted to the first-party schema, prefer tightening its entry to
 * the named union type via an overloaded record.
 *
 * codex.credential_health
 *   Emits credential-observability fields: enums (credential source, sync
 *   outcome), booleans (rotation detected, refresh succeeded), and coarse
 *   counts (rotations detected). No token material and no PII.
 *   External-system event (Codex CLI) — not yet in PaperclipEventName.
 *   Class: operational_enum_count — 90-day window.
 */
export const EVENT_RETENTION_CLASS: Partial<Record<string, RetentionClass>> = {
  "codex.credential_health": "operational_enum_count",
};
