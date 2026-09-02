-- Drop the cloud sync (cloud upstream) tables. The host-to-host transport
-- has been removed in favor of the Import/Export flow, and nothing reads or
-- writes these tables any more. The sender tables (connections, runs) came
-- from 0089; the receiver-side tables never shipped, so these two are all
-- that exist. The feature was experimental and flag-gated off by default,
-- so its run history is intentionally discarded.
DROP TABLE IF EXISTS "cloud_upstream_runs";
--> statement-breakpoint
DROP TABLE IF EXISTS "cloud_upstream_connections";
