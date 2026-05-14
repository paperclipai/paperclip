import { pgTable, uuid, text, boolean, integer, timestamp, jsonb, doublePrecision, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const syntheticSshProbeResults = pgTable(
  "synthetic_ssh_probe_results",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    targetHost: text("target_host").notNull(),
    targetUser: text("target_user").notNull(),
    ok: boolean("ok").notNull(),
    totalMs: integer("total_ms").notNull(),
    sshHandshakeMs: integer("ssh_handshake_ms"),
    curlMs: integer("curl_ms"),
    errorClass: text("error_class"),
    attemptsJson: jsonb("attempts_json").notNull().default(sql`'[]'::jsonb`),
    hostLoadAvg1m: doublePrecision("host_load_avg_1m"),
    sshdAuthAttempts: integer("sshd_auth_attempts"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetStartedIdx: index("synthetic_ssh_probe_results_target_started_idx").on(table.targetHost, table.startedAt),
    startedIdx: index("synthetic_ssh_probe_results_started_idx").on(table.startedAt),
  }),
);
