import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  posthogAssetsOrigin,
  posthogUiHost,
  resolveBrowserAnalyticsConfig,
} from "../services/cloud-posthog-browser.js";
import { resolveCloudPostHogConfig } from "../services/cloud-posthog-config.js";
import {
  createPostHogProxyLimitReporter,
  DEFAULT_POSTHOG_PROXY_LIMITS,
  posthogProxyClientKey,
  posthogProxyRoutes,
  posthogUpstreamUrl,
  posthogVisitorIp,
  resolvePostHogProxyLimits,
  resolvePostHogProxyMount,
  type PostHogProxyLimits,
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
      consentRequired: null,
      cloudTrialInferenceEnabled: false,
    });
  });

  it("decides consent from the configured edge country header, and leaves it to the browser otherwise", () => {
    const on = { ...CLOUD, ...TOKEN, ...BROWSER };
    const withHeader = { ...on, PAPERCLIP_POSTHOG_COUNTRY_HEADER: "CF-IPCountry" };
    expect(resolveBrowserAnalyticsConfig(on, { "cf-ipcountry": "DE" })?.consentRequired).toBeNull();
    expect(resolveBrowserAnalyticsConfig(withHeader, { "cf-ipcountry": "DE" })?.consentRequired).toBe(true);
    expect(resolveBrowserAnalyticsConfig(withHeader, { "cf-ipcountry": "gb" })?.consentRequired).toBe(true);
    expect(resolveBrowserAnalyticsConfig(withHeader, { "cf-ipcountry": "CH" })?.consentRequired).toBe(true);
    expect(resolveBrowserAnalyticsConfig(withHeader, { "cf-ipcountry": "NO" })?.consentRequired).toBe(true);
    expect(resolveBrowserAnalyticsConfig(withHeader, { "cf-ipcountry": "US" })?.consentRequired).toBe(false);
    expect(resolveBrowserAnalyticsConfig(withHeader, { "cf-ipcountry": "XX" })?.consentRequired).toBeNull();
    expect(resolveBrowserAnalyticsConfig(withHeader, {})?.consentRequired).toBeNull();
    expect(resolveBrowserAnalyticsConfig(withHeader, { "cf-ipcountry": ["FR", "US"] })?.consentRequired).toBe(true);
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

  it("forwards the visitor's IP from X-Forwarded-For when the peer is a private proxy hop", async () => {
    const res = await request(proxyApp())
      .post("/_ph/e/")
      .set("Content-Type", "application/json")
      .set("X-Forwarded-For", "8.8.8.8, 100.64.0.11")
      .send(JSON.stringify({ event: "$pageview" }));

    expect(res.status).toBe(200);
    expect(seen[0]!.headers["x-forwarded-for"]).toBe("8.8.8.8");
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
    app.use("/_ph", posthogProxyRoutes(upstreamUrl, { maxBodyBytes: 10, maxInFlightPerClient: 16, maxInFlight: 256, requestDeadlineMs: 60_000 }));
    const res = await request(app).post("/_ph/e/").set("Content-Type", "text/plain").send("x".repeat(11));
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("cuts off a streamed body that grows past the limit", async () => {
    const app = express();
    app.use("/_ph", posthogProxyRoutes(upstreamUrl, { maxBodyBytes: 10, maxInFlightPerClient: 16, maxInFlight: 256, requestDeadlineMs: 60_000 }));
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

  async function withHeldUpstream(
    limits: PostHogProxyLimits,
    run: (send: (ip?: string) => Promise<number>, release: () => void, arrived: (count: number) => Promise<void>) => Promise<void>,
    options: { trustProxy?: boolean; reportLimit?: Parameters<typeof posthogProxyRoutes>[2] } = {},
  ) {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    const waiters: Array<{ count: number; resolve: () => void }> = [];
    const slow = http.createServer(async (_req, res) => {
      arrivals += 1;
      for (const waiter of waiters.filter((entry) => entry.count <= arrivals)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      await held;
      res.end("ok");
    });
    const arrived = (count: number) =>
      count <= arrivals ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push({ count, resolve }); });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const app = express();
    if (options.trustProxy) app.set("trust proxy", "loopback");
    app.use("/_ph", posthogProxyRoutes(`http://127.0.0.1:${(slow.address() as AddressInfo).port}`, limits, options.reportLimit));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const send = (ip?: string) => {
      const req = request(server).get("/_ph/static/array.js");
      if (ip) req.set("X-Forwarded-For", ip);
      return req.then((res) => res.status);
    };
    try {
      await run(send, release, arrived);
    } finally {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  }

  it("limits requests in flight from one public client address", async () => {
    const limits = { maxBodyBytes: 1024, maxInFlightPerClient: 1, maxInFlight: 256, requestDeadlineMs: 60_000 };
    await withHeldUpstream(limits, async (send, release, arrived) => {
      const first = send("8.8.8.8");
      await arrived(1);
      expect(await send("8.8.8.8")).toBe(429);
      const other = send("9.9.9.9");
      await arrived(2);
      release();
      expect(await first).toBe(200);
      expect(await other).toBe(200);
      expect(await send("8.8.8.8")).toBe(200);
    }, { trustProxy: true });
  });

  it("applies only the total limit when the client address is a shared private hop", async () => {
    const limits = { maxBodyBytes: 1024, maxInFlightPerClient: 1, maxInFlight: 3, requestDeadlineMs: 60_000 };
    await withHeldUpstream(limits, async (send, release, arrived) => {
      const held = [send(), send(), send()];
      await arrived(3);
      expect(await send()).toBe(429);
      release();
      expect(await Promise.all(held)).toEqual([200, 200, 200]);
      expect(await send()).toBe(200);
    });
  });

  it("does not key the per-client limit on a forged X-Forwarded-For when no proxy is trusted", async () => {
    const limits = { maxBodyBytes: 1024, maxInFlightPerClient: 1, maxInFlight: 8, requestDeadlineMs: 60_000 };
    await withHeldUpstream(limits, async (send, release, arrived) => {
      const held = [send("8.8.8.8"), send("8.8.8.8"), send("8.8.8.8")];
      await arrived(3);
      release();
      expect(await Promise.all(held)).toEqual([200, 200, 200]);
    });
  });

  it("frees a slot when PostHog holds a request past the request deadline", async () => {
    const limits = { maxBodyBytes: 1024, maxInFlightPerClient: 8, maxInFlight: 1, requestDeadlineMs: 200 };
    await withHeldUpstream(limits, async (send, _release, arrived) => {
      const startedAt = Date.now();
      const first = send();
      await arrived(1);
      expect(await send()).toBe(429);
      expect(await first).toBe(502);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      const second = send();
      await arrived(2);
      expect(await second).toBe(502);
    });
  });

  it("closes a response the browser does not read by the request deadline", async () => {
    const big = Buffer.alloc(16 * 1024 * 1024, 120);
    const finished: string[] = [];
    const fast = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/javascript", "content-length": String(big.length) });
      res.end(big, () => finished.push("upstream"));
    });
    await new Promise<void>((resolve) => fast.listen(0, "127.0.0.1", resolve));
    const app = express();
    app.use("/_ph", posthogProxyRoutes(`http://127.0.0.1:${(fast.address() as AddressInfo).port}`, { maxBodyBytes: 1024, maxInFlightPerClient: 8, maxInFlight: 1, requestDeadlineMs: 300 }, () => {}));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      let browserRequest: http.ClientRequest | undefined;
      const headers = await new Promise<number>((resolve) => {
        browserRequest = http.get({ host: "127.0.0.1", port, path: "/_ph/static/recorder.js" }, (res) => {
          res.on("error", () => {});
          res.pause();
          resolve(res.statusCode ?? 0);
        });
        browserRequest.on("error", () => {});
      });
      expect(headers).toBe(200);
      expect((await request(server).get("/_ph/static/array.js")).status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(finished).toEqual(["upstream"]);
      const next = await request(server).get("/_ph/static/array.js");
      browserRequest?.destroy();
      expect(next.status).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fast.closeAllConnections();
      await new Promise<void>((resolve) => fast.close(() => resolve()));
    }
  });

  it("cuts off a body that trickles in past the request deadline", async () => {
    const app = express();
    app.use("/_ph", posthogProxyRoutes(upstreamUrl, { maxBodyBytes: 1024, maxInFlightPerClient: 8, maxInFlight: 1, requestDeadlineMs: 200 }, () => {}));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    let drip: ReturnType<typeof setInterval> | undefined;
    try {
      const startedAt = Date.now();
      const outcome = await new Promise<number | string>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/_ph/e/", method: "POST", headers: { "content-type": "text/plain", "transfer-encoding": "chunked" } }, (res) => {
          res.on("error", () => {});
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", () => resolve("error"));
        req.on("close", () => resolve("closed"));
        drip = setInterval(() => req.write("x"), 20);
      });
      expect([502, "error", "closed"]).toContain(outcome);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect((await request(server).get("/_ph/static/array.js")).status).not.toBe(429);
    } finally {
      clearInterval(drip);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("limits requests in flight in total across public clients and reports each refusal", async () => {
    const limits = { maxBodyBytes: 1024, maxInFlightPerClient: 8, maxInFlight: 2, requestDeadlineMs: 60_000 };
    const reported: Array<[string, number]> = [];
    await withHeldUpstream(limits, async (send, release, arrived) => {
      const held = [send("8.8.8.8"), send("9.9.9.9")];
      await arrived(2);
      expect(await send("1.1.1.1")).toBe(429);
      release();
      expect(await Promise.all(held)).toEqual([200, 200]);
    }, { trustProxy: true, reportLimit: (reason, inFlight) => reported.push([reason, inFlight]) });
    expect(reported).toEqual([["total", 2]]);
  });

  it("reports a per-client refusal with its reason", async () => {
    const limits = { maxBodyBytes: 1024, maxInFlightPerClient: 1, maxInFlight: 8, requestDeadlineMs: 60_000 };
    const reported: Array<[string, number]> = [];
    await withHeldUpstream(limits, async (send, release, arrived) => {
      const first = send("8.8.8.8");
      await arrived(1);
      expect(await send("8.8.8.8")).toBe(429);
      release();
      expect(await first).toBe(200);
    }, { trustProxy: true, reportLimit: (reason, inFlight) => reported.push([reason, inFlight]) });
    expect(reported).toEqual([["per_client", 1]]);
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

describe("posthogVisitorIp", () => {
  it("keeps a public peer address and ignores X-Forwarded-For", () => {
    expect(posthogVisitorIp("9.9.9.9", { "x-forwarded-for": "8.8.8.8" })).toBe("9.9.9.9");
  });

  it.each(["100.64.0.11", "10.1.2.3", "172.20.0.1", "192.168.1.5", "127.0.0.1", "::1", "::ffff:100.64.0.5", "::ffff:7f00:1", "fd00::1", "febf::1"])(
    "uses the edge-appended X-Forwarded-For entry behind private hop %s",
    (peer) => {
      expect(posthogVisitorIp(peer, { "x-forwarded-for": "8.8.8.8, 100.64.0.2" })).toBe("8.8.8.8");
    },
  );

  it("ignores a client-supplied leftmost entry and uses the address the edge appended", () => {
    expect(posthogVisitorIp("100.64.0.11", { "x-forwarded-for": "1.2.3.4, 1.1.1.1" })).toBe("1.1.1.1");
    expect(posthogVisitorIp("100.64.0.11", { "x-forwarded-for": "1.2.3.4, 1.1.1.1, 100.64.0.3" })).toBe("1.1.1.1");
  });

  it("falls back to the peer when X-Forwarded-For is missing or not an IP", () => {
    expect(posthogVisitorIp("100.64.0.11", {})).toBe("100.64.0.11");
    expect(posthogVisitorIp("100.64.0.11", { "x-forwarded-for": "not-an-ip" })).toBe("100.64.0.11");
    expect(posthogVisitorIp("100.64.0.11", { "x-forwarded-for": "10.0.0.1, 100.64.0.3" })).toBe("100.64.0.11");
  });
});

describe("PostHog proxy limits", () => {
  const ON = { ...CLOUD, ...TOKEN, ...BROWSER };

  it("fits many tabs per user and many users per stack by default", () => {
    expect(DEFAULT_POSTHOG_PROXY_LIMITS).toEqual({
      maxBodyBytes: 64 * 1024 * 1024,
      maxInFlightPerClient: 128,
      maxInFlight: 1024,
      requestDeadlineMs: 60_000,
    });
    const warn = vi.fn();
    expect(resolvePostHogProxyLimits({}, warn)).toEqual(DEFAULT_POSTHOG_PROXY_LIMITS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads both limits from the environment", () => {
    const warn = vi.fn();
    const limits = resolvePostHogProxyLimits(
      {
        PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT: "65536",
        PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT: " 256 ",
      },
      warn,
    );
    expect(limits).toEqual({ ...DEFAULT_POSTHOG_PROXY_LIMITS, maxInFlight: 65536, maxInFlightPerClient: 256 });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["0", "-5", "1.5", "1e3", "12abc", "abc", "0x10", "+8", "65537", "1024000", "99999999999999999999"])(
    "keeps the default and warns for the invalid value %s",
    (value) => {
      const warn = vi.fn();
      const limits = resolvePostHogProxyLimits(
        { PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT: value, PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT: value },
        warn,
      );
      expect(limits).toEqual(DEFAULT_POSTHOG_PROXY_LIMITS);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.map(([fields]) => fields.variable)).toEqual([
        "PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT",
        "PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT",
      ]);
    },
  );

  it("treats an empty value as unset", () => {
    const warn = vi.fn();
    expect(resolvePostHogProxyLimits({ PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT: " " }, warn)).toEqual(DEFAULT_POSTHOG_PROXY_LIMITS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes the configured limits to the mounted proxy", () => {
    const mount = resolvePostHogProxyMount({
      ...ON,
      PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT: "2048",
      PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT: "64",
    });
    expect(mount?.limits).toEqual({ ...DEFAULT_POSTHOG_PROXY_LIMITS, maxInFlight: 2048, maxInFlightPerClient: 64 });
    expect(resolvePostHogProxyMount({ ...ON, PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT: "lots" })?.limits).toEqual(
      DEFAULT_POSTHOG_PROXY_LIMITS,
    );
  });

  it.each([
    ["8.8.8.8", "8.8.8.8"],
    ["2001:4860:4860::8888", "2001:4860:4860::8888"],
    ["100.64.0.11", null],
    ["10.0.0.2", null],
    ["127.0.0.1", null],
    ["::1", null],
    ["::ffff:127.0.0.1", null],
    ["fd00::1", null],
    [undefined, null],
  ])("uses %s as a per-client bucket only when it is public", (ip, key) => {
    expect(posthogProxyClientKey(ip)).toBe(key);
  });

  it("warns at most once a minute and counts the refusals in between", () => {
    let now = 1_000;
    const warn = vi.fn();
    const report = createPostHogProxyLimitReporter(DEFAULT_POSTHOG_PROXY_LIMITS, { now: () => now, warn });

    report("total", 1024);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({
      refusedAtTotalLimit: 1,
      refusedAtPerClientLimit: 0,
      inFlight: 1024,
      maxInFlight: 1024,
      maxInFlightPerClient: 128,
      sinceMs: null,
    });

    for (let index = 0; index < 50; index += 1) {
      now += 1_000;
      report(index % 2 === 0 ? "per_client" : "total", 900);
    }
    expect(warn).toHaveBeenCalledTimes(1);

    now = 61_000;
    report("per_client", 700);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]![0]).toMatchObject({
      refusedAtTotalLimit: 25,
      refusedAtPerClientLimit: 26,
      inFlight: 700,
      sinceMs: 60_000,
    });

    now += 59_999;
    report("total", 1024);
    expect(warn).toHaveBeenCalledTimes(2);
    now += 1;
    report("total", 1024);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2]![0]).toMatchObject({ refusedAtTotalLimit: 2, refusedAtPerClientLimit: 0 });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
