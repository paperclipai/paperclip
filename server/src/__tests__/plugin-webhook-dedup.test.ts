/**
 * Tests for inbound plugin-webhook delivery de-duplication.
 *
 * Providers (GitHub, Stripe, ...) and load balancers retry webhook POSTs.
 * When the provider supplies an idempotency id (e.g. `x-github-delivery`),
 * the host must record the delivery once and acknowledge retries without
 * re-dispatching `handleWebhook` to the plugin worker.
 *
 * Two layers are covered here:
 * 1. Route-level behavior via supertest with a fake db that simulates the
 *    partial unique index (`onConflictDoNothing` returns no rows for a
 *    duplicate non-null external id).
 * 2. The real partial unique index against embedded Postgres (migration
 *    0099), asserting `onConflictDoNothing` yields an empty `returning`
 *    for duplicate (plugin_id, webhook_key, external_id) and that NULL
 *    external ids are never deduplicated.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import { plugins, pluginWebhookDeliveries } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  upsertConfig: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT_KEY = "gh-events";

const readyPlugin = {
  id: PLUGIN_ID,
  pluginKey: "acme.github",
  status: "ready",
  manifestJson: {
    capabilities: ["webhooks.receive"],
    webhooks: [{ endpointKey: ENDPOINT_KEY }],
  },
};

/**
 * Fake db for the route harness. Tracks (pluginId, webhookKey, externalId)
 * triples; when an insert carries a non-null externalId AND uses
 * `onConflictDoNothing()`, a repeat triple yields an empty `returning` —
 * exactly what Postgres does with the partial unique index in place.
 */
function createWebhookDb() {
  const seen = new Set<string>();
  const insertedValues: Array<Record<string, unknown>> = [];

  const insert = vi.fn(() => {
    let values: Record<string, unknown> = {};
    let onConflict = false;
    const chain = {
      values(v: Record<string, unknown>) {
        values = v;
        insertedValues.push(v);
        return chain;
      },
      onConflictDoNothing() {
        onConflict = true;
        return chain;
      },
      returning() {
        const externalId = values.externalId as string | null | undefined;
        if (onConflict && externalId != null) {
          const key = `${values.pluginId}:${values.webhookKey}:${externalId}`;
          if (seen.has(key)) return Promise.resolve([]);
          seen.add(key);
        }
        return Promise.resolve([{ id: randomUUID() }]);
      },
    };
    return chain;
  });

  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([])),
    })),
  }));

  return { db: { insert, update }, insertedValues };
}

async function createApp() {
  const { pluginRoutes } = await import("../routes/plugins.js");
  const { errorHandler } = await import("../middleware/index.js");

  const { db, insertedValues } = createWebhookDb();
  const handleWebhookCall = vi.fn(async () => ({}));
  const webhookDeps = { workerManager: { call: handleWebhookCall } };
  const loader = { installPlugin: vi.fn() };

  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    pluginRoutes(
      db as never,
      loader as never,
      undefined,
      webhookDeps as never,
      undefined,
      undefined,
    ),
  );
  app.use(errorHandler);

  return { app, handleWebhookCall, insertedValues };
}

describe("plugin webhook delivery dedup (route)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue(readyPlugin);
    mockRegistry.getByKey.mockResolvedValue(readyPlugin);
  });

  it("dispatches handleWebhook once for retries with the same provider idempotency id", async () => {
    const { app, handleWebhookCall, insertedValues } = await createApp();
    const url = `/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`;
    const payload = { action: "opened" };

    const first = await request(app)
      .post(url)
      .set("x-github-delivery", "guid-1")
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("success");
    expect(handleWebhookCall).toHaveBeenCalledTimes(1);
    expect(handleWebhookCall).toHaveBeenCalledWith(
      PLUGIN_ID,
      "handleWebhook",
      expect.objectContaining({ endpointKey: ENDPOINT_KEY }),
    );
    expect(insertedValues[0]).toMatchObject({ externalId: "guid-1" });

    const second = await request(app)
      .post(url)
      .set("x-github-delivery", "guid-1")
      .send(payload);
    expect(second.status).toBe(202);
    expect(second.body.status).toBe("duplicate");
    expect(handleWebhookCall).toHaveBeenCalledTimes(1);
  });

  it("recognizes alternate idempotency headers (idempotency-key)", async () => {
    const { app, handleWebhookCall } = await createApp();
    const url = `/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`;

    const first = await request(app)
      .post(url)
      .set("idempotency-key", "idem-1")
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(url)
      .set("idempotency-key", "idem-1")
      .send({});
    expect(second.status).toBe(202);
    expect(second.body.status).toBe("duplicate");
    expect(handleWebhookCall).toHaveBeenCalledTimes(1);
  });

  it("dispatches every delivery when no idempotency header is present", async () => {
    const { app, handleWebhookCall, insertedValues } = await createApp();
    const url = `/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`;

    const first = await request(app).post(url).send({ n: 1 });
    const second = await request(app).post(url).send({ n: 1 });

    expect(first.status).toBe(200);
    expect(first.body.status).toBe("success");
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("success");
    expect(handleWebhookCall).toHaveBeenCalledTimes(2);
    expect(insertedValues).toHaveLength(2);
    expect(insertedValues[0]).toMatchObject({ externalId: null });
    expect(insertedValues[1]).toMatchObject({ externalId: null });
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describeEmbedded("plugin webhook delivery dedup (partial unique index)", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;
  let pluginId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-webhook-dedup-");
    db = createDb(tempDb.connectionString);
    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: "acme.github",
        packageName: "@acme/github",
        version: "1.0.0",
        manifestJson: {
          capabilities: ["webhooks.receive"],
          webhooks: [{ endpointKey: ENDPOINT_KEY }],
        } as never,
        status: "ready",
      })
      .returning({ id: plugins.id });
    pluginId = plugin.id;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function insertDelivery(externalId: string | null, webhookKey = ENDPOINT_KEY) {
    return db
      .insert(pluginWebhookDeliveries)
      .values({
        pluginId,
        webhookKey,
        externalId,
        status: "pending",
        payload: {},
        headers: {},
      })
      .onConflictDoNothing()
      .returning({ id: pluginWebhookDeliveries.id });
  }

  it("returns no rows for a duplicate (plugin_id, webhook_key, external_id)", async () => {
    const first = await insertDelivery("dup-guid-1");
    expect(first).toHaveLength(1);

    const second = await insertDelivery("dup-guid-1");
    expect(second).toHaveLength(0);
  });

  it("allows the same external_id on a different webhook key", async () => {
    const first = await insertDelivery("shared-guid", "gh-events-a");
    const second = await insertDelivery("shared-guid", "gh-events-b");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("never deduplicates NULL external ids", async () => {
    const first = await insertDelivery(null);
    const second = await insertDelivery(null);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});
