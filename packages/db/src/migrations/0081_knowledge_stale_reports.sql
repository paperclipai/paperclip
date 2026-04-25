-- Migration: knowledge_stale_reports table for Phase K.3c stale-pressure valve
-- Parent issue: KIT-3607 (Phase K.3c - Stale-pressure valve)
-- Tracks audit of [KNOWLEDGE-STALE] reports from agents

CREATE TABLE IF NOT EXISTS knowledge_stale_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_slug text NOT NULL,
  agent_id uuid NOT NULL,
  agent_name text NOT NULL,
  issue_link text NOT NULL,
  company_id uuid NOT NULL,
  priority text NOT NULL DEFAULT 'medium',
  trigger text NOT NULL DEFAULT 'agent_stale_report',
  resolution_status text NOT NULL DEFAULT 'pending',
  resolution_detail text,
  crawl_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS knowledge_stale_reports_topic_slug_idx ON knowledge_stale_reports(topic_slug);
CREATE INDEX IF NOT EXISTS knowledge_stale_reports_agent_id_idx ON knowledge_stale_reports(agent_id);
CREATE INDEX IF NOT EXISTS knowledge_stale_reports_company_id_idx ON knowledge_stale_reports(company_id);
CREATE INDEX IF NOT EXISTS knowledge_stale_reports_resolution_status_idx ON knowledge_stale_reports(resolution_status);
CREATE INDEX IF NOT EXISTS knowledge_stale_reports_created_at_idx ON knowledge_stale_reports(created_at);

CREATE TRIGGER update_knowledge_stale_reports_updated_at
  BEFORE UPDATE ON knowledge_stale_reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
