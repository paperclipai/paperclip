import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const adminUrl = process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
const support = adminUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};
const master = journal.entries.find(entry => entry.tag === "0419_slippery_impossible_man")!;
const status = journal.entries.find(entry => entry.tag === "0420_broad_johnny_storm")!;
const statusSql = await readFile(new URL(`./migrations/${status.tag}.sql`, import.meta.url), "utf8");
const hash = async (tag: string) => createHash("sha256")
  .update(await readFile(new URL(`./migrations/${tag}.sql`, import.meta.url), "utf8")).digest("hex");

async function database() {
  if (!adminUrl) return startEmbeddedPostgresTestDatabase("status-reason-upgrade-");
  const name = `status_reason_${randomUUID().replaceAll("-", "")}_test`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`create database "${name}"`); }
  finally { await admin.end(); }
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const cleanup = async () => {
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    try { await admin.unsafe(`drop database "${name}"`); }
    finally { await admin.end(); }
  };
  try { await applyPendingMigrations(url.toString()); }
  catch (error) { await cleanup(); throw error; }
  return { connectionString: url.toString(), cleanup };
}

async function seed(sql: postgres.Sql) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
  const lastMessage = new Date("2026-10-20T12:00:00.000Z");
  await sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'Migration proof', ${`M${companyId.slice(0, 10)}`})`;
  await sql`insert into agents (id, company_id, name, adapter_type) values (${agentId}, ${companyId}, 'Agent', 'process')`;
  await sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
    values (${userId}, 'Reader', ${`${userId}@example.test`}, true, now(), now())`;
  await sql`insert into issues (id, company_id, title, status, assignee_agent_id,
    conversation_agent_id, conversation_user_id, conversation_state)
    values (${issueId}, ${companyId}, 'Conversation', 'in_review', ${agentId}, ${agentId}, ${userId}, 'waiting')`;
  await sql`insert into issue_comments (company_id, issue_id, author_agent_id, author_type, body, origin, client_request_id, created_at)
    values (${companyId}, ${issueId}, ${agentId}, 'agent', 'Preserved reply', 'comment', 'retry-key', ${lastMessage})`;
  await sql`insert into issue_comments (company_id, issue_id, author_agent_id, author_type, body, origin, created_at)
    values (${companyId}, ${issueId}, ${agentId}, 'system', 'Excluded system notice', 'comment', ${new Date(lastMessage.getTime() + 1000)})`;
  const cardId = randomUUID(), savedDeadline = new Date("2026-10-21T12:00:00.000Z");
  await sql`insert into status_cards (id, company_id, interest_prompt, refresh_policy, next_eval_at, pending_change_hash)
    values (${cardId}, ${companyId}, 'Watch preserved work', '{"mode":"manual"}'::jsonb, ${savedDeadline}, 'preserved-change')`;
  return { companyId, agentId, issueId, userId, lastMessage, cardId, savedDeadline };
}

async function assertFinal(sql: postgres.Sql, row: Awaited<ReturnType<typeof seed>>, expectedRead: Date) {
  const [column] = await sql`select data_type, is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'status_cards' and column_name = 'next_eval_reason'`;
  expect(column).toMatchObject({ data_type: "text", is_nullable: "YES" });
  const [constraint] = await sql`select i.indisvalid, i.indisunique from pg_constraint c
    join pg_index i on i.indexrelid = c.conindid
    where c.conrelid = 'issue_comments'::regclass and c.conname = 'issue_comments_agent_client_request_uq'`;
  expect(constraint).toMatchObject({ indisvalid: true, indisunique: true });
  const [read] = await sql`select last_read_at from issue_read_states
    where company_id = ${row.companyId} and issue_id = ${row.issueId} and user_id = ${row.userId}`;
  expect(read.last_read_at).toEqual(expectedRead);
  const [card] = await sql`select next_eval_at, next_eval_reason, pending_change_hash from status_cards where id = ${row.cardId}`;
  expect(card).toMatchObject({ next_eval_at: row.savedDeadline, next_eval_reason: null, pending_change_hash: "preserved-change" });
  await sql`update status_cards set next_eval_reason = 'retry' where id = ${row.cardId}`;
  expect((await sql`select next_eval_at, next_eval_reason from status_cards where id = ${row.cardId}`)[0])
    .toMatchObject({ next_eval_at: row.savedDeadline, next_eval_reason: "retry" });
  await expect(sql`insert into issue_comments (company_id, issue_id, author_agent_id, body, client_request_id)
    values (${row.companyId}, ${row.issueId}, ${row.agentId}, 'Duplicate', 'retry-key')`)
    .rejects.toMatchObject({ code: "23505", constraint_name: "issue_comments_agent_client_request_uq" });
}

describe.skipIf(!support.supported)("status-card reason migration after the published comment migration", () => {
  it.each(["0418", "master0419"] as const)("upgrades from %s without dropping comment uniqueness or read history", async previous => {
    expect(master.idx).toBe(419);
    expect(status.idx).toBeGreaterThan(master.idx);
    expect(statusSql.trim()).toBe('ALTER TABLE "status_cards" ADD COLUMN "next_eval_reason" text;');
    const db = await database();
    const sql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
    try {
      // Reconstruct exactly the two migrations' preimages; all older schema and
      // receipts stay intact, as in the repository's other replay regressions.
      await sql`alter table status_cards drop column next_eval_reason`;
      await sql`delete from drizzle.__drizzle_migrations where hash = ${await hash(status.tag)}`;
      if (previous === "0418") {
        await sql`alter table issue_comments drop constraint issue_comments_agent_client_request_uq`;
        await sql`delete from drizzle.__drizzle_migrations where hash = ${await hash(master.tag)}`;
      }
      const row = await seed(sql);
      const preservedRead = new Date("2026-10-19T12:00:00.000Z");
      if (previous === "master0419") await sql`insert into issue_read_states (company_id, issue_id, user_id, last_read_at)
        values (${row.companyId}, ${row.issueId}, ${row.userId}, ${preservedRead})`;
      expect(await inspectMigrations(db.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: previous === "0418" ? [`${master.tag}.sql`, `${status.tag}.sql`] : [`${status.tag}.sql`],
      });
      await applyPendingMigrations(db.connectionString);
      expect(await inspectMigrations(db.connectionString)).toMatchObject({ status: "upToDate" });
      await assertFinal(sql, row, previous === "0418" ? row.lastMessage : preservedRead);
      const receipts = await sql`select hash from drizzle.__drizzle_migrations order by id`;
      const hashes = receipts.map(receipt => receipt.hash);
      expect(hashes.indexOf(await hash(master.tag))).toBeLessThan(hashes.indexOf(await hash(status.tag)));
      await applyPendingMigrations(db.connectionString);
      expect(await sql`select hash from drizzle.__drizzle_migrations order by id`).toEqual(receipts);
    } finally { await sql.end(); await db.cleanup(); }
  }, 90_000);
});
