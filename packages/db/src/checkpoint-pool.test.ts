import { afterEach, expect, it } from "vitest";
import { checkpointDb, closeCheckpointDb, closeRegisteredClients, createDb, type Db } from "./client.js";

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
