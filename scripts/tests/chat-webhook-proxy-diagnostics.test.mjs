import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { observeChatWebhookProxyRejection } from "../lib/chat-webhook-proxy-diagnostics.mjs";

const allowedHost = "dottas-macbook-pro.tail29c1aa.ts.net:8443";
const allowedPath = "/api/chat-webhooks/PRIVATE_ENDPOINT_SENTINEL/slack";
const closedKeys = [
  "bytes",
  "connectionId",
  "durationMs",
  "event",
  "reason",
  "statusCode",
];

function assertPrivate(rows) {
  assert.doesNotMatch(
    JSON.stringify(rows),
    /private|sentinel|authorization|forwarded|cookie|https?:\/\//i,
  );
}

function fixtureHandler(rows, connections, upstreamPort) {
  return (req, res) => {
    const observation = observeChatWebhookProxyRejection(req, res, {
      connectionId: connections.get(req.socket),
      emit: (row) => rows.push(row),
    });
    const reject = (reason, status) => {
      observation.reject(reason);
      req.on("data", (chunk) => observation.countBytes(chunk.length));
      res.writeHead(status).end();
      req.resume();
    };
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      reject("malformed_target", 400);
      return;
    }
    if (req.method !== "POST") return reject("method", 404);
    if (req.headers.host?.toLowerCase() !== allowedHost)
      return reject("host", 404);
    if (
      !/^\/api\/chat-webhooks\/[A-Za-z0-9_-]+\/(slack|github|telegram|microsoft-teams)\/?$/.test(
        url.pathname,
      )
    )
      return reject("path", 404);
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };
}

async function harness(t, options = {}) {
  const rows = [];
  const connections = new WeakMap();
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({ path: req.url, host: req.headers.host });
    req.on("error", () => {});
    req.on("end", () => res.writeHead(202).end());
    req.resume();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  let server;
  if (process.env.PAPERCLIP_WEBHOOK_PROXY_UNDER_TEST) {
    // Optional integration against the ignored local proxy; the portable suite
    // needs no live deployment/configuration or ignored workspace artifacts.
    const source = readFileSync(
      process.env.PAPERCLIP_WEBHOOK_PROXY_UNDER_TEST,
      "utf8",
    ).replace(/^import .*;\r?\n/gm, "");
    const wrappedHttp = {
      createServer(handler) {
        server = http.createServer(handler);
        return { on: (...args) => server.on(...args), listen() {} };
      },
      request(options, callback) {
        assert.equal(options.hostname, "127.0.0.1");
        assert.equal(options.port, 3137);
        assert.equal(options.timeout, 30_000);
        return http.request(
          { ...options, port: upstream.address().port },
          callback,
        );
      },
    };
    new Function(
      "http",
      "console",
      "observeChatWebhookProxyRejection",
      "process",
      source,
    )(
      wrappedHttp,
      {
        log: (line) => {
          try {
            rows.push(JSON.parse(line));
          } catch {}
        },
      },
      observeChatWebhookProxyRejection,
      { env: { PAPERCLIP_QA_FAIL_ONCE_GITHUB_PATH: options.faultPath } },
    );
  } else {
    server = http.createServer(
      fixtureHandler(rows, connections, upstream.address().port),
    );
    let nextId = 1;
    server.on("connection", (socket) => connections.set(socket, nextId++));
  }
  const baseline = http.createServer();
  assert.equal(server.listenerCount("clientError"), 0);
  for (const key of [
    "keepAliveTimeout",
    "keepAliveTimeoutBuffer",
    "headersTimeout",
    "requestTimeout",
    "timeout",
  ])
    assert.equal(server[key], baseline[key]);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    agent.destroy();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  });
  const request = ({
    method = "POST",
    path = allowedPath,
    host = allowedHost,
    body = "PRIVATE_BODY_SENTINEL",
    headers = {},
  } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          agent,
          host: "127.0.0.1",
          port: server.address().port,
          method,
          path,
          headers: {
            host,
            authorization: "PRIVATE_AUTH_SENTINEL",
            cookie: "PRIVATE_COOKIE_SENTINEL",
            "content-length": Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({ status: res.statusCode, socket: req.socket }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  return { rows, server, upstreamRequests, request };
}

test(
  "real keep-alive HTTP observes each rejection exactly once alongside accepted traffic",
  { timeout: 5_000 },
  async (t) => {
    const { rows, request, upstreamRequests } = await harness(t);
    const first = await request();
    assert.equal(first.status, 202);
    for (const [input, reason, status] of [
      [{ method: "PUT" }, "method", 404],
      [{ host: "PRIVATE_HOST_SENTINEL.invalid" }, "host", 404],
      [
        { path: "/PRIVATE_PATH_SENTINEL?secret=PRIVATE_QUERY_SENTINEL" },
        "path",
        404,
      ],
      [{ path: "http://[PRIVATE_TARGET_SENTINEL" }, "malformed_target", 400],
    ]) {
      const prior = rows.filter(
        (row) => row.event === "chat_webhook_proxy_rejection",
      ).length;
      const response = await request(input);
      assert.equal(response.status, status);
      assert.equal(response.socket, first.socket);
      const observations = rows.filter(
        (row) => row.event === "chat_webhook_proxy_rejection",
      );
      assert.equal(observations.length, prior + 1);
      assert.equal(observations.at(-1).reason, reason);
      assert.equal(observations.at(-1).statusCode, status);
      assert.equal(observations.at(-1).connectionId, 1);
      assert.deepEqual(Object.keys(observations.at(-1)).sort(), closedKeys);
    }
    const last = await request({
      path: `${allowedPath}?token=PRIVATE_QUERY_SENTINEL`,
    });
    assert.equal(last.status, 202);
    assert.equal(last.socket, first.socket);
    assert.equal(upstreamRequests.length, 2);
    assertPrivate(rows);
  },
);

test(
  "real Node parser retains native 400/431 and never reaches rejection observer",
  { timeout: 5_000 },
  async (t) => {
    const { server, rows, upstreamRequests } = await harness(t);
    const exchange = (raw) =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection({
          host: "127.0.0.1",
          port: server.address().port,
        });
        t.after(() => socket.destroy());
        let response = "";
        socket.setTimeout(2_000, () =>
          socket.destroy(new Error("fixture timeout")),
        );
        socket.on("connect", () => socket.write(raw));
        socket.on("data", (chunk) => {
          response += chunk.toString();
        });
        socket.on("error", reject);
        socket.on("close", () => resolve(response));
      });
    assert.match(
      await exchange(
        "INVALID_PRIVATE_METHOD_SENTINEL / HTTP/1.1\r\nHost: private.invalid\r\n\r\n",
      ),
      /^HTTP\/1\.1 400 /,
    );
    assert.match(
      await exchange(
        `GET / HTTP/1.1\r\nHost: private.invalid\r\nX-Private: ${"x".repeat(http.maxHeaderSize + 1024)}\r\n\r\n`,
      ),
      /^HTTP\/1\.1 431 /,
    );
    assert.equal(server.listenerCount("clientError"), 0);
    assert.equal(upstreamRequests.length, 0);
    assert.equal(
      rows.filter((row) => row.event === "chat_webhook_proxy_rejection").length,
      0,
    );
    assertPrivate(rows);
  },
);

test("observer does not read/resume bodies and emits one closed event for abort then close", () => {
  const req = new EventEmitter();
  req.resume = () => assert.fail("observer must not resume request");
  const res = Object.assign(new EventEmitter(), { headersSent: false });
  const rows = [];
  const observation = observeChatWebhookProxyRejection(req, res, {
    connectionId: 4,
    emit: (row) => rows.push(row),
  });
  assert.equal(req.listenerCount("data"), 0);
  observation.reject("path");
  observation.countBytes(17);
  req.emit("aborted");
  res.emit("close");
  res.emit("finish");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bytes, 17);
  assert.equal(rows[0].statusCode, null);
  assert.equal(req.listenerCount("aborted"), 0);
  assertPrivate(rows);
});

for (const failure of ["client_abort", "response_error"]) {
  test(
    `real HTTP ${failure} records one rejection without private error prose`,
    { timeout: 5_000 },
    async (t) => {
      const rows = [];
      let signalBytes;
      const bytesRead = new Promise((resolve) => {
        signalBytes = resolve;
      });
      let response;
      let signalObservation;
      const observed = new Promise((resolve) => {
        signalObservation = resolve;
      });
      const server = http.createServer((req, res) => {
        response = res;
        const observation = observeChatWebhookProxyRejection(req, res, {
          connectionId: 1,
          emit: (row) => {
            rows.push(row);
            signalObservation();
          },
        });
        assert.equal(req.listenerCount("data"), 0);
        observation.reject("path");
        req.on("data", (chunk) => {
          observation.countBytes(chunk.length);
          signalBytes();
        });
        // The fixture deliberately holds its response so it can exercise the
        // observer's abort/close path, not change the deployed rejection policy.
        req.on("error", () => {});
        res.on("error", () => {});
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: server.address().port,
      });
      socket.on("error", () => {});
      const closed = once(socket, "close");
      t.after(async () => {
        socket.destroy();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      await once(socket, "connect");
      socket.write(
        "POST /PRIVATE_PATH_SENTINEL HTTP/1.1\r\nHost: PRIVATE_HOST_SENTINEL.invalid\r\nContent-Length: 100\r\n\r\nabc",
      );
      await bytesRead;
      if (failure === "client_abort") socket.destroy();
      else response.destroy(new Error("PRIVATE_ERROR_SENTINEL"));
      await Promise.all([observed, closed]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(server.listenerCount("clientError"), 0);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].bytes, 3);
      assert.equal(rows[0].statusCode, null);
      assert.deepEqual(Object.keys(rows[0]).sort(), closedKeys);
      assertPrivate(rows);
    },
  );
}

if (process.env.PAPERCLIP_WEBHOOK_PROXY_UNDER_TEST) {
  test(
    "wired proxy preserves its 1 MiB streaming limit and accepted timing",
    { timeout: 5_000 },
    async (t) => {
      const { rows, request } = await harness(t);
      assert.equal(
        (await request({ body: Buffer.alloc(1_048_576) })).status,
        202,
      );
      assert.equal(
        (await request({ body: Buffer.alloc(1_048_577) })).status,
        413,
      );
      const timings = rows.filter(
        (row) => row.event === "chat_webhook_proxy_timing",
      );
      assert.deepEqual(
        timings.map((row) => [row.statusCode, row.outcome, row.bytes]),
        [
          [202, "completed", 1_048_576],
          [413, "body_too_large", 1_048_577],
        ],
      );
      assert.equal(
        rows.filter((row) => row.event === "chat_webhook_proxy_rejection")
          .length,
        0,
      );
      assertPrivate(rows);
    },
  );

  test(
    "wired proxy preserves exact one-shot GitHub fault without rejected-route consumption",
    { timeout: 5_000 },
    async (t) => {
      const faultPath = "/api/chat-webhooks/PRIVATE_ENDPOINT_SENTINEL/github";
      const { rows, request, upstreamRequests } = await harness(t, {
        faultPath,
      });
      assert.equal(
        (
          await request({
            method: "PUT",
            path: faultPath,
            headers: { "x-github-event": "issue_comment" },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request({
            path: faultPath,
            headers: { "x-github-event": "ping" },
          })
        ).status,
        202,
      );
      assert.equal(
        (
          await request({
            path: faultPath,
            headers: { "x-github-event": "issue_comment" },
          })
        ).status,
        503,
      );
      assert.equal(
        (
          await request({
            path: faultPath,
            headers: { "x-github-event": "issue_comment" },
          })
        ).status,
        202,
      );
      assert.equal(upstreamRequests.length, 2);
      assert.equal(
        rows.filter((row) => row.outcome === "qualification_injected_503")
          .length,
        1,
      );
      assert.equal(
        rows.filter((row) => row.event === "chat_webhook_proxy_rejection")
          .length,
        1,
      );
      assertPrivate(rows);
    },
  );
}

test("closed labels, bounds and failing diagnostic sinks cannot change response handling", async () => {
  for (const value of ["PRIVATE_REASON_SENTINEL", "method"]) {
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), {
      headersSent: true,
      statusCode: 404,
    });
    const rows = [];
    let clock = 20;
    const observation = observeChatWebhookProxyRejection(req, res, {
      connectionId: "PRIVATE_ID_SENTINEL",
      now: () => clock,
      emit: (row) => rows.push(row),
    });
    observation.reject(value);
    observation.countBytes(Infinity);
    observation.countBytes(-1);
    observation.countBytes("PRIVATE_BYTES_SENTINEL");
    observation.countBytes(Number.MAX_SAFE_INTEGER);
    observation.countBytes(1);
    clock = -100;
    res.emit("finish");
    assert.equal(rows.length, value === "method" ? 1 : 0);
    if (rows.length)
      assert.deepEqual(rows[0], {
        event: "chat_webhook_proxy_rejection",
        reason: "method",
        connectionId: null,
        statusCode: 404,
        durationMs: 0,
        bytes: Number.MAX_SAFE_INTEGER,
      });
    assertPrivate(rows);
  }
  for (const emit of [
    () => {
      throw new Error("PRIVATE_ERROR_SENTINEL");
    },
    async () => {
      throw new Error("PRIVATE_ERROR_SENTINEL");
    },
  ]) {
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), {
      headersSent: true,
      statusCode: 404,
    });
    observeChatWebhookProxyRejection(req, res, { emit }).reject("method");
    assert.doesNotThrow(() => res.emit("finish"));
  }
  await new Promise((resolve) => setImmediate(resolve));
});
