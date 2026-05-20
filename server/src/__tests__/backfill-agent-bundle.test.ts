import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedRequest {
  method: string;
  url: string;
  body: unknown;
}

let captured: CapturedRequest[] = [];

const responseFor = {
  listAgents: [] as Array<{ id: string; name: string; role: string }>,
  bundleByAgentId: {} as Record<string, { mode: string }>,
  upsertShouldFailFor: new Set<string>(),
};

beforeEach(() => {
  captured = [];
  responseFor.listAgents = [];
  responseFor.bundleByAgentId = {};
  responseFor.upsertShouldFailFor = new Set();
  process.env.PAPERCLIP_API_KEY = "test-key";
  process.env.PAPERCLIP_API_BASE = "http://test";
  process.env.PAPERCLIP_COMPANY_ID = "test-company";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      captured.push({ method, url, body });

      if (method === "GET" && url.endsWith("/agents")) {
        return new Response(JSON.stringify(responseFor.listAgents), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const bundleMatch = url.match(/\/api\/agents\/([^/]+)\/instructions-bundle$/);
      if (method === "GET" && bundleMatch) {
        const agentId = bundleMatch[1];
        const bundle = responseFor.bundleByAgentId[agentId] ?? { mode: "managed" };
        return new Response(JSON.stringify(bundle), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const upsertMatch = url.match(/\/api\/agents\/([^/]+)\/instructions-bundle\/file$/);
      if (method === "PUT" && upsertMatch) {
        const agentId = upsertMatch[1];
        if (responseFor.upsertShouldFailFor.has(agentId)) {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PAPERCLIP_API_KEY;
  delete process.env.PAPERCLIP_API_BASE;
  delete process.env.PAPERCLIP_COMPANY_ID;
});

describe("backfillAgentBundles (BLO-6151 R2 rollout)", () => {
  it("upserts AGENTS.md for each managed default-role agent", async () => {
    responseFor.listAgents = [
      { id: "a1", name: "AgentOne", role: "default" },
      { id: "a2", name: "AgentTwo", role: "default" },
    ];
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const results = await backfillAgentBundles(
      responseFor.listAgents,
      "test content",
    );

    expect(results).toEqual([
      { agentId: "a1", agentName: "AgentOne", status: "succeeded" },
      { agentId: "a2", agentName: "AgentTwo", status: "succeeded" },
    ]);

    const upserts = captured.filter((r) => r.method === "PUT");
    expect(upserts).toHaveLength(2);
    expect(upserts[0].body).toEqual({ path: "AGENTS.md", content: "test content" });
  });

  it("is idempotent: a second run produces identical results", async () => {
    responseFor.listAgents = [
      { id: "a1", name: "AgentOne", role: "default" },
    ];
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const first = await backfillAgentBundles(responseFor.listAgents, "x");
    const second = await backfillAgentBundles(responseFor.listAgents, "x");

    expect(first).toEqual(second);
  });

  it("isolates per-agent errors: one failure does NOT abort the batch", async () => {
    responseFor.listAgents = [
      { id: "a1", name: "AgentOne", role: "default" },
      { id: "a2", name: "AgentTwo", role: "default" },
      { id: "a3", name: "AgentThree", role: "default" },
    ];
    responseFor.upsertShouldFailFor.add("a2");
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const results = await backfillAgentBundles(responseFor.listAgents, "x");

    expect(results[0].status).toBe("succeeded");
    expect(results[1].status).toBe("failed");
    expect(results[1].reason).toMatch(/500/);
    expect(results[2].status).toBe("succeeded");
  });

  it("skips agents with role 'ceo'", async () => {
    responseFor.listAgents = [
      { id: "ceo1", name: "Boss", role: "ceo" },
      { id: "a1", name: "AgentOne", role: "default" },
    ];
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const results = await backfillAgentBundles(responseFor.listAgents, "x");

    expect(results[0]).toEqual({
      agentId: "ceo1",
      agentName: "Boss",
      status: "skipped",
      reason: "ceo role uses different bundle",
    });
    expect(results[1].status).toBe("succeeded");
    const upserts = captured.filter((r) => r.method === "PUT");
    expect(upserts).toHaveLength(1);
  });

  it("skips agents whose bundle mode is NOT 'managed'", async () => {
    responseFor.listAgents = [
      { id: "a1", name: "AgentOne", role: "default" },
    ];
    responseFor.bundleByAgentId["a1"] = { mode: "external" };
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const results = await backfillAgentBundles(responseFor.listAgents, "x");

    expect(results[0]).toEqual({
      agentId: "a1",
      agentName: "AgentOne",
      status: "skipped",
      reason: 'bundle mode is "external", not "managed"',
    });
  });
});
