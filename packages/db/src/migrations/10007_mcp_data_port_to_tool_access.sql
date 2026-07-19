-- NEO-569 (563b): Data-port migration — fork MCP data → upstream tool-access tables.
--
-- Idempotent forward-only DATA port. Moves rows from the fork MCP stack
-- (10002 mcp_servers/agent_mcp_servers/mcp_server_catalog_snapshots,
-- 10003 companies.mcp_client_enabled, 10004 governance + mcp_server_audit_log,
-- 10005 requester-clearance columns) onto the canonical upstream tool-access
-- schema (0148/0149/0168). NO fork schema is dropped here — deletion is 563e
-- (10008). See NEO-563 plan §1 (capability map) and §3.2.
--
-- Invariants:
--   * Fresh DB = no-op (fork tables exist but are empty ⇒ every SELECT is empty).
--   * Populated DB = every fork row ported with no data loss.
--   * Re-runnable: every write is guarded by a deterministic ON CONFLICT DO
--     NOTHING (against a natural/derived unique key) or a NOT EXISTS check, and
--     later steps re-derive the ported rows by the fork id stashed in
--     metadata/config, so a second apply is a no-op.
--
-- Governance → status mapping (§1-E / GAP-2, board-confirmed default-deny-until-
-- active): allowlisted → connection `active` (+ requester-clearance allow policy);
-- pending/quarantine/unknown → `disabled` (default-deny, no allow); revoked →
-- `archived`.

-- 1. mcp_servers → tool_applications (one application per server; §1-A).
--    application_key/metadata.forkMcpServerId are the deterministic join keys used
--    by every later step. ON CONFLICT DO NOTHING (no target) so a re-run is inert
--    and a rare (company, name) collision is skipped rather than erroring.
INSERT INTO "tool_applications" (
  "company_id", "application_key", "name", "type", "status", "description",
  "owner_agent_id", "owner_user_id", "metadata", "created_at", "updated_at"
)
SELECT
  s."company_id",
  'fork_mcp:' || s."id"::text,
  s."name",
  CASE WHEN s."transport" = 'stdio' THEN 'mcp_stdio' ELSE 'mcp_http' END,
  CASE lower(coalesce(s."governance_status", 'pending'))
    WHEN 'allowlisted' THEN 'active'
    WHEN 'revoked' THEN 'archived'
    ELSE 'disabled'
  END,
  s."description",
  s."created_by_agent_id",
  s."created_by_user_id",
  jsonb_build_object(
    'source', 'fork_mcp_port',
    'forkMcpServerId', s."id",
    'forkSlug', s."slug",
    'forkGovernanceStatus', s."governance_status",
    'forkRiskLevel', s."risk_level"
  ),
  s."created_at",
  s."updated_at"
FROM "mcp_servers" s
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 2. mcp_servers → tool_connections (transport, status, health, creds; §1-A).
--    config carries the FULL fork transport descriptor (lossless port, incl. the
--    forkMcpServerId join key and the raw credential ref); transport_config keeps
--    only the non-sensitive subset. The fork's single text `credential_secret_ref`
--    is not shaped like upstream credentialSecretRefs (secretId uuid + configPath),
--    so it is preserved raw in config.forkCredentialSecretRef for 563c to remap —
--    never fabricated into a structured ref.
INSERT INTO "tool_connections" (
  "company_id", "application_id", "name", "connection_kind", "transport", "status",
  "enabled", "config", "transport_config", "credential_refs", "credential_secret_refs",
  "health_status", "health_message", "last_health_at", "health_checked_at",
  "last_catalog_refresh_at", "last_error", "created_by_agent_id", "created_by_user_id",
  "created_at", "updated_at"
)
SELECT
  s."company_id",
  a."id",
  s."name",
  'managed',
  CASE WHEN s."transport" = 'stdio' THEN 'local_stdio' ELSE 'remote_http' END,
  CASE lower(coalesce(s."governance_status", 'pending'))
    WHEN 'allowlisted' THEN 'active'
    WHEN 'revoked' THEN 'archived'
    ELSE 'disabled'
  END,
  (lower(coalesce(s."governance_status", 'pending')) = 'allowlisted' AND s."enabled"),
  jsonb_build_object(
    'source', 'fork_mcp_port',
    'forkMcpServerId', s."id",
    'forkSlug', s."slug",
    'transport', s."transport",
    'command', s."command",
    'args', s."args",
    'cwd', s."cwd",
    'url', s."url",
    'headers', s."headers",
    'env', s."env",
    'forkCredentialSecretRef', s."credential_secret_ref"
  ),
  jsonb_strip_nulls(jsonb_build_object(
    'url', s."url",
    'command', s."command",
    'args', s."args",
    'cwd', s."cwd"
  )),
  '[]'::jsonb,
  '[]'::jsonb,
  CASE
    WHEN s."last_health_status" IN (
      'unknown', 'healthy', 'degraded', 'failed', 'unchecked', 'ok', 'error', 'missing_secret'
    ) THEN s."last_health_status"
    ELSE 'unknown'
  END,
  s."last_error",
  s."last_healthcheck_at",
  s."last_healthcheck_at",
  s."last_discovery_at",
  s."last_error",
  s."created_by_agent_id",
  s."created_by_user_id",
  s."created_at",
  s."updated_at"
FROM "mcp_servers" s
JOIN "tool_applications" a
  ON a."company_id" = s."company_id"
 AND a."metadata"->>'forkMcpServerId' = s."id"::text
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 3. companies.mcp_client_enabled = true → tool_connection_installs (company scope;
--    §1-B). The fork's single global boolean becomes a per-connection install for
--    every ACTIVE ported connection in that company (global → per-connection).
INSERT INTO "tool_connection_installs" (
  "company_id", "connection_id", "target_type", "target_id", "created_at"
)
SELECT conn."company_id", conn."id", 'company', conn."company_id"::text, now()
FROM "tool_connections" conn
JOIN "companies" co ON co."id" = conn."company_id"
WHERE co."mcp_client_enabled" = true
  AND conn."config"->>'forkMcpServerId' IS NOT NULL
  AND conn."status" = 'active'
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 4. latest mcp_server_catalog_snapshots → tool_catalog_entries (§1-D).
--    Historical snapshots collapse to the live catalog: only the most recent
--    succeeded snapshot per server is ported. MCP annotation hints
--    (readOnlyHint/destructiveHint) drive the risk/read-only/write/destructive
--    flags; absent hints default to read-only (least privilege).
WITH latest_snapshot AS (
  SELECT DISTINCT ON (snap."mcp_server_id") snap.*
  FROM "mcp_server_catalog_snapshots" snap
  WHERE snap."status" = 'succeeded'
  ORDER BY snap."mcp_server_id", snap."created_at" DESC
)
INSERT INTO "tool_catalog_entries" (
  "company_id", "application_id", "connection_id", "entry_kind", "name", "tool_name",
  "title", "description", "input_schema", "annotations", "risk_level",
  "is_read_only", "is_write", "is_destructive", "status", "version_hash", "schema_hash",
  "first_seen_at", "last_seen_at", "created_at", "updated_at"
)
SELECT
  l."company_id",
  conn."application_id",
  conn."id",
  'tool',
  tool.value->>'name',
  tool.value->>'name',
  coalesce(tool.value->>'title', tool.value->>'displayName'),
  tool.value->>'description',
  coalesce(tool.value->'inputSchema', tool.value->'parametersSchema', '{}'::jsonb),
  coalesce(tool.value->'annotations', '{}'::jsonb),
  CASE
    WHEN coalesce((tool.value->'annotations'->>'destructiveHint')::boolean, false) THEN 'destructive'
    WHEN NOT coalesce((tool.value->'annotations'->>'readOnlyHint')::boolean, true) THEN 'write'
    ELSE 'read'
  END,
  (coalesce((tool.value->'annotations'->>'readOnlyHint')::boolean, true)
   AND NOT coalesce((tool.value->'annotations'->>'destructiveHint')::boolean, false)),
  NOT (coalesce((tool.value->'annotations'->>'readOnlyHint')::boolean, true)
   AND NOT coalesce((tool.value->'annotations'->>'destructiveHint')::boolean, false)),
  coalesce((tool.value->'annotations'->>'destructiveHint')::boolean, false),
  'active',
  md5(tool.value::text),
  md5(tool.value::text),
  l."created_at",
  l."created_at",
  now(),
  now()
FROM latest_snapshot l
JOIN "tool_connections" conn
  ON conn."company_id" = l."company_id"
 AND conn."config"->>'forkMcpServerId' = l."mcp_server_id"::text
CROSS JOIN LATERAL jsonb_array_elements(coalesce(l."tools", '[]'::jsonb)) AS tool(value)
WHERE tool.value ? 'name'
ON CONFLICT ("connection_id", "name") DO NOTHING;--> statement-breakpoint

-- 5. agent_mcp_servers → tool_profiles (one profile per agent↔server binding; §1-C).
--    default_action = deny (default-deny). The 563a requester-clearance descriptor
--    (agentAuthority/autonomousAllowed/defaultMinUserRole/toolClearances) is stashed
--    on metadata so the gateway resolver (563c) has a per-binding home for the
--    decision inputs that the minRequesterRole selector alone cannot carry.
INSERT INTO "tool_profiles" (
  "company_id", "profile_key", "name", "description", "status", "default_action",
  "metadata", "created_at", "updated_at"
)
SELECT
  b."company_id",
  'fork_mcp:agent:' || b."agent_id"::text || ':srv:' || b."mcp_server_id"::text,
  left('Fork MCP — ' || coalesce(ag."name", b."agent_id"::text) || ' → ' || coalesce(s."name", s."slug"), 200),
  'Ported from fork agent_mcp_servers binding (NEO-569 / 10007).',
  CASE WHEN b."enabled" THEN 'active' ELSE 'disabled' END,
  'deny',
  jsonb_build_object(
    'source', 'fork_mcp_port',
    'forkAgentId', b."agent_id",
    'forkMcpServerId', b."mcp_server_id",
    'bindingMode', b."binding_mode",
    'clearance', jsonb_build_object(
      'agentAuthority', b."binding_authority",
      'autonomousAllowed', b."autonomous_allowed",
      'defaultMinUserRole', b."default_min_user_role",
      'toolClearances', b."tool_clearances"
    )
  ),
  b."created_at",
  b."updated_at"
FROM "agent_mcp_servers" b
JOIN "mcp_servers" s ON s."id" = b."mcp_server_id"
LEFT JOIN "agents" ag ON ag."id" = b."agent_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 6a. allowed_tools → per-tool include entries (§1-C). Non-empty allowed_tools
--     means "only these tools"; each becomes a tool_name include entry.
INSERT INTO "tool_profile_entries" (
  "company_id", "profile_id", "selector_type", "effect", "connection_id", "tool_name",
  "created_at", "updated_at"
)
SELECT b."company_id", p."id", 'tool_name', 'include', conn."id", t."tool_name", now(), now()
FROM "agent_mcp_servers" b
JOIN "tool_profiles" p
  ON p."company_id" = b."company_id"
 AND p."profile_key" = 'fork_mcp:agent:' || b."agent_id"::text || ':srv:' || b."mcp_server_id"::text
JOIN "tool_connections" conn
  ON conn."company_id" = b."company_id"
 AND conn."config"->>'forkMcpServerId' = b."mcp_server_id"::text
CROSS JOIN LATERAL jsonb_array_elements_text(b."allowed_tools") AS t("tool_name")
WHERE jsonb_typeof(b."allowed_tools") = 'array'
  AND jsonb_array_length(b."allowed_tools") > 0
  AND NOT EXISTS (
    SELECT 1 FROM "tool_profile_entries" e
    WHERE e."profile_id" = p."id" AND e."selector_type" = 'tool_name' AND e."tool_name" = t."tool_name"
  );--> statement-breakpoint

-- 6b. empty allowed_tools → whole-connection include entry (binding grants the
--     entire server's catalog).
INSERT INTO "tool_profile_entries" (
  "company_id", "profile_id", "selector_type", "effect", "connection_id",
  "created_at", "updated_at"
)
SELECT b."company_id", p."id", 'connection', 'include', conn."id", now(), now()
FROM "agent_mcp_servers" b
JOIN "tool_profiles" p
  ON p."company_id" = b."company_id"
 AND p."profile_key" = 'fork_mcp:agent:' || b."agent_id"::text || ':srv:' || b."mcp_server_id"::text
JOIN "tool_connections" conn
  ON conn."company_id" = b."company_id"
 AND conn."config"->>'forkMcpServerId' = b."mcp_server_id"::text
WHERE (
    jsonb_typeof(b."allowed_tools") IS DISTINCT FROM 'array'
    OR jsonb_array_length(coalesce(b."allowed_tools", '[]'::jsonb)) = 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM "tool_profile_entries" e
    WHERE e."profile_id" = p."id" AND e."selector_type" = 'connection' AND e."connection_id" = conn."id"
  );--> statement-breakpoint

-- 7. agent_mcp_servers → tool_profile_bindings (target_type = agent; §1-C). Carries
--    the clearance descriptor for 563c and preserves fork creator attribution.
INSERT INTO "tool_profile_bindings" (
  "company_id", "profile_id", "target_type", "target_id", "priority", "metadata",
  "created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
)
SELECT
  b."company_id",
  p."id",
  'agent',
  b."agent_id"::text,
  100,
  jsonb_build_object(
    'source', 'fork_mcp_port',
    'clearance', jsonb_build_object(
      'agentAuthority', b."binding_authority",
      'autonomousAllowed', b."autonomous_allowed",
      'defaultMinUserRole', b."default_min_user_role",
      'toolClearances', b."tool_clearances"
    )
  ),
  b."created_by_agent_id",
  b."created_by_user_id",
  b."created_at",
  b."updated_at"
FROM "agent_mcp_servers" b
JOIN "tool_profiles" p
  ON p."company_id" = b."company_id"
 AND p."profile_key" = 'fork_mcp:agent:' || b."agent_id"::text || ':srv:' || b."mcp_server_id"::text
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 8a. binding.default_min_user_role → tool_policies allow w/ minRequesterRole selector
--     (563a clearance model, §1-G). The selector matches only when the request's
--     effective clearance (MIN(agent,requester,origin), autonomous floored to guest)
--     meets the min role; agentAuthority/autonomousAllowed/toolClearances ride in
--     config for the gateway resolver. Only allowlisted (active) connections yield
--     an allow, preserving default-deny-until-active.
INSERT INTO "tool_policies" (
  "company_id", "name", "description", "policy_type", "priority", "enabled",
  "selectors", "config", "created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
)
SELECT
  b."company_id",
  'fork_mcp_clearance:' || b."agent_id"::text || ':' || b."mcp_server_id"::text,
  'Requester-clearance default min role ported from fork binding (NEO-569 / 563a model).',
  'allow',
  100,
  (b."enabled" AND conn."status" = 'active'),
  jsonb_build_object(
    'agentIds', jsonb_build_array(b."agent_id"),
    'connectionIds', jsonb_build_array(conn."id"),
    'minRequesterRole', b."default_min_user_role"
  ),
  jsonb_build_object(
    'source', 'fork_mcp_port',
    'agentId', b."agent_id",
    'forkMcpServerId', b."mcp_server_id",
    'agentAuthority', b."binding_authority",
    'autonomousAllowed', b."autonomous_allowed",
    'defaultMinUserRole', b."default_min_user_role",
    'toolClearances', b."tool_clearances"
  ),
  b."created_by_agent_id",
  b."created_by_user_id",
  now(),
  now()
FROM "agent_mcp_servers" b
JOIN "tool_connections" conn
  ON conn."company_id" = b."company_id"
 AND conn."config"->>'forkMcpServerId' = b."mcp_server_id"::text
WHERE b."default_min_user_role" IN ('guest', 'member', 'board')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 8b. per-tool tool_clearances → per-tool minRequesterRole allow policies (higher
--     precedence than the binding default; §1-G).
INSERT INTO "tool_policies" (
  "company_id", "name", "description", "policy_type", "priority", "enabled",
  "selectors", "config", "created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
)
SELECT
  b."company_id",
  'fork_mcp_clearance:' || b."agent_id"::text || ':' || b."mcp_server_id"::text || ':tool:' || tc."tool_name",
  'Per-tool requester-clearance override ported from fork tool_clearances (NEO-569 / 563a model).',
  'allow',
  90,
  (b."enabled" AND conn."status" = 'active'),
  jsonb_build_object(
    'agentIds', jsonb_build_array(b."agent_id"),
    'connectionIds', jsonb_build_array(conn."id"),
    'toolNames', jsonb_build_array(tc."tool_name"),
    'minRequesterRole', tc."role"
  ),
  jsonb_build_object(
    'source', 'fork_mcp_port',
    'agentId', b."agent_id",
    'forkMcpServerId', b."mcp_server_id",
    'toolName', tc."tool_name",
    'minRequesterRole', tc."role"
  ),
  b."created_by_agent_id",
  b."created_by_user_id",
  now(),
  now()
FROM "agent_mcp_servers" b
JOIN "tool_connections" conn
  ON conn."company_id" = b."company_id"
 AND conn."config"->>'forkMcpServerId' = b."mcp_server_id"::text
CROSS JOIN LATERAL jsonb_each_text(b."tool_clearances") AS tc("tool_name", "role")
WHERE jsonb_typeof(b."tool_clearances") = 'object'
  AND tc."role" IN ('guest', 'member', 'board')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 9. mcp_server_audit_log → tool_access_audit_events (best-effort history; §1-F).
--    The rich fork columns (status transitions, risk, on-behalf-of attribution,
--    arg/result digests) are preserved under details; details->>'forkAuditId' is
--    the idempotency dedupe key (NOT EXISTS guard makes the port re-runnable).
INSERT INTO "tool_access_audit_events" (
  "company_id", "connection_id", "actor_type", "actor_id", "action", "outcome",
  "reason_code", "details", "created_at"
)
SELECT
  al."company_id",
  conn."id",
  CASE WHEN al."actor_type" IN ('agent', 'user', 'system', 'plugin') THEN al."actor_type" ELSE 'system' END,
  al."actor_id",
  al."event_type",
  coalesce(al."decision", al."to_status", 'recorded'),
  al."reason",
  coalesce(al."details", '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'source', 'fork_mcp_port',
    'forkAuditId', al."id",
    'serverSlug', al."server_slug",
    'fromStatus', al."from_status",
    'toStatus', al."to_status",
    'riskLevel', al."risk_level",
    'toolName', al."tool_name",
    'onBehalfOfUserId', al."on_behalf_of_user_id",
    'onBehalfOfRole', al."on_behalf_of_role",
    'decision', al."decision",
    'argsDigest', al."args_digest",
    'resultDigest', al."result_digest"
  )),
  al."created_at"
FROM "mcp_server_audit_log" al
LEFT JOIN "tool_connections" conn
  ON conn."company_id" = al."company_id"
 AND conn."config"->>'forkMcpServerId' = al."mcp_server_id"::text
WHERE NOT EXISTS (
  SELECT 1 FROM "tool_access_audit_events" e
  WHERE e."company_id" = al."company_id"
    AND e."details"->>'forkAuditId' = al."id"::text
);
