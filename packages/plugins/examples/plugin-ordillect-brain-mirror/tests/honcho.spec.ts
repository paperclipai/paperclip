import { describe, expect, it, vi } from "vitest";
import { HonchoClient, peerIdForComment, sessionIdForIssue } from "../src/honcho.js";

describe("peerIdForComment", () => {
  it("maps a registered leadership agent to its role peer", () => {
    expect(
      peerIdForComment({ authorAgentId: "9ce4abb5-e3ed-45bc-8cdc-8f735ea27708" }),
    ).toBe("agent-ceo");
    expect(
      peerIdForComment({ authorAgentId: "afde9a62-ea2a-4a11-a94a-7edd03a00bf7" }),
    ).toBe("agent-cto");
  });

  it("slugifies unknown agent ids", () => {
    expect(peerIdForComment({ authorAgentId: "abc-123@x" })).toBe("agent-abc-123_x");
  });

  it("prefers user id when no agent id present", () => {
    expect(peerIdForComment({ authorUserId: "user-42" })).toBe("user-user-42");
  });

  it("falls back to bot when author is unknown", () => {
    expect(peerIdForComment({})).toBe("bot");
  });
});

describe("sessionIdForIssue", () => {
  it("prefixes issue id with issue-", () => {
    expect(sessionIdForIssue("050e607c-0256-495c-b09d-58abef5c31f0")).toBe(
      "issue-050e607c-0256-495c-b09d-58abef5c31f0",
    );
  });
});

describe("HonchoClient", () => {
  it("posts create-workspace/peer/session/message with expected shapes", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = new HonchoClient({
      baseUrl: "http://honcho.test:8000",
      workspace: "ordillect-brain",
      fetchImpl,
    });

    await client.ensureWorkspace();
    await client.ensurePeer("agent-cto", { role: "cto" });
    await client.ensureSession("issue-abc", { plugin: "ordillect.brain-mirror" });
    await client.addSessionPeers("issue-abc", ["agent-cto"]);
    await client.postMessage("issue-abc", {
      peerId: "agent-cto",
      content: "hello world",
      metadata: { paperclip_comment_id: "c1" },
    });

    expect(calls.map((c) => c.url)).toEqual([
      "http://honcho.test:8000/v3/workspaces",
      "http://honcho.test:8000/v3/workspaces/ordillect-brain/peers",
      "http://honcho.test:8000/v3/workspaces/ordillect-brain/sessions",
      "http://honcho.test:8000/v3/workspaces/ordillect-brain/sessions/issue-abc/peers",
      "http://honcho.test:8000/v3/workspaces/ordillect-brain/sessions/issue-abc/messages",
    ]);
    expect(calls[4].body).toEqual({
      messages: [
        {
          peer_id: "agent-cto",
          content: "hello world",
          metadata: { paperclip_comment_id: "c1" },
        },
      ],
    });
  });

  it("adds Authorization header when token is set", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = new HonchoClient({
      baseUrl: "http://honcho.test:8000",
      workspace: "ordillect-brain",
      token: "secret",
      fetchImpl,
    });
    await client.ensureWorkspace();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = new HonchoClient({
      baseUrl: "http://honcho.test:8000",
      workspace: "ordillect-brain",
      fetchImpl,
    });
    await expect(client.ensureWorkspace()).rejects.toThrow(/500/);
  });
});
