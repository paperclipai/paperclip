import { createServer, request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalRunnerBrowserMiddleware } from "./local-runner-browser-server.mjs";

const openServers = new Set();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakeRunner() {
  const completions = [];
  let startCalls = 0;
  return {
    completions,
    get startCalls() {
      return startCalls;
    },
    async load() {
      return {
        async startLocalRunnerScenario({ scenario }) {
          startCalls += 1;
          const completion = deferred();
          completions.push(completion);
          return {
            metadata: { schema: "test", scenario },
            completion: completion.promise,
            async interrupt() {
              return { status: "accepted" };
            },
            async resolveRequest() {
              return { status: "accepted" };
            },
          };
        },
      };
    },
  };
}

async function startServer(options = {}) {
  const middleware = createLocalRunnerBrowserMiddleware(options);
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  openServers.add(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test server did not expose a TCP address");
  }
  return { server, port: address.port };
}

function sendRequest(port, options = {}) {
  const body = options.body ?? "";
  const host = options.host ?? `127.0.0.1:${port}`;
  const origin = options.origin === undefined ? `http://${host}` : options.origin;
  const headers = {
    host,
    ...(origin === null ? {} : { origin }),
    ...(body.length === 0 ? {} : { "content-type": "application/json" }),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: options.path ?? "/api/localRunner/runs",
        method: options.method ?? "POST",
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const source = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode,
            body: source.length === 0 ? null : JSON.parse(source),
          });
        });
      },
    );
    request.on("error", reject);
    if (options.chunks !== undefined) {
      for (const chunk of options.chunks) {
        request.write(chunk);
      }
      request.end();
    } else {
      request.end(body);
    }
  });
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  const servers = [...openServers];
  openServers.clear();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections?.();
        }),
    ),
  );
});

describe("Local runner browser transport hardening", () => {
  it("denies cross-origin starts and applies the guard before route lookup", async () => {
    const runner = fakeRunner();
    const { port } = await startServer({ loadRunner: () => runner.load() });

    const start = await sendRequest(port, {
      origin: "https://attacker.example",
      body: JSON.stringify({ scenario: "happy-path" }),
    });
    const unknown = await sendRequest(port, {
      method: "GET",
      path: "/api/localRunner/runs/missing/events",
      origin: "https://attacker.example",
    });

    expect(start.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(runner.startCalls).toBe(0);
  });

  it("rejects non-loopback Host values even when Origin matches", async () => {
    const runner = fakeRunner();
    const { port } = await startServer({ loadRunner: () => runner.load() });

    const response = await sendRequest(port, {
      host: "attacker.example",
      origin: "http://attacker.example",
      body: JSON.stringify({ scenario: "happy-path" }),
    });

    expect(response.status).toBe(403);
    expect(runner.startCalls).toBe(0);
  });

  it("rejects a loopback Host that does not name the listening port", async () => {
    const runner = fakeRunner();
    const { port } = await startServer({ loadRunner: () => runner.load() });

    const response = await sendRequest(port, {
      host: "127.0.0.1:9",
      origin: "http://127.0.0.1:9",
      body: JSON.stringify({ scenario: "happy-path" }),
    });

    expect(response.status).toBe(403);
    expect(runner.startCalls).toBe(0);
  });

  it("caps active runs and evicts the oldest completed run at the retention bound", async () => {
    const runner = fakeRunner();
    const { port } = await startServer({
      loadRunner: () => runner.load(),
      limits: { maxActiveRuns: 1, maxRetainedRuns: 2 },
    });
    const body = JSON.stringify({ scenario: "happy-path" });

    const first = await sendRequest(port, { body });
    const rejected = await sendRequest(port, { body });
    expect(first.status).toBe(201);
    expect(rejected.status).toBe(429);

    runner.completions[0].resolve({ run: 1 });
    await flushPromises();
    const second = await sendRequest(port, { body });
    expect(second.status).toBe(201);
    runner.completions[1].resolve({ run: 2 });
    await flushPromises();

    const third = await sendRequest(port, { body });
    expect(third.status).toBe(201);
    const evicted = await sendRequest(port, {
      method: "GET",
      path: `/api/localRunner/runs/${first.body.id}/events`,
    });
    expect(evicted.status).toBe(404);

    runner.completions[2].resolve({ run: 3 });
    await flushPromises();
  });

  it("rejects declared and streamed oversized JSON before starting a runner", async () => {
    const runner = fakeRunner();
    const { port } = await startServer({
      loadRunner: () => runner.load(),
      limits: { maxRequestBodyBytes: 32 },
    });
    const oversized = JSON.stringify({ scenario: "x".repeat(64) });

    const declared = await sendRequest(port, { body: oversized });
    const streamed = await sendRequest(port, {
      chunks: ["{\"scenario\":\"", "y".repeat(64), "\"}"],
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    });

    expect(declared.status).toBe(413);
    expect(streamed.status).toBe(413);
    expect(runner.startCalls).toBe(0);
  });

  it("requires JSON content so a simple text/plain browser POST cannot start work", async () => {
    const runner = fakeRunner();
    const { port } = await startServer({ loadRunner: () => runner.load() });

    const response = await sendRequest(port, {
      body: JSON.stringify({ scenario: "happy-path" }),
      headers: { "content-type": "text/plain" },
    });

    expect(response.status).toBe(415);
    expect(runner.startCalls).toBe(0);
  });
});
