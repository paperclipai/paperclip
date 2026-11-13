import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, registerPostCommitHook } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("post-commit hooks on a createDb database", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let observer: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-post-commit-hooks-");
    db = createDb(database.connectionString);
    observer = createDb(database.connectionString);
    await db.execute(sql`create table post_commit_probe (id text primary key)`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end();
    await observer?.$client.end();
    await database?.cleanup();
  });

  async function committed(id: string) {
    const rows = await observer.execute(sql`select id from post_commit_probe where id = ${id}`);
    return rows.length === 1;
  }

  it("runs a hook once its transaction committed", async () => {
    const id = randomUUID();
    const seenByHook: boolean[] = [];

    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into post_commit_probe (id) values (${id})`);
      expect(registerPostCommitHook(tx, async () => {
        seenByHook.push(await committed(id));
      })).toBe(true);
      expect(await committed(id)).toBe(false);
    });

    expect(seenByHook).toEqual([true]);
  });

  it("drops the hook when the transaction rolls back", async () => {
    const id = randomUUID();
    const hook = vi.fn();

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`insert into post_commit_probe (id) values (${id})`);
      registerPostCommitHook(tx, hook);
      throw new Error("abort");
    })).rejects.toThrow("abort");

    expect(hook).not.toHaveBeenCalled();
    expect(await committed(id)).toBe(false);
  });

  it("drops the hooks of a savepoint that rolls back and runs the others after the outer commit", async () => {
    const kept = randomUUID();
    const rolledBack = randomUUID();
    const ran: string[] = [];

    await db.transaction(async (tx) => {
      await tx.transaction(async (savepoint) => {
        await savepoint.execute(sql`insert into post_commit_probe (id) values (${kept})`);
        registerPostCommitHook(savepoint, () => { ran.push(kept); });
      });
      await expect(tx.transaction(async (savepoint) => {
        await savepoint.execute(sql`insert into post_commit_probe (id) values (${rolledBack})`);
        registerPostCommitHook(savepoint, () => { ran.push(rolledBack); });
        throw new Error("savepoint abort");
      })).rejects.toThrow("savepoint abort");
      expect(ran).toEqual([]);
    });

    expect(ran).toEqual([kept]);
    expect(await committed(kept)).toBe(true);
    expect(await committed(rolledBack)).toBe(false);
  });

  it("runs hooks in registration order across a savepoint and its outer transaction", async () => {
    const ran: string[] = [];

    await db.transaction(async (tx) => {
      registerPostCommitHook(tx, () => { ran.push("outer before"); });
      await tx.transaction(async (savepoint) => {
        registerPostCommitHook(savepoint, () => { ran.push("savepoint"); });
        registerPostCommitHook(tx, () => { ran.push("outer during savepoint"); });
        await savepoint.transaction(async (inner) => {
          registerPostCommitHook(inner, () => { ran.push("inner savepoint"); });
        });
      });
      registerPostCommitHook(tx, () => { ran.push("outer after"); });
    });

    expect(ran).toEqual(["outer before", "savepoint", "outer during savepoint", "inner savepoint", "outer after"]);
  });

  it("drops the hooks of a savepoint nested in a savepoint that rolls back", async () => {
    const ran: string[] = [];

    await db.transaction(async (tx) => {
      await expect(tx.transaction(async (savepoint) => {
        await savepoint.transaction(async (inner) => {
          registerPostCommitHook(inner, () => { ran.push("inner"); });
        });
        throw new Error("outer savepoint abort");
      })).rejects.toThrow("outer savepoint abort");
      registerPostCommitHook(tx, () => { ran.push("outer"); });
    });

    expect(ran).toEqual(["outer"]);
  });

  it("keeps the committed result when a hook fails and still runs the later hooks", async () => {
    const id = randomUUID();
    const later = vi.fn();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`insert into post_commit_probe (id) values (${id})`);
      registerPostCommitHook(tx, () => { throw new Error("hook failure"); });
      registerPostCommitHook(tx, later);
      return "committed";
    });

    expect(result).toBe("committed");
    expect(later).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(await committed(id)).toBe(true);
    report.mockRestore();
  });

  it("does not register a hook outside a transaction", () => {
    expect(registerPostCommitHook(db, vi.fn())).toBe(false);
  });
});
