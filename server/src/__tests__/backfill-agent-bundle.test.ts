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
  fileByAgentId: {} as Record<string, { content: string }>,
  upsertShouldFailFor: new Set<string>(),
};

const PREFLIGHT = "## Wake Pre-flight (sample protocol)\n\nstep one\nstep two\n";
const PREFLIGHT_PREFIX = "## Wake Pre-flight";

beforeEach(() => {
  captured = [];
  responseFor.listAgents = [];
  responseFor.bundleByAgentId = {};
  responseFor.fileByAgentId = {};
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

      const fileGetMatch = url.match(
        /\/api\/agents\/([^/]+)\/instructions-bundle\/file\?path=AGENTS\.md$/,
      );
      if (method === "GET" && fileGetMatch) {
        const agentId = fileGetMatch[1];
        const file = responseFor.fileByAgentId[agentId] ?? { content: "" };
        return new Response(JSON.stringify(file), {
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
        // Reflect the new content into the simulated store so a follow-up read sees it.
        if (body && typeof body === "object" && (body as { content?: string }).content) {
          responseFor.fileByAgentId[agentId] = {
            content: (body as { content: string }).content,
          };
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

describe("backfillAgentBundles (BLO-6151 additive R2 rollout)", () => {
  it("PREPENDS Wake Pre-flight to an agent whose AGENTS.md does NOT already start with the marker, preserving the original body", async () => {
    responseFor.listAgents = [
      { id: "a1", name: "MulticastEngineer", role: "engineer" },
    ];
    responseFor.fileByAgentId["a1"] = {
      content:
        "You are an agent at Paperclip company.\n\n# Role\n\nYou are MulticastEngineer.\n\n## Charter\nM1 → M5 multicast.\n",
    };
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const results = await backfillAgentBundles(responseFor.listAgents, PREFLIGHT);

    expect(results).toEqual([
      { agentId: "a1", agentName: "MulticastEngineer", status: "succeeded" },
    ]);

    const upserts = captured.filter((r) => r.method === "PUT");
    expect(upserts).toHaveLength(1);
    const body = upserts[0].body as { path: string; content: string };
    expect(body.path).toBe("AGENTS.md");
    expect(body.content.startsWith(PREFLIGHT_PREFIX)).toBe(true);
    expect(body.content).toContain("# Role");
    expect(body.content).toContain("MulticastEngineer");
    expect(body.content).toContain("## Charter");
    expect(body.content).toContain("M1 → M5 multicast.");
  });

  it("SKIPS an agent whose AGENTS.md already starts with the Wake Pre-flight marker (idempotency)", async () => {
    responseFor.listAgents = [
      { id: "a1", name: "AlreadyDone", role: "engineer" },
    ];
    responseFor.fileByAgentId["a1"] = {
      content: `${PREFLIGHT_PREFIX} (legacy variant)\n\nrest of file\n`,
    };
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const results = await backfillAgentBundles(responseFor.listAgents, PREFLIGHT);

    expect(results).toEqual([
      {
        agentId: "a1",
        agentName: "AlreadyDone",
        status: "skipped",
        reason: "already has Wake Pre-flight",
      },
    ]);
    expect(captured.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("SKIPS the ceo role (CEO bundle is separate)", async () => {
    responseFor.listAgents = [
      { id: "c1", name: "CEO", role: "ceo" },
    ];
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const results = await backfillAgentBundles(responseFor.listAgents, PREFLIGHT);

    expect(results).toEqual([
      {
        agentId: "c1",
        agentName: "CEO",
        status: "skipped",
        reason: "ceo role uses different bundle",
      },
    ]);
    expect(captured.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("SKIPS an agent whose bundle is not in managed mode", async () => {
    responseFor.listAgents = [
      { id: "x1", name: "ExternalAgent", role: "engineer" },
    ];
    responseFor.bundleByAgentId["x1"] = { mode: "external" };
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const results = await backfillAgentBundles(responseFor.listAgents, PREFLIGHT);

    expect(results).toEqual([
      {
        agentId: "x1",
        agentName: "ExternalAgent",
        status: "skipped",
        reason: 'bundle mode is "external", not "managed"',
      },
    ]);
    expect(captured.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("ISOLATES per-agent errors: one failure does not abort the batch", async () => {
    responseFor.listAgents = [
      { id: "a1", name: "AgentOne", role: "engineer" },
      { id: "a2", name: "AgentTwo", role: "engineer" },
      { id: "a3", name: "AgentThree", role: "engineer" },
    ];
    for (const id of ["a1", "a2", "a3"]) {
      responseFor.fileByAgentId[id] = { content: `# ${id} body\n` };
    }
    responseFor.upsertShouldFailFor.add("a2");
    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const results = await backfillAgentBundles(responseFor.listAgents, PREFLIGHT);

    expect(results.map((r) => r.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    const failedReason = results[1].reason ?? "";
    expect(failedReason).toContain("500");
  });

  it("is IDEMPOTENT across runs: re-running after a successful first pass skips every agent", async () => {
    responseFor.listAgents = [
      { id: "a1", name: "AgentOne", role: "engineer" },
      { id: "a2", name: "AgentTwo", role: "engineer" },
    ];
    responseFor.fileByAgentId["a1"] = { content: "# A1 body\n" };
    responseFor.fileByAgentId["a2"] = { content: "# A2 body\n" };

    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    const first = await backfillAgentBundles(responseFor.listAgents, PREFLIGHT);
    expect(first.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);

    captured = [];
    const second = await backfillAgentBundles(responseFor.listAgents, PREFLIGHT);
    expect(second.every((r) => r.status === "skipped")).toBe(true);
    expect(second.every((r) => r.reason === "already has Wake Pre-flight")).toBe(true);
    expect(captured.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("never DOUBLE-prepends — composed bodies stay single-prefix on re-run", async () => {
    responseFor.listAgents = [
      { id: "a1", name: "AgentOne", role: "engineer" },
    ];
    const originalBody = "# Role\n\nYou are AgentOne.\n";
    responseFor.fileByAgentId["a1"] = { content: originalBody };

    const { backfillAgentBundles } = await import(
      "../scripts/backfill-agent-bundle.js"
    );

    await backfillAgentBundles(responseFor.listAgents, PREFLIGHT);
    const afterFirst = responseFor.fileByAgentId["a1"].content;

    await backfillAgentBundles(responseFor.listAgents, PREFLIGHT);
    const afterSecond = responseFor.fileByAgentId["a1"].content;

    expect(afterFirst).toBe(afterSecond);
    // Only one Wake Pre-flight prefix in the resulting content.
    const matches = afterFirst.match(/## Wake Pre-flight/g) ?? [];
    expect(matches.length).toBe(1);
    expect(afterFirst).toContain(originalBody);
  });
});
