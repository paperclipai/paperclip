-- AGNB migration 0001 — recreate Supabase relations missing from the base-table
-- data backup (views hold no rows; pipeline_move_log was created post-backup).
-- Schema-qualified to `agnb`. Idempotent. See docs/migration/AGNB_CONSOLIDATION.md §8.

CREATE SCHEMA IF NOT EXISTS agnb;

-- ── pipeline_move_log (table) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agnb.pipeline_move_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id text NOT NULL,
  from_stage_id text,
  to_stage_id text NOT NULL,
  from_stage_label text,
  to_stage_label text,
  moved_by text,
  moved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_move_log_deal_at
  ON agnb.pipeline_move_log (deal_id, moved_at DESC);

-- ── restore unique constraints the data backup dropped (needed for upserts) ──
-- The JSON backup load kept only primary keys; ON CONFLICT targets in the
-- ported routes/jobs need these unique indexes or the upsert throws at runtime.
CREATE UNIQUE INDEX IF NOT EXISTS rss_items_url_key ON agnb.rss_items (url);
CREATE UNIQUE INDEX IF NOT EXISTS gsc_rank_data_uniq ON agnb.gsc_rank_data (blog_url, query, capture_date);
CREATE UNIQUE INDEX IF NOT EXISTS backlink_prospects_uniq ON agnb.backlink_prospects (source_domain, referring_to);
CREATE UNIQUE INDEX IF NOT EXISTS positive_signal_uniq ON agnb.positive_signal (lead_email, thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS crm_hygiene_issues_uniq ON agnb.crm_hygiene_issues (hubspot_object_type, hubspot_object_id, issue_type);
CREATE UNIQUE INDEX IF NOT EXISTS content_audit_issues_uniq ON agnb.content_audit_issues (blog_path, issue_type);
CREATE UNIQUE INDEX IF NOT EXISTS daily_metrics_snapshots_uniq ON agnb.daily_metrics_snapshots (snapshot_date);
CREATE UNIQUE INDEX IF NOT EXISTS content_gaps_uniq ON agnb.content_gaps (topic);
CREATE UNIQUE INDEX IF NOT EXISTS work_items_uniq ON agnb.work_items (kind, ref_table, ref_id);
CREATE UNIQUE INDEX IF NOT EXISTS utm_hygiene_issues_uniq ON agnb.utm_hygiene_issues (source_kind, source_id, url);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_groups_jid_uniq ON agnb.whatsapp_groups (jid);

-- ── bucket_rollup (view) — live signal from Rocket campaign mirror ────────────
DROP VIEW IF EXISTS agnb.bucket_rollup;
CREATE VIEW agnb.bucket_rollup AS
SELECT
  b.id                                                     AS bucket_id,
  COALESCE(SUM(c.sent_count), 0)::bigint                   AS total_sent,
  COALESCE(SUM(c.open_count), 0)::bigint                   AS total_opens,
  COALESCE(SUM(c.reply_count), 0)::bigint                  AS total_replies,
  COALESCE(SUM(c.meeting_count), 0)::bigint                AS total_meetings,
  CASE WHEN COALESCE(SUM(c.sent_count), 0) > 0
       THEN SUM(c.reply_count)::numeric / SUM(c.sent_count)
       ELSE NULL END                                       AS compound_reply_rate,
  CASE WHEN COALESCE(SUM(c.sent_count), 0) > 0
       THEN SUM(c.open_count)::numeric / SUM(c.sent_count)
       ELSE NULL END                                       AS compound_open_rate,
  CASE WHEN COALESCE(SUM(c.sent_count), 0) > 0
       THEN SUM(c.meeting_count)::numeric / SUM(c.sent_count)
       ELSE NULL END                                       AS compound_meeting_rate,
  COUNT(DISTINCT c.id)::int                                AS campaigns_run,
  MAX(c.synced_at)                                         AS last_sync_at
FROM agnb.experiment_buckets b
LEFT JOIN agnb.campaign_drafts cd ON cd.bucket_id = b.id
LEFT JOIN agnb.rocket_campaigns c ON c.id = cd.rocket_campaign_id
GROUP BY b.id;
