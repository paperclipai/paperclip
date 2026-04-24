import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueWorkflowInstances = pgTable(
  "issue_workflow_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    rootIssueId: uuid("root_issue_id").notNull().references(() => issues.id),
    templateKey: text("template_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rootIssueIdx: uniqueIndex("issue_workflow_instances_root_issue_idx").on(table.rootIssueId),
    companyTemplateIdx: index("issue_workflow_instances_company_template_idx").on(table.companyId, table.templateKey),
  }),
);

export const issueWorkflowLanes = pgTable(
  "issue_workflow_lanes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    workflowInstanceId: uuid("workflow_instance_id")
      .notNull()
      .references(() => issueWorkflowInstances.id, { onDelete: "cascade" }),
    rootIssueId: uuid("root_issue_id").notNull().references(() => issues.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    laneRole: text("lane_role").notNull(),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: uniqueIndex("issue_workflow_lanes_issue_idx").on(table.issueId),
    instanceLaneIdx: uniqueIndex("issue_workflow_lanes_instance_lane_idx").on(table.workflowInstanceId, table.laneRole),
    rootLaneIdx: index("issue_workflow_lanes_root_lane_idx").on(table.rootIssueId, table.laneRole),
  }),
);

export const issueWorkflowLaneArtifacts = pgTable(
  "issue_workflow_lane_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    workflowLaneId: uuid("workflow_lane_id")
      .notNull()
      .references(() => issueWorkflowLanes.id, { onDelete: "cascade" }),
    artifactKey: text("artifact_key").notNull(),
    label: text("label").notNull(),
    kind: text("kind").notNull(),
    blocking: boolean("blocking").notNull().default(true),
    documentKey: text("document_key"),
    workProductTypes: jsonb("work_product_types").$type<string[]>(),
    commentMarkers: jsonb("comment_markers").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    laneArtifactIdx: uniqueIndex("issue_workflow_lane_artifacts_lane_key_idx").on(
      table.workflowLaneId,
      table.artifactKey,
    ),
    companyKindIdx: index("issue_workflow_lane_artifacts_company_kind_idx").on(table.companyId, table.kind),
    blockingArtifactIdx: index("issue_workflow_lane_artifacts_blocking_idx")
      .on(table.workflowLaneId, table.blocking)
      .where(sql`${table.blocking} = true`),
  }),
);
