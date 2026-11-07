import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, pluginWebhookDeliveries, plugins } from "@paperclipai/db";
import { pluginRoutes, pluginWebhookJsonbValue } from "../routes/plugins.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// PostgreSQL refuses a jsonb value that holds U+0000 or an unpaired UTF-16 surrogate (22P05). The webhook route
// stores a jsonb-safe copy of the body and headers on the delivery row, and passes the request to the worker as sent.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

describe("pluginWebhookJsonbValue", () => {
  it("drops NUL and replaces unpaired surrogates in keys and values, and keeps everything else", () => {
    expect(pluginWebhookJsonbValue({ "k\u0000ey": ["a\u0000b", { n: "\ud800x\udc00" }], pair: "\ud83d\ude00", n: 1 }))
      .toEqual({ key: ["ab", { n: "\ufffdx\ufffd" }], pair: "\ud83d\ude00", n: 1 });
  });

  it("keeps an escaped backslash before a literal u0000, and returns a clean value unchanged", () => {
    expect(pluginWebhookJsonbValue({ path: "C:\\u0000", both: "\\\u0000" })).toEqual({ path: "C:\\u0000", both: "\\" });
    const clean = { a: "b", c: [1, null] };
    expect(pluginWebhookJsonbValue(clean)).toBe(clean);
  });
});

describe.skipIf(!embeddedPostgresSupport.supported)("plugin webhook route: Postgres-invalid Unicode", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const workerCall = vi.fn(async () => undefined);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-webhook-unicode-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    workerCall.mockReset();
    workerCall.mockImplementation(async () => undefined);
    await db.delete(pluginWebhookDeliveries);
    await db.delete(plugins);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin() {
    const id = randomUUID();
    const key = `paperclip.webhook-unicode-test-${id.slice(0, 8)}`;
    await db.insert(plugins).values({
      id,
      pluginKey: key,
      packageName: `@paperclipai/${key}`,
      version: "0.0.1",
      apiVersion: 1,
      categories: ["connector"],
      manifestJson: {
        id: key, apiVersion: 1, version: "0.0.1", displayName: "Webhook test", description: "Test plugin",
        author: "Paperclip", categories: ["connector"], capabilities: ["webhooks.receive"],
        entrypoints: { worker: "./dist/worker.js" },
        webhooks: [{ endpointKey: "hook", displayName: "Hook" }],
      },
      status: "ready",
      installOrder: 1,
    } as never);
    return id;
  }

  function app() {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
    a.use("/api", pluginRoutes(db, {} as never, undefined, { workerManager: { call: workerCall } } as never));
    return a;
  }

  it("records a delivery whose body holds NUL and an unpaired surrogate, and passes the body to the worker as sent", async () => {
    const id = await seedPlugin();
    const body = '{"text":"a\\u0000b","bad\\u0000key":"\\ud800"}';
    const res = await request(app())
      .post(`/api/plugins/${id}/webhooks/hook`)
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(workerCall).toHaveBeenCalledTimes(1);
    expect(workerCall.mock.calls[0]).toEqual([id, "handleWebhook", expect.objectContaining({
      rawBody: body,
      parsedBody: { text: "a\u0000b", "bad\u0000key": "\ud800" },
    })]);
    const rows = await db.select().from(pluginWebhookDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "success", payload: { text: "ab", badkey: "\ufffd" } });
  });
});
