ALTER TABLE "execution_admissions" ADD COLUMN IF NOT EXISTS "admitted_project_ids" uuid[];--> statement-breakpoint
-- Unsettled charges are still the complete admitted set. Settled rows already lost theirs and stay unknown (null).
UPDATE "execution_admissions" AS "admission" SET "admitted_project_ids" = coalesce((
  SELECT array_agg("charge"."project_id" ORDER BY "charge"."project_id") FROM "execution_admission_project_charges" AS "charge"
  WHERE "charge"."company_id" = "admission"."company_id" AND "charge"."admission_id" = "admission"."id"
), '{}'::uuid[]) WHERE "admission"."settled_at" IS NULL AND "admission"."admitted_project_ids" IS NULL;--> statement-breakpoint
ALTER TABLE "execution_admissions" DROP CONSTRAINT IF EXISTS "execution_admissions_project_set_check";--> statement-breakpoint
ALTER TABLE "execution_admissions" ADD CONSTRAINT "execution_admissions_project_set_check" CHECK (case when "execution_admissions"."admitted_project_ids" is null
    then "execution_admissions"."settled_at" is not null else array_position("execution_admissions"."admitted_project_ids", null) is null and cardinality("execution_admissions"."admitted_project_ids") <= 100 end);--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_execution_admission_project_set_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.admitted_project_ids IS DISTINCT FROM OLD.admitted_project_ids THEN
    RAISE EXCEPTION 'execution admission project set is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_execution_admission_project_set_immutable ON "execution_admissions";--> statement-breakpoint
CREATE TRIGGER paperclip_execution_admission_project_set_immutable BEFORE UPDATE OF admitted_project_ids ON "execution_admissions"
FOR EACH ROW EXECUTE FUNCTION paperclip_execution_admission_project_set_immutable();
