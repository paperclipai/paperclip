import { pgTable, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { providerCredentials } from "./provider_credentials.js";

export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id").notNull().references(() => providerCredentials.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentCredentialUniqueIdx: uniqueIndex("agent_credentials_agent_credential_unique_idx").on(
      table.agentId,
      table.credentialId,
    ),
    agentIdx: index("agent_credentials_agent_idx").on(table.agentId),
    credentialIdx: index("agent_credentials_credential_idx").on(table.credentialId),
  }),
);
