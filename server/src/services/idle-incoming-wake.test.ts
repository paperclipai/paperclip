import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  readIdleIncomingWakeProof,
  incomingWakeFingerprint,
} from "./idle-incoming-wake.js";
import { registerConnectionEventWake } from "./connection-event-wake.js";
import type { VerifiedIdleCapabilities } from "./idle-incoming-wake-capability.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
function fixture(count: number) {
  const endpoints = Array.from({ length: count }, (_, i) => ({
    endpoint: {
      id: `endpoint-${i}`,
      companyId: "company",
      status: "active",
      activatedAt: new Date(0),
      botExternalId: `bot-${i}`,
      providerAccountId: `app-${i}`,
      setup: {
        step: "complete",
        github: {
          cloudRegistrationId: String(i).padStart(43, "a"),
          registrationStatus: "completed",
        },
      },
    },
    connection: { id: `connection-${i}` },
  }));
  const registrations = endpoints.map(({ endpoint }) => ({
    endpointId: endpoint.id,
    companyId: endpoint.companyId,
    userId: "owner",
    cloudId: endpoint.setup.github.cloudRegistrationId,
  }));
  const tuples = registrations.map((row) => [
    `github-app:${row.cloudId}`,
    row.companyId,
    row.userId,
    "github.bot",
    `gateway:${row.cloudId}`,
    row.cloudId,
    row.cloudId,
  ]);
  const capability = {
    incomingWake: {
      version: 1,
      ownerId,
      generation: "a".repeat(64),
      routes: ["github-broker-events-v1"],
      githubBroker: {
        instanceId: "fixture-instance",
        bindingsFingerprint: incomingWakeFingerprint(tuples),
      },
    },
  } as VerifiedIdleCapabilities;
  return { endpoints, registrations, capability };
}
/** Named DB boundary for cardinality/elapsed guards; PostgreSQL fixture covers real SQL separately. */
function database(replies: Array<() => unknown[]>) {
  let index = 0;
  const select = vi.fn(() => {
    const reply = replies[index++];
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      limit: async () => reply?.() ?? [],
    };
    return query;
  });
  const execute = vi.fn(async () => []);
  return {
    db: { select, execute } as unknown as Pick<Db, "select" | "execute">,
    select,
    execute,
  };
}
const stops: Array<() => void> = [];
function input(
  db: object,
  capabilities: VerifiedIdleCapabilities,
  now?: () => number,
) {
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", "fixture-instance");
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", "fixture");
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY", "fixture");
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT", "test");
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", "http://127.0.0.1");
  stops.push(registerConnectionEventWake(db, () => {}));
  return { ownerId, receiverOwner: db, capabilities, now };
}
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.unstubAllEnvs();
});

describe("bounded incoming wake owner projection", () => {
  it("uses three bounded selects for a thousand bots and retains exact per-bot authority", async () => {
    const f = fixture(1000),
      sql = database([() => [], () => f.endpoints, () => f.registrations]);
    const result = await readIdleIncomingWakeProof(
      sql.db,
      input(sql.db, f.capability),
    );
    expect(sql.select).toHaveBeenCalledTimes(3);
    expect(sql.execute).toHaveBeenCalledTimes(4);
    expect(result?.endpointIds).toHaveLength(1000);
    expect(result?.connectionIds).toHaveLength(1000);
  });
  it.each(["duplicate", "foreign", "missing"])(
    "rejects %s registration authority",
    async (fault) => {
      const f = fixture(1);
      let registrations = f.registrations;
      if (fault === "duplicate")
        registrations = [...registrations, ...registrations];
      if (fault === "foreign")
        registrations = registrations.map((r) => ({
          ...r,
          companyId: "foreign",
        }));
      if (fault === "missing") registrations = [];
      const sql = database([() => [], () => f.endpoints, () => registrations]);
      await expect(
        readIdleIncomingWakeProof(sql.db, input(sql.db, f.capability)),
      ).rejects.toThrow("registration authority");
    },
  );
  it("stops the complete inspection when its monotonic budget expires before another query", async () => {
    const f = fixture(1);
    let now = 0;
    const sql = database([
      () => {
        now = 2001;
        return [];
      },
      () => f.endpoints,
      () => f.registrations,
    ]);
    await expect(
      readIdleIncomingWakeProof(
        sql.db,
        input(sql.db, f.capability, () => now),
      ),
    ).rejects.toThrow("budget exhausted");
    expect(sql.select).toHaveBeenCalledTimes(1);
    expect(sql.execute).toHaveBeenCalledTimes(1);
  });
  it("fails closed at row limits before expanding work or issuing registration queries", async () => {
    const f = fixture(1001),
      sql = database([() => [], () => f.endpoints, () => f.registrations]);
    await expect(
      readIdleIncomingWakeProof(sql.db, input(sql.db, f.capability)),
    ).rejects.toThrow("Too many GitHub endpoints");
    expect(sql.select).toHaveBeenCalledTimes(2);
  });
});
