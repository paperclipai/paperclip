import { foreignKey, jsonb, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export type DurableAgentFileEntry = { path: string } & (
  | { kind: "dir" }
  | { kind: "file"; mode: number; size: number; sha256: string; objectKey: string | null }
);

/** Current managed files. The filesystem is a projection once this row exists. */
export const agentFileRoots = pgTable("agent_file_roots", {
  companyId: uuid("company_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  generation: uuid("generation").notNull(),
  entries: jsonb("entries").$type<DurableAgentFileEntry[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  identity: primaryKey({ columns: [t.companyId, t.agentId] }),
  owner: foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
}));
