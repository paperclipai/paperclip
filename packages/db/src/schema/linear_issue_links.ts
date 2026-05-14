import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// Phase 2 of the Linear ↔ Paperclip ID Unification plan
// (onprem-k8s commit 9979d0d, .planning/linear-id-unification.md).
//
// One row per (paperclip issue, Linear issue) pair. Owned by paperclip;
// populated when the issue creation flow takes the Linear-issued path
// (companies.identifier_provider = 'linear'), or by an external sync
// process for issues that originated in Linear.
//
// Why a dedicated table instead of overloading plugin_entities (which
// already has a similar generic shape):
//
//   1. ON DELETE CASCADE from issues. plugin_entities.scope_id is text,
//      so a paperclip issue delete would orphan its plugin row. With
//      typed FKs we get cascade for free, which matters at the
//      tens-of-thousands-of-issues scale this is sized for.
//   2. Unique on paperclip_issue_id — exactly one Linear counterpart
//      per paperclip issue. Enforced at the DB layer, not in app code.
//   3. Unique on (company_id, linear_identifier) — also enforced at
//      the DB layer. Catches mis-syncs where the same Linear identifier
//      gets wired to two paperclip issues.
//   4. Unique on (company_id, linear_issue_id) — Linear's opaque UUID
//      is the natural webhook dedup key (linear_identifier can in
//      principle be reissued; the opaque id cannot). Backs
//      issueService.getByLinearIssueId on the inbound-webhook hot path
//      and serializes concurrent inserts at the DB across replicas.
//
// All UNIQUE indexes give O(log n) lookups in either direction
// without app-level dedupe logic.
export const linearIssueLinks = pgTable(
  "linear_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    paperclipIssueId: uuid("paperclip_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    /** Linear's opaque issue id (UUID-ish), used for API mutations. */
    linearIssueId: text("linear_issue_id").notNull(),
    /** Linear's human identifier (e.g. "BLO-12345"); also the value
     *  mirrored into issues.identifier when source = 'linear'. */
    linearIdentifier: text("linear_identifier").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    paperclipIssueUniqueIdx: uniqueIndex("linear_issue_links_paperclip_issue_idx").on(table.paperclipIssueId),
    companyLinearIdentifierUniqueIdx: uniqueIndex("linear_issue_links_company_linear_identifier_idx").on(
      table.companyId,
      table.linearIdentifier,
    ),
    companyLinearIssueIdUniqueIdx: uniqueIndex("linear_issue_links_company_linear_issue_id_idx").on(
      table.companyId,
      table.linearIssueId,
    ),
  }),
);
