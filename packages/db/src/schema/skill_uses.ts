/**
 * Plan 4 — append-only use-event log for guild skills.
 *
 * Every call to `recordUse` inserts one row here AND updates the
 * cumulative counters on `skills`. Together they give the auto-promotion
 * scanner two signals: aggregate ratio (counters) and sample diversity
 * (COUNT DISTINCT run_id over this table).
 *
 * Append-only enforced by a trigger (see migration 0091). UPDATE/DELETE
 * raise unless coming from CASCADE delete on a parent row.
 */
import { pgTable, uuid, boolean, timestamp, index } from "drizzle-orm/pg-core";

import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { skills } from "./skills.js";

export const skillUses = pgTable(
  "skill_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    guildId: uuid("guild_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    success: boolean("success").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    skillIdx: index("skill_uses_skill_idx").on(table.skillId),
    guildRecordedIdx: index("skill_uses_guild_recorded_idx").on(
      table.guildId,
      table.recordedAt.desc(),
    ),
  }),
);
