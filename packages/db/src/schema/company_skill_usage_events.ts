import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SkillUsageEventKind } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { companySkills } from "./company_skills.js";
import { companySkillVersions } from "./company_skills.js";

export const companySkillUsageEvents = pgTable(
  "company_skill_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    skillKey: text("skill_key").notNull(),
    skillId: uuid("skill_id").references(() => companySkills.id, { onDelete: "set null" }),
    skillVersionId: uuid("skill_version_id").references(() => companySkillVersions.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    adapter: text("adapter").notNull(),
    eventKind: text("event_kind").$type<SkillUsageEventKind>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("company_skill_usage_events_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    companySkillIdx: index("company_skill_usage_events_company_skill_created_idx").on(
      table.companyId,
      table.skillId,
      table.createdAt,
    ),
    companySkillKeyIdx: index("company_skill_usage_events_company_skill_key_created_idx").on(
      table.companyId,
      table.skillKey,
      table.createdAt,
    ),
  }),
);
