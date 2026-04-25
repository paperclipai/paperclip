import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

export const secretAccessLog = pgTable(
  "secret_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    secretName: text("secret_name").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorRole: text("actor_role"),
    accessGranted: boolean("access_granted").notNull().default(false),
    denialReason: text("denial_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    secretIdIdx: index("secret_access_log_secret_id_idx").on(table.secretId),
    companyIdIdx: index("secret_access_log_company_id_idx").on(table.companyId),
    createdAtIdx: index("secret_access_log_created_at_idx").on(table.createdAt),
  }),
);