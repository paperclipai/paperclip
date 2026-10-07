import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const journal = JSON.parse(readFileSync(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"));
const hashes = journal.entries.filter((entry: { tag: string }) => entry.tag === "0312_easy_eternity").map((entry: { tag: string }) => `${entry.tag}.sql`).map((name: string) =>
  createHash("sha256").update(readFileSync(new URL(`./migrations/${name}`, import.meta.url))).digest("hex"));

async function historicalDatabase() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-accounting-upgrade-");
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  // Restore the complete predecessor shape for the changed tables, including
  // the old uniqueness predicate and migration journal. Upgrade uses the real
  // production migrator, not hand-picked statements from the migration.
  await sql.unsafe(`
    DROP TABLE provider_billing_snapshots, cost_adjustments, billing_invoice_lines, billing_invoices, budget_reservations, run_usage_receipts, accounting_runtime_baselines;
    DROP INDEX cost_events_company_project_occurred_idx;
    DROP INDEX cost_events_unpriced_idx;
    ALTER TABLE cost_events DROP COLUMN provider_request_id, DROP COLUMN reported_cost_cents, DROP COLUMN pricing_provenance;
    ALTER TABLE heartbeat_runs DROP COLUMN accounting_projection_version, DROP COLUMN accounting_last_attempt_at, DROP COLUMN accounting_last_error, DROP COLUMN accounting_attempt_count;
    ALTER TABLE budget_policies DROP COLUMN reservation_cents;
    ALTER TABLE companies DROP COLUMN spend_month_utc;
    ALTER TABLE agents DROP COLUMN spend_month_utc;
    ALTER TABLE finance_events ALTER COLUMN amount_cents TYPE integer;
    ALTER TABLE status_card_updates ALTER COLUMN cost_cents TYPE integer;
    ALTER TABLE cost_events DROP CONSTRAINT cost_events_nonnegative_amounts;
    ALTER TABLE cost_events DROP COLUMN idempotency_key, DROP COLUMN receipt_hash;
    ALTER TABLE finance_events DROP COLUMN idempotency_key, DROP COLUMN receipt_hash;
    ALTER TABLE heartbeat_runs DROP COLUMN cost_accounting_pending, DROP COLUMN cost_accounted_at;
    ALTER TABLE budget_policies DROP COLUMN enforcement_version, DROP COLUMN enforcement_delivered_version, DROP COLUMN unpriced_usage_policy;
    ALTER TABLE cost_events ALTER COLUMN cost_cents TYPE integer;
    ALTER TABLE companies ALTER COLUMN spent_monthly_cents TYPE integer;
    ALTER TABLE agents ALTER COLUMN spent_monthly_cents TYPE integer;
    ALTER TABLE agent_runtime_state ALTER COLUMN total_cost_cents TYPE bigint;
    ALTER TABLE budget_incidents ALTER COLUMN amount_observed TYPE integer;
    DROP INDEX budget_incidents_policy_window_threshold_idx;
    CREATE UNIQUE INDEX budget_incidents_policy_window_threshold_idx
      ON budget_incidents (policy_id, window_start, threshold_type) WHERE status <> 'dismissed';
  `);
  await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN ${sql(hashes)}`;
  return { database, sql, close: async () => { await sql.end(); await database.cleanup(); } };
}

(support.supported ? describe : describe.skip)("cost accounting historical upgrade", () => {
  it("preserves historical receipts, counters, references, finance currencies and incident history", async () => {
    const f = await historicalDatabase();
    const { sql } = f;
    const company = randomUUID(), agent = randomUUID(), run = randomUUID(), policy = randomUUID();
    try {
      await sql`INSERT INTO companies (id,name,issue_prefix,spent_monthly_cents) VALUES (${company},'Historical','HIST',2147483647)`;
      await sql`INSERT INTO agents (id,company_id,name,spent_monthly_cents) VALUES (${agent},${company},'Historical worker',2147483647)`;
      await sql`INSERT INTO heartbeat_runs (id,company_id,agent_id,status,usage_json,finished_at)
        VALUES (${run},${company},${agent},'succeeded','{"inputTokens":42,"costUsd":0.004}', '2025-12-31T23:59:59Z')`;
      await sql`INSERT INTO agent_runtime_state (agent_id,company_id,adapter_type,total_cost_cents,total_input_tokens)
        VALUES (${agent},${company},'codex_local',9007199254740993,42)`;
      await sql`INSERT INTO cost_events (company_id,agent_id,heartbeat_run_id,provider,model,input_tokens,output_tokens,cost_cents,occurred_at)
        VALUES (${company},${agent},${run},'historical','old-model',42,5,2147483647,'2025-12-31T23:59:59Z'),
          (${company},${agent},${run},'historical','old-model',0,0,0,'2026-01-01T00:00:00Z')`;
      await sql`INSERT INTO finance_events (company_id,event_kind,direction,biller,amount_cents,currency,occurred_at,external_invoice_id)
        VALUES (${company},'adjustment','debit','historical',12345,'EUR',now(),'invoice-1'),
          (${company},'adjustment','credit','historical',789,'USD',now(),'invoice-1')`;
      await sql`INSERT INTO budget_policies (id,company_id,scope_type,scope_id,metric,window_kind,amount)
        VALUES (${policy},${company},'agent',${agent},'billed_cents','calendar_month_utc',100)`;
      await sql`INSERT INTO budget_incidents (company_id,policy_id,scope_type,scope_id,metric,window_kind,window_start,window_end,threshold_type,amount_limit,amount_observed,status)
        VALUES (${company},${policy},'agent',${agent},'billed_cents','calendar_month_utc','2026-01-01Z','2026-02-01Z','hard',100,101,'resolved'),
          (${company},${policy},'agent',${agent},'billed_cents','calendar_month_utc','2026-01-01Z','2026-02-01Z','hard',100,101,'dismissed')`;
      const before = await sql`SELECT id,company_id,agent_id,heartbeat_run_id,provider,model,cost_cents::text,input_tokens,occurred_at FROM cost_events ORDER BY id`;
      const financeBefore = await sql`SELECT id,event_kind,direction,amount_cents,currency,external_invoice_id FROM finance_events ORDER BY id`;
      await applyPendingMigrations(f.database.connectionString);
      await applyPendingMigrations(f.database.connectionString);
      expect((await inspectMigrations(f.database.connectionString)).status).toBe("upToDate");
      const after = await sql`SELECT id,company_id,agent_id,heartbeat_run_id,provider,model,cost_cents::text,input_tokens,occurred_at FROM cost_events ORDER BY id`;
      expect(after.map(row => ({ ...row, cost_cents: Number(row.cost_cents) }))).toEqual(before.map(row => ({ ...row, cost_cents: Number(row.cost_cents) })));
      expect((await sql`SELECT id,event_kind,direction,amount_cents,currency,external_invoice_id FROM finance_events ORDER BY id`).map(row => ({ ...row, amount_cents: Number(row.amount_cents) }))).toEqual(financeBefore);
      expect(await sql`SELECT cost_accounting_pending,cost_accounted_at FROM heartbeat_runs WHERE id=${run}`).toEqual([{ cost_accounting_pending: false, cost_accounted_at: null }]);
      expect(await sql`SELECT enforcement_version,enforcement_delivered_version,unpriced_usage_policy FROM budget_policies WHERE id=${policy}`)
        .toEqual([{ enforcement_version: 0, enforcement_delivered_version: 0, unpriced_usage_policy: "block" }]);
      for (const [table, column, expected] of [["companies","spent_monthly_cents","2147483647.0000000"],["agents","spent_monthly_cents","2147483647.0000000"],["agent_runtime_state","total_cost_cents","9007199254740993.0000000"]]) {
        expect((await sql.unsafe(`SELECT ${column}::text AS value FROM ${table}`))[0].value).toBe(expected);
      }
      expect(await sql`SELECT DISTINCT idempotency_key,receipt_hash FROM cost_events`).toEqual([{ idempotency_key: null, receipt_hash: null }]);
      expect((await sql`SELECT reservation_cents::text FROM budget_policies WHERE id=${policy}`)[0].reservation_cents).toBe("0.0000000");
      expect((await sql`SELECT spend_month_utc FROM companies WHERE id=${company}`)[0].spend_month_utc).toBeNull();
      await sql`INSERT INTO finance_events (company_id,event_kind,biller,amount_cents,currency,occurred_at) VALUES (${company},'adjustment','new',0.0000001,'USD',now())`;
      expect((await sql`SELECT amount_cents::text FROM finance_events WHERE biller='new'`)[0].amount_cents).toBe("0.0000001");
      // Closed historical incidents must not prevent a fresh threshold crossing.
      const insertIncident = () => sql`INSERT INTO budget_incidents (company_id,policy_id,scope_type,scope_id,metric,window_kind,window_start,window_end,threshold_type,amount_limit,amount_observed,status)
        VALUES (${company},${policy},'agent',${agent},'billed_cents','calendar_month_utc','2026-01-01Z','2026-02-01Z','hard',150,150.4,'open')`;
      await insertIncident();
      await expect(insertIncident()).rejects.toMatchObject({ code: "23505" });
      expect(await sql`SELECT status FROM budget_incidents ORDER BY status`).toEqual([{ status:"dismissed" },{ status:"open" },{ status:"resolved" }]);
      await sql`INSERT INTO cost_events (company_id,agent_id,provider,model,cost_cents,occurred_at,idempotency_key)
        VALUES (${company},${agent},'new','model',0.0000001,now(),'new-receipt')`;
      expect((await sql`SELECT cost_cents::text FROM cost_events WHERE idempotency_key='new-receipt'`)[0].cost_cents).toBe("0.0000001");
      await expect(sql`INSERT INTO cost_events (company_id,agent_id,provider,model,cost_cents,occurred_at,idempotency_key)
        VALUES (${company},${agent},'new','model',1,now(),'new-receipt')`).rejects.toMatchObject({ code: "23505" });
      // A development deployment can have applied this schema under an older
      // migration number. Replaying the SQL must preserve both old and new rows.
      const beforeReplay = await sql`SELECT id,cost_cents::text FROM cost_events ORDER BY id`;
      const migration = readFileSync(new URL("./migrations/0312_easy_eternity.sql", import.meta.url), "utf8");
      await sql.begin(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) await tx.unsafe(statement);
      });
      expect(await sql`SELECT id,cost_cents::text FROM cost_events ORDER BY id`).toEqual(beforeReplay);
    } finally { await f.close(); }
  }, 60_000);

  it("rejects invalid historical amounts atomically and can retry after explicit repair", async () => {
    const f = await historicalDatabase(); const { sql } = f;
    const company = randomUUID(), agent = randomUUID();
    try {
      await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${company},'Invalid historical','BAD')`;
      await sql`INSERT INTO agents (id,company_id,name) VALUES (${agent},${company},'Worker')`;
      await sql`INSERT INTO cost_events (company_id,agent_id,provider,model,cost_cents,occurred_at) VALUES (${company},${agent},'old','old',-1,now())`;
      const journal = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
      await expect(applyPendingMigrations(f.database.connectionString)).rejects.toThrow();
      expect(await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(journal);
      expect((await sql`SELECT data_type FROM information_schema.columns WHERE table_name='cost_events' AND column_name='cost_cents'`)[0].data_type).toBe("integer");
      expect(await sql`SELECT column_name FROM information_schema.columns WHERE table_name='cost_events' AND column_name='idempotency_key'`).toHaveLength(0);
      expect((await sql`SELECT cost_cents FROM cost_events`)[0].cost_cents).toBe(-1);
      await sql`UPDATE cost_events SET cost_cents=0`;
      await applyPendingMigrations(f.database.connectionString);
      expect((await inspectMigrations(f.database.connectionString)).status).toBe("upToDate");
    } finally { await f.close(); }
  }, 60_000);
});
