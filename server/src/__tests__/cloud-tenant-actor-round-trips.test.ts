import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "../middleware/auth.js";

// Cloud tenant requests resolve their actor on every request, static files
// included. On a loaded database each round trip waits, so the steady-state
// resolution (tenant sync debounced) must cost one round trip, not one per
// statement. This proxy delays every client-to-server write by a fixed amount
// so the number of sequential round trips shows up as wall time.

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_CLOUD_PROVISIONING_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SERVER_TOKEN = "test-server-token";
const ROUND_TRIP_DELAY_MS = 150;

function startDelayProxy(target: URL, delayMs: number) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    sockets.add(client);
    sockets.add(upstream);
    let releaseAt = 0;
    client.on("data", (chunk) => {
      // Preserve byte order while delaying each write by at least delayMs.
      releaseAt = Math.max(Date.now() + delayMs, releaseAt);
      setTimeout(() => upstream.write(chunk), releaseAt - Date.now());
    });
    upstream.on("data", (chunk) => client.write(chunk));
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", close);
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      const proxied = new URL(target.toString());
      proxied.hostname = "127.0.0.1";
      proxied.port = String(port);
      resolve({
        url: proxied.toString(),
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

describeEmbeddedPostgres("cloud tenant actor round trips", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let directDb!: ReturnType<typeof createDb>;
  let slowDb!: ReturnType<typeof createDb>;
  let proxy!: Awaited<ReturnType<typeof startDelayProxy>>;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tenant-round-trips-");
    const url = external ?? tempDb!.connectionString;
    directDb = createDb(url);
    proxy = await startDelayProxy(new URL(url), ROUND_TRIP_DELAY_MS);
    slowDb = createDb(proxy.url);
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = SERVER_TOKEN;
  }, 30_000);

  afterAll(async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    await directDb?.delete(activityLog);
    await directDb?.delete(principalPermissionGrants);
    await directDb?.delete(companyMemberships);
    await directDb?.delete(companies);
    await directDb?.delete(instanceUserRoles);
    await directDb?.delete(authUsers);
    await slowDb?.$client.end({ timeout: 1 });
    await directDb?.$client.end({ timeout: 1 });
    await proxy?.close();
    await tempDb?.cleanup();
  });

  it("resolves a synced tenant actor in about one database round trip", async () => {
    const headers = cloudActorHeaderSourceFromHeaders({
      "x-paperclip-cloud-tenant-token": SERVER_TOKEN,
      "x-paperclip-cloud-user-id": "user-round-trips",
      "x-paperclip-cloud-user-email": "user-round-trips@example.com",
      "x-paperclip-cloud-stack-id": "stack-round-trips",
      // Owners also read the instance settings for owner elevation.
      "x-paperclip-cloud-stack-role": "owner",
    });

    // First request provisions the tenant; its writes are debounced afterwards.
    const first = await resolveCloudTenantActor(slowDb, headers);
    expect(first?.type).toBe("board");
    // Open enough pooled connections that connection setup is not measured.
    await Promise.all(Array.from({ length: 4 }, () => slowDb.execute(sql`select 1`)));

    // Measure one statement through the same proxy as the baseline, so a slow
    // runner scales both sides of the comparison.
    const statementMs: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const statementStarted = performance.now();
      await slowDb.execute(sql`select 1`);
      statementMs.push(performance.now() - statementStarted);
    }
    const oneStatementMs = statementMs.sort((a, b) => a - b)[1]!;

    const started = performance.now();
    const actor = await resolveCloudTenantActor(slowDb, headers);
    const elapsedMs = performance.now() - started;

    expect(actor).toMatchObject({
      type: "board",
      userId: "user-round-trips",
      source: "cloud_tenant",
      isInstanceAdmin: false,
    });
    expect(actor?.type === "board" ? actor.companyIds : []).toHaveLength(1);
    // `select 1` is one delayed write; a parameterized statement is two. Three
    // sequential statements (purge, memberships, owner elevation) take about
    // 6 × the baseline; concurrent statements take about 2 ×.
    expect(elapsedMs).toBeLessThan(oneStatementMs * 4);
  }, 30_000);
});
