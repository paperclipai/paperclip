import { describe, it, expect, vi } from "vitest";
import {
  promoteFactsForRun,
  makeHindsightFetch,
  deriveHindsightBankId,
} from "../fact-promotion.js";
import type { GbrainCallable } from "../pages.js";

describe("deriveHindsightBankId", () => {
  it("formats as paperclip::company::agent", () => {
    expect(deriveHindsightBankId("c-1", "a-1")).toBe("paperclip::c-1::a-1");
  });
});

describe("promoteFactsForRun", () => {
  it("filters memory_units by document_id and promotes each as a fact page", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = {
      call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        calls.push([tool, args]);
        return { status: "ok" };
      }),
    };
    const hindsightFetch = vi.fn(async (_path: string) => ({
      results: [
        { id: "m-1", text: "fact A", document_id: "r-1", fact_type: "world" },
        { id: "m-2", text: "fact B", document_id: "r-1", fact_type: "experience", context: "ctx" },
        { id: "m-3", text: "from another run", document_id: "r-OTHER" },
      ],
    }));

    const result = await promoteFactsForRun({
      client: client as unknown as GbrainCallable,
      hindsightFetch,
      bankId: "paperclip::c-1::a-1",
      runId: "r-1",
      issuePageSlug: "issue-blo-1",
      agentPageSlug: "agent-cto",
    });

    expect(result).toEqual({ scanned: 3, matched: 2, promoted: 2 });

    // 2 facts * (put_page + 2 add_link) = 6 calls
    expect(calls).toHaveLength(6);
    expect(calls[0][0]).toBe("put_page");
    expect(calls[0][1].slug).toBe("fact-m-1");
    expect(calls[0][1].content).toContain("type: fact");
    expect(calls[0][1].content).toContain('source_run_id: "r-1"');
    expect(calls[0][1].content).toContain("fact A");
    expect(calls[1]).toEqual(["add_link", {
      from: "issue-blo-1",
      to: "fact-m-1",
      link_type: "mentions",
    }]);
    expect(calls[2]).toEqual(["add_link", {
      from: "agent-cto",
      to: "fact-m-1",
      link_type: "authored_by",
    }]);
    expect(calls[3][1].slug).toBe("fact-m-2");
    expect(calls[3][1].content).toContain('fact_type: "experience"');
    expect(calls[3][1].content).toContain('context: "ctx"');
  });

  it("URL-encodes the bank_id in the hindsight path", async () => {
    const client = { call: vi.fn().mockResolvedValue(null) };
    const hindsightFetch = vi.fn(async () => ({ results: [] }));
    await promoteFactsForRun({
      client: client as unknown as GbrainCallable,
      hindsightFetch,
      bankId: "paperclip::c::a",
      runId: "r-1",
      issuePageSlug: "issue-x",
      agentPageSlug: "agent-x",
    });
    expect(hindsightFetch).toHaveBeenCalledWith(
      "/v1/default/banks/paperclip%3A%3Ac%3A%3Aa/memories/list?limit=100&offset=0",
    );
  });

  it("no-ops when no memory_units match the runId", async () => {
    const client = { call: vi.fn() };
    const hindsightFetch = vi.fn(async () => ({
      results: [{ id: "m-99", text: "other run", document_id: "r-OTHER" }],
    }));
    const result = await promoteFactsForRun({
      client: client as unknown as GbrainCallable,
      hindsightFetch,
      bankId: "b",
      runId: "r-1",
      issuePageSlug: "i",
      agentPageSlug: "a",
    });
    expect(result.promoted).toBe(0);
    expect(client.call).not.toHaveBeenCalled();
  });
});

describe("makeHindsightFetch", () => {
  it("strips trailing slash from baseUrl and GETs with json accept", async () => {
    const mockFetch = vi.fn(async () => new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const f = makeHindsightFetch("http://hindsight/", mockFetch);
    const out = await f("/v1/x") as { ok: boolean };
    expect(out.ok).toBe(true);
    const [url, init] = (mockFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("http://hindsight/v1/x");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).accept).toBe("application/json");
  });

  it("throws on non-OK response", async () => {
    const mockFetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const f = makeHindsightFetch("http://hindsight", mockFetch);
    await expect(f("/v1/x")).rejects.toThrow(/HTTP 500/);
  });
});
