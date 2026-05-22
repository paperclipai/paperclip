import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const providerRateLimitBlocks = pgTable(
  "provider_rate_limit_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    adapterType: text("adapter_type").notNull(),
    limitKind: text("limit_kind").notNull(),
    modelFamily: text("model_family"),
    message: text("message"),
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    hitCount: integer("hit_count").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAdapterIdx: index("provider_rate_limit_blocks_company_adapter_idx")
      .on(table.companyId, table.adapterType),
    companyAdapterResolvedIdx: index("provider_rate_limit_blocks_resolved_idx")
      .on(table.companyId, table.adapterType, table.resolvedAt),
    activeBlockUq: uniqueIndex("provider_rate_limit_blocks_active_idx")
      .on(table.companyId, table.adapterType, table.limitKind, sql`COALESCE(${table.modelFamily}, '')`)
      .where(sql`${table.resolvedAt} IS NULL`),
  }),
);

export const providerRateLimitBlockMembers = pgTable(
  "provider_rate_limit_block_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockId: uuid("block_id").notNull().references(() => providerRateLimitBlocks.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    originalAgentStatus: text("original_agent_status"),
    releaseStatus: text("release_status"),
    releaseReason: text("release_reason"),
    wakeupRequestId: uuid("wakeup_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    blockAgentUq: uniqueIndex("provider_rate_limit_block_members_block_agent_uq")
      .on(table.blockId, table.agentId),
    blockIdx: index("provider_rate_limit_block_members_block_idx").on(table.blockId),
    companyAgentIdx: index("provider_rate_limit_block_members_company_agent_idx")
      .on(table.companyId, table.agentId),
  }),
);
