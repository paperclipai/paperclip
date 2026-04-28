import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Career profiles - portable career history for agents
 * M3.3: CareerMate - 커리어/산출물 포트폴리오, 이동성, 스킬 이식
 */
export const rt2CareerProfiles = pgTable(
  "rt2_career_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Agent this profile belongs to
    agentId: uuid("agent_id").notNull(),
    // Profile identity
    name: text("name").notNull(),
    title: text("title"), // e.g., "Senior Full-Stack Engineer"
    summary: text("summary"), // Short bio
    // Skills as JSON array
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    // Certifications and credentials
    certifications: jsonb("certifications").$type<string[]>().notNull().default([]),
    // Career stats
    totalTasksCompleted: integer("total_tasks_completed").notNull().default(0),
    totalProjectsDelivered: integer("total_projects_delivered").notNull().default(0),
    averageQualityScore: integer("average_quality_score").notNull().default(0), // 0-5000 (0.0-5.0)
    yearsOfExperience: integer("years_of_experience").notNull().default(0),
    // Portfolio visibility
    isPublic: boolean("is_public").notNull().default(false),
    // Portable export data
    portableData: jsonb("portable_data").$type<Record<string, unknown>>(),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("career_profiles_company_idx").on(table.companyId),
    agentIdx: index("career_profiles_agent_idx").on(table.agentId),
    publicIdx: index("career_profiles_public_idx").on(table.isPublic),
  }),
);

/**
 * Work product portfolio entries - links work products to career for portable portfolio
 * M3.3: 산출물 포트폴리오
 */
export const rt2CareerPortfolio = pgTable(
  "rt2_career_portfolio",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    careerProfileId: uuid("career_profile_id").notNull().references(() => rt2CareerProfiles.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Work product reference
    workProductId: uuid("work_product_id"), // Reference to issue_work_products.id
    // Portfolio entry details
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").notNull(), // 'code', 'design', 'document', 'research', 'analysis'
    // Tags for search
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    // Quality metrics from AI evaluation
    qualityScore: integer("quality_score").notNull().default(0),
    complexityLevel: text("complexity_level").notNull().default("medium"), // 'simple', 'medium', 'complex', 'expert'
    // Impact description
    impactSummary: text("impact_summary"),
    // Evidence links
    evidenceUrls: jsonb("evidence_urls").$type<string[]>().notNull().default([]),
    // Display order
    displayOrder: integer("display_order").notNull().default(0),
    // Is featured?
    isFeatured: boolean("is_featured").notNull().default(false),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    careerProfileIdx: index("career_portfolio_profile_idx").on(table.careerProfileId),
    companyIdx: index("career_portfolio_company_idx").on(table.companyId),
    categoryIdx: index("career_portfolio_category_idx").on(table.category),
    featuredIdx: index("career_portfolio_featured_idx").on(table.isFeatured),
  }),
);

/**
 * Skill transfers - track skill export/import between agents or companies
 * M3.3: 스킬 이식
 */
export const rt2SkillTransfers = pgTable(
  "rt2_skill_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Transfer type
    transferType: text("transfer_type").notNull(), // 'export', 'import', 'share'
    // Source
    sourceProfileId: uuid("source_profile_id").references(() => rt2CareerProfiles.id),
    sourceCompanyId: uuid("source_company_id"),
    // Destination
    destProfileId: uuid("dest_profile_id").references(() => rt2CareerProfiles.id),
    destCompanyId: uuid("dest_company_id"),
    // Skills transferred
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    // Transfer metadata
    transferReason: text("transfer_reason"),
    // Status
    status: text("status").notNull().default("pending"), // 'pending', 'completed', 'rejected', 'expired'
    // Completion
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Verification
    verificationScore: integer("verification_score").notNull().default(0),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("skill_transfers_company_idx").on(table.companyId),
    sourceIdx: index("skill_transfers_source_idx").on(table.sourceProfileId),
    destIdx: index("skill_transfers_dest_idx").on(table.destProfileId),
    statusIdx: index("skill_transfers_status_idx").on(table.status),
  }),
);

/**
 * Career milestones - track career progression
 * M3.3: 커리어 마일스톤
 */
export const rt2CareerMilestones = pgTable(
  "rt2_career_milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    careerProfileId: uuid("career_profile_id").notNull().references(() => rt2CareerProfiles.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Milestone details
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").notNull(), // 'promotion', 'certification', 'achievement', 'project', 'training'
    // Date achieved
    achievedAt: timestamp("achieved_at", { withTimezone: true }),
    // Evidence
    evidenceUrls: jsonb("evidence_urls").$type<string[]>().notNull().default([]),
    // Impact metrics
    impactMetrics: jsonb("impact_metrics").$type<Record<string, unknown>>(),
    // Display order
    displayOrder: integer("display_order").notNull().default(0),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    careerProfileIdx: index("career_milestones_profile_idx").on(table.careerProfileId),
    companyIdx: index("career_milestones_company_idx").on(table.companyId),
    categoryIdx: index("career_milestones_category_idx").on(table.category),
  }),
);