import { describe, it, expect, vi } from "vitest";
import {
  prefetchRunContext,
  buildCacheEntry,
  RECALL_STATE_KEY,
  DEFAULT_RECALL_DEPTH,
} from "../recall.js";
import type { GbrainCallable } from "../pages.js";

describe("RECALL_STATE_KEY + defaults", () => {
  it("exposes a stable key + depth so worker + tool agree", () => {
    expect(RECALL_STATE_KEY).toBe("gbrain-context");
    expect(DEFAULT_RECALL_DEPTH).toBe(2);
  });
});

describe("prefetchRunContext", () => {
  it("returns ok=false with reason when issue identifier is null", async () => {
    const client = { call: vi.fn() };
    const out = await prefetchRunContext({
      client: client as unknown as GbrainCallable,
      issueIdentifier: null,
      depth: 2,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/no issue identifier/i);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("calls traverse_graph with the issue slug + depth", async () => {
    const client = {
      call: vi.fn(async () => ({
        nodes: [{ slug: "issue-blo-1" }],
        edges: [],
      })),
    };
    const out = await prefetchRunContext({
      client: client as unknown as GbrainCallable,
      issueIdentifier: "BLO-1",
      depth: 3,
    });
    expect(client.call).toHaveBeenCalledWith("traverse_graph", {
      slug: "issue-blo-1",
      depth: 3,
    });
    expect(out.ok).toBe(true);
    expect(out.issuePageSlug).toBe("issue-blo-1");
    expect(out.graph).toEqual({ nodes: [{ slug: "issue-blo-1" }], edges: [] });
  });

  it("clamps depth to 1 minimum", async () => {
    const client = { call: vi.fn(async () => ({ nodes: [] })) };
    await prefetchRunContext({
      client: client as unknown as GbrainCallable,
      issueIdentifier: "BLO-1",
      depth: 0,
    });
    expect(client.call).toHaveBeenCalledWith("traverse_graph", {
      slug: "issue-blo-1",
      depth: 1,
    });
  });

  it("treats null graph (page not in gbrain yet) as ok-with-no-graph", async () => {
    const client = { call: vi.fn(async () => null) };
    const out = await prefetchRunContext({
      client: client as unknown as GbrainCallable,
      issueIdentifier: "BLO-NEW",
      depth: 2,
      enrichmentFallback: false,
    });
    expect(out.ok).toBe(true);
    expect(out.graph).toBeNull();
    expect(out.reason).toMatch(/does not exist/i);
  });

  it("falls back to the agent hub when the issue graph is an island", async () => {
    const client = {
      call: vi.fn(async (_tool: string, args: Record<string, unknown>) => {
        if (args.slug === "issue-blo-1") {
          return { nodes: [{ slug: "issue-blo-1" }], edges: [] };
        }
        if (args.slug === "agent-cto") {
          return {
            nodes: [{ slug: "agent-cto" }, { slug: "issue-blo-999" }],
            edges: [{ from: "agent-cto", to: "issue-blo-999" }],
          };
        }
        return null;
      }),
    };

    const out = await prefetchRunContext({
      client: client as unknown as GbrainCallable,
      issueIdentifier: "BLO-1",
      agentName: "CTO",
      depth: 2,
    });

    expect(client.call).toHaveBeenCalledWith("traverse_graph", {
      slug: "agent-cto",
      depth: 2,
    });
    expect(out.reason).toMatch(/enriched with agent graph agent-cto/);
    expect(out.graph).toEqual({
      nodes: [{ slug: "issue-blo-1" }, { slug: "agent-cto" }, { slug: "issue-blo-999" }],
      edges: [{ from: "agent-cto", to: "issue-blo-999" }],
    });
  });

  it("tries ID-based agent and project fallbacks after a missing named agent hub", async () => {
    const client = {
      call: vi.fn(async (_tool: string, args: Record<string, unknown>) => {
        if (args.slug === "issue-blo-1" || args.slug === "agent-cto") return [];
        if (args.slug === "paperclip/agents/c-1/a-1") return null;
        if (args.slug === "project-rag") {
          return {
            nodes: [{ slug: "project-rag" }, { slug: "issue-blo-2" }],
            edges: [{ from: "project-rag", to: "issue-blo-2" }],
          };
        }
        return null;
      }),
    };

    const out = await prefetchRunContext({
      client: client as unknown as GbrainCallable,
      issueIdentifier: "BLO-1",
      companyId: "c-1",
      agentId: "a-1",
      agentName: "CTO",
      projectId: "p-1",
      projectNameOrKey: "rag",
      depth: 2,
    });

    expect(client.call).toHaveBeenCalledWith("traverse_graph", {
      slug: "paperclip/agents/c-1/a-1",
      depth: 2,
    });
    expect(client.call).toHaveBeenCalledWith("traverse_graph", {
      slug: "project-rag",
      depth: 2,
    });
    expect(out.reason).toMatch(/enriched with project graph project-rag/);
    expect(out.graph).toEqual({
      nodes: [{ slug: "project-rag" }, { slug: "issue-blo-2" }],
      edges: [{ from: "project-rag", to: "issue-blo-2" }],
    });
  });

  it("does not call fallback slugs when enrichment fallback is disabled", async () => {
    const client = {
      call: vi.fn(async () => ({ nodes: [{ slug: "issue-blo-1" }], edges: [] })),
    };

    const out = await prefetchRunContext({
      client: client as unknown as GbrainCallable,
      issueIdentifier: "BLO-1",
      agentName: "CTO",
      depth: 2,
      enrichmentFallback: false,
    });

    expect(client.call).toHaveBeenCalledTimes(1);
    expect(out.graph).toEqual({ nodes: [{ slug: "issue-blo-1" }], edges: [] });
  });

  it("catches MCP errors and returns ok=false with the message", async () => {
    const client = {
      call: vi.fn(async () => {
        throw new Error("gbrain down");
      }),
    };
    const out = await prefetchRunContext({
      client: client as unknown as GbrainCallable,
      issueIdentifier: "BLO-1",
      depth: 2,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/traverse_graph failed.*gbrain down/);
  });
});

describe("buildCacheEntry", () => {
  it("maps a graph with nodes and edges → status=ok", () => {
    const entry = buildCacheEntry({
      result: {
        ok: true,
        issuePageSlug: "issue-blo-1",
        graph: {
          nodes: [{ slug: "issue-blo-1" }, { slug: "agent-a" }],
          edges: [{ from: "issue-blo-1", to: "agent-a" }],
        },
      },
      depth: 2,
      nowIso: "2026-05-16T03:00:00.000Z",
    });
    expect(entry).toMatchObject({
      status: "ok",
      issuePageSlug: "issue-blo-1",
      depth: 2,
      fetchedAtIso: "2026-05-16T03:00:00.000Z",
    });
  });

  it("maps an empty array graph → status=empty", () => {
    const entry = buildCacheEntry({
      result: { ok: true, issuePageSlug: "issue-blo-1", graph: [] },
      depth: 2,
    });
    expect(entry.status).toBe("empty");
    expect(entry.note).toMatch(/empty graph/i);
  });

  it("maps a single-node array graph → status=island", () => {
    const entry = buildCacheEntry({
      result: {
        ok: true,
        issuePageSlug: "issue-blo-1",
        graph: [{ slug: "issue-blo-1" }],
      },
      depth: 2,
    });
    expect(entry.status).toBe("island");
    expect(entry.note).toMatch(/only the issue page/i);
  });

  it("maps a nodes-without-edges graph → status=island", () => {
    const entry = buildCacheEntry({
      result: {
        ok: true,
        issuePageSlug: "issue-blo-1",
        graph: { nodes: [{ slug: "issue-blo-1" }, { slug: "fact-a" }], edges: [] },
      },
      depth: 2,
    });
    expect(entry.status).toBe("island");
    expect(entry.note).toMatch(/no edges/i);
  });

  it("maps ok+null-graph → status=no-issue-page", () => {
    const entry = buildCacheEntry({
      result: { ok: true, issuePageSlug: "issue-blo-1", graph: null, reason: "no page" },
      depth: 2,
    });
    expect(entry.status).toBe("no-issue-page");
    expect(entry.graph).toBeNull();
    expect(entry.note).toMatch(/no page/);
  });

  it("maps !ok → status=skipped with reason", () => {
    const entry = buildCacheEntry({
      result: { ok: false, issuePageSlug: null, graph: null, reason: "no issue identifier on run" },
      depth: 2,
    });
    expect(entry.status).toBe("skipped");
    expect(entry.note).toBe("no issue identifier on run");
    expect(entry.issuePageSlug).toBeNull();
  });

  it("maps traversal failure for an issue page → status=error", () => {
    const entry = buildCacheEntry({
      result: {
        ok: false,
        issuePageSlug: "issue-blo-1",
        graph: null,
        reason: "traverse_graph failed: HTTP 401",
      },
      depth: 2,
    });
    expect(entry.status).toBe("error");
    expect(entry.note).toMatch(/HTTP 401/);
  });

  it("uses current time when nowIso omitted", () => {
    const before = Date.now();
    const entry = buildCacheEntry({
      result: { ok: true, issuePageSlug: "s", graph: [{ slug: "s" }, { slug: "a" }] },
      depth: 2,
    });
    const t = Date.parse(entry.fetchedAtIso);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
