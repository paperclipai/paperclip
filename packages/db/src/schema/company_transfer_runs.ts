import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Durable ledger for chunked company transfers (export publishes and import
// applies). One row per run; `completedParts` records every container part
// (chunk or blob name) that has been fully processed and verified, so an
// interrupted run resumes from the parts it already finished instead of
// restarting. `idempotencyKey` is the transfer manifest's content-derived key:
// a retried publish/apply of identical content finds its prior run.
export const companyTransferRuns = pgTable(
  "company_transfer_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null while an import targeting a new company has not created it yet;
    // set as soon as the destination company exists.
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    direction: text("direction").notNull(), // "export" | "import"
    status: text("status").notNull().default("pending"), // pending | running | applying | completed | failed | cancelled
    // The actor the run belongs to (board session / API key identity); run
    // visibility and resume are scoped to the same actor.
    actorKey: text("actor_key").notNull(),
    // Credential-free description of where the container lives (zip upload
    // reference or relay bucket/prefix). Secrets never land in this column.
    containerRef: jsonb("container_ref").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    manifestSha256: text("manifest_sha256"),
    // The parsed transfer manifest (chunk + blob index). Persisted so resume
    // can re-verify parts without refetching manifest.json first.
    manifest: jsonb("manifest"),
    chunkCount: integer("chunk_count").notNull().default(0),
    blobCount: integer("blob_count").notNull().default(0),
    // Container part names ("chunks/0000.json.gz", "blobs/<sha256>") that
    // completed processing, in completion order.
    completedParts: jsonb("completed_parts").notNull().default([]),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_transfer_runs_company_idx").on(table.companyId),
    idempotencyDirectionIdx: index("company_transfer_runs_idempotency_direction_idx").on(
      table.idempotencyKey,
      table.direction,
    ),
    actorStatusIdx: index("company_transfer_runs_actor_status_idx").on(table.actorKey, table.status),
  }),
);
