import { pgTable, uuid, text, bigint, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").references(() => issues.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    kind: text("kind").notNull().default("attachment"),
    title: text("title").notNull(),
    description: text("description"),
    url: text("url"),
    filePath: text("file_path"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    previewUrl: text("preview_url"),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("idx_artifacts_company").on(table.companyId),
    issueIdx: index("idx_artifacts_issue").on(table.issueId),
    runIdx: index("idx_artifacts_run_id").on(table.runId),
  }),
);
