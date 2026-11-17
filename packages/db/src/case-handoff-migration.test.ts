import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationNames = [
  "0363_steady_storm.sql", "0364_clear_maria_hill.sql", "0365_naive_shatterstar.sql",
  "0366_superb_adam_warlock.sql", "0367_noisy_lilandra.sql", "0368_abandoned_bucky.sql",
];
const migrations = await Promise.all(migrationNames.map(async name => {
  const body = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
  return { name, body, hash: createHash("sha256").update(body).digest("hex") };
}));
// Receipts written by feature checkouts before these migrations were renumbered
// to follow master. Keep them as historical receipts, rather than rewriting them.
const legacyHashes = [
  "aff5773e553ed3f698bf068ebe65703dfbb1572961986eeb1dfb3654632e8277",
  "7029364157e542096c254b628a76bbe38f50b081f0ff390f399d46d88fa2900a",
  "c7249783638bddaa9c86cf5e1d5139ee832063394fec000d3a47b84fdcb2e924",
  "99f7d24f4b8db5ae2b718112ead427d94ebf302031ef9bde50e522e894b1c3db",
  "343a69c1f20fea11adf9a9cddd77dced125c673522ed50a6615a67a87096689e",
];
// These byte-identical SQL receipts were written before master added its own
// 0362 migration. Renaming our files must not replay or rewrite those receipts.
const previousFeatureReceipts = [
  { hash: "b9270a6d233463f808aba4360f4478f30eba4604e0d105ecc53970191671c6d8", createdAt: 1792498810598 },
  { hash: "aa979e1f432aed46873d5e94465bb134f8aa171c6f3a6c0a2704961e602af3cb", createdAt: 1792498810599 },
  { hash: "1a44b0f62f4bb617a16295378b48412da9baf1684bb31fa7a71dca5bc421e0a2", createdAt: 1792498810600 },
  { hash: "13006eb46e3a1b91389abd71301f03471207297ac0208f07911ac60e27930f59", createdAt: 1792498810601 },
  { hash: "6339672e38d852726eae64478250e0bc3628c248d8419c65aeced0431f0c86e5", createdAt: 1792498810602 },
  { hash: "ed8849bb66aac03150a1414db4485fc086aab6608c8e838b9621efb062d0b0cb", createdAt: 1792507212651 },
];
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function database() {
  const temporary = await startEmbeddedPostgresTestDatabase("paperclip-case-migration-");
  cleanups.push(temporary.cleanup);
  const sql = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(() => sql.end());
  return { ...temporary, sql };
}

async function seed(sql: postgres.Sql) {
  const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID();
  const issueId = randomUUID(), doneIssueId = randomUUID(), caseId = randomUUID(), doneCaseId = randomUUID();
  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Case migration', 'CMG')`;
  await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${agentId}, ${companyId}, 'Case agent', 'engineer', 'process')`;
  await sql`INSERT INTO projects (id, company_id, name, visibility) VALUES (${projectId}, ${companyId}, 'Private research', 'private')`;
  await sql`INSERT INTO issues (id, company_id, title, status, assignee_agent_id) VALUES
    (${issueId}, ${companyId}, 'Retained source', 'todo', ${agentId}),
    (${doneIssueId}, ${companyId}, 'Completed work', 'done', ${agentId})`;
  await sql`INSERT INTO cases (id, company_id, project_id, case_number, identifier, case_type, title, fields) VALUES
    (${caseId}, ${companyId}, ${projectId}, 1, 'CMG-C1', 'receipt', 'Saved receipt', '{"items":[{"quantity":2,"unitPrice":3}]}'),
    (${doneCaseId}, ${companyId}, null, 2, 'CMG-C2', 'receipt', 'Completed receipt', '{"total":6}')`;
  await sql`INSERT INTO case_issue_links (company_id, case_id, issue_id, role) VALUES (${companyId}, ${caseId}, ${issueId}, 'work')`;
  await sql`INSERT INTO case_events (company_id, case_id, kind, actor_type, payload) VALUES (${companyId}, ${caseId}, 'created', 'system', '{"saved":true}')`;
  const documentId = randomUUID();
  await sql`INSERT INTO documents (id, company_id, title, latest_body) VALUES (${documentId}, ${companyId}, 'Research', 'Preserved findings')`;
  await sql`INSERT INTO case_documents (company_id, case_id, document_id, key) VALUES (${companyId}, ${caseId}, ${documentId}, 'research')`;
  return { companyId, agentId, projectId, issueId, doneIssueId, caseId, doneCaseId };
}

async function contents(sql: postgres.Sql) {
  const tables = ["cases", "case_access_sources", "case_handoffs", "case_issue_links", "case_events", "case_documents", "documents", "issue_comments"];
  const rows = await Promise.all(tables.map(table => sql.unsafe(`SELECT * FROM "${table}" ORDER BY id`)));
  return Object.fromEntries(tables.map((table, index) => [table, rows[index]]));
}

async function guards(sql: postgres.Sql) {
  return {
    constraints: await sql`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid IN ('cases'::regclass, 'case_access_sources'::regclass, 'case_handoffs'::regclass, 'case_events'::regclass) ORDER BY conname`,
    indexes: await sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
      AND tablename IN ('cases', 'case_access_sources', 'case_handoffs', 'case_events') ORDER BY indexname`,
  };
}

async function expectActorContextColumn(sql: postgres.Sql) {
  expect(await sql`SELECT data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'case_handoffs' AND column_name = 'actor_context'`)
    .toEqual([{ data_type: "jsonb", is_nullable: "YES", column_default: null }]);
}

describePostgres("case handoff migration upgrades", () => {
  it("preserves passive case data and backfills every retained source on a first upgrade", async () => {
    const { sql, connectionString } = await database();
    await sql`DROP TABLE case_handoffs, case_access_sources`;
    await sql`ALTER TABLE cases DROP COLUMN work_issue_id, DROP COLUMN phase, DROP COLUMN handoff_version`;
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN ${sql(migrations.map(row => row.hash))}`;
    const row = await seed(sql);
    const before = await contentsWithoutRouting(sql);
    await applyPendingMigrations(connectionString);
    expect(await contentsWithoutRouting(sql)).toEqual(before);
    expect(await sql`SELECT work_issue_id, phase, handoff_version FROM cases WHERE id = ${row.caseId}`)
      .toEqual([{ work_issue_id: null, phase: null, handoff_version: 0 }]);
    expect(await sql`SELECT source_kind, source_id FROM case_access_sources WHERE case_id = ${row.caseId} ORDER BY source_kind`)
      .toEqual([{ source_kind: "issue", source_id: row.issueId }, { source_kind: "project", source_id: row.projectId }]);
    expect(await sql`SELECT count(*)::int AS count FROM case_handoffs`).toEqual([{ count: 0 }]);
    await expectActorContextColumn(sql);
    expect(await inspectMigrations(connectionString)).toMatchObject({ status: "upToDate" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("adds nullable actor context without inventing authority for existing handoffs", async () => {
    const { sql, connectionString } = await database();
    const actorContextMigration = migrations.find(migration => migration.name === "0368_abandoned_bucky.sql")!;
    await sql`ALTER TABLE case_handoffs DROP COLUMN actor_context`;
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${actorContextMigration.hash}`;
    const row = await seed(sql);
    await sql`UPDATE cases SET work_issue_id = ${row.issueId}, phase = 'verification', handoff_version = 1 WHERE id = ${row.caseId}`;
    const handoffId = randomUUID();
    await sql`INSERT INTO case_handoffs (id, company_id, case_id, issue_id, version, from_agent_id, destination_kind,
      to_agent_id, phase, instructions, actor_type, actor_id, wakeup_request_id, idempotency_key, input_fingerprint, state) VALUES
      (${handoffId}, ${row.companyId}, ${row.caseId}, ${row.issueId}, 1, ${row.agentId}, 'agent', ${row.agentId},
      'verification', 'Preserve legacy intent', 'agent', ${row.agentId}, ${randomUUID()}, 'legacy-context', 'fingerprint', 'pending_dispatch')`;
    const [before] = await sql`SELECT * FROM case_handoffs WHERE id = ${handoffId}`;
    expect(await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'case_handoffs' AND column_name = 'actor_context'`).toEqual([]);
    expect(await inspectMigrations(connectionString)).toMatchObject({ status: "needsMigrations", pendingMigrations: [actorContextMigration.name] });

    await applyPendingMigrations(connectionString);

    await expectActorContextColumn(sql);
    expect(await sql`SELECT * FROM case_handoffs WHERE id = ${handoffId}`).toEqual([{ ...before, actor_context: null }]);
    expect(await inspectMigrations(connectionString)).toMatchObject({ status: "upToDate" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("replays over old feature receipts without losing records, terminal rows, or schema guards", async () => {
    const { sql, connectionString } = await database();
    const row = await seed(sql);
    await sql`UPDATE cases SET work_issue_id = ${row.issueId}, phase = 'verification', handoff_version = 2 WHERE id = ${row.caseId}`;
    await sql`UPDATE cases SET work_issue_id = ${row.doneIssueId}, phase = 'done', handoff_version = 1, status = 'done', completed_at = now() WHERE id = ${row.doneCaseId}`;
    await sql`INSERT INTO case_access_sources (company_id, case_id, source_kind, source_id) VALUES
      (${row.companyId}, ${row.caseId}, 'issue', ${row.issueId}), (${row.companyId}, ${row.caseId}, 'project', ${row.projectId})`;
    await sql`INSERT INTO case_handoffs (company_id, case_id, issue_id, version, from_agent_id, destination_kind, to_agent_id,
      phase, instructions, actor_type, actor_id, wakeup_request_id, idempotency_key, input_fingerprint, state, completed_at) VALUES
      (${row.companyId}, ${row.caseId}, ${row.issueId}, 2, ${row.agentId}, 'agent', ${row.agentId}, 'verification', 'Verify saved receipt', 'agent', ${row.agentId}, ${randomUUID()}, 'pending', 'fingerprint', 'pending_dispatch', null),
      (${row.companyId}, ${row.doneCaseId}, ${row.doneIssueId}, 1, ${row.agentId}, 'done', null, 'done', 'Receipt completed', 'agent', ${row.agentId}, ${randomUUID()}, 'done', 'fingerprint', 'completed', now())`;
    await sql`INSERT INTO case_events (company_id, case_id, kind, actor_type) VALUES (${row.companyId}, ${row.doneCaseId}, 'handoff_completed', 'system')`;
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN ${sql(migrations.map(item => item.hash))}`;
    for (const [index, hash] of legacyHashes.entries()) {
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${1792415648299 + index})`;
    }
    const before = await contents(sql), beforeGuards = await guards(sql);
    const beforeHistory = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
    expect(await inspectMigrations(connectionString)).toMatchObject({ status: "needsMigrations", pendingMigrations: migrationNames });
    await applyPendingMigrations(connectionString);
    expect(await contents(sql)).toEqual(before);
    expect(await guards(sql)).toEqual(beforeGuards);
    await expectActorContextColumn(sql);
    const afterHistory = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
    expect(afterHistory).toEqual(expect.arrayContaining(beforeHistory));
    expect(afterHistory).toHaveLength(beforeHistory.length + migrations.length);
    await applyPendingMigrations(connectionString);
    expect(await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(afterHistory);
    expect(await inspectMigrations(connectionString)).toMatchObject({ status: "upToDate" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("recognizes every already-applied receipt from the previous feature numbering", async () => {
    const { sql, connectionString } = await database();
    const row = await seed(sql);
    await sql`UPDATE cases SET work_issue_id = ${row.issueId}, phase = 'verification', handoff_version = 1 WHERE id = ${row.caseId}`;
    await sql`INSERT INTO case_handoffs (company_id, case_id, issue_id, version, from_agent_id, destination_kind,
      to_agent_id, phase, instructions, actor_type, actor_id, actor_context, wakeup_request_id, idempotency_key, input_fingerprint, state) VALUES
      (${row.companyId}, ${row.caseId}, ${row.issueId}, 1, ${row.agentId}, 'agent', ${row.agentId},
      'verification', 'Keep the existing authority context', 'agent', ${row.agentId}, '{"preserved":true}',
      ${randomUUID()}, 'previous-numbering', 'fingerprint', 'pending_dispatch')`;
    expect(migrations.map(migration => migration.hash)).toEqual(previousFeatureReceipts.map(receipt => receipt.hash));
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN ${sql(migrations.map(migration => migration.hash))}`;
    for (const receipt of previousFeatureReceipts) {
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${receipt.hash}, ${receipt.createdAt})`;
    }
    const before = await contents(sql), beforeGuards = await guards(sql);
    const beforeHistory = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
    expect(await inspectMigrations(connectionString)).toMatchObject({ status: "upToDate" });
    await applyPendingMigrations(connectionString);
    expect(await contents(sql)).toEqual(before);
    expect(await guards(sql)).toEqual(beforeGuards);
    expect(await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(beforeHistory);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rolls back the complete migration and its receipt when a replacement guard fails", async () => {
    const { sql, connectionString } = await database();
    const row = await seed(sql);
    await sql`ALTER TABLE case_handoffs DROP CONSTRAINT case_handoffs_destination_check, DROP CONSTRAINT case_handoffs_destination_state_check`;
    await sql`INSERT INTO case_handoffs (company_id, case_id, issue_id, version, destination_kind, phase, instructions,
      actor_type, actor_id, wakeup_request_id, idempotency_key, input_fingerprint, state) VALUES
      (${row.companyId}, ${row.caseId}, ${row.issueId}, 1, 'invalid', 'triage', 'Legacy invalid destination',
      'system', 'system', ${randomUUID()}, 'invalid', 'fingerprint', 'delivered')`;
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrations[3]!.hash}`;
    const before = await contents(sql), beforeGuards = await guards(sql);
    const beforeHistory = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
    await expect(applyPendingMigrations(connectionString)).rejects.toMatchObject({ code: "23514", constraint_name: "case_handoffs_destination_check" });
    expect(await contents(sql)).toEqual(before);
    expect(await guards(sql)).toEqual(beforeGuards);
    expect(await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(beforeHistory);
    expect(await inspectMigrations(connectionString)).toMatchObject({ status: "needsMigrations", pendingMigrations: [migrationNames[3]] });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});

async function contentsWithoutRouting(sql: postgres.Sql) {
  return {
    cases: await sql`SELECT id, company_id, project_id, case_number, identifier, case_type, title, fields, status FROM cases ORDER BY id`,
    links: await sql`SELECT * FROM case_issue_links ORDER BY id`,
    events: await sql`SELECT * FROM case_events ORDER BY id`,
    documents: await sql`SELECT * FROM documents ORDER BY id`,
    caseDocuments: await sql`SELECT * FROM case_documents ORDER BY id`,
  };
}
