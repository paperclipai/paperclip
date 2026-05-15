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
    client.call.mockResolvedValueOnce({ slug: "issue/BLO-1", exists: true });
    await ensureIssuePage(client, {
      identifier: "BLO-1",
      title: "Fix login",
      description: "Login is broken",
    });
    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith("get_page", { slug: "issue/BLO-1" });
  });

  it("calls put_page when get_page returns null/missing", async () => {
    client.call.mockResolvedValueOnce(null);
    client.call.mockResolvedValueOnce({ slug: "issue/BLO-1", created: true });

    await ensureIssuePage(client, {
      identifier: "BLO-1",
      title: "Fix login",
      description: "Login is broken",
    });

    expect(client.call).toHaveBeenNthCalledWith(2, "put_page", {
      slug: "issue/BLO-1",
      type: "issue",
      title: "Fix login",
      content: "Login is broken",
    });
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
    client.call.mockResolvedValueOnce({ slug: "agent/cto", created: true });

    await ensureAgentPage(client, { agentId: "a-1", agentName: "CTO" });

    expect(client.call).toHaveBeenNthCalledWith(1, "get_page", { slug: "agent/cto" });
    expect(client.call).toHaveBeenNthCalledWith(2, "put_page", {
      slug: "agent/cto",
      type: "agent",
      title: "CTO",
      content: "Agent CTO (id a-1)",
    });
  });

  it("throws when agent name produces empty slug", async () => {
    await expect(
      ensureAgentPage(client, { agentId: "a-1", agentName: "   " }),
    ).rejects.toThrow(/agent/);
  });
});

describe("addWorkedOnLink", () => {
  it("posts add_link with worked_on type", async () => {
    const client = { call: vi.fn().mockResolvedValue(null) };
    await addWorkedOnLink(client, { agentSlug: "agent/cto", issueSlug: "issue/BLO-1" });

    expect(client.call).toHaveBeenCalledWith("add_link", {
      from_slug: "agent/cto",
      to_slug: "issue/BLO-1",
      link_type: "worked_on",
    });
  });
});

describe("addRunTimelineEntry", () => {
  it("posts add_timeline_entry with full identity metadata", async () => {
    const client = { call: vi.fn().mockResolvedValue(null) };
    await addRunTimelineEntry(client, {
      issueSlug: "issue/BLO-1",
      body: "agent output excerpt",
      agentId: "a-1",
      runId: "r-1",
      companyId: "c-1",
      outcome: "succeeded",
      finishedAt: "2026-05-15T12:00:00Z",
    });

    expect(client.call).toHaveBeenCalledWith("add_timeline_entry", {
      slug: "issue/BLO-1",
      body: "agent output excerpt",
      occurred_at: "2026-05-15T12:00:00Z",
      metadata: {
        agentId: "a-1",
        runId: "r-1",
        companyId: "c-1",
        outcome: "succeeded",
        source: "paperclip-plugin-gbrain",
      },
    });
  });
});
