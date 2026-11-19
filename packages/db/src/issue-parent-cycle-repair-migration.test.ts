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
  const issueChain = async (length: number, firstParent: string | null) => {
    if (length === 0) return [];
    const ids = Array.from({ length }, () => randomUUID());
    const values = ids
      .map((_, index) => `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5})`)
      .join(", ");
    const params = ids.flatMap((id, index) => [
      id, companyId, `Issue ${id.slice(0, 6)}`, "todo", index === 0 ? firstParent : ids[index - 1],
    ]);
    await sql.unsafe(
      `INSERT INTO issues (id, company_id, title, status, parent_id) VALUES ${values}`,
      params,
    );
    return ids;
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
  // 1000-cycle: the scale the round-2 review flagged. The repair must stay
  // linear in the cycle length (no per-row path arrays), so a cycle this long
  // repairs quickly instead of copying quadratic path contents into temp.
  // A child hangs below it too.
  const longCycle = await issueChain(1000, null);
  await sql`UPDATE issues SET parent_id = ${longCycle[longCycle.length - 1]} WHERE id = ${longCycle[0]}`;
  const longHanger = await issue(longCycle[0]);
  // A deep healthy chain (nested issues are allowed) the repair must not
  // touch: reachability over it must stay linear in the issue count, not a
  // walk from every row.
  const deepChain = await issueChain(300, null);
  // A healthy chain the repair must not touch.
  const chainRoot = await issue(null);
  const chainMid = await issue(chainRoot);
  const chainLeaf = await issue(chainMid);
  return { companyId, selfId, twoA, twoB, threeA, threeB, threeC, hanger, bigCycle, bigHanger, longCycle, longHanger, deepChain, chainRoot, chainMid, chainLeaf };
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
      ...seeded.longCycle, seeded.longHanger,
      ...seeded.deepChain,
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
    // A 1000-member cycle is fully repaired with the staging repair: every
    // edge in it goes without quadratic temp copying.
    for (const id of seeded.longCycle) expect(after[id]).toBeNull();
    expect(after[seeded.longHanger]).toBe(seeded.longCycle[0]);
    // The deep healthy chain keeps every parent edge.
    for (let step = 1; step < seeded.deepChain.length; step += 1) {
      expect(after[seeded.deepChain[step]]).toBe(seeded.deepChain[step - 1]);
    }
    // The healthy chain is untouched.
    expect(after[seeded.chainMid]).toBe(seeded.chainRoot);
    expect(after[seeded.chainLeaf]).toBe(seeded.chainMid);

    // Re-running repairs nothing further: the migration is idempotent.
    await runMigrationBody(sql);
    expect(await parents(sql, members)).toEqual(after);
    expect(await inspectMigrations(connectionString)).toMatchObject({ status: "upToDate" });
  }, 120_000);
});
