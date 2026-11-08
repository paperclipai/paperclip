import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const external = process.env.PAPERCLIP_MIGRATION_TEST_DATABASE_URL;
if (external && !new URL(external).pathname.endsWith("_test")) throw new Error("Migration test URL must name a test database");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const migrationFile = "0396_tan_paladin.sql";
const indexName = "chat_voice_inbound_cleanup_idx";

(support.supported ? describe : describe.skip)("inbound voice cleanup migration", () => {
  it("boots through the application migrator and repairs an interrupted index on concurrent replay", async () => {
    let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
    let admin: ReturnType<typeof postgres> | undefined;
    let databaseName: string | undefined;
    let connectionString: string;
    let client: ReturnType<typeof postgres> | undefined;
    try {
      if (external) {
        admin = postgres(external, { max: 1, onnotice: () => {} });
        databaseName = `voice_migration_${randomUUID().replaceAll("-", "")}_test`;
        await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(external); url.pathname = `/${databaseName}`;
        connectionString = url.toString();
        await applyPendingMigrations(connectionString);
      } else {
        temporary = await startEmbeddedPostgresTestDatabase("voice-inbound-migration-");
        connectionString = temporary.connectionString;
      }
      client = postgres(connectionString, { max: 1, onnotice: () => {} });
      const columns = await client`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chat_voice_inbound_calls'`;
      expect(columns.map(row => row.column_name)).toEqual(expect.arrayContaining([
        "cleanup_confirmed_at", "cleanup_next_attempt_at", "provider_account_id",
      ]));
      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await client`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await client.unsafe(`DROP INDEX ${indexName}`);
      const [company, otherCompany] = await client`INSERT INTO companies (name, issue_prefix)
        VALUES ('First', 'VM1'), ('Second', 'VM2') RETURNING id`;
      const agentId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
      await client`INSERT INTO agents (id, company_id, name, adapter_type) VALUES (${agentId}, ${company.id}, 'Migration voice', 'paperclip_runner')`;
      await client`INSERT INTO tool_applications (id, company_id, name, type) VALUES (${applicationId}, ${company.id}, 'Voice', 'chat')`;
      await client`INSERT INTO tool_connections (id, company_id, application_id, name, uid, transport, connection_purpose)
        VALUES (${connectionId}, ${company.id}, ${applicationId}, 'Voice', ${connectionId}, 'voice', 'channel')`;
      await client`INSERT INTO chat_endpoints (id, company_id, connection_id, assigned_agent_id, provider, public_id, status)
        VALUES (${endpointId}, ${company.id}, ${connectionId}, ${agentId}, 'speko', ${endpointId}, 'active')`;
      await client`WITH candidates AS (SELECT gen_random_uuid() AS id FROM generate_series(1, 1005))
        INSERT INTO chat_voice_inbound_calls (id, company_id, endpoint_id, provider_session_id, state,
          approval_code, generation, credential_fingerprint, tool_token_hash, request_fingerprint, expires_at)
        SELECT id, ${company.id}, ${endpointId}, 'migration:' || id::text, 'ended', '123456', 1,
          'migration', repeat('a', 64), id::text, now() FROM candidates`;
      const nilId = '00000000-0000-0000-0000-000000000000', signed = randomUUID();
      const denied = randomUUID(), wrongCompany = randomUUID(), wrongAction = randomUUID();
      const pending = randomUUID(), expired = randomUUID(), confirmed = randomUUID();
      const confirmedAt = new Date('2020-01-01T00:00:00Z');
      const rows = [
        { id: nilId, state: 'ended', actor: null }, { id: signed, state: 'ended', actor: 'approver' },
        { id: denied, state: 'ended', actor: 'denier' }, { id: wrongCompany, state: 'ended', actor: 'approver' },
        { id: wrongAction, state: 'ended', actor: 'approver' }, { id: pending, state: 'awaiting_approval', actor: null },
        { id: expired, state: 'expired', actor: null }, { id: confirmed, state: 'ended', actor: null },
      ].map(row => ({ id: row.id, company_id: company.id, endpoint_id: endpointId,
        provider_session_id: `migration:${row.id}`, state: row.state, approved_by_user_id: row.actor,
        approval_code: '123456', generation: 1, credential_fingerprint: 'migration', tool_token_hash: 'a'.repeat(64),
        request_fingerprint: row.id, expires_at: new Date(), cleanup_confirmed_at: row.id === confirmed ? confirmedAt : null }));
      await client`INSERT INTO chat_voice_inbound_calls ${client(rows, 'id', 'company_id', 'endpoint_id',
        'provider_session_id', 'state', 'approved_by_user_id', 'approval_code', 'generation',
        'credential_fingerprint', 'tool_token_hash', 'request_fingerprint', 'expires_at', 'cleanup_confirmed_at')}`;
      await client`INSERT INTO activity_log (company_id, actor_id, action, entity_type, entity_id)
        VALUES (${company.id}, 'migration', 'voice.call.ended', 'voice_inbound_call', ${signed}),
          (${otherCompany.id}, 'migration', 'voice.call.ended', 'voice_inbound_call', ${wrongCompany}),
          (${company.id}, 'migration', 'voice.call.requested', 'voice_inbound_call', ${wrongAction})`;
      await client.unsafe(`CREATE TABLE voice_cleanup_backfill_probe (call_id uuid NOT NULL, transaction_id bigint NOT NULL);
        CREATE FUNCTION record_voice_cleanup_backfill() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO voice_cleanup_backfill_probe VALUES (NEW.id, txid_current()); RETURN NEW; END $$;
        CREATE TRIGGER record_voice_cleanup_backfill AFTER UPDATE ON chat_voice_inbound_calls
        FOR EACH ROW WHEN (OLD.cleanup_confirmed_at IS NULL AND NEW.cleanup_confirmed_at IS NOT NULL)
        EXECUTE FUNCTION record_voice_cleanup_backfill()`);

      // A failed unique build deterministically leaves an invalid index under
      // the migration's name, as cancellation does, without timing a cancel.
      await expect(client.unsafe(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON companies ((true))`)).rejects.toThrow();
      const [invalid] = await client`SELECT indisvalid FROM pg_index WHERE indexrelid = ${indexName}::regclass`;
      expect(invalid.indisvalid).toBe(false);
      await Promise.all([applyPendingMigrations(connectionString), applyPendingMigrations(connectionString)]);
      const [rebuilt] = await client`SELECT indisvalid, pg_get_indexdef(indexrelid) AS definition
        FROM pg_index WHERE indexrelid = ${indexName}::regclass`;
      expect(rebuilt.indisvalid).toBe(true);
      expect(rebuilt.definition).toContain("chat_voice_inbound_calls");
      expect(rebuilt.definition).toContain("cleanup_confirmed_at IS NULL");
      const [history] = await client`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      expect(history.count).toBe(1);
      const [backfill] = await client`SELECT count(*)::int AS count, count(DISTINCT transaction_id)::int AS transactions
        FROM voice_cleanup_backfill_probe`;
      expect(backfill.count).toBe(1007); expect(backfill.transactions).toBeGreaterThanOrEqual(2);
      const [batch] = await client`SELECT max(size)::int AS size FROM (
        SELECT count(*) AS size FROM voice_cleanup_backfill_probe GROUP BY transaction_id
      ) groups`;
      expect(batch.size).toBeLessThanOrEqual(1000);
      const proof = await client`SELECT id, cleanup_confirmed_at FROM chat_voice_inbound_calls
        WHERE id = ANY(${[nilId, signed, denied, wrongCompany, wrongAction, pending, expired, confirmed]})`;
      for (const id of [nilId, signed]) expect(proof.find(row => row.id === id)?.cleanup_confirmed_at).toBeInstanceOf(Date);
      for (const id of [denied, wrongCompany, wrongAction, pending, expired])
        expect(proof.find(row => row.id === id)?.cleanup_confirmed_at).toBeNull();
      expect(proof.find(row => row.id === confirmed)?.cleanup_confirmed_at.getTime()).toBe(confirmedAt.getTime());
      await applyPendingMigrations(connectionString);
      const [unchanged] = await client`SELECT count(*)::int AS count FROM voice_cleanup_backfill_probe`;
      expect(unchanged.count).toBe(1007);
    } finally {
      await client?.end();
      if (admin && databaseName) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin?.end();
      await temporary?.cleanup();
    }
  }, 120_000);
});
