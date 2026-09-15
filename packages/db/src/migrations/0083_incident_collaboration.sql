-- Incident Collaboration: Chat Messages + Activity Log (IUN-2911)
-- Adds real-time dispatcher chat and an immutable incident event log.

CREATE TABLE IF NOT EXISTS "incident_chat_messages" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "alert_id"    uuid NOT NULL REFERENCES "solaris_alerts"("id") ON DELETE CASCADE,
  "company_id"  uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "body"        text NOT NULL,
  "author_id"   text,
  "author_name" text,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "incident_chat_messages_alert_idx"
  ON "incident_chat_messages" ("alert_id", "created_at");

CREATE TABLE IF NOT EXISTS "incident_activity_log" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "alert_id"    uuid NOT NULL REFERENCES "solaris_alerts"("id") ON DELETE CASCADE,
  "company_id"  uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "event_type"  text NOT NULL,
  "actor_id"    text,
  "actor_name"  text,
  "metadata"    jsonb,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "incident_activity_log_alert_idx"
  ON "incident_activity_log" ("alert_id", "created_at");
