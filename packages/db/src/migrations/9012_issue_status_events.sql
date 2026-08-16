-- TSMC-20879: durable status-transition history (operator directive 2026-08-16).
-- Populated by a DATABASE TRIGGER, not per-call-site instrumentation: 61+ code
-- paths update issues.status across 8 services, and any missed site would make
-- closure counts silently wrong again (the 2026-08-15 updated_at-proxy defect
-- inflated closures 25%). The trigger catches every writer, including future ones.
CREATE TABLE IF NOT EXISTS "issue_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_status_events_issue_idx" ON "issue_status_events" ("issue_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_status_events_company_idx" ON "issue_status_events" ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_status_events_to_status_idx" ON "issue_status_events" ("company_id","to_status","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_issue_status_event() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO issue_status_events (company_id, issue_id, from_status, to_status)
    VALUES (NEW.company_id, NEW.id, NULL, NEW.status);
  ELSIF (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status) THEN
    INSERT INTO issue_status_events (company_id, issue_id, from_status, to_status)
    VALUES (NEW.company_id, NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS issue_status_event_trigger ON issues;
--> statement-breakpoint
CREATE TRIGGER issue_status_event_trigger
AFTER INSERT OR UPDATE OF status ON issues
FOR EACH ROW EXECUTE FUNCTION record_issue_status_event();
