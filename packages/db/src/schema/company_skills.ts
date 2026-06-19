import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { CompanySkillFileInventoryEntry, CompanySkillSharingScope } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const companySkills = pgTable(
  "company_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    key: text("key").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    markdown: text("markdown").notNull(),
    sourceType: text("source_type").notNull().default("local_path"),
    sourceLocator: text("source_locator"),
    sourceRef: text("source_ref"),
    trustLevel: text("trust_level").notNull().default("markdown_only"),
    compatibility: text("compatibility").notNull().default("compatible"),
    fileInventory: jsonb("file_inventory").$type<Array<Record<string, unknown>>>().notNull().default([]),
    iconUrl: text("icon_url"),
    color: text("color"),
    tagline: text("tagline"),
    authorName: text("author_name"),
    homepageUrl: text("homepage_url"),
    categories: text("categories").array().notNull().default([]),
    sharingScope: text("sharing_scope").$type<CompanySkillSharingScope>().notNull().default("company"),
    publicShareToken: text("public_share_token"),
    forkedFromSkillId: uuid("forked_from_skill_id").references((): AnyPgColumn => companySkills.id, { onDelete: "set null" }),
    forkedFromCompanyId: uuid("forked_from_company_id").references(() => companies.id, { onDelete: "set null" }),
    starCount: integer("star_count").notNull().default(0),
    installCount: integer("install_count").notNull().default(0),
    forkCount: integer("fork_count").notNull().default(0),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => companySkillVersions.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUniqueIdx: uniqueIndex("company_skills_company_key_idx").on(table.companyId, table.key),
    companyNameIdx: index("company_skills_company_name_idx").on(table.companyId, table.name),
    companyCategoriesIdx: index("company_skills_company_categories_idx").using("gin", table.categories),
    companySharingScopeIdx: index("company_skills_company_sharing_scope_idx").on(table.companyId, table.sharingScope),
    companyCurrentVersionIdx: index("company_skills_company_current_version_idx").on(table.companyId, table.currentVersionId),
    companyForkedFromIdx: index("company_skills_company_forked_from_idx").on(table.companyId, table.forkedFromSkillId),
  }),
);

export type CompanySkillVersionFileInventoryEntry = CompanySkillFileInventoryEntry & {
  content: string;
};

export const companySkillVersions = pgTable(
  "company_skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    companySkillId: uuid("company_skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    label: text("label"),
    fileInventory: jsonb("file_inventory").$type<CompanySkillVersionFileInventoryEntry[]>().notNull().default([]),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySkillRevisionUniqueIdx: uniqueIndex("company_skill_versions_skill_revision_idx").on(
      table.companySkillId,
      table.revisionNumber,
    ),
    companySkillCreatedIdx: index("company_skill_versions_company_skill_created_idx").on(
      table.companyId,
      table.companySkillId,
      table.createdAt,
    ),
  }),
);

export const companySkillStars = pgTable(
  "company_skill_stars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    companySkillId: uuid("company_skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySkillAgentUniqueIdx: uniqueIndex("company_skill_stars_skill_agent_idx").on(table.companySkillId, table.agentId),
    companySkillUserUniqueIdx: uniqueIndex("company_skill_stars_skill_user_idx").on(table.companySkillId, table.userId),
    companySkillCreatedIdx: index("company_skill_stars_company_skill_created_idx").on(
      table.companyId,
      table.companySkillId,
      table.createdAt,
    ),
  }),
);

export const companySkillComments = pgTable(
  "company_skill_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    companySkillId: uuid("company_skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    parentCommentId: uuid("parent_comment_id").references((): AnyPgColumn => companySkillComments.id, { onDelete: "set null" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    body: text("body").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySkillCreatedIdx: index("company_skill_comments_company_skill_created_idx").on(
      table.companyId,
      table.companySkillId,
      table.createdAt,
    ),
    parentIdx: index("company_skill_comments_parent_idx").on(table.parentCommentId),
  }),
);
