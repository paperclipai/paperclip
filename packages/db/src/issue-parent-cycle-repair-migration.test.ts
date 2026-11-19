import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationFile = "0500_issue_parent_cycle_repair.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function database() {
  const temporary = await startEmbeddedPostgresTestDatabase("paperclip-issue-cycle-");
  cleanups.push(temporary.cleanup);
  const sql = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(() => sql.end());
  return { ...temporary, sql };
}

async function runMigrationBody(sql: postgres.Sql) {
  await sql.begin(async tx => {
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.unsafe(statement);
    }
  });
}

async function seed(sql: postgres.Sql) {
  const companyId = randomUUID();
  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Cycle repair', 'CYP')`;
  const issue = async (parentId: string | null) => {
    const id = randomUUID();
    await sql`INSERT INTO issues (id, company_id, title, status, parent_id)
      VALUES (${id}, ${companyId}, ${`Issue ${id.slice(0, 6)}`}, 'todo', ${parentId})`;
    return id;
  };
  const selfId = await issue(null);
  await sql`UPDATE issues SET parent_id = id WHERE id = ${selfId}`;
  // 2-cycle: x -> y -> x.
  const twoA = await issue(null);
  const twoB = await issue(twoA);
  await sql`UPDATE issues SET parent_id = ${twoB} WHERE id = ${twoA}`;
  // 3-cycle: a -> b -> c -> a, with a healthy child hanging below a.
  const threeA = await issue(null);
  const threeB = await issue(threeA);
  const threeC = await issue(threeB);
  await sql`UPDATE issues SET parent_id = ${threeC} WHERE id = ${threeA}`;
  const hanger = await issue(threeA);
  // 220-cycle: far beyond the 200-step walk the first revision used, so the
  // repair must not depend on any depth bound. A child hangs below it too.
  const bigCycle = [await issue(null)];
  for (let step = 1; step < 220; step += 1) bigCycle.push(await issue(bigCycle[bigCycle.length - 1]));
  await sql`UPDATE issues SET parent_id = ${bigCycle[bigCycle.length - 1]} WHERE id = ${bigCycle[0]}`;
  const bigHanger = await issue(bigCycle[0]);
  // A healthy chain the repair must not touch.
  const chainRoot = await issue(null);
  const chainMid = await issue(chainRoot);
  const chainLeaf = await issue(chainMid);
  return { companyId, selfId, twoA, twoB, threeA, threeB, threeC, hanger, bigCycle, bigHanger, chainRoot, chainMid, chainLeaf };
}

async function parents(sql: postgres.Sql, ids: string[]) {
  const rows = await sql`SELECT id, parent_id FROM issues WHERE id IN ${sql(ids)}`;
  return Object.fromEntries(rows.map(row => [row.id, row.parent_id]));
}

describePostgres("0500 issue parent cycle repair", () => {
  it("breaks self-parent and longer cycles, keeps hanging and healthy edges, and is re-runnable", async () => {
    const { sql, connectionString } = await database();
    await applyPendingMigrations(connectionString);
    const seeded = await seed(sql);
    const members = [
      seeded.selfId, seeded.twoA, seeded.twoB,
      seeded.threeA, seeded.threeB, seeded.threeC, seeded.hanger,
      ...seeded.bigCycle, seeded.bigHanger,
      seeded.chainRoot, seeded.chainMid, seeded.chainLeaf,
    ];

    await runMigrationBody(sql);

    const after = await parents(sql, members);
    // Self-parent edge is gone.
    expect(after[seeded.selfId]).toBeNull();
    // Every member of a longer cycle loses its parent edge; the cycle cannot survive.
    expect(after[seeded.twoA]).toBeNull();
    expect(after[seeded.twoB]).toBeNull();
    expect(after[seeded.threeA]).toBeNull();
    expect(after[seeded.threeB]).toBeNull();
    expect(after[seeded.threeC]).toBeNull();
    // A child hanging below a cycle keeps its (now acyclic) parent edge.
    expect(after[seeded.hanger]).toBe(seeded.threeA);
    // A cycle longer than 200 members is fully repaired: every edge in it goes.
    for (const id of seeded.bigCycle) expect(after[id]).toBeNull();
    expect(after[seeded.bigHanger]).toBe(seeded.bigCycle[0]);
    // The healthy chain is untouched.
    expect(after[seeded.chainMid]).toBe(seeded.chainRoot);
    expect(after[seeded.chainLeaf]).toBe(seeded.chainMid);

    // Re-running repairs nothing further: the migration is idempotent.
    await runMigrationBody(sql);
    expect(await parents(sql, members)).toEqual(after);
    expect(await inspectMigrations(connectionString)).toMatchObject({ status: "upToDate" });
  }, 60_000);
});
