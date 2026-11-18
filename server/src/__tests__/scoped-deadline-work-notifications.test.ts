import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import { DATABASE_WORK_CHANNEL, enableDatabaseWorkNotifications, receiveDatabaseWorkNotification,
  signalDatabaseWork } from "@paperclipai/db/work-signals";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../services/scoped-deadline-work.js";

type Entry = { id: string; companyId: string; dueAt: number };
const COMPANIES = 20;
const ROWS_PER_COMPANY = 40;
const queue = DELIVERY_QUEUES.secretProposalExpiry;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("scoped deadline work across server processes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sender: ReturnType<typeof createDb>, receiver: ReturnType<typeof createDb>, listener: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  const loads: string[] = [];
  let rowsLoaded = 0;
  const onError = vi.fn();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("scoped-deadline-notifications-");
    sender = createDb(database.connectionString);
    receiver = createDb(database.connectionString);
    listener = createDb(database.connectionString, { maxConnections: 1 });
    enableDatabaseWorkNotifications(sender);
    enableDatabaseWorkNotifications(receiver);
    await sender.execute(sql`create table scoped_deadline_fixture (id text primary key, company_id text not null)`);
    await sender.execute(sql`insert into scoped_deadline_fixture
      select 'company-' || c || '-' || r, 'company-' || c
      from generate_series(1, ${COMPANIES}::int) as c, generate_series(1, ${ROWS_PER_COMPANY}::int) as r`);
    await listener.$client.listen(DATABASE_WORK_CHANNEL, payload => receiveDatabaseWorkNotification(receiver, payload));
    coordinator = createDeliveryWorkCoordinator({ owner: receiver, canRun: () => true, onError });
    const worker = registerScopedDeadlineWork<Entry, string>(coordinator, {
      queue,
      minimumPassIntervalMs: 0,
      decodeScope: hint => hint === "*" ? undefined : hint,
      matches: (entry, companyId) => companyId === undefined || entry.companyId === companyId,
      scopeKey: { entry: entry => entry.companyId, scope: companyId => companyId },
      load: async companyId => {
        const rows = companyId === undefined
          ? await receiver.execute<{ id: string; company_id: string }>(sql`select id, company_id from scoped_deadline_fixture`)
          : await receiver.execute<{ id: string; company_id: string }>(sql`select id, company_id from scoped_deadline_fixture
            where company_id = ${companyId}`);
        rowsLoaded += rows.length;
        loads.push(companyId ?? "*");
        return rows.map(row => ({ id: row.id, companyId: row.company_id, dueAt: Date.now() + 3_600_000 }));
      },
      check: async entry => entry,
    }, () => true);
    await worker.ready;
    await eventually(() => loads.includes("*"));
  }, 90_000);

  afterAll(async () => {
    await coordinator?.stop();
    await listener?.$client.end({ timeout: 1 });
    await sender?.$client.end({ timeout: 1 });
    await receiver?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  async function eventually(check: () => boolean) {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Scoped deadline work did not settle");
      await delay(10);
    }
  }

  async function commitInOtherProcess(write: (tx: Parameters<Parameters<typeof sender.transaction>[0]>[0]) => Promise<void>) {
    loads.length = 0;
    rowsLoaded = 0;
    await sender.transaction(write);
    await eventually(() => loads.length > 0);
    await delay(200);
    return { loads: [...loads], rowsLoaded };
  }

  it("reloads only the hinted company when another process commits scoped work", async () => {
    const result = await commitInOtherProcess(async tx => {
      await signalDatabaseWork(tx, queue, "company-7");
      await tx.execute(sql`insert into scoped_deadline_fixture values ('company-7-new', 'company-7')`);
    });
    expect(result).toEqual({ loads: ["company-7"], rowsLoaded: ROWS_PER_COMPANY + 1 });
    expect(onError).not.toHaveBeenCalled();
  });

  it("reloads only the hinted companies when one commit touches several", async () => {
    const result = await commitInOtherProcess(async tx => {
      await signalDatabaseWork(tx, queue, "company-3");
      await signalDatabaseWork(tx, queue, "company-4");
      await signalDatabaseWork(tx, queue, "company-3");
    });
    expect(result.loads.sort()).toEqual(["company-3", "company-4"]);
    expect(result.rowsLoaded).toBe(2 * ROWS_PER_COMPANY);
    expect(onError).not.toHaveBeenCalled();
  });

  it("still reloads every candidate when another process commits unscoped work", async () => {
    const result = await commitInOtherProcess(async tx => { await signalDatabaseWork(tx, queue); });
    expect(result.loads).toEqual(["*"]);
    expect(result.rowsLoaded).toBe(COMPANIES * ROWS_PER_COMPANY + 1);
    expect(onError).not.toHaveBeenCalled();
  });
});
