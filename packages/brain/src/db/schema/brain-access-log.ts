import { bigserial, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { brainSchema } from "./brain-notes.js";

export const brainAccessLog = brainSchema.table(
  "access_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    agentId: text("agent_id").notNull(),
    tool: text("tool").notNull(),
    query: text("query"),
    path: text("path"),
    returnedPaths: text("returned_paths").array(),
    latencyMs: integer("latency_ms"),
    ok: boolean("ok").notNull(),
  },
  (table) => ({
    tsIdx: index("brain_access_log_ts_idx").on(table.ts),
    agentTsIdx: index("brain_access_log_agent_ts_idx").on(table.agentId, table.ts),
  }),
);
