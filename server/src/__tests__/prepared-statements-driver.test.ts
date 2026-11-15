import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import { nativeProgressPageQuery, nativeProgressPageStatement } from "../services/chat-native-progress.js";
import { stallWaiterPageQuery, stallWaiterPageStatement } from "../services/recovery/blocker-stall-wakeups.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("prepared reads at the driver", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const clients: Db[] = [];
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("prepared-statements-driver-"); }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const db of clients.splice(0)) await db.$client.end({ timeout: 1 });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  const companyId = randomUUID(), issueId = randomUUID(), since = new Date(Date.now() - 3_600_000);
  const stall = { companyId, issueId, actionId: randomUUID(), parentId: randomUUID() };
  const reads = [
    { name: "native chat progress page", text: "safe_native_progress_base_publication", statementName: "safe_native_chat_progress_page",
      builder: (db: Db) => nativeProgressPageQuery(db, { since, companyId, issueId, cursor: null, pageSize: 200 }),
      prepared: (db: Db) => {
        const { statement, values } = nativeProgressPageStatement(db, { since, scope: { companyId, issueId }, cursor: null, pageSize: 200 });
        return statement.execute(values);
      } },
    { name: "blocker stall waiter page", text: "issue_blocker_stalled:", statementName: "issue_blocker_stall_waiter_page",
      builder: (db: Db) => stallWaiterPageQuery(db, { companyId, stalledIssueId: stall.issueId, parentId: stall.parentId, hasParent: true,
        wakeKeySuffix: `:${stall.issueId}:${stall.actionId}` }),
      prepared: (db: Db) => {
        const { statement, values } = stallWaiterPageStatement(db, { stall, onlyIssueId: null, after: null });
        return statement.execute(values);
      } },
  ];

  it.each([
    { setting: undefined, named: false },
    { setting: false, named: false },
    { setting: true, named: true },
  ])("asks the driver for the same thing as the query builder with DATABASE_PREPARED_STATEMENTS=$setting", async ({ setting, named }) => {
    const db = createDb(temporary.connectionString, { maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0,
      ...(setting === undefined ? {} : { prepare: setting }) });
    clients.push(db);
    const serverStatements = async (text: string) => (await db.$client.unsafe(
      "select name, statement from pg_prepared_statements where statement not like '%pg_prepared_statements%'", [], { prepare: false }))
      .filter(row => String(row.statement).includes(text)).map(row => String(row.name));
    for (const read of reads) {
      const driver = vi.spyOn(db.$client, "unsafe");
      const sent = async (run: (db: Db) => PromiseLike<unknown>) => {
        driver.mockClear();
        expect(await run(db)).toEqual([]);
        expect(driver).toHaveBeenCalledTimes(1);
        const query = driver.mock.results[0]!.value as { options: { prepare?: boolean; simple?: boolean } };
        return { arguments: driver.mock.calls[0], options: { ...query.options }, serverStatements: await serverStatements(read.text) };
      };
      const builder = await sent(read.builder), prepared = await sent(read.prepared), repeated = await sent(read.prepared);
      driver.mockRestore();
      expect(prepared).toStrictEqual(builder);
      expect(repeated).toStrictEqual(builder);
      expect(builder.arguments).toHaveLength(2);
      expect(String(builder.arguments![0])).toContain(read.text);
      expect(builder.options).toEqual({ prepare: named, simple: false });
      expect(builder.serverStatements).toHaveLength(named ? 1 : 0);
      expect(builder.serverStatements.join()).not.toContain(read.statementName);
    }
  });
});
