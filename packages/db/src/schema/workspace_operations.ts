import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const workspaceOperations = pgTable(
  "workspace_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    executionWorkspaceId: uuid("execution_workspace_id").references(() => executionWorkspaces.id, {
      onDelete: "set null",
    }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    phase: text("phase").notNull(),
    command: text("command"),
    cwd: text("cwd"),
    status: text("status").notNull().default("running"),
    exitCode: integer("exit_code"),
    logStore: text("log_store"),
    logRef: text("log_ref"),
    logBytes: bigint("log_bytes", { mode: "number" }),
    logSha256: text("log_sha256"),
    logCompressed: boolean("log_compressed").notNull().default(false),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunStartedIdx: index("workspace_operations_company_run_started_idx").on(
      table.companyId,
      table.heartbeatRunId,
      table.startedAt,
    ),
    companyWorkspaceStartedIdx: index("workspace_operations_company_workspace_started_idx").on(
      table.companyId,
      table.executionWorkspaceId,
      table.startedAt,
    ),
  }),
);
