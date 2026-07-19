import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// NEO-569 (563b): data-port migration 10007 — fork MCP data → upstream tool-access.
const MIGRATION_FILE = "10007_mcp_data_port_to_tool_access.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

/** Re-arm migration 10007 so applyPendingMigrations re-runs it against seeded data. */
async function rerunDataPort(sql: postgres.Sql, connectionString: string) {
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
  await applyPendingMigrations(connectionString);
}

describeEmbeddedPostgres("mcp data-port migration 10007", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("is a no-op on a fresh DB (no fork rows ⇒ no fork-sourced tool-access rows)", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-mcp-data-port-noop-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Migration already ran at startup against empty fork tables. Nothing sourced
    // from the fork stack should exist.
    const [{ count: apps }] = await sql`
      SELECT count(*)::int AS count FROM "tool_applications" WHERE "metadata"->>'source' = 'fork_mcp_port'`;
    const [{ count: conns }] = await sql`
      SELECT count(*)::int AS count FROM "tool_connections" WHERE "config"->>'source' = 'fork_mcp_port'`;
    const [{ count: profiles }] = await sql`
      SELECT count(*)::int AS count FROM "tool_profiles" WHERE "metadata"->>'source' = 'fork_mcp_port'`;
    expect(apps).toBe(0);
    expect(conns).toBe(0);
    expect(profiles).toBe(0);
  }, 30_000);

  it("ports every fork row with no loss and is idempotent on re-run", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-mcp-data-port-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const agentId = randomUUID();
    const allowlistedServerId = randomUUID();
    const quarantinedServerId = randomUUID();

    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix", "mcp_client_enabled")
      VALUES (${companyId}, 'Paperclip', 'PAP', true)`;
    await sql`INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "created_at", "updated_at")
      VALUES (${agentId}, ${companyId}, 'Gene', 'cto', 'claude_local', now(), now())`;

    // An allowlisted stdio server (→ active connection + install) and a quarantined
    // http server (→ disabled connection, no install, no allow policy).
    await sql`INSERT INTO "mcp_servers"
        ("id", "company_id", "name", "slug", "transport", "command", "args", "enabled",
         "last_health_status", "credential_secret_ref", "governance_status", "risk_level", "created_by_agent_id")
      VALUES
        (${allowlistedServerId}, ${companyId}, 'Files', 'files', 'stdio', 'file-mcp', '["--root","/"]'::jsonb, true,
         'ok', 'secret://files-key', 'allowlisted', 'medium', ${agentId}),
        (${quarantinedServerId}, ${companyId}, 'Web', 'web', 'http', NULL, '[]'::jsonb, true,
         'unknown', NULL, 'quarantine', 'high', ${agentId})`;

    // Latest catalog snapshot for the allowlisted server: a read tool and a
    // destructive tool (annotation hints drive the risk flags).
    await sql`INSERT INTO "mcp_server_catalog_snapshots"
        ("company_id", "mcp_server_id", "status", "tools", "created_at")
      VALUES
        (${companyId}, ${allowlistedServerId}, 'succeeded',
         '[{"name":"read_file","description":"Read","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]'::jsonb,
         now() - interval '1 hour'),
        (${companyId}, ${allowlistedServerId}, 'succeeded',
         '[{"name":"read_file","annotations":{"readOnlyHint":true}},{"name":"delete_file","annotations":{"destructiveHint":true}}]'::jsonb,
         now())`;

    // Agent binding: only two tools allowed, with a per-tool clearance override.
    await sql`INSERT INTO "agent_mcp_servers"
        ("company_id", "agent_id", "mcp_server_id", "binding_mode", "enabled", "allowed_tools",
         "binding_authority", "tool_clearances", "default_min_user_role", "autonomous_allowed", "created_by_agent_id")
      VALUES
        (${companyId}, ${agentId}, ${allowlistedServerId}, 'allowed', true,
         '["read_file","delete_file"]'::jsonb, 'board',
         '{"delete_file":"board"}'::jsonb, 'member', true, ${agentId})`;

    // Governance audit row (with on-behalf-of attribution) to port.
    await sql`INSERT INTO "mcp_server_audit_log"
        ("company_id", "mcp_server_id", "server_slug", "event_type", "from_status", "to_status",
         "actor_type", "actor_id", "decision", "on_behalf_of_user_id", "on_behalf_of_role")
      VALUES
        (${companyId}, ${allowlistedServerId}, 'files', 'governance_transition', 'quarantine', 'allowlisted',
         'user', 'user-1', 'allow', 'user-1', 'board')`;

    await rerunDataPort(sql, database.connectionString);

    // Applications: one per server, transport-typed, status mapped.
    const apps = await sql`
      SELECT "type", "status", "metadata"->>'forkMcpServerId' AS fork_id
      FROM "tool_applications" WHERE "metadata"->>'source' = 'fork_mcp_port' ORDER BY "type"`;
    expect(apps.map((a) => ({ type: a.type, status: a.status }))).toEqual([
      { type: "mcp_http", status: "disabled" }, // quarantined web
      { type: "mcp_stdio", status: "active" }, // allowlisted files
    ]);

    // Connections: allowlisted → active+enabled+local_stdio; quarantined → disabled.
    const conns = await sql`
      SELECT "transport", "status", "enabled", "config"->>'forkCredentialSecretRef' AS cred
      FROM "tool_connections" WHERE "config"->>'source' = 'fork_mcp_port'
      ORDER BY "transport"`;
    const files = conns.find((c) => c.transport === "local_stdio");
    const web = conns.find((c) => c.transport === "remote_http");
    expect(files).toMatchObject({ status: "active", enabled: true, cred: "secret://files-key" });
    expect(web).toMatchObject({ status: "disabled", enabled: false });

    // Install: mcp_client_enabled=true installs the ACTIVE connection at company scope only.
    const installs = await sql`
      SELECT "target_type", "target_id" FROM "tool_connection_installs" WHERE "target_type" = 'company'`;
    expect(installs).toHaveLength(1);
    expect(installs[0].target_id).toBe(companyId);

    // Catalog: latest snapshot only (2 tools), with risk flags from annotations.
    const catalog = await sql`
      SELECT "tool_name", "risk_level", "is_read_only", "is_write", "is_destructive"
      FROM "tool_catalog_entries" WHERE "application_id" IN (
        SELECT "id" FROM "tool_applications" WHERE "metadata"->>'source' = 'fork_mcp_port'
      ) ORDER BY "tool_name"`;
    expect(catalog).toHaveLength(2);
    expect(catalog.find((c) => c.tool_name === "read_file")).toMatchObject({
      risk_level: "read", is_read_only: true, is_write: false, is_destructive: false,
    });
    expect(catalog.find((c) => c.tool_name === "delete_file")).toMatchObject({
      risk_level: "destructive", is_read_only: false, is_write: true, is_destructive: true,
    });

    // Profile + per-tool include entries + agent binding.
    const [{ count: entries }] = await sql`
      SELECT count(*)::int AS count FROM "tool_profile_entries"
      WHERE "selector_type" = 'tool_name' AND "tool_name" IN ('read_file','delete_file')`;
    expect(entries).toBe(2);
    const bindings = await sql`
      SELECT "target_type", "target_id", "metadata"->'clearance'->>'agentAuthority' AS authority
      FROM "tool_profile_bindings" WHERE "metadata"->>'source' = 'fork_mcp_port'`;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ target_type: "agent", target_id: agentId, authority: "board" });

    // Clearance policies: one default (member) + one per-tool override (delete_file→board).
    const policies = await sql`
      SELECT "name", "selectors"->>'minRequesterRole' AS min_role, "selectors"->>'toolNames' AS tools
      FROM "tool_policies" WHERE "config"->>'source' = 'fork_mcp_port' ORDER BY "priority"`;
    const override = policies.find((p) => p.tools !== null);
    const dflt = policies.find((p) => p.tools === null);
    expect(dflt?.min_role).toBe("member");
    expect(override?.min_role).toBe("board");
    expect(override?.tools).toContain("delete_file");

    // Audit event ported with on-behalf-of attribution preserved in details.
    const audit = await sql`
      SELECT "action", "outcome", "details"->>'onBehalfOfUserId' AS obo, "details"->>'forkAuditId' AS fork_id
      FROM "tool_access_audit_events" WHERE "details"->>'source' = 'fork_mcp_port'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "governance_transition", outcome: "allow", obo: "user-1" });

    // Idempotency: capture counts, re-run, assert nothing duplicated.
    const countKeys = [
      sql`SELECT count(*)::int AS c FROM "tool_applications" WHERE "metadata"->>'source' = 'fork_mcp_port'`,
      sql`SELECT count(*)::int AS c FROM "tool_connections" WHERE "config"->>'source' = 'fork_mcp_port'`,
      sql`SELECT count(*)::int AS c FROM "tool_connection_installs"`,
      sql`SELECT count(*)::int AS c FROM "tool_catalog_entries" WHERE "application_id" IN (SELECT "id" FROM "tool_applications" WHERE "metadata"->>'source' = 'fork_mcp_port')`,
      sql`SELECT count(*)::int AS c FROM "tool_profiles" WHERE "metadata"->>'source' = 'fork_mcp_port'`,
      sql`SELECT count(*)::int AS c FROM "tool_profile_entries"`,
      sql`SELECT count(*)::int AS c FROM "tool_profile_bindings" WHERE "metadata"->>'source' = 'fork_mcp_port'`,
      sql`SELECT count(*)::int AS c FROM "tool_policies" WHERE "config"->>'source' = 'fork_mcp_port'`,
      sql`SELECT count(*)::int AS c FROM "tool_access_audit_events" WHERE "details"->>'source' = 'fork_mcp_port'`,
    ];
    const before = (await Promise.all(countKeys)).map((r) => r[0].c);
    await rerunDataPort(sql, database.connectionString);
    const after = (await Promise.all(countKeys)).map((r) => r[0].c);
    expect(after).toEqual(before);
  }, 60_000);
});
