// Tests for the API/worker-split reverse proxy. Verifies that
// registerWorkerTierProxyRoutes forwards worker-dependent plugin routes to a
// configured worker-tier URL, shadows the real handlers, leaves
// non-allowlisted routes alone, and degrades cleanly when the worker tier is
// unreachable.

import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import request from "supertest";
import {
  registerWorkerTierProxyRoutes,
  WORKER_DEPENDENT_PLUGIN_ROUTES,
} from "../routes/worker-tier-proxy.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Stub worker tier — records the request and replies with a scripted response. */
function startWorkerStub(
  handler: (captured: CapturedRequest) => {
    status: number;
    headers?: Record<string, string>;
    body: string;
  },
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const result = handler({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(result.status, {
        "content-type": "application/json",
        ...result.headers,
      });
      res.end(result.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function buildApp(workersUrl: string) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerWorkerTierProxyRoutes(router, workersUrl);
  // Real handlers registered AFTER the proxy — they must be shadowed for
  // allowlisted routes and reached for everything else.
  router.post("/plugins/:pluginId/enable", (_req, res) => {
    res.status(200).json({ handledBy: "local" });
  });
  router.get("/plugins", (_req, res) => {
    res.status(200).json({ handledBy: "local" });
  });
  app.use("/api", router);
  return app;
}

/**
 * Build a test app that mirrors the PRODUCTION body-parser stack from
 * server/src/app.ts: express.json + express.urlencoded + express.raw catch-all,
 * each capturing the exact request bytes into req.rawBody. The proxy forwards
 * req.rawBody verbatim, so webhook signature verification downstream sees the
 * bytes the provider signed (Slack/Linear HMAC). Used by the raw-body-fidelity
 * tests; the plain buildApp above keeps the legacy bare express.json() setup.
 */
function buildAppWithRawCapture(workersUrl: string) {
  const captureRawBody = (
    req: express.Request,
    _res: express.Response,
    buf: Buffer,
  ) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false, verify: captureRawBody }));
  app.use(express.raw({ type: "*/*", verify: captureRawBody }));
  const router = express.Router();
  registerWorkerTierProxyRoutes(router, workersUrl);
  app.use("/api", router);
  return app;
}

async function getFreePort(): Promise<number> {
  const server = createServer((_req, res) => res.end());
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe("registerWorkerTierProxyRoutes", () => {
  let worker: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  it("proxies an allowlisted route to the worker tier, shadowing the local handler", async () => {
    let captured: CapturedRequest | undefined;
    worker = await startWorkerStub((req) => {
      captured = req;
      return { status: 201, body: JSON.stringify({ handledBy: "worker" }) };
    });
    const app = buildApp(worker.url);

    const res = await request(app)
      .post("/api/plugins/ccrotate/enable")
      .send({ note: "activate" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ handledBy: "worker" });
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/api/plugins/ccrotate/enable");
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({ note: "activate" });
  });

  it("does NOT proxy non-allowlisted routes — they reach the local handler", async () => {
    let workerHit = false;
    worker = await startWorkerStub(() => {
      workerHit = true;
      return { status: 200, body: "{}" };
    });
    const app = buildApp(worker.url);

    const res = await request(app).get("/api/plugins");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handledBy: "local" });
    expect(workerHit).toBe(false);
  });

  it("proxies plugin webhooks to the worker tier", async () => {
    let captured: CapturedRequest | undefined;
    worker = await startWorkerStub((req) => {
      captured = req;
      return { status: 200, body: JSON.stringify({ status: "success" }) };
    });
    const app = buildApp(worker.url);

    const res = await request(app)
      .post("/api/plugins/paperclip-plugin-linear/webhooks/linear-events")
      .send({ action: "update" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success" });
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe(
      "/api/plugins/paperclip-plugin-linear/webhooks/linear-events",
    );
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({ action: "update" });
  });

  it("forwards a form-urlencoded webhook body verbatim with its original content-type (Slack interactivity)", async () => {
    let captured: CapturedRequest | undefined;
    worker = await startWorkerStub((req) => {
      captured = req;
      return { status: 200, body: JSON.stringify({ ok: true }) };
    });
    const app = buildAppWithRawCapture(worker.url);

    // Slack interactivity arrives as application/x-www-form-urlencoded with a
    // single `payload=<urlencoded-json>` field — the exact bytes Slack signed.
    const rawBody =
      "payload=%7B%22type%22%3A%22block_actions%22%2C%22actions%22%3A%5B%5D%7D";

    await request(app)
      .post("/api/plugins/paperclip-plugin-slack/webhooks/slack-interactivity")
      .set("content-type", "application/x-www-form-urlencoded")
      .send(rawBody);

    // The worker MUST receive the exact signed bytes, not "{}" (the bug:
    // express.json skips form bodies -> req.body={} -> proxied as JSON.stringify({})).
    expect(captured?.body).toBe(rawBody);
    // And the original content-type MUST survive, not be forced to application/json.
    expect(captured?.headers["content-type"]).toMatch(
      /application\/x-www-form-urlencoded/,
    );
  });

  it("forwards auth-bearing headers so the worker tier can re-authorize", async () => {
    let captured: CapturedRequest | undefined;
    worker = await startWorkerStub((req) => {
      captured = req;
      return { status: 200, body: "{}" };
    });
    const app = buildApp(worker.url);

    await request(app)
      .post("/api/plugins/install")
      .set("cookie", "paperclip.session=abc123")
      .set("authorization", "Bearer tok")
      .send({ package: "@paperclipai/plugin-ccrotate" });

    expect(captured?.headers.cookie).toBe("paperclip.session=abc123");
    expect(captured?.headers.authorization).toBe("Bearer tok");
  });

  it("pins x-forwarded-host to the original hostname so the worker hostname guard passes", async () => {
    let captured: CapturedRequest | undefined;
    worker = await startWorkerStub((req) => {
      captured = req;
      return { status: 200, body: "{}" };
    });
    const app = buildApp(worker.url);

    await request(app)
      .post("/api/plugins/ccrotate/enable")
      .set("host", "paperclip.blockcast.net")
      .send({});

    // host is rewritten to the worker Service by fetch; the original
    // hostname survives as x-forwarded-host (checked first by the guard).
    expect(captured?.headers["x-forwarded-host"]).toBe("paperclip.blockcast.net");
  });

  it("preserves an existing x-forwarded-host instead of overwriting it", async () => {
    let captured: CapturedRequest | undefined;
    worker = await startWorkerStub((req) => {
      captured = req;
      return { status: 200, body: "{}" };
    });
    const app = buildApp(worker.url);

    await request(app)
      .post("/api/plugins/ccrotate/enable")
      .set("host", "paperclip-api.internal")
      .set("x-forwarded-host", "paperclip.blockcast.net")
      .send({});

    expect(captured?.headers["x-forwarded-host"]).toBe("paperclip.blockcast.net");
  });

  it("rewrites the host header away from the original public hostname", async () => {
    let captured: CapturedRequest | undefined;
    worker = await startWorkerStub((req) => {
      captured = req;
      return { status: 200, body: "{}" };
    });
    const app = buildApp(worker.url);

    await request(app)
      .post("/api/plugins/ccrotate/enable")
      .set("host", "paperclip.blockcast.net")
      .send({});

    // fetch addresses the worker Service, so the worker sees its own host —
    // never the original public hostname (which it would forward verbatim).
    expect(captured?.headers.host).not.toBe("paperclip.blockcast.net");
  });

  it("forwards a worker-tier 5xx verbatim to the client", async () => {
    worker = await startWorkerStub(() => ({
      status: 503,
      body: JSON.stringify({ error: "plugin worker crashed" }),
    }));
    const app = buildApp(worker.url);

    const res = await request(app).post("/api/plugins/ccrotate/enable").send({});

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "plugin worker crashed" });
  });

  it("returns 502 when the worker tier is unreachable", async () => {
    // Port 1 is privileged and never listening — fetch fails fast.
    const app = buildApp("http://127.0.0.1:1");

    const res = await request(app).post("/api/plugins/ccrotate/disable").send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/worker tier unreachable/i);
  });

  it("retries idempotent GET routes during worker startup races", async () => {
    const port = await getFreePort();
    const workersUrl = `http://127.0.0.1:${port}`;
    const app = buildApp(workersUrl);
    let hits = 0;

    const delayedWorker = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const listenTimer = setTimeout(() => {
      delayedWorker.listen(port, "127.0.0.1");
    }, 150);

    try {
      const res = await request(app).get(
        "/api/plugins/kkroo.ccrotate/api/state?companyId=abc",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(hits).toBe(1);
    } finally {
      clearTimeout(listenTimer);
      await new Promise<void>((resolve) => {
        if (!delayedWorker.listening) {
          resolve();
          return;
        }
        delayedWorker.close(() => resolve());
      });
    }
  });

  it("streams the worker response body for the SSE bridge route", async () => {
    worker = await startWorkerStub(() => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: "event: ping\ndata: 1\n\nevent: ping\ndata: 2\n\n",
    }));
    const app = buildApp(worker.url);

    const res = await request(app).get(
      "/api/plugins/ccrotate/bridge/stream/pool",
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain("data: 1");
    expect(res.text).toContain("data: 2");
  });

  it("covers exactly the worker-dependent plugin routes", () => {
    // Guard against accidental scope creep / drops in the allowlist.
    expect(WORKER_DEPENDENT_PLUGIN_ROUTES.map((r) => `${r.method} ${r.path}`))
      .toEqual([
        "post /plugins/install",
        "post /plugins/tools/execute",
        "post /plugins/:pluginId/enable",
        "post /plugins/:pluginId/disable",
        "post /plugins/:pluginId/upgrade",
        "delete /plugins/:pluginId",
        "post /plugins/:pluginId/config",
        "post /plugins/:pluginId/config/test",
        "post /plugins/:pluginId/jobs/:jobId/trigger",
        "post /plugins/:pluginId/webhooks/:endpointKey",
        "post /plugins/:pluginId/bridge/data",
        "post /plugins/:pluginId/bridge/action",
        "post /plugins/:pluginId/data/:key",
        "post /plugins/:pluginId/actions/:key",
        "get /plugins/:pluginId/bridge/stream/:channel",
        "get /plugins/:pluginId/api/*splat",
        "post /plugins/:pluginId/api/*splat",
        "put /plugins/:pluginId/api/*splat",
        "delete /plugins/:pluginId/api/*splat",
      ]);
  });

  // Regression for 2026-05-19: PR #84's first cut missed plugin-declared
  // scoped API routes (`/plugins/:pluginId/api/*`), so the UI's ccrotate
  // pool view 503'd from the API tier with "Plugin worker is not running"
  // even though the worker had activated on the worker tier. The proxy
  // must forward GET (snapshot, state-get) and POST (refresh, state-put,
  // import) on any inner path, since `apiRoutes` are manifest-declared
  // per-plugin and only the worker tier knows whether the inner path is
  // valid.
  it("proxies plugin scoped API routes (GET/POST/PUT/DELETE) on any inner path", async () => {
    let captured: CapturedRequest | undefined;
    worker = await startWorkerStub((req) => {
      captured = req;
      return { status: 200, body: JSON.stringify({ ok: true, by: "worker" }) };
    });
    const app = buildApp(worker.url);

    // GET on an arbitrary inner path — exactly what the UI calls.
    const getRes = await request(app).get(
      "/api/plugins/kkroo.ccrotate/api/snapshot?companyId=abc",
    );
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ ok: true, by: "worker" });
    expect(captured?.method).toBe("GET");
    expect(captured?.url).toBe(
      "/api/plugins/kkroo.ccrotate/api/snapshot?companyId=abc",
    );

    // POST on a different inner path with a body.
    const postRes = await request(app)
      .post("/api/plugins/kkroo.ccrotate/api/refresh")
      .send({ companyId: "abc" });
    expect(postRes.status).toBe(200);
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/api/plugins/kkroo.ccrotate/api/refresh");
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({ companyId: "abc" });

    // PUT — covered for plugins that declare PUT routes.
    const putRes = await request(app)
      .put("/api/plugins/some.plugin/api/state/key1")
      .send({ value: "v" });
    expect(putRes.status).toBe(200);
    expect(captured?.method).toBe("PUT");

    // DELETE — same.
    const delRes = await request(app).delete(
      "/api/plugins/some.plugin/api/items/42",
    );
    expect(delRes.status).toBe(200);
    expect(captured?.method).toBe("DELETE");
  });
});
