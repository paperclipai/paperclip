import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Merged-PR ↔ issue linkage for the fleet $/merged-output metric
 * (BLO-9117 / BLO-9102 Diff 2). This is the storage the GitHub webhook never
 * had: the webhook only *woke* the assignee, it never persisted that a PR
 * merged against an issue.
 *
 * Identity hard-guard (operator note 2026-06-05): agent merged-PRs span ≥2
 * GitHub identities (kkroo, app/allyblockcast, app/blockcast-ci-packages).
 * Keying the join on PR author silently drops whole identity buckets — the
 * BLO-9103 floor bug. So the link key is the `BLO-####` ref (branch/title/body)
 * captured in `linkSource`, and there is DELIBERATELY no `prAuthor` column:
 * a filter that cannot reference author cannot accidentally reintroduce the
 * author-scoped drop. The unique key is (companyId, repoFullName, prNumber).
 *
 * Cost is NOT denormalized here — it stays in `cost_events`, joined per issue.
 */
export const issuePullRequests = pgTable(
  "issue_pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    // Nullable until attributed. A merged PR with no resolvable BLO- ref is
    // stored with a null issueId and counted toward the option-(C) coverage
    // denominator — surfaced as unattributed, never silently dropped.
    issueId: uuid("issue_id").references(() => issues.id),
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    // Raw figures straight from the PR payload (contamination-inclusive).
    additions: integer("additions"),
    deletions: integer("deletions"),
    // Generated-paths-excluded figures, filled by the files-fetch enrichment.
    // Null until enrichment runs (see locEnrichedAt).
    authoredAdditions: integer("authored_additions"),
    authoredDeletions: integer("authored_deletions"),
    // Audit trail of what the authored figure dropped and why (rule id per path).
    excludedPaths: jsonb("excluded_paths").$type<
      Array<{ path: string; ruleId: string; additions: number; deletions: number }>
    >(),
    // branch_ref | title_ref | body_ref | reconciler | manual.
    // How the issue link was established — NOT the PR author.
    linkSource: text("link_source"),
    // The BLO- identifier the PR text carried (metadata / coverage audit). Null
    // for the unattributed tail.
    paperclipIdentifier: text("paperclip_identifier"),
    // Set when the authored-LOC enrichment has run; null means pending so the
    // reconciler knows what still needs a pulls/{n}/files fetch.
    locEnrichedAt: timestamp("loc_enriched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    repoPrUnique: uniqueIndex("issue_pull_requests_repo_pr_unique").on(
      table.companyId,
      table.repoFullName,
      table.prNumber,
    ),
    companyIssueIdx: index("issue_pull_requests_company_issue_idx").on(table.companyId, table.issueId),
    companyMergedIdx: index("issue_pull_requests_company_merged_idx").on(table.companyId, table.mergedAt),
    enrichPendingIdx: index("issue_pull_requests_enrich_pending_idx").on(table.locEnrichedAt),
  }),
);
