import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

let db: Db;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let companyId: string;
const gate = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { opened, open }; };
// Counts backends blocked on a heavyweight lock while running a query that matches the pattern.
const lockWaiters = async (pattern: string) => (await db.execute<{ count: number }>(sql`select count(*)::int as count
  from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like ${pattern}`))[0]?.count;

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("paperclip-checkout-deadlock-");
  db = createDb(database.connectionString);
  [{ id: companyId }] = await db.insert(companies)
    .values({ name: "KCD", issuePrefix: "KCD", defaultResponsibleUserId: "checkout-test-owner" }).returning();
});
afterAll(async () => {
  await database?.cleanup();
});

it("run setup checkout retries as the deadlock victim instead of failing", async () => {
  const [agent] = await db.insert(agents).values({ companyId, name: randomUUID(), role: "engineer" }).returning();
  const [issue] = await db.insert(issues)
    .values({ companyId, title: "Checkout deadlock", status: "todo", priority: "medium", assigneeAgentId: agent.id }).returning();
  const writerLocked = gate(), writerContinues = gate();
  // A writer holds the agent row, then needs the issue the checkout locked.
  const writer = db.transaction(async tx => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id)).for("update");
    writerLocked.open(); await writerContinues.opened;
    await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue.id)).for("update");
  });
  await writerLocked.opened;
  const checkout = issueService(db).checkout(issue.id, agent.id, ["todo"], null);
  void checkout.catch(() => undefined);
  // The checkout holds the issue and waits for its agent share lock, so its
  // deadlock timer fires first and it is the victim of the cycle.
  await vi.waitFor(async () => expect(await lockWaiters('select "id", "company_id", "permissions" from "agents"%')).toBe(1),
    { timeout: 10_000, interval: 25 });
  writerContinues.open();
  const [writerResult, checkoutResult] = await Promise.allSettled([writer, checkout]);
  expect(writerResult.status).toBe("fulfilled");
  expect(checkoutResult).toMatchObject({ status: "fulfilled", value: { id: issue.id, status: "in_progress", assigneeAgentId: agent.id } });
}, 30_000);
