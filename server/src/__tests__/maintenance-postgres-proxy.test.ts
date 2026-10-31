import { createDb } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createPostgresProtocolObserver, startMaintenancePostgresProxy, type ObservedQuery } from "./helpers/maintenance/postgres-proxy.js";

const startup = Buffer.from([0, 0, 0, 8, 0, 3, 0, 0]);
function frame(type: string, body: Buffer | string = "") {
  const payload = Buffer.from(body), header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0); header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

describe("passive maintenance PostgreSQL observer", () => {
  it("counts fragmented simple and reused prepared executions without counting parses or parameter values", () => {
    const queries: ObservedQuery[] = [];
    const observer = createPostgresProtocolObserver(query => queries.push(query));
    const bytes = Buffer.concat([startup,
      frame("Q", "select 1\0"),
      frame("P", "statement\0select $1::text\0"),
      frame("B", "portal\0statement\0parameter-value-sentinel"),
      frame("E", Buffer.concat([Buffer.from("portal\0"), Buffer.alloc(4)])), frame("S"),
      frame("B", "portal2\0statement\0other-value-sentinel"),
      frame("E", Buffer.concat([Buffer.from("portal2\0"), Buffer.alloc(4)])), frame("S"),
    ]);
    for (let index = 0; index < bytes.length; index += 3) observer.frontend(bytes.subarray(index, index + 3));
    expect(queries.map(query => [query.protocol, query.sql])).toEqual([
      ["simple", "select 1"], ["extended", "select $1::text"], ["extended", "select $1::text"],
    ]);
    expect(queries[1]!.fingerprint).toBe(queries[2]!.fingerprint);
    expect(JSON.stringify(queries)).not.toContain("value-sentinel");
    expect(observer.pending).toBe(3);
    const ready = frame("Z", "I");
    for (const byte of Buffer.concat([ready, ready, ready])) observer.backend(Buffer.from([byte]));
    expect(observer.pending).toBe(0);
  });

  it("rejects unobserved prepared executions instead of silently claiming quiet", () => {
    const observer = createPostgresProtocolObserver(() => {});
    observer.frontend(startup);
    expect(() => observer.frontend(frame("E", Buffer.from("missing\0\0\0\0\0")))).toThrow("not observed");
  });
});

let databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_MAINTENANCE_TEST_DATABASE_URL");
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
describe("maintenance observer against PostgreSQL", () => {
  beforeAll(async () => {
    if (!databaseUrl) { temporary = await startEmbeddedPostgresTestDatabase("maintenance-observer-"); databaseUrl = temporary.connectionString; }
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });
  it("observes raw tagged SQL, simple SQL, rollback and reused prepared executions with real sockets", async () => {
    const proxy = await startMaintenancePostgresProxy(databaseUrl!);
    const db = createDb(proxy.url, { prepare: true, maxConnections: 1 });
    try {
      const tagged = (value: number) => db.$client`select ${value}::integer as value`;
      expect((await tagged(1))[0]!.value).toBe(1);
      const first = proxy.queries.length, frames = proxy.frames;
      expect((await tagged(2))[0]!.value).toBe(2);
      expect(proxy.queries.length).toBe(first + 1);
      expect(proxy.frames.Parse).toBe(frames.Parse);
      expect(proxy.frames.Execute).toBe(frames.Execute + 1);
      expect(proxy.queries.at(-1)!.fingerprint).toBe(proxy.queries.at(-2)!.fingerprint);
      await db.$client.unsafe("select 3 as value").simple();
      await expect(db.$client.begin(async tx => { await tx`select 4`; throw new Error("rollback control"); })).rejects.toThrow("rollback control");
      expect(proxy.queries.some(query => query.protocol === "simple" && query.sql.includes("select 3"))).toBe(true);
      expect(proxy.queries.some(query => /rollback/i.test(query.sql))).toBe(true);
      expect(proxy.pending).toBe(0);
      expect(proxy.errors).toEqual([]);
      expect(proxy.transport).toMatchObject({ connectionsOpened: 1, connectionsClosed: 0 });
      expect(proxy.transport.frontendBytes).toBeGreaterThan(0);
      expect(proxy.transport.backendBytes).toBeGreaterThan(0);
      const before = proxy.queries.length, transport = proxy.transport;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(proxy.queries.length).toBe(before);
      expect(proxy.transport).toEqual(transport);
    } finally { await db.$client.end(); await proxy.stop(); }
  });
});
