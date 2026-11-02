import { afterEach, expect, it } from "vitest";
import { checkpointDb, closeCheckpointDb, closeRegisteredClients, createDb, livenessDb, type Db } from "./client.js";

// postgres.js pools are lazy: these tests exercise actual client lifetimes but
// never connect to a database or depend on embedded Postgres availability.
const url = "postgres://fixture:fixture@127.0.0.1:1/checkpoint_pool_lifetime";
afterEach(() => closeRegisteredClients(url, { scope: "database" }));

it("fences checkpoints when shutdown precedes the first pool request", async () => {
  const db = createDb(url);
  await closeCheckpointDb(db, 1);
  expect(() => checkpointDb(db)).toThrow("checkpoint_pool_closed");
  await closeCheckpointDb(db, 1);
  expect(() => checkpointDb(db)).toThrow("checkpoint_pool_closed");
});

it("keeps an already-created checkpoint pool ended after shutdown", async () => {
  const db = createDb(url);
  const pool = checkpointDb(db);
  expect(pool.$client.options.max).toBe(3);
  await closeCheckpointDb(db, 1);
  expect(checkpointDb(db)).toBe(pool);
  await expect(pool.$client`select 1`).rejects.toMatchObject({ code: "CONNECTION_ENDED" });
});

it("preserves other owner lifetimes and non-owning test-double behavior", async () => {
  const closed = createDb(url), open = createDb(url);
  await closeCheckpointDb(closed, 1);
  expect(checkpointDb(open)).not.toBe(open);
  const nonOwner = {} as Db;
  await closeCheckpointDb(nonOwner, 1);
  expect(checkpointDb(nonOwner)).toBe(nonOwner);
});

it("bounds one cached checkpoint pool per owner without changing request or renewal capacity", () => {
  const first = createDb(url, { maxConnections: 10 });
  const second = createDb(url, { maxConnections: 10 });
  const pool = checkpointDb(first);
  expect(pool).not.toBe(first);
  expect(checkpointDb(first)).toBe(pool);
  expect(checkpointDb(second)).not.toBe(pool);
  expect(pool.$client.options.max).toBe(3);
  expect(checkpointDb(second).$client.options.max).toBe(3);
  expect(first.$client.options.max).toBe(10);
  expect(livenessDb(first).$client.options.max).toBe(2);
});
