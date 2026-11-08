-- Environment requirements use the same durable runtime journal as explicit skill assignments.
CREATE OR REPLACE FUNCTION paperclip_environment_selects_runtime_skill(p_company uuid, p_environment uuid, p_skill uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM environments e
    JOIN plugins p ON p.plugin_key = e.config->>'pluginKey'
    JOIN plugin_managed_resources r ON r.plugin_id = p.id AND r.company_id = p_company
      AND r.resource_kind = 'skill' AND r.resource_id = p_skill
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.manifest_json->'environmentDrivers', '[]'::jsonb)) AS declared_driver(value)
    WHERE e.id = coalesce(p_environment, (SELECT default_environment_id FROM instance_settings LIMIT 1))
      AND e.driver = 'plugin' AND declared_driver.value->>'driverKey' = e.config->>'driverKey'
      AND coalesce(declared_driver.value->'skillKeys', '[]'::jsonb) ? r.resource_key);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_skill_source_runtimes(p_company uuid, sources uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = p_company
    AND a.status NOT IN ('pending_approval', 'terminated') AND EXISTS (
      SELECT 1 FROM company_skills s WHERE s.company_id = p_company AND s.access_source_id = ANY(sources)
        AND (paperclip_agent_selects_runtime_skill(a.adapter_config, a.adapter_type, s.key, s.slug)
          OR paperclip_environment_selects_runtime_skill(p_company, a.default_environment_id, s.id)))
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
        WHERE lower(trim(CASE WHEN jsonb_typeof(choice) = 'string' THEN choice#>>'{}' ELSE choice->>'key' END)) = ANY(keys))
      OR paperclip_environment_selects_runtime_skill(company, a.default_environment_id, coalesce((current->>'id')::uuid, (previous->>'id')::uuid)))
    ORDER BY a.id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(company, candidate);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_environment_runtimes_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous jsonb; current jsonb; candidate record;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'plugin_company_settings' THEN
    IF coalesce((previous->>'enabled')::boolean, true) IS NOT DISTINCT FROM coalesce((current->>'enabled')::boolean, true) THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND (CASE TG_TABLE_NAME
    WHEN 'environments' THEN previous->'config' IS NOT DISTINCT FROM current->'config' AND previous->'driver' IS NOT DISTINCT FROM current->'driver'
    WHEN 'plugins' THEN previous->'manifest_json' IS NOT DISTINCT FROM current->'manifest_json' AND previous->'status' IS NOT DISTINCT FROM current->'status'
    ELSE previous->'default_environment_id' IS NOT DISTINCT FROM current->'default_environment_id' END) THEN RETURN NEW; END IF;
  FOR candidate IN SELECT a.id, a.company_id FROM agents a
    WHERE a.status NOT IN ('pending_approval', 'terminated') AND (CASE TG_TABLE_NAME
      WHEN 'environments' THEN coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
        = coalesce((current->>'id')::uuid, (previous->>'id')::uuid)
      WHEN 'plugins' THEN EXISTS (SELECT 1 FROM environments e
        WHERE e.id = coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
          AND e.driver = 'plugin' AND e.config->>'pluginKey' = coalesce(current->>'plugin_key', previous->>'plugin_key'))
      WHEN 'plugin_company_settings' THEN a.company_id = coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid)
        AND EXISTS (SELECT 1 FROM environments e JOIN plugins p ON p.plugin_key = e.config->>'pluginKey'
          WHERE e.id = coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
            AND e.driver = 'plugin' AND p.id = coalesce((current->>'plugin_id')::uuid, (previous->>'plugin_id')::uuid))
      ELSE a.default_environment_id IS NULL END)
    ORDER BY a.company_id, a.id FOR NO KEY UPDATE OF a LOOP
    PERFORM paperclip_record_agent_runtime(candidate.company_id, candidate.id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paperclip_environment_runtime_changed AFTER INSERT OR UPDATE ON environments
  FOR EACH ROW EXECUTE FUNCTION paperclip_environment_runtimes_changed();
--> statement-breakpoint
CREATE TRIGGER paperclip_plugin_environment_runtime_changed AFTER UPDATE ON plugins
  FOR EACH ROW EXECUTE FUNCTION paperclip_environment_runtimes_changed();
--> statement-breakpoint
CREATE TRIGGER paperclip_plugin_company_environment_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON plugin_company_settings
  FOR EACH ROW EXECUTE FUNCTION paperclip_environment_runtimes_changed();
--> statement-breakpoint
CREATE TRIGGER paperclip_default_environment_runtime_changed AFTER UPDATE ON instance_settings
  FOR EACH ROW EXECUTE FUNCTION paperclip_environment_runtimes_changed();
