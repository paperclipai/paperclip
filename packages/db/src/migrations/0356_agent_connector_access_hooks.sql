CREATE OR REPLACE FUNCTION paperclip_connector_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid; query text; target record; binding record; candidate uuid;
  old_projection text := '(to_jsonb(o) - $1)'; new_projection text := '(to_jsonb(n) - $1)';
  ignored text[] := ARRAY['updated_at', 'created_at', 'last_used_at', 'last_resolved_at', 'last_health_at',
    'health_status', 'health_checked_at', 'health_message', 'last_catalog_refresh_at', 'last_seen_at', 'last_error', 'last_event_at', 'last_publication_at',
    'last_sync_at', 'sync_checkpoint', 'activation_at', 'lease_token', 'lease_expires_at'];
BEGIN
  IF TG_TABLE_NAME = 'tool_profiles' AND TG_OP = 'INSERT' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'connection_grant_delegations' THEN
    IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id, agent_id FROM new_rows ORDER BY company_id, agent_id';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id, agent_id FROM old_rows ORDER BY company_id, agent_id';
    ELSE query := 'WITH changed AS (
      SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.id = n.id
      WHERE (to_jsonb(o) - $1) IS DISTINCT FROM (to_jsonb(n) - $1)), targets AS (
      SELECT previous AS target FROM changed UNION SELECT current FROM changed)
      SELECT DISTINCT (target->>''company_id'')::uuid AS company_id, (target->>''agent_id'')::uuid AS agent_id
      FROM targets WHERE target IS NOT NULL ORDER BY company_id, agent_id';
    END IF;
    FOR binding IN EXECUTE query USING ignored LOOP
      PERFORM paperclip_invalidate_connector_agent(binding.company_id, binding.agent_id);
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'company_secret_bindings' THEN
    IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id, target_type, target_id FROM new_rows ORDER BY company_id, target_id';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id, target_type, target_id FROM old_rows ORDER BY company_id, target_id';
    ELSE query := 'WITH changed AS (
      SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.id = n.id
      WHERE (to_jsonb(o) - $1) IS DISTINCT FROM (to_jsonb(n) - $1)), targets AS (
      SELECT previous AS target FROM changed UNION SELECT current FROM changed)
      SELECT DISTINCT (target->>''company_id'')::uuid AS company_id, target->>''target_type'' AS target_type, target->>''target_id'' AS target_id
      FROM targets WHERE target IS NOT NULL ORDER BY company_id, target_id';
    END IF;
    FOR binding IN EXECUTE query USING ignored LOOP
      IF binding.target_type = 'agent' THEN
        SELECT id INTO candidate FROM agents WHERE company_id = binding.company_id AND id::text = binding.target_id;
        IF FOUND THEN PERFORM paperclip_record_agent_runtime(binding.company_id, candidate); END IF;
      ELSE PERFORM paperclip_invalidate_connector_company(binding.company_id);
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'connection_grants' THEN
    old_projection := old_projection || ' #- ''{provider_tenant,oauth,refreshLease}'' #- ''{external_credential,lastVerifiedAt}'' #- ''{provider_tenant,github,lastWebhookAt}'' #- ''{provider_tenant,github,webhookHealth}''';
    new_projection := new_projection || ' #- ''{provider_tenant,oauth,refreshLease}'' #- ''{external_credential,lastVerifiedAt}'' #- ''{provider_tenant,github,lastWebhookAt}'' #- ''{provider_tenant,github,webhookHealth}''';
  END IF;
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
  FOREACH relation IN ARRAY ARRAY['tool_applications', 'tool_connections', 'connection_grants', 'connection_grant_members',
    'connection_grant_delegations', 'tool_connection_installs', 'tool_catalog_entries', 'tool_profiles', 'tool_profile_entries',
    'tool_profile_bindings', 'tool_policies', 'tool_mcp_gateways', 'company_memberships', 'principal_permission_grants',
    'company_secret_bindings', 'chat_endpoints', 'chat_endpoint_resources', 'chat_agent_routes', 'chat_identity_links',
    'chat_voice_callbacks', 'email_endpoints'] LOOP
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
CREATE OR REPLACE FUNCTION paperclip_connector_uses_secret(p_company uuid, p_secret uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tool_connections WHERE company_id = p_company AND (
      credential_refs @> jsonb_build_array(jsonb_build_object('secretId', p_secret::text)) OR
      credential_secret_refs @> jsonb_build_array(jsonb_build_object('secretId', p_secret::text)))) OR
    EXISTS (SELECT 1 FROM connection_grants WHERE company_id = p_company AND
      credential_secret_refs @> jsonb_build_array(jsonb_build_object('secretId', p_secret::text)));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_secret_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE secret uuid; company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_build_array(OLD.status, OLD.latest_version, OLD.deleted_at, OLD.external_ref, OLD.provider_config_id, OLD.provider_metadata)
    IS NOT DISTINCT FROM jsonb_build_array(NEW.status, NEW.latest_version, NEW.deleted_at, NEW.external_ref, NEW.provider_config_id, NEW.provider_metadata) THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN secret := OLD.id; company := OLD.company_id;
  ELSE secret := NEW.id; company := NEW.company_id; END IF;
  IF paperclip_connector_uses_secret(company, secret) THEN
    PERFORM paperclip_invalidate_connector_company(company);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_connector_secret_changed ON company_secrets;
CREATE TRIGGER paperclip_connector_secret_changed AFTER UPDATE OR DELETE ON company_secrets
  FOR EACH ROW EXECUTE FUNCTION paperclip_connector_secret_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_vault_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE vault uuid; company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_build_array(OLD.provider, OLD.status, OLD.config, OLD.is_default, OLD.disabled_at)
    IS NOT DISTINCT FROM jsonb_build_array(NEW.provider, NEW.status, NEW.config, NEW.is_default, NEW.disabled_at) THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN vault := OLD.id; ELSE vault := NEW.id; END IF;
  FOR company IN SELECT DISTINCT s.company_id FROM company_secrets s WHERE s.provider_config_id = vault
    AND paperclip_connector_uses_secret(s.company_id, s.id) ORDER BY s.company_id LOOP
    PERFORM paperclip_invalidate_connector_company(company);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_connector_vault_changed ON company_secret_provider_configs;
CREATE TRIGGER paperclip_connector_vault_changed AFTER INSERT OR UPDATE OR DELETE ON company_secret_provider_configs
  FOR EACH ROW EXECUTE FUNCTION paperclip_connector_vault_changed();
--> statement-breakpoint
