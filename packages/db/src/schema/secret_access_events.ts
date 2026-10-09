import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { plugins } from "./plugins.js";
import { userSecretDefinitions } from "./user_secret_definitions.js";

export const secretAccessEvents = pgTable(
  "secret_access_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "cascade" }),
    userSecretDefinitionId: uuid("user_secret_definition_id").references(() => userSecretDefinitions.id, { onDelete: "set null" }),
    secretScope: text("secret_scope").notNull().default("company"),
    version: integer("version"),
    provider: text("provider").notNull(),
    responsibleUserId: text("responsible_user_id"),
    credentialOwnerUserId: text("credential_owner_user_id"),
    credentialSubjectType: text("credential_subject_type"),
    credentialSubjectId: text("credential_subject_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    consumerType: text("consumer_type").notNull(),
    consumerId: text("consumer_id").notNull(),
    configPath: text("config_path"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    pluginId: uuid("plugin_id").references(() => plugins.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("secret_access_events_company_created_idx").on(table.companyId, table.createdAt),
    secretCreatedIdx: index("secret_access_events_secret_created_idx").on(table.secretId, table.createdAt),
    userDefinitionCreatedIdx: index("secret_access_events_user_definition_created_idx").on(
      table.userSecretDefinitionId,
      table.createdAt,
    ),
    credentialOwnerIdx: index("secret_access_events_company_credential_owner_idx").on(
      table.companyId,
      table.credentialOwnerUserId,
      table.createdAt,
    ),
    consumerIdx: index("secret_access_events_consumer_idx").on(table.companyId, table.consumerType, table.consumerId),
    runIdx: index("secret_access_events_run_idx").on(table.heartbeatRunId),
  }),
);
