import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_BUDGETS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("withAccountingTransaction queue and isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-accounting-tx-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it("serializes concurrent transactions for the same company in FIFO order", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Queue Co", issuePrefix: "QUE" });

    const executionOrder: string[] = [];
    let activeWorkers = 0;
    let maxConcurrent = 0;

    const runWorker = (name: string, delayMs: number) =>
      withAccountingTransaction(db, companyId, async () => {
        activeWorkers++;
        if (activeWorkers > maxConcurrent) maxConcurrent = activeWorkers;
        executionOrder.push(`${name}-start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        executionOrder.push(`${name}-end`);
        activeWorkers--;
        return name;
      });

    const [r1, r2, r3] = await Promise.all([
      runWorker("w1", 60),
      runWorker("w2", 40),
      runWorker("w3", 20),
    ]);

    expect(r1).toBe("w1");
    expect(r2).toBe("w2");
    expect(r3).toBe("w3");
    expect(maxConcurrent).toBe(1);
    expect(executionOrder).toEqual([
      "w1-start",
      "w1-end",
      "w2-start",
      "w2-end",
      "w3-start",
      "w3-end",
    ]);
  });

  it("allows concurrent transactions for different companies without waiting", async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    await db.insert(companies).values([
      { id: c1, name: "Co 1", issuePrefix: "CO1" },
      { id: c2, name: "Co 2", issuePrefix: "CO2" },
    ]);

    const order: string[] = [];

    const p1 = withAccountingTransaction(db, c1, async () => {
      order.push("c1-start");
      await new Promise((resolve) => setTimeout(resolve, 80));
      order.push("c1-end");
      return "c1";
    });

    const p2 = withAccountingTransaction(db, c2, async () => {
      order.push("c2-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("c2-end");
      return "c2";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("c1");
    expect(r2).toBe("c2");
    expect(order.indexOf("c2-end")).toBeLessThan(order.indexOf("c1-end"));
  });

  it("continues serving subsequent queued transactions if a previous transaction throws", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fail Co", issuePrefix: "FAI" });

    const p1 = withAccountingTransaction(db, companyId, async () => {
      throw new Error("Controlled failure");
    });

    const p2 = withAccountingTransaction(db, companyId, async () => {
      return "recovered";
    });

    await expect(p1).rejects.toThrow("Controlled failure");
    const r2 = await p2;
    expect(r2).toBe("recovered");
  });

  it("supports re-entrant nested withAccountingTransaction calls without deadlock", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Nested Co", issuePrefix: "NES" });

    const result = await withAccountingTransaction(db, companyId, async () => {
      const nested = await withAccountingTransaction(db, companyId, async () => {
        return "nested-done";
      });
      return `outer-${nested}`;
    });

    expect(result).toBe("outer-nested-done");
  });

  it("bypasses queue when invoked with an existing transaction", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Tx Co", issuePrefix: "TXC" });

    const result = await db.transaction(async (tx) => {
      return await withAccountingTransaction(tx as unknown as typeof db, companyId, async () => {
        return "tx-done";
      });
    });

    expect(result).toBe("tx-done");
  });

  it("throws notFound when company does not exist and frees the queue", async () => {
    const nonexistent = randomUUID();
    await expect(
      withAccountingTransaction(db, nonexistent, async () => "unreachable"),
    ).rejects.toThrow("Company not found");

    await expect(
      withAccountingTransaction(db, nonexistent, async () => "unreachable-2"),
    ).rejects.toThrow("Company not found");
  });
});
