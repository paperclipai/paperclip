-- Phase 0.6: Event router (LISTEN/NOTIFY)
-- Replaces 80% of cron heartbeats with event-driven precise wakes

-- Adds event_processed flag to activity_log for durable replay on restart
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS event_processed boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS activity_log_event_processed_idx ON activity_log USING btree (event_processed) WHERE event_processed = false;

-- Event channel names
NOTIFY paperclip_events;
--> statement-breakpoint

-- Trigger function: emits compact NOTIFY payload {event_type, entity_id, txid}
CREATE OR REPLACE FUNCTION emit_event_notification()
RETURNS TRIGGER AS $$
DECLARE
  v_event_type text;
  v_entity_id text;
  v_payload text;
BEGIN
  v_event_type := TG_ARGV[0];
  v_entity_id := COALESCE(NEW.id::text, OLD.id::text);
  v_payload := jsonb_build_object(
    'event_type', v_event_type,
    'entity_id', v_entity_id,
    'txid', txid_current()
  )::text;
  PERFORM pg_notify('paperclip_events', v_payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Issues trigger: fires on INSERT, UPDATE (status/assignee changes)
DROP TRIGGER IF EXISTS trg_issues_event ON issues;
CREATE TRIGGER trg_issues_event
  AFTER INSERT OR UPDATE OF status, assignee_agent_id, priority ON issues
  FOR EACH ROW EXECUTE FUNCTION emit_event_notification('issue');

-- Issue comments trigger: fires on INSERT
DROP TRIGGER IF EXISTS trg_issue_comments_event ON issue_comments;
CREATE TRIGGER trg_issue_comments_event
  AFTER INSERT ON issue_comments
  FOR EACH ROW EXECUTE FUNCTION emit_event_notification('issue_comment');

-- Agents trigger: fires on UPDATE (status changes only)
DROP TRIGGER IF EXISTS trg_agents_event ON agents;
CREATE TRIGGER trg_agents_event
  AFTER UPDATE OF status, current_company_id ON agents
  FOR EACH ROW EXECUTE FUNCTION emit_event_notification('agent');

-- Function to replay unprocessed events from the last N minutes
-- Used on listener startup to recover events that fired during downtime
CREATE OR REPLACE FUNCTION replay_unprocessed_events(p_minutes integer DEFAULT 60)
RETURNS TABLE(id uuid, event_type text, entity_id text, txid bigint, created_at timestamptz) AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.action::text AS event_type,
    a.entity_id,
    (a.details->>'txid')::bigint AS txid,
    a.created_at
  FROM activity_log a
  WHERE a.event_processed = false
    AND a.created_at >= NOW() - (p_minutes || ' minutes')::interval
    AND a.action IN ('issue_created', 'issue_updated', 'issue_comment_created', 'agent_updated')
  ORDER BY a.created_at ASC;
END;
$$ LANGUAGE plpgsql;

-- Mark events as processed after the listener handles them
CREATE OR REPLACE FUNCTION mark_events_processed(p_event_ids uuid[])
RETURNS void AS $$
  UPDATE activity_log
  SET event_processed = true
  WHERE id = ANY(p_event_ids);
$$ LANGUAGE sql;