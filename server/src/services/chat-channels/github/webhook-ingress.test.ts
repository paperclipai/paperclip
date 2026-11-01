import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, chatActions, createDb } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import { cleanupIngressFixture, githubIngressFixture as createFixture } from "../../../__tests__/helpers/github-webhook-ingress.js";
import { createGitHubWebhookIngress } from "./webhook-ingress.js";
import { PROVIDER_EFFECT_STALE_MS } from "../../chat-action-work.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("GitHub webhook ingress claim PostgreSQL behavior", () => {
  let db: ReturnType<typeof createDb>;
  const fixtureCompanyIds = new Set<string>();
  async function githubIngressFixture(database: typeof db, factory = createGitHubWebhookIngress, bodyBytes?: number) {
    const fixture = await createFixture(database, factory, bodyBytes);
    fixtureCompanyIds.add(fixture.companyId);
    return fixture;
  }
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("github-ingress-claim-");
    else await applyPendingMigrations(externalUrl);
    db = createDb(externalUrl ?? temporary!.connectionString);
  }, 90_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const companyId of fixtureCompanyIds) await cleanupIngressFixture(db, companyId);
    fixtureCompanyIds.clear();
  });
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  it("returns the full replay body only to a successful claimant", async () => {
    const f = await githubIngressFixture(db, createGitHubWebhookIngress, 768 * 1024);
    const action = await f.insertAction();
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 1, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { chatActions }, capture);
    try { expect((await f.service.processGitHubWebhookIngress(action.id))?.status).toBe(202); }
    finally { capture.flush(); }
    const reads = events.filter(event => event.operation === "select" && event.table === "chat_actions");
    expect(reads.reduce((sum, event) => sum + Number(event.responseValueBytes), 0)).toBeLessThan(1024);
    expect(f.calls).toEqual([{ publicId: f.endpoint.publicId, provider: "github", body: f.payload.body, delivery: f.payload.deliveryId,
      signature: `sha256=${createHmac("sha256", "fixture-secret").update(f.payload.body).digest("hex")}` }]);
    expect(await f.readAction(action.id)).toMatchObject({ status: "processed", payload: { redacted: true, bodySha256: f.payload.bodySha256 }, result: { attempts: 1, httpStatus: 202, retryable: false } });
  });

  it.each([
    { status: "processed", result: null, accepted: true },
    { status: "cancelled", result: null, accepted: true },
    { status: "failed", result: { retryable: false }, accepted: true },
    { status: "failed", result: { retryable: true, retryAt: new Date(Date.now() + 60_000).toISOString() }, accepted: false },
    { status: "processing", result: { attempts: 1 }, accepted: false },
    { status: "delivery_unknown", result: null, accepted: false },
  ])("does not fetch a body or mutate an ineligible $status row ($result)", async ({ status, result, accepted }) => {
    const f = await githubIngressFixture(db);
    // A corrupt body must not let a nonclaimant overwrite a live or delayed claim.
    const action = await f.insertAction({ status, result, payload: { ...f.payload, bodySha256: "0".repeat(64) } });
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 1, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { chatActions }, capture);
    let response: Response | null;
    try { response = await f.service.processGitHubWebhookIngress(action.id); }
    finally { capture.flush(); }
    expect(response?.status ?? null).toBe(accepted ? 202 : null);
    expect(await f.readAction(action.id)).toEqual(action);
    expect(f.calls).toEqual([]);
    expect(events.find(event => event.event === "paperclip.db_response_capture.summary.v1")?.responseValueBytes).toBeLessThan(1024);
  });

  it.each(["received", "failed", "processing"])("settles eligible malformed %s payloads without replay", async status => {
    const f = await githubIngressFixture(db);
    const action = await f.insertAction({ status, payload: { ...f.payload, bodySha256: "0".repeat(64) },
      result: { attempts: 2, retryable: true, retryAt: new Date(0).toISOString() }, updatedAt: new Date(0) });
    expect((await f.service.processGitHubWebhookIngress(action.id))?.status).toBe(202);
    expect(await f.readAction(action.id)).toMatchObject({ status: "failed", payload: {}, result: { code: "github_webhook_ingress_payload_invalid", retryable: false } });
    expect(f.calls).toEqual([]);
  });

  it.each(["failed", "processing"])("recovers a due %s attempt after a worker restart", async status => {
    const f = await githubIngressFixture(db);
    const action = await f.insertAction({ status, result: { attempts: 2, retryable: true, retryAt: new Date(0).toISOString() }, updatedAt: new Date(Date.now() - PROVIDER_EFFECT_STALE_MS - 1000) });
    const restarted = createGitHubWebhookIngress(db, f.options);
    expect((await restarted.processGitHubWebhookIngress(action.id))?.status).toBe(202);
    expect(f.calls).toHaveLength(1);
    expect(await f.readAction(action.id)).toMatchObject({ status: "processed", result: { attempts: 3, httpStatus: 202 } });
  });

  it.each(["received", "failed", "processing"])("lets only one concurrent worker claim and replay a %s delivery", async status => {
    const f = await githubIngressFixture(db);
    const previousAttempts = status === "received" ? 0 : 2;
    const action = await f.insertAction({ status,
      result: { attempts: previousAttempts, retryable: true, retryAt: new Date(0).toISOString() },
      updatedAt: new Date(0),
    });
    // All workers must observe the same eligible attempt before any can claim it.
    let arrived = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      if (++arrived === 12) release();
      await ready;
      return transaction(callback, config);
    });
    const responses = await Promise.all(Array.from({ length: 12 }, () => f.service.processGitHubWebhookIngress(action.id)));
    expect(responses.some(response => response?.status === 202)).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(await f.readAction(action.id)).toMatchObject({ status: "processed", result: { attempts: previousAttempts + 1 } });
  });

  it("does not read the body when another worker wins between eligibility and claim", async () => {
    const f = await githubIngressFixture(db);
    const action = await f.insertAction();
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
      await db.update(chatActions).set({ status: "processing", result: { attempts: 1 } }).where(eq(chatActions.id, action.id));
      return transaction(callback, config);
    });
    expect(await f.service.processGitHubWebhookIngress(action.id)).toBeNull();
    expect(f.calls).toEqual([]);
    expect(await f.readAction(action.id)).toMatchObject({ status: "processing", payload: f.payload, result: { attempts: 1 } });
  });

  it("does not clear a malformed body after its claim is superseded", async () => {
    const f = await githubIngressFixture(db);
    const action = await f.insertAction({ payload: { ...f.payload, bodySha256: "0".repeat(64) } });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction")
      .mockImplementationOnce(transaction)
      .mockImplementationOnce(async (callback, config) => {
        await db.update(chatActions).set({ result: { attempts: 2 } }).where(eq(chatActions.id, action.id));
        return transaction(callback, config);
      });
    expect((await f.service.processGitHubWebhookIngress(action.id))?.status).toBe(202);
    expect(await f.readAction(action.id)).toMatchObject({ status: "processing", payload: action.payload, result: { attempts: 2 } });
    expect(f.calls).toEqual([]);
  });

  it("validates the current claimed body instead of a body replaced before the claim", async () => {
    const f = await githubIngressFixture(db);
    const action = await f.insertAction();
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
      await db.update(chatActions).set({ payload: { ...f.payload, body: "corrupt replacement" } }).where(eq(chatActions.id, action.id));
      return transaction(callback, config);
    });
    expect((await f.service.processGitHubWebhookIngress(action.id))?.status).toBe(202);
    expect(f.calls).toEqual([]);
    expect(await f.readAction(action.id)).toMatchObject({ status: "failed", payload: {}, result: { code: "github_webhook_ingress_payload_invalid", retryable: false } });
  });

  it("keeps the replay body and retry deadline after a retryable provider failure", async () => {
    const f = await githubIngressFixture(db);
    const action = await f.insertAction();
    f.options.handleWebhook = async () => new Response("temporary", { status: 503 });
    const service = createGitHubWebhookIngress(db, f.options);
    expect((await service.processGitHubWebhookIngress(action.id))?.status).toBe(202);
    const failed = await f.readAction(action.id);
    expect(failed).toMatchObject({ status: "failed", payload: f.payload, result: { attempts: 1, httpStatus: 503, retryable: true, retryAt: expect.any(String) } });
    expect(Date.parse(String(failed.result?.retryAt))).toBeGreaterThan(Date.now());
  });
});
