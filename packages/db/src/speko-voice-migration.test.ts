import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Speko additive voice migration", () => {
  it("upgrades existing Slack data and constrains voice transport to channel connections", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-speko-upgrade-");
    const sql = postgres(database.connectionString, { max: 1 });
    try {
      expect(await sql`SELECT to_regclass('chat_voice_sessions') AS name`).toEqual([{ name: "chat_voice_sessions" }]);
      // Reconstruct exactly the pre-Speko schema in this disposable database.
      await sql`DROP TABLE chat_voice_inbound_calls`;
      await sql`DROP TABLE chat_voice_phone_lines`;
      await sql`DROP TABLE chat_voice_reports`;
      await sql`DROP TABLE chat_voice_callbacks`;
      await sql`DROP TABLE chat_voice_replies`;
      await sql`DROP TABLE chat_voice_tool_calls`;
      await sql`DROP TABLE chat_voice_sessions`;
      const constraints = [
        ["chat_endpoints", "chat_endpoints_provider_check", "provider in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail', 'imessage-photon')"],
        ["chat_external_principals", "chat_external_principals_provider_check", "provider in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail', 'imessage-photon')"],
        ["tool_connections", "tool_connections_transport_check", "transport in ('mcp_remote', 'rest_api', 'local_stdio', 'chat_sdk', 'runtime_auth')"],
        ["tool_connections", "tool_connections_channel_transport_check", "(connection_purpose = 'tool' and transport not in ('chat_sdk', 'runtime_auth')) or (connection_purpose = 'channel' and (transport = 'chat_sdk' or (transport = 'rest_api' and config->>'provider' = 'agentmail'))) or (connection_purpose = 'ai' and transport = 'runtime_auth')"],
      ];
      for (const [table, name, definition] of constraints) {
        await sql.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
        await sql.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${definition})`);
      }
      for (const name of ["0323_long_franklin_storm.sql", "0324_aberrant_machine_man.sql", "0325_blushing_screwball.sql", "0326_sad_proteus.sql", "0327_chunky_mentallo.sql", "0328_free_wolf_cub.sql", "0329_spooky_white_tiger.sql"]) {
        const migration = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
        const hash = createHash("sha256").update(migration).digest("hex");
        await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      }
      const company = randomUUID(), agent = randomUUID(), application = randomUUID(), connection = randomUUID(), endpoint = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Existing company', 'OLD')`;
      await sql`INSERT INTO agents (id, company_id, name, role, status, adapter_type) VALUES (${agent}, ${company}, 'Existing agent', 'general', 'idle', 'process')`;
      await sql`INSERT INTO tool_applications (id, company_id, application_key, name, type, status) VALUES (${application}, ${company}, 'slack', 'Slack', 'chat', 'active')`;
      await sql`INSERT INTO tool_connections (id, company_id, application_id, name, uid, connection_purpose, transport, status, enabled) VALUES (${connection}, ${company}, ${application}, 'Existing Slack', 'slack/existing', 'channel', 'chat_sdk', 'active', true)`;
      await sql`INSERT INTO chat_endpoints (id, company_id, connection_id, provider, public_id, assigned_agent_id, status) VALUES (${endpoint}, ${company}, ${connection}, 'slack', ${randomUUID()}, ${agent}, 'active')`;
      const aiConnection = randomUUID(), mailConnection = randomUUID();
      await sql`INSERT INTO tool_connections (id, company_id, application_id, name, uid, connection_purpose, transport, status, enabled) VALUES (${aiConnection}, ${company}, ${application}, 'Existing AI', 'ai/existing', 'ai', 'runtime_auth', 'active', true)`;
      await sql`INSERT INTO tool_connections (id, company_id, application_id, name, uid, connection_purpose, transport, status, enabled, config) VALUES (${mailConnection}, ${company}, ${application}, 'Existing email', 'email/existing', 'channel', 'rest_api', 'active', true, '{"provider":"agentmail"}'::jsonb)`;
      await applyPendingMigrations(database.connectionString);
      expect(await sql`SELECT transport FROM tool_connections WHERE id = ${aiConnection}`).toEqual([{ transport: "runtime_auth" }]);
      expect(await sql`SELECT transport FROM tool_connections WHERE id = ${mailConnection}`).toEqual([{ transport: "rest_api" }]);
      // Upstream AI/email transports and newly added chat providers remain valid.
      await sql`UPDATE tool_connections SET connection_purpose = 'ai', transport = 'runtime_auth' WHERE id = ${aiConnection}`;
      await sql`UPDATE tool_connections SET config = '{"provider":"agentmail"}'::jsonb WHERE id = ${mailConnection}`;
      await sql`UPDATE chat_endpoints SET provider = 'imessage-photon' WHERE id = ${endpoint}`;
      await sql`UPDATE chat_endpoints SET provider = 'agentmail', publication_mode = 'explicit', external_execution_policy = 'agent' WHERE id = ${endpoint}`;
      await sql`UPDATE chat_endpoints SET provider = 'slack' WHERE id = ${endpoint}`;
      expect(await sql`SELECT provider, assigned_agent_id FROM chat_endpoints WHERE id = ${endpoint}`).toEqual([{ provider: "slack", assigned_agent_id: agent }]);
      expect(await sql`SELECT name, transport FROM tool_connections WHERE id = ${connection}`).toEqual([{ name: "Existing Slack", transport: "chat_sdk" }]);
      await sql`UPDATE tool_connections SET transport = 'voice' WHERE id = ${connection}`;
      await expect(sql`UPDATE tool_connections SET connection_purpose = 'tool' WHERE id = ${connection}`).rejects.toMatchObject({ code: "23514" });
      await sql`UPDATE chat_endpoints SET provider = 'speko' WHERE id = ${endpoint}`;
      expect(await sql`SELECT to_regclass('chat_voice_tool_calls') AS name`).toEqual([{ name: "chat_voice_tool_calls" }]);
      expect(await sql`SELECT to_regclass('chat_voice_reports') AS name`).toEqual([{ name: "chat_voice_reports" }]);
      const [toolConstraint] = await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'chat_voice_tool_calls_tool_check'`;
      expect(toolConstraint.definition).toContain("answer_question");
      expect(await sql`SELECT to_regclass('chat_voice_callbacks') AS name`).toEqual([{ name: "chat_voice_callbacks" }]);
      await sql`INSERT INTO chat_voice_callbacks (company_id, endpoint_id, user_id, phone_number) VALUES (${company}, ${endpoint}, 'member', '+12015551234')`;
      expect(await sql`SELECT enabled FROM chat_voice_callbacks WHERE endpoint_id = ${endpoint}`).toEqual([{ enabled: false }]);
      await expect(sql`INSERT INTO chat_voice_callbacks (company_id, endpoint_id, user_id, phone_number) VALUES (${company}, ${endpoint}, 'invalid', '555')`).rejects.toMatchObject({ code: "23514" });
      await expect(sql`INSERT INTO chat_voice_callbacks (company_id, endpoint_id, user_id, phone_number) VALUES (${randomUUID()}, ${endpoint}, 'foreign', '+12015551234')`).rejects.toMatchObject({ code: "23503" });
      await expect(sql`INSERT INTO chat_voice_callbacks (company_id, endpoint_id, user_id, phone_number) VALUES (${company}, ${endpoint}, 'member', '+12015559999')`).rejects.toMatchObject({ code: "23505" });
      await applyPendingMigrations(database.connectionString);
      // Existing installations have older migration hashes after renumbering.
      // Force each stage to execute again while preserving the actual saved rows.
      for (const name of ["0323_long_franklin_storm.sql", "0324_aberrant_machine_man.sql", "0325_blushing_screwball.sql", "0326_sad_proteus.sql", "0327_chunky_mentallo.sql", "0328_free_wolf_cub.sql", "0329_spooky_white_tiger.sql"]) {
        const migration = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
        const hash = createHash("sha256").update(migration).digest("hex");
        await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      }
      await applyPendingMigrations(database.connectionString);
      expect(await sql`SELECT count(*)::int AS count FROM chat_endpoints WHERE id = ${endpoint}`).toEqual([{ count: 1 }]);
      expect(await sql`SELECT phone_number, enabled FROM chat_voice_callbacks WHERE endpoint_id = ${endpoint} AND user_id = 'member'`).toEqual([{phone_number: "+12015551234", enabled: false}]);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 60_000);
});
