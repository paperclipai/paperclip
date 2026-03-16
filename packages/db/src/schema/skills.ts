import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  real,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
  varchar,
} from "drizzle-orm/pg-core";
import { agents, companies, authUsers } from "./index.js";

// Enums for skill categories and statuses
export const skillCategoryEnum = pgEnum("skill_category", [
  "math",
  "text",
  "data",
  "utility",
  "custom",
]);

export const skillStatusEnum = pgEnum("skill_status", [
  "published",
  "draft",
  "deprecated",
]);

export const skillRuntimeEnum = pgEnum("skill_runtime", ["javascript", "python"]);

export const skillExecutionStatusEnum = pgEnum("skill_execution_status", [
  "pending",
  "running",
  "success",
  "error",
]);

/**
 * Skills library - all available skills
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").unique().notNull(),
    category: skillCategoryEnum("category").notNull(),
    description: text("description").notNull(),
    version: text("version").notNull().default("1.0.0"),
    status: skillStatusEnum("status").notNull().default("published"),
    authorId: uuid("author_id").references(() => authUsers.id),
    parameters: jsonb("parameters").$type<Record<string, unknown>>(),
    returns: jsonb("returns").$type<Record<string, unknown>>(),
    sourceCode: text("source_code"),
    runtime: skillRuntimeEnum("runtime"),
    isBuiltin: boolean("is_builtin").default(false),
    downloadCount: integer("download_count").default(0),
    rating: real("rating").default(0.0),
    ratingCount: integer("rating_count").default(0),
    repositoryUrl: text("repository_url"),
    documentationUrl: text("documentation_url"),
    tags: text("tags").array(),
    dependencies: jsonb("dependencies").$type<Record<string, string>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => ({
    nameIdx: index("skills_name_idx").on(table.name),
    categoryIdx: index("skills_category_idx").on(table.category),
    statusIdx: index("skills_status_idx").on(table.status),
  })
);

/**
 * Skill installations - which agents/companies have installed which skills
 */
export const skillInstallations = pgTable(
  "skill_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    version: text("version").notNull(),
    enabled: boolean("enabled").default(true),
    configuration: jsonb("configuration").$type<Record<string, unknown>>(),
    installedBy: uuid("installed_by")
      .notNull()
      .references(() => authUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("skill_installations_company_idx").on(table.companyId),
    agentIdx: index("skill_installations_agent_idx").on(table.agentId),
    skillIdx: index("skill_installations_skill_idx").on(table.skillId),
    uniqueInstallation: uniqueIndex("skill_installations_unique").on(
      table.skillId,
      table.companyId,
      table.agentId
    ),
  })
);

/**
 * Skill execution logs
 */
export const skillExecutions = pgTable(
  "skill_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id"),
    status: skillExecutionStatusEnum("status").notNull(),
    inputData: jsonb("input_data").$type<Record<string, unknown>>(),
    outputData: jsonb("output_data").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    executionTimeMs: integer("execution_time_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    agentIdx: index("skill_executions_agent_idx").on(table.agentId),
    statusIdx: index("skill_executions_status_idx").on(table.status),
    createdIdx: index("skill_executions_created_idx").on(table.createdAt),
  })
);

/**
 * Skill ratings and reviews
 */
export const skillReviews = pgTable(
  "skill_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    reviewText: text("review_text"),
    helpfulCount: integer("helpful_count").default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    skillIdx: index("skill_reviews_skill_idx").on(table.skillId),
    ratingIdx: index("skill_reviews_rating_idx").on(table.rating),
    uniqueReview: uniqueIndex("skill_reviews_unique").on(
      table.skillId,
      table.userId
    ),
  })
);
