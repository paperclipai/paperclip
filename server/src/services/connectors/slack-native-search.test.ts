import { describe, expect, it, vi } from "vitest";
import { fetchTransientSlackSearch } from "./slack-native-search.js";
import {
  rememberVerifiedSlackSearchEvent,
  slackSearchActionToken,
} from "./slack-search-context.js";
import type { SlackTaskAuthority } from "./slack-authority.js";
import type { Db } from "@paperclipai/db";
const authority = {
  endpoint: { providerAccountId: "T1" },
  botToken: "bot-token",
  slackUserId: "U1",
  searchActionToken: "verified-event-token",
} as SlackTaskAuthority;

describe("Slack transient search provider (not exposed to retaining runtimes)", () => {
  it("uses the event token and validates workspace, channel, author and dates despite injected search modifiers", async () => {
    const hit = {
      team_id: "T1",
      channel_id: "C1",
      author_user_id: "U1",
      message_ts: "100.1",
      content: "Decision",
    };
    const fetched = vi.fn(async () =>
      Response.json({
        ok: true,
        results: {
          messages: [
            hit,
            { ...hit, team_id: "T2" },
            { ...hit, channel_id: "CSECRET" },
            { ...hit, author_user_id: "UOTHER" },
            { ...hit, message_ts: "1.0" },
          ],
        },
        next_cursor: "more",
      }),
    );
    const authorizeChannel = vi.fn(async () => ({
      id: "C1",
      is_private: false,
    }));
    const personalSearchToken = vi.fn();
    const result = await fetchTransientSlackSearch({
      authority,
      assertCurrentAuthority: async () => {},
      args: {
        channels: ["C1"],
        query: "in:secret OR everything",
        author: "U1",
        oldest: "99.0",
      },
      fetchImpl: fetched as typeof fetch,
      authorizeChannel,
      personalSearchToken,
    });
    expect(result.results).toHaveLength(1);
    expect(result.pages).toEqual([{ channel: "C1", nextCursor: "more" }]);
    expect(authorizeChannel).toHaveBeenCalledTimes(2);
    expect(personalSearchToken).not.toHaveBeenCalled();
    const init = (
      fetched.mock.calls as unknown as [unknown, RequestInit][]
    )[0][1];
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get("action_token")).toBe("verified-event-token");
    expect(JSON.parse(sent.get("term_clauses")!)).toEqual(["in:<#C1>", "from:<@U1>"]);
    expect(sent.get("include_context_messages")).toBe("false");
    expect(JSON.stringify(result)).not.toContain("verified-event-token");
  });
  it("uses a search-only personal grant for private search and rejects revoked access before delivery", async () => {
    const personalSearchToken = vi.fn(async () => ({
      token: "personal-token",
      scopes: ["search:read.public", "search:read.private"],
    }));
    const fetched = vi.fn(async () =>
      Response.json({ ok: true, results: { messages: [] } }),
    );
    const authorizeChannel = vi
      .fn()
      .mockResolvedValueOnce({ id: "G1", is_private: true })
      .mockRejectedValueOnce(new Error("Membership revoked"));
    await expect(
      fetchTransientSlackSearch({
        authority,
        assertCurrentAuthority: async () => {},
        args: { channels: ["G1"], query: "decision" },
        fetchImpl: fetched as typeof fetch,
        authorizeChannel,
        personalSearchToken,
      }),
    ).rejects.toThrow("Membership revoked");
    const init = (
      fetched.mock.calls as unknown as [unknown, RequestInit][]
    )[0][1];
    expect(init.headers).toMatchObject({
      authorization: "Bearer personal-token",
    });
    expect(new URLSearchParams(String(init.body)).has("action_token")).toBe(false);
  });
  it("does not expose file hits outside bot-verified channel shares", async () => {
    const fetched = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/files.info")
        ? Response.json({
            ok: true,
            file: { id: "F1", shares: { private: { GOTHER: [{}] } } },
          })
        : Response.json({
            ok: true,
            results: {
              files: [{ team_id: "T1", file_id: "F1", content: "private" }],
            },
          }),
    );
    const result = await fetchTransientSlackSearch({
      authority,
      assertCurrentAuthority: async () => {},
      args: { channels: ["C1"], query: "report", contentType: "files" },
      fetchImpl: fetched as typeof fetch,
      authorizeChannel: async () => ({ id: "C1" }),
      personalSearchToken: vi.fn(),
    });
    expect(result.results).toEqual([]);
    expect(fetched).toHaveBeenCalledTimes(2);
  });
});
describe("Verified search action credentials", () => {
  it("binds memory-only tokens to endpoint, workspace, sender and message and expires them", () => {
    vi.useFakeTimers();
    try {
      const db = {} as Db;
      rememberVerifiedSlackSearchEvent(
        db,
        "endpoint",
        "T1",
        JSON.stringify({
          team_id: "T1",
          event: {
            type: "app_mention",
            user: "U1",
            ts: "100.1",
            action_token: "short-lived",
          },
        }),
      );
      expect(slackSearchActionToken(db, "endpoint", "T1", "U1", "100.1")).toBe(
        "short-lived",
      );
      expect(
        slackSearchActionToken(db, "other", "T1", "U1", "100.1"),
      ).toBeNull();
      expect(
        slackSearchActionToken(db, "endpoint", "T1", "UOTHER", "100.1"),
      ).toBeNull();
      expect(
        slackSearchActionToken(db, "endpoint", "T2", "U1", "100.1"),
      ).toBeNull();
      vi.advanceTimersByTime(180001);
      expect(
        slackSearchActionToken(db, "endpoint", "T1", "U1", "100.1"),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
