import { text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { brainSchema } from "./brain-notes.js";

export const brainAgentAcl = brainSchema.table("agent_acl", {
  agentId: text("agent_id").primaryKey(),
  allowedFolders: text("allowed_folders")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
