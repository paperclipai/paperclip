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
    });
    expect(out.ok).toBe(true);
    expect(out.graph).toBeNull();
    expect(out.reason).toMatch(/does not exist/i);
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
  it("maps ok+graph → status=ok", () => {
    const entry = buildCacheEntry({
      result: { ok: true, issuePageSlug: "issue-blo-1", graph: { nodes: [] } },
      depth: 2,
      nowIso: "2026-05-16T03:00:00.000Z",
    });
    expect(entry).toMatchObject({
      status: "ok",
      issuePageSlug: "issue-blo-1",
      depth: 2,
      graph: { nodes: [] },
      fetchedAtIso: "2026-05-16T03:00:00.000Z",
    });
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

  it("uses current time when nowIso omitted", () => {
    const before = Date.now();
    const entry = buildCacheEntry({
      result: { ok: true, issuePageSlug: "s", graph: {} },
      depth: 2,
    });
    const t = Date.parse(entry.fetchedAtIso);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
