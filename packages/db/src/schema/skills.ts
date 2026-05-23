/**
 * Plan 3 v2 organisation — guild skills.
 *
 * A guild (an agent row with `kind = 'guild'`) owns a library of skills.
 * Each skill is a short, reusable knowledge note an ephemeral worker
 * discovered while completing a task. Workers write skills at provenance
 * `provisional`; the operator (or a future PM/COO) promotes them to
 * `canonical` via the API. Once canonical, other workers spawning under
 * the same guild can rely on them as established practice.
 *
 * Counts (`successCount` / `failCount`) record how often subsequent
 * workers used the skill and whether the run succeeded; this powers the
 * quality-vote mechanism in spec risk 3 (Plan 3b).
 *
 * `retiredAt` soft-deletes a skill that turned out to be wrong or
 * obsolete; the row is preserved so future audits can trace why a skill
 * went away.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The guild that owns this skill. Always an agents row with
    // kind='guild'; the API write path enforces that invariant.
    guildId: uuid("guild_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    // Denormalized for company-scoped queries (the API will already have
    // the companyId from the auth context; storing it here avoids a join
    // when listing skills for a company-wide search).
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    body: text("body").notNull(),
    provenance: text("provenance", { enum: ["provisional", "canonical"] })
      .notNull()
      .default("provisional"),
    // The run that wrote this skill. Nullable: a future seeding flow may
    // import canonical skills from outside any specific run (e.g. a
    // bootstrap script). If the source run gets deleted we keep the
    // skill but lose the trace; that's an acceptable trade.
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    successCount: integer("success_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    bodyUpdatedAt: timestamp("body_updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    guildIdx: index("skills_guild_idx").on(table.guildId),
    companyIdx: index("skills_company_idx").on(table.companyId),
    // Listing provisional-only is the operator's main read pattern
    // (promotion queue), so index that filter.
    guildProvenanceIdx: index("skills_guild_provenance_idx").on(table.guildId, table.provenance),
    // Name lookup within a guild is the worker's deduplication path
    // ("does a skill with this name already exist?"). Not unique because
    // a retired skill can be superseded by a fresh one with the same
    // slug; the application layer enforces uniqueness over non-retired
    // rows.
    guildNameIdx: index("skills_guild_name_idx").on(table.guildId, table.name),
  }),
);
