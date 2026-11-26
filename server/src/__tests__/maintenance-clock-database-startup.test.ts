import { createRequire } from "node:module";
import { once } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databasePort, trackDatabaseConnectionStartup } from "./helpers/maintenance/database-startup.js";

const databaseRequire = createRequire(createRequire(import.meta.url).resolve("@paperclipai/db"));
type PostgresClient = {
  (strings: TemplateStringsArray): { simple(): { execute(): Promise<unknown[]> } };
  end(options: { timeout: number }): Promise<void>;
};
const postgres = (await import(pathToFileURL(databaseRequire.resolve("postgres")).href)).default as (options: Record<string, unknown>) => PostgresClient;
const realTimeout = globalThis.setTimeout;
const realImmediate = globalThis.setImmediate;

function frame(type: string, body: Buffer) {
  const header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0); header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

async function startHeldPostgres(startupReply = Buffer.concat([frame("R", Buffer.alloc(4)), frame("Z", Buffer.from("I"))])) {
  const held: Socket[] = [], sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      held.push(socket);
      socket.on("data", () => socket.write(Buffer.concat([frame("C", Buffer.from("SELECT 0\0")), frame("Z", Buffer.from("I"))])));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    held,
    release() {
      for (const socket of held.splice(0)) {
        if (!socket.destroyed) socket.write(startupReply);
      }
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function startConnection(port: number, tracker: ReturnType<typeof trackDatabaseConnectionStartup>, upstream: { held: Socket[] }, cleanup: Array<() => unknown>) {
  const sql = postgres({ host: "127.0.0.1", port, username: "maintenance", database: "maintenance", password: "unused",
    ssl: false, fetch_types: false, connect_timeout: 30, max: 1, onnotice: () => {} });
  const query = sql`select 1`.simple().execute();
  query.catch(() => {});
  cleanup.push(() => sql.end({ timeout: 0 }));
  const deadline = performance.now() + 5_000;
  while (tracker.starting === 0 || upstream.held.length === 0) {
    if (performance.now() > deadline) throw new Error("PostgreSQL client did not start its connection");
    vi.advanceTimersByTime(0);
    await new Promise(resolve => realImmediate(resolve));
  }
  return { query };
}

describe("maintenance fake clock and database connection startup", () => {
  const cleanup: Array<() => unknown> = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  it("fires the driver connect timeout when the clock advances during connection startup", async () => {
    const upstream = await startHeldPostgres(); cleanup.push(() => upstream.stop());
    const tracker = trackDatabaseConnectionStartup(upstream.port); cleanup.push(() => tracker.dispose());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { query } = await startConnection(upstream.port, tracker, upstream, cleanup);
    vi.advanceTimersByTime(30_000);
    upstream.release();
    await expect(query).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
  });

  it("advances the clock only after every database connection has finished startup", async () => {
    const upstream = await startHeldPostgres(); cleanup.push(() => upstream.stop());
    const tracker = trackDatabaseConnectionStartup(upstream.port); cleanup.push(() => tracker.dispose());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { query } = await startConnection(upstream.port, tracker, upstream, cleanup);
    expect(tracker.starting).toBe(1);
    realTimeout(() => upstream.release(), 50);
    const ticks: number[] = [];
    await tracker.advanceAfterStartup(ms => { ticks.push(ms); expect(tracker.starting).toBe(0); vi.advanceTimersByTime(ms); }, 30_000, 5_000);
    expect(ticks).toEqual([30_000]);
    await expect(query).resolves.toHaveLength(0);
  });

  it("reports an unreadable startup reply once and keeps later advances usable", async () => {
    const upstream = await startHeldPostgres(Buffer.from([0x52, 0, 0, 0, 0])); cleanup.push(() => upstream.stop());
    const tracker = trackDatabaseConnectionStartup(upstream.port); cleanup.push(() => tracker.dispose());
    const client = createConnection({ host: "127.0.0.1", port: upstream.port });
    let clientError: Error | undefined;
    client.on("error", error => { clientError = error; }); cleanup.push(() => client.destroy());
    await once(client, "connect");
    client.write(Buffer.from([0, 0, 0, 8, 0, 3, 0, 0]));
    const deadline = performance.now() + 5_000;
    while (upstream.held.length === 0) {
      if (clientError) throw clientError;
      if (performance.now() > deadline) throw new Error("PostgreSQL stub did not receive the startup message");
      await new Promise(resolve => realTimeout(resolve, 5));
    }
    expect(tracker.starting).toBe(1);
    upstream.release();
    await expect(tracker.waitUntilStarted(5_000)).rejects.toThrow("Database connection startup could not be observed");
    expect(tracker.starting).toBe(0);
    await expect(tracker.waitUntilStarted(5_000)).resolves.toBeUndefined();
  });

  it("uses the PostgreSQL default port when the database URL omits it", () => {
    expect(databasePort("postgres://maintenance@127.0.0.1/maintenance_test")).toBe(5432);
    expect(databasePort("postgres://maintenance@127.0.0.1:6543/maintenance_test")).toBe(6543);
  });
});
