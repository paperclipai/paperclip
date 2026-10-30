ALTER TABLE "resource_lifecycle_events" DROP CONSTRAINT IF EXISTS "resource_lifecycle_events_resource_type_check";--> statement-breakpoint
ALTER TABLE "resource_lifecycle_events" DROP CONSTRAINT IF EXISTS "resource_lifecycle_events_action_check";--> statement-breakpoint
ALTER TABLE "resource_lifecycle_events" ADD CONSTRAINT "resource_lifecycle_events_resource_type_check" CHECK ("resource_lifecycle_events"."resource_type" IN ('agent', 'project', 'agent_runtime'));--> statement-breakpoint
ALTER TABLE "resource_lifecycle_events" ADD CONSTRAINT "resource_lifecycle_events_action_check" CHECK (("resource_lifecycle_events"."resource_type" = 'agent_runtime' AND "resource_lifecycle_events"."action" IN ('update', 'delete')) OR "resource_lifecycle_events"."action" = 'create' OR ("resource_lifecycle_events"."resource_type" = 'project' AND "resource_lifecycle_events"."action" IN ('update', 'archive', 'delete')) OR ("resource_lifecycle_events"."resource_type" = 'agent' AND "resource_lifecycle_events"."action" IN ('pause', 'resume', 'terminate')));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_record_agent_runtime(p_company uuid, p_agent uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE revision bigint;
BEGIN
  PERFORM 1 FROM agents WHERE company_id = p_company AND id = p_agent
    AND status NOT IN ('pending_approval', 'terminated') FOR UPDATE;
  IF FOUND THEN
    INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
      VALUES (p_company, 'agent_runtime', p_agent, 'update') RETURNING id INTO revision;
  END IF;
  RETURN revision;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_agent_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
      VALUES (OLD.company_id, 'agent_runtime', OLD.id, 'delete');
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND
    jsonb_build_array(OLD.name, OLD.role, OLD.title, OLD.capabilities, OLD.reports_to, OLD.adapter_type, OLD.adapter_config, OLD.runtime_config, OLD.default_environment_id, OLD.permissions, OLD.metadata, OLD.lifecycle_required_plugin_ids)
    IS NOT DISTINCT FROM
    jsonb_build_array(NEW.name, NEW.role, NEW.title, NEW.capabilities, NEW.reports_to, NEW.adapter_type, NEW.adapter_config, NEW.runtime_config, NEW.default_environment_id, NEW.permissions, NEW.metadata, NEW.lifecycle_required_plugin_ids)
    AND NOT (OLD.status = 'pending_approval' AND NEW.status <> 'pending_approval')
    AND NOT (NEW.lifecycle_state = 'ready' AND OLD.lifecycle_state <> 'ready') THEN
    RETURN NEW;
  END IF;
  PERFORM paperclip_record_agent_runtime(NEW.company_id, NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_runtime_changed ON agents;
CREATE TRIGGER paperclip_agent_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION paperclip_agent_runtime_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_agent_runtime_files_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE revision bigint;
BEGIN
  IF NEW.entity_type = 'agent' AND NEW.action IN ('agent.files_updated', 'agent.instructions_path_updated',
    'agent.instructions_bundle_updated', 'agent.instructions_file_updated', 'agent.instructions_file_deleted', 'plugin.managed_agent.reset') THEN
    revision := paperclip_record_agent_runtime(NEW.company_id, NEW.entity_id::uuid);
    NEW.details := coalesce(NEW.details, '{}'::jsonb) || jsonb_build_object('agentRuntimeRevision', revision::text);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_runtime_files_changed ON activity_log;
CREATE TRIGGER paperclip_agent_runtime_files_changed BEFORE INSERT ON activity_log
  FOR EACH ROW EXECUTE FUNCTION paperclip_agent_runtime_files_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_notify_plugin_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('paperclip_plugin_lifecycle', '');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_notify_plugin_lifecycle ON resource_lifecycle_events;
CREATE TRIGGER paperclip_notify_plugin_lifecycle AFTER INSERT ON resource_lifecycle_events
  FOR EACH ROW WHEN (NEW.resource_type = 'agent_runtime') EXECUTE FUNCTION paperclip_notify_plugin_lifecycle();
--> statement-breakpoint
INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
  SELECT company_id, 'agent_runtime', id, 'update' FROM agents a
  WHERE status NOT IN ('pending_approval', 'terminated') AND NOT EXISTS (
    SELECT 1 FROM resource_lifecycle_events e WHERE e.company_id = a.company_id AND e.resource_type = 'agent_runtime' AND e.resource_id = a.id);
