import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { providerCredentials } from "./provider_credentials.js";

export const credentialAccessGrants = pgTable(
  "credential_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    credentialId: uuid("credential_id").notNull().references(() => providerCredentials.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    accessLevel: text("access_level").notNull().default("use"),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    credPrincipalUniqueIdx: uniqueIndex("credential_access_grants_cred_principal_unique_idx").on(
      table.credentialId,
      table.principalType,
      table.principalId,
    ),
  }),
);
