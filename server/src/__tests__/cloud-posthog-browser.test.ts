import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  posthogAssetsOrigin,
  posthogUiHost,
  resolveBrowserAnalyticsConfig,
} from "../services/cloud-posthog-browser.js";
import { resolveCloudPostHogConfig } from "../services/cloud-posthog-config.js";
import {
  posthogProxyRoutes,
  posthogUpstreamUrl,
  resolvePostHogProxyMount,
} from "../routes/posthog-proxy.js";

const CLOUD = { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-token", PAPERCLIP_CLOUD_STACK_ID: "stack-1" };
const TOKEN = { PAPERCLIP_POSTHOG_PROJECT_TOKEN: "phc_test" };
const BROWSER = { PAPERCLIP_POSTHOG_BROWSER_ENABLED: "1" };

describe("browser analytics config exposure", () => {
  const cases: Array<[string, Record<string, string>, boolean, boolean | null]> = [
    ["self-hosted, even with every PostHog switch set", { ...TOKEN, ...BROWSER, PAPERCLIP_CLOUD_STACK_ID: "stack-1" }, false, null],
    ["Cloud without a token", { ...CLOUD, ...BROWSER }, false, null],
    ["Cloud without a stack ID", { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "t", ...TOKEN, ...BROWSER }, false, null],
    ["Cloud with a token but no browser switch", { ...CLOUD, ...TOKEN }, false, null],
    ["Cloud with the browser switch set to something other than 1", { ...CLOUD, ...TOKEN, PAPERCLIP_POSTHOG_BROWSER_ENABLED: "true" }, false, null],
    ["Cloud with browser analytics on", { ...CLOUD, ...TOKEN, ...BROWSER }, true, true],
    ["Cloud with browser analytics on and replay off", { ...CLOUD, ...TOKEN, ...BROWSER, PAPERCLIP_POSTHOG_REPLAY_ENABLED: "0" }, true, false],
  ];

  it.each(cases)("%s", (_name, env, exposed, replayEnabled) => {
    const config = resolveBrowserAnalyticsConfig(env);
    if (!exposed) {
      expect(config).toBeNull();
      return;
    }
    expect(config).toEqual({
      token: "phc_test",
      apiHost: "/_ph",
      uiHost: "https://us.posthog.com",
      environment: "production",
      stackId: "stack-1",
      replayEnabled,
    });
  });

  it("always sends an environment: the explicit variable, else staging or production from the host", () => {
    const on = { ...CLOUD, ...TOKEN, ...BROWSER };
    expect(resolveBrowserAnalyticsConfig({ ...on, PAPERCLIP_POSTHOG_ENVIRONMENT: "qa" })?.environment).toBe("qa");
    expect(resolveBrowserAnalyticsConfig({ ...on, PAPERCLIP_PRIMARY_HOST: "acme.staging.paperclip.app" })?.environment).toBe("staging");
    expect(resolveBrowserAnalyticsConfig({ ...on, PAPERCLIP_PRIMARY_HOST: "acme.paperclip.app" })?.environment).toBe("production");
  });

  it("never turns replay on without the browser switch", () => {
    expect(resolveCloudPostHogConfig({ ...CLOUD, ...TOKEN, PAPERCLIP_POSTHOG_REPLAY_ENABLED: "1" })?.replayEnabled).toBe(false);
  });

  it("keeps browser analytics off for an invalid host", () => {
    expect(resolveBrowserAnalyticsConfig({ ...CLOUD, ...TOKEN, ...BROWSER, PAPERCLIP_POSTHOG_HOST: "not a url" })).toBeNull();
  });

  it("maps PostHog Cloud hosts to their assets and app hosts", () => {
    expect(posthogAssetsOrigin("https://us.i.posthog.com")).toBe("https://us-assets.i.posthog.com");
    expect(posthogAssetsOrigin("https://eu.i.posthog.com")).toBe("https://eu-assets.i.posthog.com");
    expect(posthogAssetsOrigin("http://127.0.0.1:9999")).toBe("http://127.0.0.1:9999");
    expect(posthogUiHost("https://eu.i.posthog.com")).toBe("https://eu.posthog.com");
    expect(posthogUiHost("http://127.0.0.1:9999")).toBeNull();
  });
});

describe("PostHog proxy mount", () => {
  it("is not mounted unless browser analytics is on", () => {
    expect(resolvePostHogProxyMount({})).toBeNull();
    expect(resolvePostHogProxyMount({ ...TOKEN, ...BROWSER, PAPERCLIP_CLOUD_STACK_ID: "s" })).toBeNull();
    expect(resolvePostHogProxyMount({ ...CLOUD, ...TOKEN })).toBeNull();
    expect(resolvePostHogProxyMount({ ...CLOUD, ...TOKEN, ...BROWSER })?.path).toBe("/_ph");
  });

  it("routes static assets to the assets host and events to the ingest host", () => {
    const host = "https://us.i.posthog.com";
    expect(posthogUpstreamUrl(host, "GET", "/static/recorder.js?v=1")?.href)
      .toBe("https://us-assets.i.posthog.com/static/recorder.js?v=1");
    expect(posthogUpstreamUrl(host, "GET", "/array/phc_x/config.js")?.origin).toBe("https://us-assets.i.posthog.com");
    expect(posthogUpstreamUrl(host, "GET", "/array/phc_x/config")?.origin).toBe("https://us-assets.i.posthog.com");
    expect(posthogUpstreamUrl(host, "GET", "/static/1.442.1/lazy-recorder.js")?.href)
      .toBe("https://us-assets.i.posthog.com/static/1.442.1/lazy-recorder.js");
    expect(posthogUpstreamUrl(host, "POST", "/e/?ip=0")?.href).toBe("https://us.i.posthog.com/e/?ip=0");
    expect(posthogUpstreamUrl(host, "POST", "/i/v0/e/")?.origin).toBe("https://us.i.posthog.com");
    expect(posthogUpstreamUrl(host, "POST", "/s/?compression=gzip-js")?.pathname).toBe("/s/");
    expect(posthogUpstreamUrl(host, "POST", "/flags/?v=2")?.pathname).toBe("/flags/");
  });

  it.each([
    ["GET", "/e/"],
    ["PUT", "/e/"],
    ["DELETE", "/s/"],
    ["OPTIONS", "/flags/"],
    ["POST", "/static/recorder.js"],
    ["GET", "/api/projects/"],
    ["POST", "/api/surveys/"],
    ["GET", "/static/../api/x.js"],
    ["GET", "/static/recorder.css"],
    ["GET", "/static/v1/../x.js"],
    ["GET", "/static/a/b/c.js"],
    ["GET", "//evil.example/static/x.js"],
    ["POST", "//evil.example/e/"],
    ["GET", "/array/phc_x/../../api"],
    ["GET", "/"],
  ])("refuses %s %s", (method, path) => {
    expect(posthogUpstreamUrl("https://us.i.posthog.com", method, path)).toBeNull();
  });
});

describe("PostHog proxy forwarding", () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }>;

  beforeEach(async () => {
    seen = [];
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=1" });
        res.end(JSON.stringify({ status: 1 }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  function proxyApp() {
    const mount = resolvePostHogProxyMount({ ...CLOUD, ...TOKEN, ...BROWSER, PAPERCLIP_POSTHOG_HOST: upstreamUrl });
    expect(mount).not.toBeNull();
    const app = express();
    app.use(mount!.path, mount!.router);
    // A body parser after the proxy, as in app.ts, must never see proxied bodies.
    app.use(express.json());
    return app;
  }

  it("streams the request body and strips Host, Cookie, Authorization and set-cookie", async () => {
    const res = await request(proxyApp())
      .post("/_ph/e/?compression=gzip-js")
      .set("Host", "acme.paperclip.app")
      .set("Content-Type", "application/json")
      .set("Cookie", "paperclip.session=secret")
      .set("Authorization", "Bearer secret")
      .set("X-POSTHOG-SESSION-ID", "s1")
      .send(JSON.stringify({ event: "$pageview" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 1 });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("/e/?compression=gzip-js");
    expect(seen[0]!.body).toBe(JSON.stringify({ event: "$pageview" }));
    expect(seen[0]!.headers.host).toBe(new URL(upstreamUrl).host);
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers["x-posthog-session-id"]).toBeUndefined();
    expect(seen[0]!.headers["x-forwarded-for"]).toBeTruthy();
  });

  it.each([
    ["GET", "/_ph/api/projects/@current"],
    ["PUT", "/_ph/e/"],
    ["DELETE", "/_ph/e/"],
    ["GET", "/_ph/e/"],
    ["POST", "/_ph/static/recorder.js"],
  ])("answers 404 to %s %s without contacting PostHog", async (method, path) => {
    const res = await request(proxyApp())[method.toLowerCase() as "get"](path);
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("refuses a declared body over the limit without contacting PostHog", async () => {
    const app = express();
    app.use("/_ph", posthogProxyRoutes(upstreamUrl, { maxBodyBytes: 10, maxInFlightPerClient: 16, maxInFlight: 256 }));
    const res = await request(app).post("/_ph/e/").set("Content-Type", "text/plain").send("x".repeat(11));
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("cuts off a streamed body that grows past the limit", async () => {
    const app = express();
    app.use("/_ph", posthogProxyRoutes(upstreamUrl, { maxBodyBytes: 10, maxInFlightPerClient: 16, maxInFlight: 256 }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const status = await new Promise<number | string>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/_ph/e/", method: "POST", headers: { "content-type": "text/plain", "transfer-encoding": "chunked" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", () => resolve("error"));
        req.write("x".repeat(8));
        req.write("x".repeat(8));
        req.end();
      });
      expect([413, "error"]).toContain(status);
      expect(seen.every((entry) => entry.body.length <= 10)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("limits requests in flight from one client", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = http.createServer(async (_req, res) => { await held; res.end("ok"); });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const app = express();
    app.use("/_ph", posthogProxyRoutes(`http://127.0.0.1:${(slow.address() as AddressInfo).port}`, { maxBodyBytes: 1024, maxInFlightPerClient: 1, maxInFlight: 256 }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const first = request(server).get("/_ph/static/array.js").then((res) => res.status);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await request(server).get("/_ph/static/array.js");
      expect(second.status).toBe(429);
      release();
      expect(await first).toBe(200);
      // The slot frees up once the first request finishes.
      expect((await request(server).get("/_ph/static/array.js")).status).toBe(200);
    } finally {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  it("never forwards the inbound Host header", async () => {
    await request(proxyApp()).get("/_ph/static/recorder.js").set("Host", "acme.paperclip.app");
    expect(seen[0]!.headers.host).toBe(new URL(upstreamUrl).host);
  });

  it("answers 502 when PostHog cannot be reached", async () => {
    const mount = resolvePostHogProxyMount({ ...CLOUD, ...TOKEN, ...BROWSER, PAPERCLIP_POSTHOG_HOST: "http://127.0.0.1:1" });
    const app = express();
    app.use(mount!.path, mount!.router);
    const res = await request(app).get("/_ph/static/array.js");
    expect(res.status).toBe(502);
  });

  it("survives PostHog closing the connection partway through a response", async () => {
    const broken = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/javascript", "content-length": "100000" });
      res.write("partial");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const brokenUrl = `http://127.0.0.1:${(broken.address() as AddressInfo).port}`;
    const errors: unknown[] = [];
    const onUncaught = (err: unknown) => errors.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      const mount = resolvePostHogProxyMount({ ...CLOUD, ...TOKEN, ...BROWSER, PAPERCLIP_POSTHOG_HOST: brokenUrl });
      const app = express();
      app.use(mount!.path, mount!.router);
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const outcome = await new Promise<string>((resolve) => {
        http.get(`http://127.0.0.1:${port}/_ph/static/recorder.js`, (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve("end"));
          res.on("error", () => resolve("error"));
          res.on("aborted", () => resolve("aborted"));
        }).on("error", () => resolve("error"));
      });
      // The browser sees a cut-off response, not a complete one.
      expect(outcome).not.toBe("end");
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The proxy keeps serving after the broken response.
      const health = await request(server).put("/_ph/e/");
      expect(health.status).toBe(404);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      process.off("uncaughtException", onUncaught);
      await new Promise<void>((resolve) => broken.close(() => resolve()));
    }
    expect(errors).toEqual([]);
  });
});
