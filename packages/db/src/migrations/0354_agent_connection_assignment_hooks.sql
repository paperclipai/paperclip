CREATE OR REPLACE FUNCTION paperclip_record_agent_runtime(p_company uuid, p_agent uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE revision bigint;
BEGIN
  PERFORM 1 FROM agents WHERE company_id = p_company AND id = p_agent
    AND status NOT IN ('pending_approval', 'terminated') FOR NO KEY UPDATE;
  IF FOUND THEN
    INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
      VALUES (p_company, 'agent_runtime', p_agent, 'update') RETURNING id INTO revision;
  END IF;
  RETURN revision;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_company_agent_runtimes(p_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  FOR candidate IN SELECT id FROM agents WHERE company_id = p_company
    AND status NOT IN ('pending_approval', 'terminated') ORDER BY id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_skill_source_runtimes(p_company uuid, sources uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = p_company
    AND a.status NOT IN ('pending_approval', 'terminated') AND EXISTS (
      SELECT 1 FROM company_skills s WHERE s.company_id = p_company AND s.access_source_id = ANY(sources)
        AND paperclip_agent_selects_runtime_skill(a.adapter_config, a.adapter_type, s.key, s.slug))
    ORDER BY a.id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_skill_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous jsonb; current jsonb; keys text[]; company uuid; candidate uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND
    jsonb_build_array(OLD.key, OLD.slug, OLD.markdown, OLD.source_type, OLD.source_locator, OLD.source_ref,
      OLD.file_inventory, OLD.current_version_id, OLD.access_source_id, OLD.compatibility, OLD.trust_level, OLD.metadata)
    IS NOT DISTINCT FROM
    jsonb_build_array(NEW.key, NEW.slug, NEW.markdown, NEW.source_type, NEW.source_locator, NEW.source_ref,
      NEW.file_inventory, NEW.current_version_id, NEW.access_source_id, NEW.compatibility, NEW.trust_level, NEW.metadata)
    THEN RETURN NEW; END IF;
  company := coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid);
  SELECT array_agg(DISTINCT lower(reference)) INTO keys FROM (
    SELECT row->>'key' AS reference FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT regexp_replace(row->>'key', '.*/', '') FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT CASE WHEN row->>'key' LIKE 'paperclipai/paperclip/%' THEN row->>'slug'
      ELSE (row->>'slug') || '--' || left(encode(sha256(convert_to(row->>'key', 'UTF8')), 'hex'), 10) END
      FROM unnest(ARRAY[previous, current]) row
  ) refs WHERE reference IS NOT NULL;
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = company
    AND a.status NOT IN ('pending_approval', 'terminated') AND (
      (a.adapter_type <> 'paperclip_runner' AND keys && ARRAY['paperclipai/paperclip/paperclip', 'paperclipai/paperclip/complain', 'paperclipai/paperclip/suggestion-box']) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.adapter_config#>'{paperclipSkillSync,desiredSkills}') = 'array'
        THEN a.adapter_config#>'{paperclipSkillSync,desiredSkills}' ELSE '[]'::jsonb END) choice
        WHERE lower(trim(CASE WHEN jsonb_typeof(choice) = 'string' THEN choice#>>'{}' ELSE choice->>'key' END)) = ANY(keys)))
    ORDER BY a.id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(company, candidate);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_connector_agent(p_company uuid, p_agent uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE setting text := 'paperclip.runtime_agent_' || replace(p_agent::text, '-', '_'); xid text := pg_current_xact_id()::text;
BEGIN
  IF current_setting('paperclip.runtime_' || replace(p_company::text, '-', '_'), true) IS NOT DISTINCT FROM xid
    OR current_setting(setting, true) IS NOT DISTINCT FROM xid THEN RETURN; END IF;
  PERFORM paperclip_record_agent_runtime(p_company, p_agent);
  PERFORM set_config(setting, xid, true);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_connector_company(p_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE setting text := 'paperclip.runtime_' || replace(p_company::text, '-', '_'); xid text := pg_current_xact_id()::text; candidate uuid;
BEGIN
  IF current_setting(setting, true) IS NOT DISTINCT FROM xid THEN RETURN; END IF;
  FOR candidate IN SELECT id FROM agents WHERE company_id = p_company
    AND status NOT IN ('pending_approval', 'terminated') ORDER BY id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_invalidate_connector_agent(p_company, candidate);
  END LOOP;
  PERFORM set_config(setting, xid, true);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid; query text; old_projection text; new_projection text; target record; candidate uuid;
BEGIN
  IF TG_TABLE_NAME = 'tool_profiles' AND TG_OP = 'INSERT' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT 'jsonb_build_array(' || string_agg(format('to_jsonb(o)->%L', field), ',') || ')',
      'jsonb_build_array(' || string_agg(format('to_jsonb(n)->%L', field), ',') || ')'
      INTO old_projection, new_projection FROM unnest(TG_ARGV[1:TG_NARGS - 1]) field;
  END IF;
  IF TG_TABLE_NAME IN ('tool_profile_bindings', 'tool_connection_installs') THEN
    IF TG_OP = 'INSERT' THEN query := 'SELECT company_id, target_type, target_id FROM new_rows';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT company_id, target_type, target_id FROM old_rows';
    ELSE query := format('WITH changed AS (
      SELECT o.company_id AS old_company, o.target_type AS old_type, o.target_id AS old_target,
        n.company_id AS new_company, n.target_type AS new_type, n.target_id AS new_target
      FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I WHERE %s IS DISTINCT FROM %s)
      SELECT old_company AS company_id, old_type AS target_type, old_target AS target_id FROM changed WHERE old_company IS NOT NULL UNION
      SELECT new_company AS company_id, new_type AS target_type, new_target AS target_id FROM changed WHERE new_company IS NOT NULL',
      TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
    END IF;
    FOR target IN EXECUTE 'SELECT DISTINCT company_id, target_type, target_id FROM (' || query || ') targets
      WHERE target_type IN (''agent'', ''company'')
      ORDER BY company_id, target_type DESC, target_id' LOOP
      IF target.target_type = 'company' AND target.target_id = target.company_id::text THEN
        PERFORM paperclip_invalidate_connector_company(target.company_id);
      ELSIF target.target_type = 'agent' AND target.target_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        SELECT id INTO candidate FROM agents WHERE company_id = target.company_id AND id = target.target_id::uuid;
        IF FOUND THEN PERFORM paperclip_invalidate_connector_agent(target.company_id, candidate); END IF;
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id FROM new_rows ORDER BY company_id';
  ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id FROM old_rows ORDER BY company_id';
  ELSE
    query := format('WITH changed AS (
      SELECT o.company_id AS old_company, n.company_id AS new_company FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I
      WHERE %s IS DISTINCT FROM %s)
      SELECT old_company AS company_id FROM changed WHERE old_company IS NOT NULL UNION
      SELECT new_company AS company_id FROM changed WHERE new_company IS NOT NULL ORDER BY company_id', TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
  END IF;
  FOR company IN EXECUTE query LOOP
    PERFORM paperclip_invalidate_connector_company(company);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE relation text; arguments text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['tool_connections', 'tool_connection_installs', 'tool_profiles', 'tool_profile_bindings'] LOOP
    arguments := CASE relation
      WHEN 'tool_connections' THEN '''id'', ''company_id'', ''name'', ''transport'', ''enabled'', ''status'''
      WHEN 'tool_connection_installs' THEN '''id'', ''company_id'', ''connection_id'', ''target_type'', ''target_id'''
      WHEN 'tool_profiles' THEN '''id'', ''company_id'', ''status'''
      ELSE '''id'', ''company_id'', ''profile_id'', ''target_type'', ''target_id''' END;
    EXECUTE format('DROP TRIGGER IF EXISTS paperclip_connector_runtime_insert ON %I', relation);
    EXECUTE format('DROP TRIGGER IF EXISTS paperclip_connector_runtime_update ON %I', relation);
    EXECUTE format('DROP TRIGGER IF EXISTS paperclip_connector_runtime_delete ON %I', relation);
    EXECUTE format('CREATE TRIGGER paperclip_connector_runtime_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_connector_runtime_changed(%s)', relation, arguments);
    EXECUTE format('CREATE TRIGGER paperclip_connector_runtime_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_connector_runtime_changed(%s)', relation, arguments);
    EXECUTE format('CREATE TRIGGER paperclip_connector_runtime_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_connector_runtime_changed(%s)', relation, arguments);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_flags_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid; previous jsonb := coalesce(to_jsonb(OLD)->'experimental', '{}'::jsonb);
  current jsonb := coalesce(to_jsonb(NEW)->'experimental', '{}'::jsonb);
BEGIN
  IF jsonb_build_array(coalesce(previous->'enablePublicMcp', 'false'::jsonb), coalesce(previous->'enableChatConnectors', 'false'::jsonb))
    IS DISTINCT FROM jsonb_build_array(coalesce(current->'enablePublicMcp', 'false'::jsonb), coalesce(current->'enableChatConnectors', 'false'::jsonb)) THEN
    FOR company IN SELECT DISTINCT company_id FROM agents ORDER BY company_id LOOP
      PERFORM paperclip_invalidate_connector_company(company);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_connector_flags_runtime_changed ON instance_settings;
CREATE TRIGGER paperclip_connector_flags_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON instance_settings
  FOR EACH ROW EXECUTE FUNCTION paperclip_connector_flags_runtime_changed();
