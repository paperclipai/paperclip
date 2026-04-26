-- Migration: knowledge_rss_watch_state table for Phase K.3a RSS/Changelog watchers
-- Parent issue: KIT-3604 (Phase K.3a - Change detection watchers)
-- Tracks RSS feed polling state for change detection

CREATE TABLE IF NOT EXISTS knowledge_rss_watch_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url text NOT NULL UNIQUE,
  topic_slug text NOT NULL,
  feed_type text NOT NULL DEFAULT 'rss'
    CHECK (feed_type IN ('rss', 'changelog', 'github_release')),
  last_etag text,
  last_modified text,
  last_item_hashes jsonb NOT NULL DEFAULT '[]',
  last_checked_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_rss_watch_state_source_url_idx ON knowledge_rss_watch_state(source_url);
CREATE INDEX IF NOT EXISTS knowledge_rss_watch_state_topic_slug_idx ON knowledge_rss_watch_state(topic_slug);
CREATE INDEX IF NOT EXISTS knowledge_rss_watch_state_feed_type_idx ON knowledge_rss_watch_state(feed_type);
CREATE INDEX IF NOT EXISTS knowledge_rss_watch_state_last_checked_at_idx ON knowledge_rss_watch_state(last_checked_at);

CREATE TRIGGER update_knowledge_rss_watch_state_updated_at
  BEFORE UPDATE ON knowledge_rss_watch_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
