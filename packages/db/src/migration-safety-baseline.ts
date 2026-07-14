export type MigrationSafetyBaselineEntry = {
  readonly id: string;
  readonly rule: string;
  readonly migration: string;
  readonly table: string;
  readonly reason: string;
};

export const MIGRATION_SAFETY_BASELINE = [
  {
    id: "2cfa16c89e561306",
    rule: "large-create-index-not-concurrently",
    migration: "0000_mature_masked_marvel.sql",
    table: "activity_log",
    reason: "Initial schema history predates the migration-safety guard.",
  },
  {
    id: "2e21c87a27d0ecf3",
    rule: "large-create-index-not-concurrently",
    migration: "0000_mature_masked_marvel.sql",
    table: "issue_comments",
    reason: "Initial schema history predates the migration-safety guard.",
  },
  {
    id: "3fa7b338f437c89d",
    rule: "large-create-index-not-concurrently",
    migration: "0000_mature_masked_marvel.sql",
    table: "issue_comments",
    reason: "Initial schema history predates the migration-safety guard.",
  },
  {
    id: "26bf13d0e36e3bd0",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "agent_wakeup_requests",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "da73c844de91f262",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "agent_wakeup_requests",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "b86e70ea500d5d9e",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "agent_wakeup_requests",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "d12aeab5a11d37fe",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "heartbeat_run_events",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "80d2cc53747b47bc",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "heartbeat_run_events",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "8985fd1ec26c0449",
    rule: "large-create-index-not-concurrently",
    migration: "0001_fast_northstar.sql",
    table: "heartbeat_run_events",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "06065c3f2e8bca76",
    rule: "large-create-index-not-concurrently",
    migration: "0003_shallow_quentin_quire.sql",
    table: "activity_log",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "d0cb536e5b329013",
    rule: "large-create-index-not-concurrently",
    migration: "0003_shallow_quentin_quire.sql",
    table: "activity_log",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "b84802ae05be9943",
    rule: "large-create-index-not-concurrently",
    migration: "0024_far_beast.sql",
    table: "issue_comments",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "3eaba6ddfa29a678",
    rule: "large-create-index-not-concurrently",
    migration: "0024_far_beast.sql",
    table: "issue_comments",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "2874b94c3f294f53",
    rule: "large-create-index-not-concurrently",
    migration: "0051_young_korg.sql",
    table: "issue_comments",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "f0a44a3401b28d62",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "f1fbb786a033df8d",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "f74aa7dfb0152788",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "3c1237481d6ee00d",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "21cf0a7bb66a4058",
    rule: "large-create-index-not-concurrently",
    migration: "0060_orange_annihilus.sql",
    table: "issue_reference_mentions",
    reason: "Historical migration predates the migration-safety guard.",
  },
  {
    id: "567b97176f9f06c3",
    rule: "large-create-index-not-concurrently",
    migration: "0132_issue_comment_derived_attribution_fast.sql",
    table: "issue_comments",
    reason: "Existing issue-attribution backfill branch uses a temporary support index before this guard landed.",
  },
  {
    id: "38d8055cc228913d",
    rule: "full-table-mutation-large-table",
    migration: "0132_issue_comment_derived_attribution_fast.sql",
    table: "issue_comments",
    reason: "Batched DO-loop backfill with keyset pagination (LIMIT 5000 per batch); reviewed and approved as part of PAP-1505 fix. Already merged to master before this guard landed.",
  },
] as const satisfies readonly MigrationSafetyBaselineEntry[];
