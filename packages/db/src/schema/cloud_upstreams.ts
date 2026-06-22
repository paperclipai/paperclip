import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const cloudUpstreamConnections = pgTable(
  "cloud_upstream_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    remoteUrl: text("remote_url").notNull(),
    sourceInstanceId: text("source_instance_id").notNull(),
    sourceInstanceFingerprint: text("source_instance_fingerprint").notNull(),
    sourcePublicKey: text("source_public_key").notNull(),
    // Stored through the Cloud Upstream service as an encrypted credential envelope.
    privateKeyPem: text("private_key_pem").notNull(),
    tokenStatus: text("token_status").notNull(),
    scopes: text("scopes").array().notNull().default([]),
    authorizedGlobalUserId: text("authorized_global_user_id"),
    // Stored through the Cloud Upstream service as an encrypted credential envelope.
    accessToken: text("access_token"),
    tokenId: text("token_id"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),

    targetStackId: text("target_stack_id").notNull(),
    targetStackSlug: text("target_stack_slug"),
    targetStackDisplayName: text("target_stack_display_name"),
    targetCompanyId: text("target_company_id").notNull(),
    targetOrigin: text("target_origin").notNull(),
    targetPrimaryHost: text("target_primary_host").notNull(),
    targetProduct: text("target_product").notNull(),
    targetSchemaMajor: integer("target_schema_major").notNull(),
    targetMaxChunkBytes: integer("target_max_chunk_bytes").notNull(),

    pendingState: text("pending_state"),
    pendingCodeVerifier: text("pending_code_verifier"),
    pendingRedirectUri: text("pending_redirect_uri"),
    pendingTokenUrl: text("pending_token_url"),

    lastRunId: uuid("last_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("cloud_upstream_connections_company_idx").on(table.companyId),
  ],
);

export const cloudUpstreamRuns = pgTable(
  "cloud_upstream_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").notNull().references(() => cloudUpstreamConnections.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    remoteRunId: text("remote_run_id"),
    status: text("status").notNull(),
    activeStep: text("active_step").notNull(),
    progressPercent: integer("progress_percent").notNull().default(0),
    dryRun: boolean("dry_run").notNull().default(false),
    retryOfRunId: uuid("retry_of_run_id"),
    summary: jsonb("summary").$type<import("@paperclipai/shared").CloudUpstreamSummaryCount[]>().notNull().default([]),
    warnings: jsonb("warnings").$type<import("@paperclipai/shared").CloudUpstreamWarning[]>().notNull().default([]),
    conflicts: jsonb("conflicts").$type<import("@paperclipai/shared").CloudUpstreamConflict[]>().notNull().default([]),
    events: jsonb("events").$type<import("@paperclipai/shared").CloudUpstreamRunEvent[]>().notNull().default([]),
    report: jsonb("report").$type<Record<string, unknown>>().notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    targetUrl: text("target_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("cloud_upstream_runs_company_created_idx").on(table.companyId, table.createdAt),
    index("cloud_upstream_runs_connection_idx").on(table.connectionId),
  ],
);
