import test from "node:test";
import assert from "node:assert/strict";
import { createPaperclipClient } from "../src/paperclip-client.mjs";
import { createServer, startServer } from "../src/server.mjs";

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("client rejects upstream failures without returning authorization data", async () => {
  const client = createPaperclipClient({
    baseUrl: "http://paperclip.test",
    apiKey: "secret",
    fetchImpl: async () => new Response("upstream body must stay private", { status: 503 }),
  });

  await assert.rejects(() => client.readCompanyState("c1"), /Paperclip request failed: 503/);
});

test("client reads all company resources with a bearer key and normalizes the result", async () => {
  const requests = [];
  const responses = {
    "/api/companies/c%201": { id: "c 1", name: "BrainPulse" },
    "/api/companies/c%201/dashboard": { heartbeat: "2026-08-31T15:00:00Z" },
    "/api/companies/c%201/agents": [{ id: "a1", name: "Ops", status: "idle" }],
    "/api/companies/c%201/routines": [{ id: "r1", title: "Brief", status: "active" }],
    "/api/companies/c%201/issues?limit=20": [{ id: "i1", identifier: "PAP-1", title: "Test" }],
    "/api/companies/c%201/approvals": [
      {
        id: "approval-budget",
        type: "budget_override_required",
        status: "pending",
        protected: false,
        createdAt: "2026-08-31T14:00:00.000Z",
        updatedAt: "2026-08-31T14:05:00.000Z",
        payload: { title: "secret title", apiKey: "do-not-leak" },
      },
      {
        id: "approval-board",
        type: "request_board_approval",
        status: "pending",
        protected: false,
        createdAt: "2026-08-31T14:01:00.000Z",
        updatedAt: "2026-08-31T14:06:00.000Z",
        payload: { summary: "synthetic owner decision", token: "synthetic-token" },
      },
      {
        id: "approval-future",
        type: "future_approval_type",
        status: "pending",
        protected: true,
        createdAt: "2026-08-31T14:02:00.000Z",
        updatedAt: "2026-08-31T14:07:00.000Z",
        payload: { details: "future payload", secret: "synthetic-secret" },
      },
    ],
  };
  const client = createPaperclipClient({
    baseUrl: "http://paperclip.test/",
    apiKey: "secret",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ path: `${parsed.pathname}${parsed.search}`, options });
      return new Response(JSON.stringify(responses[`${parsed.pathname}${parsed.search}`]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const state = await client.readCompanyState("c 1");

  assert.equal(state.company.name, "BrainPulse");
  assert.equal(state.timeline[0].identifier, "PAP-1");
  assert.equal(requests.length, 6);
  assert.ok(requests.every(({ options }) => options.headers.authorization === "Bearer secret"));
  assert.equal(state.decisions[0].title, "budget override required");
  assert.equal(state.decisions[0].protected, true);
  assert.equal(state.decisions[1].title, "request board approval");
  assert.equal(state.decisions[1].protected, true);
  assert.equal(state.decisions[2].title, "future approval type");
  assert.equal(state.decisions[2].protected, "Unknown");
  assert.equal(JSON.stringify(state).includes("do-not-leak"), false);
  assert.equal(JSON.stringify(state).includes("secret title"), false);
  assert.equal(JSON.stringify(state).includes("synthetic-token"), false);
  assert.equal(JSON.stringify(state).includes("synthetic-secret"), false);
});

test("client times out a hung upstream read", async () => {
  const client = createPaperclipClient({
    baseUrl: "http://paperclip.test",
    requestTimeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  await assert.rejects(() => client.readCompanyState("c1"), /Paperclip request failed: timeout/);
});

test("health check is local and does not contact Paperclip", async () => {
  let reads = 0;
  const server = createServer({
    client: { readCompanyState: async () => { reads += 1; } },
    publicDir: "/path/that/does/not/exist",
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  assert.equal(reads, 0);
});

test("state route returns normalized state from the read-only client", async () => {
  const expected = { company: { id: "c1", name: "BrainPulse" }, agents: [] };
  const calls = [];
  const server = createServer({
    client: { readCompanyState: async (companyId) => { calls.push(companyId); return expected; } },
    publicDir: "/path/that/does/not/exist",
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mission-control/state?companyId=c1`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  });

  assert.deepEqual(calls, ["c1"]);
});

test("upstream failures fail closed without leaking credentials or upstream body", async () => {
  const server = createServer({
    apiKey: "super-secret-api-key",
    client: {
      readCompanyState: async () => {
        throw new Error("upstream body: super-secret-api-key authorization Bearer super-secret-api-key");
      },
    },
    publicDir: "/path/that/does/not/exist",
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mission-control/state?companyId=c1`);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: "CONTROL_PLANE_UNAVAILABLE" });
    assert.equal(body.includes("super-secret-api-key"), false);
    assert.equal(body.includes("authorization"), false);
    assert.equal(body.includes("upstream body"), false);
  });
});

test("server bounds a hung client read and releases the request", async () => {
  const server = createServer({
    upstreamTimeoutMs: 10,
    client: { readCompanyState: async () => new Promise(() => {}) },
    publicDir: "/path/that/does/not/exist",
  });
  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mission-control/state?companyId=c1`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "CONTROL_PLANE_UNAVAILABLE" });
  });
});

test("startServer rejects non-loopback bindings", () => {
  assert.throws(() => startServer({ host: "0.0.0.0" }), /only supports loopback/);
  assert.throws(() => startServer({ host: "192.168.1.20" }), /only supports loopback/);
});

test("server does not expose mutation or unknown routes", async () => {
  const server = createServer({
    client: { readCompanyState: async () => ({}) },
    publicDir: "/path/that/does/not/exist",
  });

  await withServer(server, async (baseUrl) => {
    const post = await fetch(`${baseUrl}/api/mission-control/state?companyId=c1`, { method: "POST" });
    assert.equal(post.status, 405);
    const unknown = await fetch(`${baseUrl}/api/companies/c1`);
    assert.equal(unknown.status, 404);
  });
});
