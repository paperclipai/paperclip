import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { pushSubscriptionService } from "./push-subscriptions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("pushSubscriptionService", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-push-subscriptions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  it("subscribes a new device and lists it as active", async () => {
    const companyId = await seedCompany();
    const svc = pushSubscriptionService(db);

    const sub = await svc.subscribe(companyId, "user-1", {
      endpoint: "https://push.example/device-1",
      p256dh: "p256dh",
      auth: "auth",
    });

    expect(sub.revokedAt).toBeNull();
    const active = await svc.listActiveForUser(companyId, "user-1");
    expect(active.map((row) => row.endpoint)).toEqual(["https://push.example/device-1"]);
  });

  it("allows multiple devices for the same company+user (no unique company+user constraint)", async () => {
    const companyId = await seedCompany();
    const svc = pushSubscriptionService(db);

    await svc.subscribe(companyId, "user-1", {
      endpoint: "https://push.example/device-a",
      p256dh: "p256dh-a",
      auth: "auth-a",
    });
    await svc.subscribe(companyId, "user-1", {
      endpoint: "https://push.example/device-b",
      p256dh: "p256dh-b",
      auth: "auth-b",
    });

    const active = await svc.listActiveForUser(companyId, "user-1");
    expect(active).toHaveLength(2);
  });

  it("re-subscribing the same endpoint upserts and clears any prior revocation", async () => {
    const companyId = await seedCompany();
    const svc = pushSubscriptionService(db);
    const endpoint = "https://push.example/device-resub";

    await svc.subscribe(companyId, "user-1", { endpoint, p256dh: "old", auth: "old" });
    await svc.unsubscribe(companyId, "user-1", endpoint);
    let active = await svc.listActiveForUser(companyId, "user-1");
    expect(active).toHaveLength(0);

    const resubscribed = await svc.subscribe(companyId, "user-1", { endpoint, p256dh: "new", auth: "new" });
    expect(resubscribed.revokedAt).toBeNull();
    expect(resubscribed.p256dh).toBe("new");

    active = await svc.listActiveForUser(companyId, "user-1");
    expect(active).toHaveLength(1);
  });

  it("unsubscribe sets revokedAt and is scoped to the owning company+user", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const svc = pushSubscriptionService(db);
    const endpoint = "https://push.example/device-scope";

    await svc.subscribe(companyId, "user-1", { endpoint, p256dh: "p", auth: "a" });

    const wrongScope = await svc.unsubscribe(otherCompanyId, "user-1", endpoint);
    expect(wrongScope.revoked).toBe(false);

    const rightScope = await svc.unsubscribe(companyId, "user-1", endpoint);
    expect(rightScope.revoked).toBe(true);

    const active = await svc.listActiveForUser(companyId, "user-1");
    expect(active).toHaveLength(0);
  });

  it("revokeByEndpoint soft-revokes regardless of company/user scope (used for dead-endpoint cleanup)", async () => {
    const companyId = await seedCompany();
    const svc = pushSubscriptionService(db);
    const endpoint = "https://push.example/device-dead";
    await svc.subscribe(companyId, "user-1", { endpoint, p256dh: "p", auth: "a" });

    await svc.revokeByEndpoint(endpoint);

    const active = await svc.listActiveForUser(companyId, "user-1");
    expect(active).toHaveLength(0);
  });
});
