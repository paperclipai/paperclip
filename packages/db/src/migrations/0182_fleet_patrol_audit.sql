CREATE TABLE IF NOT EXISTS "fleet_patrol_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "authenticated_agent_id" uuid NOT NULL,
  "authenticated_run_id" uuid NOT NULL,
  "api_key_id" text,
  "credential_id" text NOT NULL,
  "operation" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "outcome" text NOT NULL,
  "reason_code" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "fleet_patrol_audit_company_created_idx"
  ON "fleet_patrol_audit" USING btree ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "fleet_patrol_audit_run_created_idx"
  ON "fleet_patrol_audit" USING btree ("authenticated_run_id", "created_at");
CREATE INDEX IF NOT EXISTS "fleet_patrol_audit_target_created_idx"
  ON "fleet_patrol_audit" USING btree ("target_type", "target_id", "created_at");

CREATE OR REPLACE FUNCTION paperclip_reject_fleet_patrol_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fleet_patrol_audit is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS fleet_patrol_audit_reject_row_mutation ON "fleet_patrol_audit";
CREATE TRIGGER fleet_patrol_audit_reject_row_mutation
  BEFORE UPDATE OR DELETE ON "fleet_patrol_audit"
  FOR EACH ROW EXECUTE FUNCTION paperclip_reject_fleet_patrol_audit_mutation();

DROP TRIGGER IF EXISTS fleet_patrol_audit_reject_truncate ON "fleet_patrol_audit";
CREATE TRIGGER fleet_patrol_audit_reject_truncate
  BEFORE TRUNCATE ON "fleet_patrol_audit"
  FOR EACH STATEMENT EXECUTE FUNCTION paperclip_reject_fleet_patrol_audit_mutation();
