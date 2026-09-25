import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// `secret_access_events` is an audit trail. Every granted-secret read appends a
// row, and the row carries the issue and the heartbeat run it was read for.
// While those two columns carried foreign keys, a single INSERT took a
// `FOR KEY SHARE` row lock on `issues` AND on `heartbeat_runs` — the two hottest
// operational tables — through the referential-integrity triggers.
//
// PostgreSQL fires AFTER ROW triggers in alphabetical order of trigger *name*,
// and RI triggers are named `RI_ConstraintTrigger_c_<oid>`. The order in which
// one INSERT takes those two row locks is therefore decided by OID text sort:
// it is neither the column order nor the constraint creation order, and it can
// differ between databases that ran the same migrations. When it puts
// `heartbeat_runs` first it inverts the canonical `issues` -> `heartbeat_runs`
// order that `issues.ts` uses (clearExecutionRunIfTerminal,
// clearCheckoutRunIfTerminal, adoptStaleCheckout), and the pair deadlocks:
// Postgres aborts one of them, which loses an agent execution.
//
// The fix is that the audit write holds no lock on operational rows at all.
// Both tests below fail on the unfixed schema and neither depends on trigger
// ordering, so they reproduce the production deadlock deterministically.

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

type Fixture = {
  company: string;
  agent: string;
  issue: string;
  run: string;
};

async function seed(sql: postgres.Sql): Promise<Fixture> {
  const ids: Fixture = {
    company: randomUUID(),
    agent: randomUUID(),
    issue: randomUUID(),
    run: randomUUID(),
  };
  await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${ids.company},'Lock order fixture','LCK')`;
  await sql`INSERT INTO agents (id,company_id,name) VALUES (${ids.agent},${ids.company},'Agent')`;
  await sql`INSERT INTO issues (id,company_id,title,status) VALUES (${ids.issue},${ids.company},'Fixture','in_progress')`;
  await sql`INSERT INTO heartbeat_runs (id,company_id,agent_id,status) VALUES (${ids.run},${ids.company},${ids.agent},'failed')`;
  return ids;
}

function insertAuditEvent(sql: postgres.Sql | postgres.TransactionSql, ids: Fixture) {
  return sql`
    INSERT INTO secret_access_events
      (company_id, provider, actor_type, consumer_type, consumer_id, issue_id, heartbeat_run_id, outcome)
    VALUES
      (${ids.company}, 'paperclip', 'agent', 'agent', ${ids.agent}, ${ids.issue}, ${ids.run}, 'success')`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A named session lets the test observe, through `pg_stat_activity`, the exact
// moment a transaction holds the locks it needs and is waiting on the next
// step. That replaces fixed sleeps, which assume a scheduler timing that CI
// does not guarantee: a slow holder must not make the append run before the
// operational rows are locked.
async function nameSession(sql: postgres.Sql, applicationName: string): Promise<void> {
  await sql`SELECT set_config('application_name', ${applicationName}, false)`;
}

async function waitUntilHolding(
  observer: postgres.Sql,
  applicationName: string,
  querySubstring: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const rows = await observer<{ state: string | null; query: string | null }[]>`
      SELECT state, query
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}`;
    const row = rows[0];
    if (row?.state === "idle in transaction" && (row.query ?? "").includes(querySubstring)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(
    `session ${applicationName} never reached idle-in-transaction on "${querySubstring}"`,
  );
}

describeDatabase("secret_access_events lock order", () => {
  it(
    "appends the audit row while another transaction holds the issue and run rows",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-secret-access-lock-");
      const holderName = `sto-lock-holder-${randomUUID()}`;
      const holder = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const writer = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: Promise<unknown> | undefined;
      try {
        await nameSession(holder, holderName);
        const ids = await seed(holder);

        // The execution-lock reconciler holds both rows for the length of its
        // transaction. An audit append that waits on either of them is what
        // makes the deadlock possible in the first place.
        held = holder.begin(async (tx) => {
          await tx`SELECT id FROM issues WHERE id = ${ids.issue} FOR UPDATE`;
          await tx`SELECT id FROM heartbeat_runs WHERE id = ${ids.run} FOR UPDATE`;
          await released;
        });

        // Only append once the holder really owns both row locks.
        await waitUntilHolding(writer, holderName, "heartbeat_runs");
        // A short statement timeout turns "blocked on an operational row" into
        // a fast, legible failure instead of a hang.
        await writer`SET statement_timeout = 3000`;
        await expect(insertAuditEvent(writer, ids)).resolves.toBeDefined();
      } finally {
        // Release and settle the holder before closing, so a failed assertion
        // cannot leave it blocked and hide the failure behind a test timeout.
        release();
        if (held) await held.catch(() => {});
        await holder.end();
        await writer.end();
        await database.cleanup();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "does not deadlock when the audit append reaches the two rows in inverted order",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-secret-access-deadlock-");
      const reconcilerName = `sto-lock-reconciler-${randomUUID()}`;
      const auditorName = `sto-lock-auditor-${randomUUID()}`;
      const setup = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const reconciler = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const auditor = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      let releaseCanonical: () => void = () => {};
      const canonicalReady = new Promise<void>((resolve) => {
        releaseCanonical = resolve;
      });
      let releaseAuditor: () => void = () => {};
      const auditorReady = new Promise<void>((resolve) => {
        releaseAuditor = resolve;
      });
      let transactionA: Promise<string> | undefined;
      let transactionB: Promise<string> | undefined;
      try {
        const ids = await seed(setup);
        await nameSession(reconciler, reconcilerName);
        await nameSession(auditor, auditorName);

        // Transaction A is the canonical order used across issues.ts:
        // issues first, then heartbeat_runs. It pauses while holding the issue.
        transactionA = reconciler
          .begin(async (tx) => {
            await tx`SELECT id FROM issues WHERE id = ${ids.issue} FOR UPDATE`;
            await canonicalReady;
            await tx`SELECT id FROM heartbeat_runs WHERE id = ${ids.run} FOR UPDATE`;
          })
          .then(() => "committed" as const)
          .catch((error: Error) => `failed: ${error.message}`);

        await waitUntilHolding(setup, reconcilerName, "FROM issues");

        // Transaction B reaches the same two rows in the inverted order: it
        // takes the run row first and pauses, so A can ask for the run row while
        // B still holds it.
        transactionB = auditor
          .begin(async (tx) => {
            await tx`SELECT id FROM heartbeat_runs WHERE id = ${ids.run} FOR KEY SHARE`;
            await auditorReady;
            await insertAuditEvent(tx, ids);
          })
          .then(() => "committed" as const)
          .catch((error: Error) => `failed: ${error.message}`);

        await waitUntilHolding(setup, auditorName, "heartbeat_runs");

        // A now asks for the run row that B holds, and B asks for the issue row
        // that A holds: the production cycle, with no timing assumption.
        releaseCanonical();
        releaseAuditor();

        expect(await Promise.all([transactionA, transactionB])).toEqual([
          "committed",
          "committed",
        ]);
      } finally {
        releaseCanonical();
        releaseAuditor();
        if (transactionA) await transactionA.catch(() => {});
        if (transactionB) await transactionB.catch(() => {});
        await setup.end();
        await reconciler.end();
        await auditor.end();
        await database.cleanup();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the audit table free of foreign keys into issues and heartbeat_runs",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-secret-access-fk-");
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await sql<{ conname: string; referenced: string }[]>`
          SELECT c.conname, c.confrelid::regclass::text AS referenced
          FROM pg_constraint c
          WHERE c.conrelid = 'secret_access_events'::regclass
            AND c.contype = 'f'
            AND c.confrelid::regclass::text IN ('issues', 'heartbeat_runs')`;
        expect(rows).toEqual([]);
      } finally {
        await sql.end();
        await database.cleanup();
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
