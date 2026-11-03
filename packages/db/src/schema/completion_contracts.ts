import {
  foreignKey,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const completionContracts = pgTable(
  "completion_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    revision: integer("revision").notNull(),
    schemaVersion: text("schema_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    risk: text("risk").notNull(),
    completionAuthority: text("completion_authority").notNull(),
    incompleteCriteriaPolicy: text("incomplete_criteria_policy").notNull(),
    contractJson: jsonb("contract_json").$type<Record<string, unknown>>().notNull(),
    canonicalSha256: text("canonical_sha256").notNull(),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    supersedesContractId: uuid("supersedes_contract_id"),
  },
  (table) => ({
    companyIssueIdUq: unique("completion_contracts_company_issue_id_uq").on(
      table.companyId,
      table.issueId,
      table.id,
    ),
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "completion_contracts_issue_company_fk",
    }),
    supersedesOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.supersedesContractId],
      foreignColumns: [table.companyId, table.issueId, table.id],
      name: "completion_contracts_supersedes_owner_fk",
    }),
    issueRevisionUq: uniqueIndex("completion_contracts_issue_revision_uq").on(
      table.issueId,
      table.revision,
    ),
    issueHashUq: uniqueIndex("completion_contracts_issue_hash_uq").on(
      table.issueId,
      table.canonicalSha256,
    ),
  }),
);
