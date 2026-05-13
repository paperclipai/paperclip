import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { legalMatters } from "./legal_matters.js";

export const legalPrivilegeFlags = pgTable(
  "legal_privilege_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    matterId: uuid("matter_id").notNull().references(() => legalMatters.id),
    artifactType: text("artifact_type").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    privilegeRing: text("privilege_ring").notNull(),
    rationale: text("rationale"),
    propagatedFromFlagId: uuid("propagated_from_flag_id"),
    taggedByAgentId: uuid("tagged_by_agent_id"),
    taggedByUserId: text("tagged_by_user_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyMatterArtifactIdx: index(
      "legal_privilege_flags_company_matter_artifact_idx",
    ).on(table.companyId, table.matterId, table.artifactType, table.artifactId),
    artifactUniqueIdx: uniqueIndex("legal_privilege_flags_artifact_uq").on(
      table.companyId,
      table.artifactType,
      table.artifactId,
    ),
  }),
);
