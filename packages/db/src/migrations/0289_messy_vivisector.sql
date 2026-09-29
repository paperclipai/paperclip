CREATE TABLE "deployment_resources" (
	"owner" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"company_id" uuid,
	"fields" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_resources_identity" ON "deployment_resources" USING btree ("owner","kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_resources_resource" ON "deployment_resources" USING btree ("kind","resource_id");
--> statement-breakpoint
CREATE FUNCTION paperclip_deployment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  binding deployment_resources%ROWTYPE;
  field text;
  column_name text;
BEGIN
  IF current_setting('paperclip.deployment_apply', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO binding FROM deployment_resources
    WHERE kind = TG_ARGV[0] AND resource_id = OLD.id;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Declaratively owned resources cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_ARGV[0] = 'secret' AND
    (to_jsonb(NEW) - ARRAY['last_resolved_at', 'updated_at', 'status']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['last_resolved_at', 'updated_at', 'status']) THEN
    RAISE EXCEPTION 'Declaratively owned secret cannot be changed' USING ERRCODE = '23514';
  END IF;
  FOR field IN SELECT jsonb_object_keys(binding.fields) LOOP
    column_name := lower(regexp_replace(field, '([A-Z])', '_\1', 'g'));
    IF (to_jsonb(NEW)->column_name) IS DISTINCT FROM (to_jsonb(OLD)->column_name) THEN
      RAISE EXCEPTION 'Declaratively owned field cannot be changed' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NOT binding.enabled AND TG_ARGV[0] IN ('agent', 'company', 'routine')
    AND (to_jsonb(NEW)->>'status') NOT IN ('paused', 'terminated', 'archived') THEN
    RAISE EXCEPTION 'Declaratively disabled resource cannot be resumed' USING ERRCODE = '23514';
  END IF;
  IF NOT binding.enabled AND (
    (TG_ARGV[0] = 'schedule' AND to_jsonb(NEW)->>'enabled' = 'true') OR
    (TG_ARGV[0] = 'secret' AND to_jsonb(NEW)->>'status' = 'active') OR
    (TG_ARGV[0] = 'taskBridge' AND to_jsonb(NEW)->>'revoked_at' IS NULL)
  ) THEN
    RAISE EXCEPTION 'Declaratively disabled resource cannot be resumed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON companies FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('company');
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('project');
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON project_workspaces FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('workspace');
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON agents FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('agent');
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON routines FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('routine');
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON routine_triggers FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('schedule');
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON agent_api_keys FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('taskBridge');
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON company_secrets FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_guard('secret');
--> statement-breakpoint
CREATE FUNCTION paperclip_deployment_secret_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('paperclip.deployment_apply', true) IS DISTINCT FROM 'on' AND EXISTS (
    SELECT 1 FROM deployment_resources WHERE kind = 'secret' AND
      resource_id IN (CASE WHEN TG_OP <> 'DELETE' THEN NEW.secret_id END, CASE WHEN TG_OP <> 'INSERT' THEN OLD.secret_id END)
  ) THEN
    RAISE EXCEPTION 'Declaratively owned secret versions cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deployment_guard BEFORE INSERT OR UPDATE OR DELETE ON company_secret_versions FOR EACH ROW EXECUTE FUNCTION paperclip_deployment_secret_version_guard();
