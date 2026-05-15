import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ensureIssuePage,
  ensureAgentPage,
  addWorkedOnLink,
  addRunTimelineEntry,
} from "../pages.js";

interface FakeClient {
  call: ReturnType<typeof vi.fn>;
}

describe("ensureIssuePage", () => {
  let client: FakeClient;
  beforeEach(() => {
    client = { call: vi.fn() };
  });

  it("does nothing if get_page returns an existing page", async () => {
    client.call.mockResolvedValueOnce({ slug: "issue-blo-1", exists: true });
    await ensureIssuePage(client, {
      identifier: "BLO-1",
      title: "Fix login",
      description: "Login is broken",
    });
    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith("get_page", { slug: "issue-blo-1" });
  });

  it("calls put_page with frontmatter content when get_page returns null", async () => {
    client.call.mockResolvedValueOnce(null);
    client.call.mockResolvedValueOnce({ slug: "issue-blo-1", status: "created_or_updated" });

    await ensureIssuePage(client, {
      identifier: "BLO-1",
      title: "Fix login",
      description: "Login is broken",
    });

    const [tool, args] = client.call.mock.calls[1];
    expect(tool).toBe("put_page");
    expect(args.slug).toBe("issue-blo-1");
    expect(typeof args.content).toBe("string");
    expect(args.content).toMatch(/^---\n/);
    expect(args.content).toContain("type: issue");
    expect(args.content).toContain('title: "Fix login"');
    expect(args.content).toContain('identifier: "BLO-1"');
    expect(args.content).toContain("Login is broken");
    expect(args.type).toBeUndefined();
    expect(args.title).toBeUndefined();
  });

  it("throws when identifier is missing", async () => {
    await expect(
      ensureIssuePage(client, { identifier: null, title: "x", description: "y" }),
    ).rejects.toThrow(/identifier/);
  });
});

describe("ensureAgentPage", () => {
  let client: FakeClient;
  beforeEach(() => {
    client = { call: vi.fn() };
  });

  it("derives slug from agent name and creates if missing", async () => {
    client.call.mockResolvedValueOnce(null);
    client.call.mockResolvedValueOnce({ slug: "agent-cto", status: "created_or_updated" });

    await ensureAgentPage(client, { agentId: "a-1", agentName: "CTO" });

    expect(client.call).toHaveBeenNthCalledWith(1, "get_page", { slug: "agent-cto" });
    const [tool, args] = client.call.mock.calls[1];
    expect(tool).toBe("put_page");
    expect(args.slug).toBe("agent-cto");
    expect(args.content).toContain("type: agent");
    expect(args.content).toContain('title: "CTO"');
    expect(args.content).toContain('agent_id: "a-1"');
    expect(args.content).toContain("Agent CTO (id a-1)");
  });

  it("throws when agent name produces empty slug", async () => {
    await expect(
      ensureAgentPage(client, { agentId: "a-1", agentName: "   " }),
    ).rejects.toThrow(/agent/);
  });
});

describe("addWorkedOnLink", () => {
  it("posts add_link with from/to/link_type", async () => {
    const client = { call: vi.fn().mockResolvedValue(null) };
    await addWorkedOnLink(client, { agentSlug: "agent-cto", issueSlug: "issue-blo-1" });

    expect(client.call).toHaveBeenCalledWith("add_link", {
      from: "agent-cto",
      to: "issue-blo-1",
      link_type: "worked_on",
    });
  });
});

describe("addRunTimelineEntry", () => {
  it("posts add_timeline_entry with date/summary/detail/source", async () => {
    const client = { call: vi.fn().mockResolvedValue(null) };
    await addRunTimelineEntry(client, {
      issueSlug: "issue-blo-1",
      body: "agent output excerpt",
      agentId: "a-12345678-aaaa",
      runId: "r-87654321-bbbb",
      companyId: "c-1",
      outcome: "succeeded",
      finishedAt: "2026-05-15T12:00:00Z",
    });

    const [tool, args] = client.call.mock.calls[0];
    expect(tool).toBe("add_timeline_entry");
    expect(args.slug).toBe("issue-blo-1");
    // gbrain requires YYYY-MM-DD — full ISO must be truncated
    expect(args.date).toBe("2026-05-15");
    expect(args.detail).toBe("agent output excerpt");
    expect(args.source).toBe("paperclip-plugin-gbrain");
    expect(typeof args.summary).toBe("string");
    expect(args.summary).toMatch(/succeeded/);
  });
});
