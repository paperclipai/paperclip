CREATE OR REPLACE FUNCTION paperclip_connector_policy_targets(p_company uuid, selectors jsonb)
RETURNS TABLE(target_type text, target_id text)
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE single_agent text := CASE WHEN jsonb_typeof(selectors->'agentId') = 'string' THEN nullif(selectors->>'agentId', '') END;
  many_agents text[];
  trim_chars text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  SELECT array_agg(value#>>'{}') INTO many_agents
    FROM jsonb_array_elements(CASE jsonb_typeof(selectors->'agentIds')
      WHEN 'array' THEN selectors->'agentIds'
      WHEN 'string' THEN jsonb_build_array(btrim(selectors->>'agentIds', trim_chars)) ELSE '[]'::jsonb END) value
    WHERE jsonb_typeof(value) = 'string' AND btrim(value#>>'{}', trim_chars) <> '';
  IF single_agent IS NOT NULL THEN
    IF coalesce(cardinality(many_agents), 0) = 0 OR single_agent = ANY(many_agents) THEN
      RETURN QUERY SELECT 'agent'::text, single_agent;
    END IF;
  ELSIF coalesce(cardinality(many_agents), 0) > 0 THEN
    RETURN QUERY SELECT 'agent'::text, unnest(many_agents);
  ELSE
    RETURN QUERY SELECT 'company'::text, p_company::text;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid; query text; target record; candidate uuid;
  old_projection text := '(to_jsonb(o) - $1)'; new_projection text := '(to_jsonb(n) - $1)';
  ignored text[] := ARRAY['credential_refs', 'credential_secret_refs', 'credential_source', 'external_credential', 'credential_policy', 'updated_at', 'created_at', 'last_used_at', 'last_resolved_at', 'last_health_at',
    'health_status', 'health_checked_at', 'health_message', 'last_catalog_refresh_at', 'last_seen_at', 'last_error', 'last_event_at', 'last_publication_at',
    'last_sync_at', 'sync_checkpoint', 'activation_at', 'lease_token', 'lease_expires_at'];
BEGIN
  IF TG_TABLE_NAME = 'tool_profiles' AND TG_OP = 'INSERT' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'tool_policies' THEN
    old_projection := old_projection || ' #- ''{config,trustRule,hitCount}'' #- ''{config,trustRule,lastHitAt}''';
    new_projection := new_projection || ' #- ''{config,trustRule,hitCount}'' #- ''{config,trustRule,lastHitAt}''';
  END IF;
  IF TG_TABLE_NAME IN ('tool_profile_bindings', 'tool_connection_installs', 'tool_profile_entries', 'tool_policies') THEN
    IF TG_TABLE_NAME IN ('tool_profile_entries', 'tool_policies') THEN
      IF TG_OP = 'INSERT' THEN query := 'SELECT to_jsonb(n) AS row_data FROM new_rows n';
      ELSIF TG_OP = 'DELETE' THEN query := 'SELECT to_jsonb(o) AS row_data FROM old_rows o';
      ELSE query := format('WITH changed AS (
        SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I
        WHERE %s IS DISTINCT FROM %s)
        SELECT previous AS row_data FROM changed WHERE previous IS NOT NULL UNION
        SELECT current AS row_data FROM changed WHERE current IS NOT NULL', TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
      END IF;
      IF TG_TABLE_NAME = 'tool_profile_entries' THEN
        query := 'SELECT b.company_id, b.target_type, b.target_id FROM (' || query || ') changed
          JOIN tool_profile_bindings b ON b.company_id = (row_data->>''company_id'')::uuid
          AND b.profile_id = (row_data->>''profile_id'')::uuid';
      ELSE
        query := 'SELECT (row_data->>''company_id'')::uuid AS company_id, t.target_type, t.target_id
          FROM (' || query || ') changed CROSS JOIN LATERAL
          paperclip_connector_policy_targets((row_data->>''company_id'')::uuid, row_data->''selectors'') t';
      END IF;
    ELSIF TG_OP = 'INSERT' THEN query := 'SELECT company_id, target_type, target_id FROM new_rows';
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
      ORDER BY company_id, target_type DESC, target_id' USING ignored LOOP
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
  ELSE query := format('WITH changed AS (
    SELECT o.company_id AS old_company, n.company_id AS new_company FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I
    WHERE %s IS DISTINCT FROM %s)
    SELECT old_company AS company_id FROM changed WHERE old_company IS NOT NULL UNION
    SELECT new_company AS company_id FROM changed WHERE new_company IS NOT NULL ORDER BY company_id', TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
  END IF;
  FOR company IN EXECUTE query USING ignored LOOP
    PERFORM paperclip_invalidate_connector_company(company);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE relation text; key_column text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['tool_applications', 'tool_connections', 'tool_connection_installs', 'tool_catalog_entries', 'tool_profiles', 'tool_profile_entries', 'tool_profile_bindings', 'tool_policies', 'tool_mcp_gateways'] LOOP
    key_column := CASE WHEN relation = 'email_endpoints' THEN 'endpoint_id' ELSE 'id' END;
    EXECUTE format('DROP TRIGGER IF EXISTS paperclip_connector_runtime_insert ON %I', relation);
    EXECUTE format('DROP TRIGGER IF EXISTS paperclip_connector_runtime_update ON %I', relation);
    EXECUTE format('DROP TRIGGER IF EXISTS paperclip_connector_runtime_delete ON %I', relation);
    EXECUTE format('CREATE TRIGGER paperclip_connector_runtime_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_connector_runtime_changed(%L)', relation, key_column);
    EXECUTE format('CREATE TRIGGER paperclip_connector_runtime_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_connector_runtime_changed(%L)', relation, key_column);
    EXECUTE format('CREATE TRIGGER paperclip_connector_runtime_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_connector_runtime_changed(%L)', relation, key_column);
  END LOOP;
END;
$$;
--> statement-breakpoint
