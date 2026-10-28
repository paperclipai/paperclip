import { describe, expect, it, vi } from "vitest";
import {
  authorizeSlackChannel,
  authorizeSlackWrite,
  recordSlackReadBoundary,
  slackPublicationAllowed,
} from "./slack-access.js";
import { slackClient } from "./slack-client.js";
import type { SlackTaskAuthority } from "./slack-authority.js";
import type { Db } from "@paperclipai/db";
import { SLACK_TOOLS } from "@paperclipai/shared";
import { tooManyRequests, unprocessable } from "../../errors.js";
const authority = {
  endpoint: {
    id: "endpoint",
    companyId: "company",
    providerAccountId: "T1",
    botExternalId: "UBOT",
    allowDirectMessages: true,
  },
  conversation: {
    id: "conversation",
    issueId: "task",
    externalConversationId: "C1",
    isDirectMessage: false,
  },
  slackUserId: "U1",
  principalId: "principal",
  userId: "user",
} as SlackTaskAuthority;
function apiFor(
  channel: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return vi.fn(
    async (
      method: string,
      _args?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> =>
      method === "users.info"
        ? { user: { id: "U1", team_id: "T1", ...extra } }
        : method === "conversations.info"
          ? { channel: { id: "C1", is_member: true, ...channel } }
          : { members: ["U1"], response_metadata: {} },
  );
}
const fakeDb = (rows: unknown[]) =>
  ({
    select: () => ({ from: () => ({ where: async () => rows }) }),
  }) as unknown as Db;
describe("Slack access and publication boundaries", () => {
  it("treats missing channels as access denials without hiding provider failures", async () => {
    for (const code of ["slack_channel_not_found", "slack_not_in_channel"]) {
      const api = apiFor({});
      api.mockRejectedValue(unprocessable("Slack rejected the lookup", { code }));
      await expect(authorizeSlackChannel(authority, api, "C1")).rejects.toMatchObject({ status: 403 });
    }
    for (const error of [tooManyRequests("Rate limited"), unprocessable("Missing scope", { code: "slack_missing_scope" })]) {
      const api = apiFor({});
      api.mockRejectedValue(error);
      await expect(authorizeSlackChannel(authority, api, "C1")).rejects.toBe(error);
    }
  });
  it("reads a public shared channel without checking the enabled response destination", async () => {
    expect((await authorizeSlackChannel(authority, apiFor({}), "C1")).id).toBe(
      "C1",
    );
    await expect(
      authorizeSlackWrite(fakeDb([]), authority, apiFor({}), "C1"),
    ).rejects.toThrow("Responses are disabled");
  });
  it("rejects missing bot membership, removed users and other people's DMs", async () => {
    await expect(
      authorizeSlackChannel(authority, apiFor({ is_member: false }), "C1"),
    ).rejects.toThrow("Invite this bot");
    await expect(
      authorizeSlackChannel(authority, apiFor({}, { deleted: true }), "C1"),
    ).rejects.toThrow("active workspace member");
    await expect(
      authorizeSlackChannel(
        authority,
        apiFor({ is_im: true, user: "UOTHER" }),
        "C1",
      ),
    ).rejects.toThrow("Other people's bot DMs");
  });
  it("paginates private membership and does not accept incomplete verification", async () => {
    const api = apiFor({ is_private: true });
    api.mockImplementation(async (method, args) => {
      if (method === "conversations.info")
        return { channel: { id: "C1", is_private: true, is_member: true } };
      if (method === "users.info") return { user: { id: "U1", team_id: "T1" } };
      return args?.cursor
        ? { members: ["U1"] }
        : { members: ["UOTHER"], response_metadata: { next_cursor: "next" } };
    });
    await expect(
      authorizeSlackChannel(authority, api, "C1"),
    ).resolves.toMatchObject({ id: "C1" });
    expect(api).toHaveBeenCalledWith(
      "conversations.members",
      expect.objectContaining({ cursor: "next" }),
    );
    api.mockImplementation(async (method) =>
      method === "conversations.info"
        ? { channel: { id: "C1", is_member: true, is_private: true } }
        : method === "users.info"
          ? { user: { id: "U1", team_id: "T1" } }
          : { members: ["UOTHER"] },
    );
    await expect(authorizeSlackChannel(authority, api, "C1")).rejects.toThrow(
      "must belong",
    );
  });
  it("rejects cross-private research in a public origin before recording or returning source data", async () => {
    await expect(
      recordSlackReadBoundary(fakeDb([]), authority, {
        id: "G2",
        is_private: true,
      }),
    ).rejects.toThrow("in a DM");
  });
  it("private-source restrictions cover automatic messages and uploads alike", async () => {
    const db = fakeDb([
      {
        payload: { channelId: "G2", requesterId: "U1", allowedDmChannel: "D1" },
      },
    ]);
    expect(
      await slackPublicationAllowed(
        db,
        "company",
        "endpoint",
        "task",
        "C1",
        null,
      ),
    ).toBe(false);
    expect(
      await slackPublicationAllowed(
        db,
        "company",
        "endpoint",
        "task",
        "G2",
        null,
      ),
    ).toBe(true);
    expect(
      await slackPublicationAllowed(
        db,
        "company",
        "endpoint",
        "task",
        "D1",
        null,
      ),
    ).toBe(true);
    expect(
      await slackPublicationAllowed(
        db,
        "company",
        "endpoint",
        "task",
        "D2",
        "UOTHER",
      ),
    ).toBe(false);
  });
});
describe("Slack contracts and transport", () => {
  it("does not accept injected identity, token or arbitrary API methods", async () => {
    const history = SLACK_TOOLS.find((t) => t.name === "slack_history")!;
    expect(
      history.schema.safeParse({
        channel: "C123",
        token: "secret",
        userId: "other",
      }).success,
    ).toBe(false);
    const fetcher = vi.fn();
    await expect(
      slackClient("bot-secret", fetcher)("admin.users.remove"),
    ).rejects.toThrow("Unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("encodes Slack arguments like the official SDK, with nested values as JSON fields", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ ok: true }));
    await slackClient("bot-secret", fetcher)("conversations.list", {
      types: "public_channel,private_channel,mpim,im", limit: 50, exclude_archived: true, cursor: undefined,
    });
    expect(fetcher.mock.calls[0][1].headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(fetcher.mock.calls[0][1].body))).toEqual({
      types: "public_channel,private_channel,mpim,im", limit: "50", exclude_archived: "true",
    });
    await slackClient("bot-secret", fetcher)("files.completeUploadExternal", { files: [{ id: "F123", title: "Test & review" }] });
    expect(JSON.parse(new URLSearchParams(fetcher.mock.calls[1][1].body).get("files")!)).toEqual([{ id: "F123", title: "Test & review" }]);
  });
  it("reports missing scopes without exposing raw provider errors or credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: "missing_scope",
          needed: "pins:read",
          secret: "bot-secret",
        }),
      ),
    );
    await expect(
      slackClient("bot-secret", fetcher)("pins.list", { channel: "C1" }),
    ).rejects.toThrow("Reinstall the app with pins:read");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer bot-secret" },
    });
  });
  it("honors rate-limit delay and does not retry a mutation automatically", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("", { status: 429, headers: { "retry-after": "42" } }),
      );
    await expect(
      slackClient("secret", fetcher)("chat.postMessage", {
        channel: "C1",
        text: "hello",
      }),
    ).rejects.toMatchObject({
      status: 429,
      details: { retryAfterSeconds: 42 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
