import { describe, expect, it, vi } from "vitest";
import {
  authorizeSlackChannel,
  authorizeSlackWrite,
  recordSlackPrivateRead,
} from "./slack-access.js";
import { slackClient } from "./slack-client.js";
import type { SlackTaskAuthority } from "./slack-authority.js";
import {
  chatActions,
  chatEndpointResources,
  type Db,
} from "@paperclipai/db";
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
  describe("DMs with other people (Proactive DMs, TECH-8286)", () => {
    const members: Record<string, Record<string, unknown>> = {
      U1: { id: "U1", team_id: "T1" },
      UOTHER: { id: "UOTHER", team_id: "T1" },
      UGONE: { id: "UGONE", team_id: "T1", deleted: true },
      UBOTTY: { id: "UBOTTY", team_id: "T1", is_bot: true },
      UGUEST: { id: "UGUEST", team_id: "T1", is_restricted: true },
      UFOREIGN: { id: "UFOREIGN", team_id: "T2" },
    };
    const dmApi = (dmWith: string) =>
      vi.fn(
        async (
          method: string,
          args?: Record<string, unknown>,
        ): Promise<Record<string, unknown>> =>
          method === "users.info"
            ? { user: members[String(args?.user)] }
            : { channel: { id: "D9", is_im: true, user: dmWith } },
      );
    it("refuses another person's DM unless Proactive DMs is on, even for a valid member", async () => {
      await expect(
        authorizeSlackChannel(authority, dmApi("UOTHER"), "D9"),
      ).rejects.toThrow("Other people's bot DMs");
      await expect(
        authorizeSlackChannel(authority, dmApi("UOTHER"), "D9", {
          allowOtherUserDm: false,
        }),
      ).rejects.toThrow("Other people's bot DMs");
    });
    it("lets reads and writes use another active full member's DM when Proactive DMs is on", async () => {
      await expect(
        authorizeSlackChannel(authority, dmApi("UOTHER"), "D9", {
          allowOtherUserDm: true,
        }),
      ).resolves.toMatchObject({ id: "D9", user: "UOTHER" });
    });
    it("never allows a deactivated user, a bot, a guest or a user from another workspace", async () => {
      for (const who of ["UGONE", "UBOTTY", "UGUEST", "UFOREIGN"])
        await expect(
          authorizeSlackChannel(authority, dmApi(who), "D9", {
            allowOtherUserDm: true,
          }),
        ).rejects.toThrow("not an active member");
    });
    it("allows writes to authorized other-user DMs regardless of prior private reads", async () => {
      const options = { allowOtherUserDm: true };
      const readPrivate = fakeDb([{ payload: { channelId: "G2", requesterId: "U1" } }]);
      expect(
        await authorizeSlackWrite(fakeDb([]), authority, dmApi("UOTHER"), "D9", options),
      ).toMatchObject({ user: "UOTHER" });
      expect(
        await authorizeSlackWrite(readPrivate, authority, dmApi("UOTHER"), "D9", options),
      ).toMatchObject({ user: "UOTHER" });
      expect(
        await authorizeSlackWrite(readPrivate, authority, dmApi("U1"), "D9", options),
      ).toMatchObject({ user: "U1" });
    });
    it("open_dm takes an optional Slack user ID and rejects anything else", () => {
      const openDm = SLACK_TOOLS.find((tool) => tool.name === "slack_open_dm")!;
      const key = "9c0dc094-41b6-4d84-a2f1-1df331774489";
      expect(openDm.schema.safeParse({ idempotencyKey: key }).success).toBe(true);
      expect(
        openDm.schema.safeParse({ idempotencyKey: key, user: "U012AB3CD" }).success,
      ).toBe(true);
      expect(
        openDm.schema.safeParse({ idempotencyKey: key, user: "patrick" }).success,
      ).toBe(false);
      expect(
        openDm.schema.safeParse({ idempotencyKey: key, users: "U012AB3CD" }).success,
      ).toBe(false);
    });
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
  it("records private channel reads for audit without throwing on cross-channel access", async () => {
    const inserted: unknown[] = [];
    const db = {
      insert: () => ({
        values: (val: unknown) => {
          inserted.push(val);
          return {
            onConflictDoNothing: async () => {},
          };
        },
      }),
    } as unknown as Db;
    await recordSlackPrivateRead(db, authority, {
      id: "G2",
      is_private: true,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      kind: "slack_private_source",
      providerActionId: `slack-private:${authority.issueId}:G2:${authority.slackUserId}`,
      payload: {
        channelId: "G2",
        requesterId: authority.slackUserId,
      },
    });
  });
  it("does not record public channel reads for audit", async () => {
    const inserted: unknown[] = [];
    const db = {
      insert: () => ({
        values: (val: unknown) => {
          inserted.push(val);
          return {
            onConflictDoNothing: async () => {},
          };
        },
      }),
    } as unknown as Db;
    await recordSlackPrivateRead(db, authority, {
      id: "C1",
      is_private: false,
    });
    expect(inserted).toHaveLength(0);
  });
});

describe("Slack private-source markers after the publication-gate removal (TECH-8774)", () => {
  // Dispatch select rows per table so a fixture can hold legacy
  // slack_private_source markers in chat_actions at the same time as an
  // Allowed Channels row in chat_endpoint_resources.
  const markerDb = (resources: unknown[], markers: unknown[]) =>
    ({
      select: () => ({
        from: (table: unknown) => ({
          where: async () =>
            table === chatEndpointResources
              ? resources
              : table === chatActions
                ? markers
                : [],
        }),
      }),
    }) as unknown as Db;
  const legacyMarkers = [
    {
      kind: "slack_private_source",
      payload: { channelId: "G2", requesterId: "U1", allowedDmChannel: null },
    },
  ];
  it("lets a private-source marker coexist with a post to another Allowed Channel", async () => {
    // The marker records research read in a different private channel; it no
    // longer vetoes writing to a destination the operator allowlisted.
    await expect(
      authorizeSlackWrite(
        markerDb([{ providerResourceId: "C1" }], legacyMarkers),
        authority,
        apiFor({}),
        "C1",
      ),
    ).resolves.toMatchObject({ id: "C1" });
  });
  it("still denies destinations outside Allowed Channels with the existing error, marker or not", async () => {
    for (const markers of [legacyMarkers, []]) {
      await expect(
        authorizeSlackWrite(markerDb([], markers), authority, apiFor({}), "C1"),
      ).rejects.toThrow(
        "Responses are disabled in this channel. Enable it in connection Settings first.",
      );
    }
  });
  it("still denies private channels the linked user does not belong to, regardless of markers", async () => {
    const nonMember = vi.fn(async (method: string) =>
      method === "conversations.info"
        ? { channel: { id: "G1", is_private: true, is_member: true } }
        : method === "users.info"
          ? { user: { id: "U1", team_id: "T1" } }
          : { members: ["UOTHER"], response_metadata: {} },
    );
    await expect(
      authorizeSlackWrite(
        markerDb([{ providerResourceId: "G1" }], legacyMarkers),
        authority,
        nonMember,
        "G1",
      ),
    ).rejects.toThrow("must belong");
    await expect(
      authorizeSlackChannel(authority, nonMember, "G1"),
    ).rejects.toThrow("must belong");
    expect(nonMember).toHaveBeenCalledWith("conversations.members", {
      channel: "G1",
      limit: 200,
    });
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
    await expect(
      slackClient("bot-secret", fetcher)("conversations.list"),
    ).rejects.toThrow("Unsupported");
    expect(fetcher).not.toHaveBeenCalled();
    const channels = SLACK_TOOLS.find((t) => t.name === "slack_channels")!;
    expect(channels.method).toBe("users.conversations");
  });
  it("encodes Slack arguments like the official SDK, with nested values as JSON fields", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ ok: true }));
    await slackClient("bot-secret", fetcher)("users.conversations", {
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
