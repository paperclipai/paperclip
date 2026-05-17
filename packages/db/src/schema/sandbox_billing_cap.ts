/**
 * Phase 4A-S4 B2 (LET-367): persisted billing-cap counters + kill-switch
 * audit trail for the E2B sandbox pilot.
 *
 * `sandbox_billing_cap_state` is keyed by (company_id, provider) and rolls a
 * single row per (company × provider) with the current UTC-day and UTC-month
 * counters plus the persisted layer states the monitor flips when caps are
 * breached. The companion `sandbox_billing_cap_events` table is an append-only
 * audit log of every soft/hard breach and operator toggle the monitor records.
 *
 * Cost numbers are stored as integer cents (USD). The monitor key — provider
 * name + run id — never includes the raw vendor API key; see B2 redaction
 * pipeline in `services/sandbox/billing-cap/redaction.ts`.
 *
 * Both tables are additive. The migration is prepared but is NOT applied to
 * production as part of LET-367; apply is a separate Andrii-gated action.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const sandboxBillingCapState = pgTable(
  "sandbox_billing_cap_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Stable provider key, e.g. "e2b". */
    provider: text("provider").notNull(),

    /** UTC date (YYYY-MM-DD 00:00Z) marking the start of the current day window. */
    dayWindowStart: timestamp("day_window_start", { withTimezone: true }).notNull(),
    /** Cumulative spend within the current day window, in USD cents. */
    daySpentCents: integer("day_spent_cents").notNull().default(0),
    /** ISO timestamp of the most recent hard-cap breach inside the current day window. */
    dayHardCapBreachedAt: timestamp("day_hard_cap_breached_at", { withTimezone: true }),

    /** UTC date marking the first-of-month boundary for the current month window. */
    monthWindowStart: timestamp("month_window_start", { withTimezone: true }).notNull(),
    /** Cumulative spend within the current month window, in USD cents. */
    monthSpentCents: integer("month_spent_cents").notNull().default(0),
    /** ISO timestamp of the most recent hard-cap breach inside the current month window. */
    monthHardCapBreachedAt: timestamp("month_hard_cap_breached_at", { withTimezone: true }),

    /**
     * Layer state for the provider-enable config flag (`sandbox.providers.<provider>.enabled`).
     * `true` means the monitor has not auto-disabled the provider; `false` means an automatic
     * disable is in effect (either day or month hard-cap breach).
     */
    providerEnableLayerEnabled: boolean("provider_enable_layer_enabled").notNull().default(true),
    /** Free-text reason persisted alongside the most recent provider-enable layer transition. */
    providerEnableReason: text("provider_enable_reason"),
    /** Actor label of the most recent provider-enable transition (e.g. `auto-cap-monitor`). */
    providerEnableActorLabel: text("provider_enable_actor_label"),
    /** Timestamp of the most recent provider-enable transition. */
    providerEnableTransitionAt: timestamp("provider_enable_transition_at", { withTimezone: true }),

    /**
     * Operator toggle layer state. Independent from the auto-disable so an operator can pre-empt
     * the monitor. Defaults to enabled.
     */
    operatorToggleEnabled: boolean("operator_toggle_enabled").notNull().default(true),
    operatorToggleReason: text("operator_toggle_reason"),
    operatorToggleActorLabel: text("operator_toggle_actor_label"),
    operatorToggleTransitionAt: timestamp("operator_toggle_transition_at", { withTimezone: true }),

    /** ISO timestamp of the last poll tick that wrote into this row. */
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    /** Source label of the most recent counter reconciliation: `e2b-usage-api` or `internal-estimate`. */
    lastSource: text("last_source"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderUniq: uniqueIndex("sandbox_billing_cap_state_company_provider_uniq").on(
      table.companyId,
      table.provider,
    ),
    companyIdx: index("sandbox_billing_cap_state_company_idx").on(table.companyId),
  }),
);

export const sandboxBillingCapEvents = pgTable(
  "sandbox_billing_cap_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /**
     * Event kind, one of: `soft_cap_breached`, `hard_cap_breached`, `operator_toggle_flipped`,
     * `provider_enable_layer_flipped`, `monthly_incident_opened`.
     */
    kind: text("kind").notNull(),
    /** Window scope: `day` or `month`. Null for operator-toggle events. */
    windowKind: text("window_kind"),
    /** Spend in cents at the moment of the event (current window total). */
    spentCents: integer("spent_cents"),
    /** Cap threshold in cents that triggered the event. */
    thresholdCents: integer("threshold_cents"),
    /** Projection in cents over the remainder of the window, if available. */
    projectionCents: integer("projection_cents"),
    /** Actor label (`auto-cap-monitor`, `operator:<userId>`). */
    actorLabel: text("actor_label").notNull(),
    /** Free-text reason or summary; safe for surfacing in operator-facing UI. */
    reason: text("reason"),
    /** Optional pointer to the Paperclip incident issue opened on monthly hard-cap breach. */
    incidentIssueId: uuid("incident_issue_id"),
    /** Pre-redacted metadata payload (no raw vendor credentials). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("sandbox_billing_cap_events_company_occurred_idx").on(
      table.companyId,
      table.occurredAt,
    ),
    companyKindOccurredIdx: index("sandbox_billing_cap_events_company_kind_occurred_idx").on(
      table.companyId,
      table.kind,
      table.occurredAt,
    ),
  }),
);
