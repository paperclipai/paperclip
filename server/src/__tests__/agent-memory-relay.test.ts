import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentMemoryRelayRoutes } from "../routes/agent-memory-relay.js";
import { AGENT_MEMORY_ENABLED_ENV, AGENT_MEMORY_PROXY_ENV, AGENT_MEMORY_URL_ENV } from "../services/default-mcp-agent-memory.js";

const MEMORY_URL = "https://rh-memory.example.ts.net";
const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const MEMORY_ID = "44444444-4444-4444-8444-444444444444";
const TOKENS: Record<string, string> = { [AGENT_A]: "token-of-agent-A", [AGENT_B]: "token-of-agent-B" };

const env = { [AGENT_MEMORY_ENABLED_ENV]: "true", [AGENT_MEMORY_URL_ENV]: MEMORY_URL } as NodeJS.ProcessEnv;

function build(opts: { actor?: Record<string, unknown>; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = opts.fetchImpl ?? vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  const resolveToken = vi.fn(async (_company: string, agentId: string) => TOKENS[agentId] ?? null);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use((req, _res, next) => {
    req.actor = { type: "agent", source: "agent_jwt", agentId: AGENT_A, companyId: COMPANY, runId: "run-1", ...opts.actor } as typeof req.actor;
    next();
  });
  app.use("/api", agentMemoryRelayRoutes({} as Db, { env: opts.env ?? env, fetchImpl: fetchImpl as typeof fetch, resolveToken }));
  return { app, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>, resolveToken };
}

const BASE = "/api/agent-memory-relay";

describe("agent memory relay (TECH-8908)", () => {
  it("relays the four routes to the configured memory service with the caller's own token and the body untouched", async () => {
    const { app, fetchImpl, resolveToken } = build();
    const searchBody = '{"query":"q",  "filters":{"user_id":"someone-else"},"top_k":3}';
    await request(app).post(`${BASE}/search`).set("content-type", "application/json").send(searchBody).expect(200);
    await request(app).post(`${BASE}/memories`).set("content-type", "application/json").send('{"messages":[],"user_id":"x","agent_id":"y"}').expect(200);
    await request(app).put(`${BASE}/memories/${MEMORY_ID}`).set("content-type", "application/json").send('{"text":"t"}').expect(200);
    await request(app).delete(`${BASE}/memories/${MEMORY_ID}`).expect(200);

    const calls = fetchImpl.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `POST ${MEMORY_URL}/search`,
      `POST ${MEMORY_URL}/memories`,
      `PUT ${MEMORY_URL}/memories/${MEMORY_ID}`,
      `DELETE ${MEMORY_URL}/memories/${MEMORY_ID}`,
    ]);
    // Body bytes are forwarded as received: no rewriting of user_id, filters or whitespace.
    expect(Buffer.from(calls[0]![1].body as Uint8Array).toString("utf8")).toBe(searchBody);
    for (const [, init] of calls) {
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(
        init.method === "DELETE" ? ["x-api-key"] : ["content-type", "x-api-key"],
      );
    }
    expect(resolveToken).toHaveBeenCalledTimes(4);
  });

  it("never uses another agent's secret: the token comes from the caller's own agent id only", async () => {
    const a = build({ actor: { agentId: AGENT_A } });
    await request(a.app).post(`${BASE}/search`).set("content-type", "application/json")
      .set("x-api-key", TOKENS[AGENT_B]!).set("x-agent-id", AGENT_B)
      .send(JSON.stringify({ query: "q", agentId: AGENT_B, agent_id: AGENT_B, user_id: AGENT_B })).expect(200);
    expect(a.resolveToken.mock.calls.every(([company, agent]) => company === COMPANY && agent === AGENT_A)).toBe(true);
    const sent = (a.fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(sent["x-api-key"]).toBe(TOKENS[AGENT_A]);
    expect(JSON.stringify(a.fetchImpl.mock.calls)).not.toContain(TOKENS[AGENT_B]!);

    const b = build({ actor: { agentId: AGENT_B } });
    await request(b.app).post(`${BASE}/search`).set("content-type", "application/json").send("{}").expect(200);
    expect(((b.fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>)["x-api-key"]).toBe(TOKENS[AGENT_B]);
  });

  it("refuses an agent with no memory token without calling the service", async () => {
    const { app, fetchImpl } = build({ actor: { agentId: "55555555-5555-4555-8555-555555555555" } });
    await request(app).post(`${BASE}/search`).set("content-type", "application/json").send("{}").expect(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["a board user", { type: "board", source: "session", agentId: undefined }],
    ["an agent API key (no run JWT)", { source: "agent_key", runId: undefined }],
    ["no actor", { type: "none", source: "none", agentId: undefined }],
  ])("refuses %s", async (_name, actor) => {
    const { app, fetchImpl, resolveToken } = build({ actor });
    await request(app).post(`${BASE}/search`).set("content-type", "application/json").send("{}").expect(403);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it.each([
    "../search",
    "..%2fsearch",
    "%2e%2e%2f%2e%2e%2fmcp",
    `${MEMORY_ID}%2f..%2fmcp`,
    `${MEMORY_ID}/extra`,
    `${MEMORY_ID}%2Fextra`,
    `${MEMORY_ID}%3Fx%3D1`,
    "not-a-uuid",
    "%00",
    `${MEMORY_ID}%0d%0aHost:%20evil`,
  ])("cannot reach another rh-memory-mcp route through the memory id %s", async (id) => {
    const { app, fetchImpl } = build();
    for (const method of ["put", "delete"] as const) {
      const req = request(app)[method](`${BASE}/memories/${id}`).set("content-type", "application/json");
      const res = await (method === "put" ? req.send('{"text":"t"}') : req);
      expect([404, 400]).toContain(res.status);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("has no wildcard: other paths and methods are not relayed", async () => {
    const { app, fetchImpl } = build();
    await request(app).get(`${BASE}/search`).expect(404);
    await request(app).post(`${BASE}/memories/${MEMORY_ID}`).set("content-type", "application/json").send("{}").expect(404);
    await request(app).post(`${BASE}/admin`).set("content-type", "application/json").send("{}").expect(404);
    await request(app).post(`${BASE}/search/../mcp`).set("content-type", "application/json").send("{}").expect(404);
    await request(app).delete(`${BASE}/memories`).expect(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards no query string and the target host is fixed by server config, not the request", async () => {
    const { app, fetchImpl } = build({ env: { ...env, [AGENT_MEMORY_PROXY_ENV]: "socks5://127.0.0.1:1055" } });
    await request(app).post(`${BASE}/search?target=http://169.254.169.254/&url=http://evil.test`)
      .set("content-type", "application/json")
      .set("host", "evil.test").set("x-forwarded-host", "evil.test").set("x-memory-url", "http://evil.test")
      .send(JSON.stringify({ query: "q", host: "http://evil.test", MEM0_HOST: "http://evil.test", url: "http://evil.test" })).expect(200);
    await request(app).delete(`${BASE}/memories/${MEMORY_ID}?host=evil.test`).set("x-forwarded-host", "evil.test").expect(200);
    for (const [url] of fetchImpl.mock.calls as Array<[string, RequestInit]>) {
      expect(url.startsWith(`${MEMORY_URL}/`)).toBe(true);
      expect(new URL(url).host).toBe("rh-memory.example.ts.net");
      expect(new URL(url).search).toBe("");
    }
  });

  it("is unavailable when the memory service is not configured or its URL is invalid, and never uses a request value instead", async () => {
    for (const bad of [{}, { [AGENT_MEMORY_ENABLED_ENV]: "true" }, { ...env, [AGENT_MEMORY_URL_ENV]: "http://not-loopback.example" }]) {
      const { app, fetchImpl } = build({ env: bad as NodeJS.ProcessEnv });
      await request(app).post(`${BASE}/search`).set("content-type", "application/json").send("{}").expect(503);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("requires a JSON body and caps its size", async () => {
    const { app, fetchImpl } = build();
    await request(app).post(`${BASE}/search`).set("content-type", "text/plain").send("x").expect(415);
    await request(app).post(`${BASE}/search`).expect(415);
    await request(app).post(`${BASE}/memories`).set("content-type", "application/json")
      .send(JSON.stringify({ messages: "x".repeat(1_000_001) })).expect(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns only the status and JSON body; redirects and non-JSON answers are not passed through", async () => {
    const redirect = build({ fetchImpl: vi.fn(async () => new Response("", { status: 302, headers: { location: "http://evil.test/" } })) as unknown as typeof fetch });
    const r1 = await request(redirect.app).post(`${BASE}/search`).set("content-type", "application/json").send("{}");
    expect(r1.status).toBe(502);
    expect(r1.headers.location).toBeUndefined();

    const html = build({ fetchImpl: vi.fn(async () => new Response("<html>secret</html>", { status: 200, headers: { "content-type": "text/html", "set-cookie": "a=b" } })) as unknown as typeof fetch });
    const r2 = await request(html.app).post(`${BASE}/search`).set("content-type", "application/json").send("{}");
    expect(r2.status).toBe(502);
    expect(r2.text).not.toContain("secret");
    expect(r2.headers["set-cookie"]).toBeUndefined();

    const notFound = build({ fetchImpl: vi.fn(async () => new Response('{"detail":"not found"}', { status: 404, headers: { "content-type": "application/json", "x-internal": "1" } })) as unknown as typeof fetch });
    const r3 = await request(notFound.app).delete(`${BASE}/memories/${MEMORY_ID}`);
    expect(r3.status).toBe(404);
    expect(r3.body).toEqual({ detail: "not found" });
    expect(r3.headers["x-internal"]).toBeUndefined();
  });

  it("answers 503, not 403, when the secret store fails, and logs no secret", async () => {
    const fetchImpl = vi.fn();
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_jwt", agentId: AGENT_A, companyId: COMPANY, runId: "run-1" } as typeof req.actor;
      next();
    });
    app.use("/api", agentMemoryRelayRoutes({} as Db, { env, fetchImpl: fetchImpl as unknown as typeof fetch, resolveToken: async () => { throw new Error("db down: token-of-agent-A"); } }));
    const res = await request(app).post(`${BASE}/search`).set("content-type", "application/json").send("{}");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("token-of-agent-A");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a bodiless upstream success (204) as a success", async () => {
    const { app } = build({ fetchImpl: vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
    const res = await request(app).delete(`${BASE}/memories/${MEMORY_ID}`);
    expect(res.status).toBe(200);
  });

  it("maps an upstream timeout to 504 and a connection failure to 502", async () => {
    const timeout = build({ fetchImpl: vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch });
    await request(timeout.app).post(`${BASE}/search`).set("content-type", "application/json").send("{}").expect(504);
    const down = build({ fetchImpl: vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await request(down.app).post(`${BASE}/search`).set("content-type", "application/json").send("{}").expect(502);
  });
});
