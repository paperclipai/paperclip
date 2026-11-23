import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const automaticRunBrakes = pgTable("automatic_run_brakes", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  state: text("state").$type<"closed" | "open" | "half_open">().notNull().default("closed"),
  reason: jsonb("reason").$type<Record<string, unknown>>().notNull().default({}),
  stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull().defaultNow(),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
  probeRunId: uuid("probe_run_id"),
  probeSuccesses: integer("probe_successes").notNull().default(0),
  releaseWindowStartedAt: timestamp("release_window_started_at", { withTimezone: true }),
  releaseWindowStarts: integer("release_window_starts").notNull().default(0),
  nextCreationAt: timestamp("next_creation_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
