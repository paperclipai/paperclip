import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { executeSlackTool } from "./slack.js";
import { registerSlackTaskAuthority, type SlackTaskAuthority } from "./slack-authority.js";
import { authorizeSlackWrite } from "./slack-access.js";
import { SLACK_OTHER_USER_DM_OPTIONS } from "./slack-opt-ins.js";

const dmAccessToken = vi.hoisted(() => vi.fn());
vi.mock("./slack-search-oauth.js", () => ({
  slackSearchOAuthService: () => ({ dmAccessToken }),
}));

const BOT = "Bearer xoxb-bot";
const PERSON = "Bearer xoxp-person";

/** The person's DMs with other people are invisible to the bot; only the person's own token can open them. */
describe("Slack DM reads with the person's own token", () => {
  const binding = { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" };
  const makeAuthority = (conversation: unknown = null) => ({
    endpoint: {
      id: "endpoint",
      companyId: "company",
      providerAccountId: "T1",
      botExternalId: "UBOT",
      allowDirectMessages: true,
      setup: { slackOptInScopeGroups: ["channel_management"], slackInstalledOptInScopeGroups: ["channel_management"] },
    },
    conversation,
    slackUserId: "U1",
    principalId: "principal",
    userId: "user",
    issueId: "issue",
    deliveryId: null,
    identityContextId: null,
    revision: "revision",
    workMode: "standard",
    botToken: "xoxb-bot",
  }) as unknown as SlackTaskAuthority;
  const authority = makeAuthority();

  /** `readDms` makes the database report that this task already read the requester's DMs. */
  function mockDb(options: { readDms?: boolean; reader?: string } = {}) {
    const inserted: any[] = [];
    const rows = options.readDms
      ? [{ id: "inv-1", status: "executing", approvalState: "approved", providerActionId: `slack-private-dm:issue:DFRIEND:${options.reader ?? "U1"}` }]
      : [{ id: "inv-1", status: "executing", approvalState: "approved" }];
    const tx = {
      execute: vi.fn(async () => undefined),
      select: () => ({ from: () => ({ where: async () => rows }) }),
      update: () => ({ set: (value: any) => ({ where: () => ({ returning: () => [{ id: "action-1", ...value }] }) }) }),
      insert: () => ({
        values: (value: any) => {
          inserted.push(value);
          return {
            onConflictDoNothing: () =>
              Object.assign(Promise.resolve(undefined), { returning: () => [{ id: "action-1", status: "received", ...value }] }),
            returning: () => [{ id: "act-1", ...value }],
          };
        },
      }),
    };
    return Object.assign({ ...tx, transaction: async (fn: any) => fn(tx) }, { inserted }) as unknown as Db & { inserted: any[] };
  }

  async function withAuthority<T>(run: (db: Db & { inserted: any[] }) => Promise<T>, options: { readDms?: boolean; conversation?: unknown } = {}) {
    const db = mockDb({ readDms: options.readDms });
    const unregister = registerSlackTaskAuthority(db, async () => makeAuthority(options.conversation ?? null));
    try {
      return await run(db);
    } finally {
      unregister();
    }
  }

  function slackFetch() {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = String(input).split("/").at(-1);
      const args = new URLSearchParams(String(init?.body ?? ""));
      const auth = (init?.headers as Record<string, string>).authorization;
      const channel = args.get("channel");
      if (method === "users.info") return Response.json({ ok: true, user: { id: "U1", team_id: "T1" } });
      if (auth === BOT) {
        if (method === "conversations.info") return Response.json({ ok: false, error: "channel_not_found" });
        if (method === "users.conversations") return Response.json({ ok: true, channels: [] });
        throw new Error(`The bot must not call ${method}`);
      }
      expect(auth).toBe(PERSON);
      if (method === "conversations.info") {
        return channel === "DFRIEND"
          ? Response.json({ ok: true, channel: { id: "DFRIEND", is_im: true, user: "UFRIEND" } })
          : channel === "CPUBLIC"
            ? Response.json({ ok: true, channel: { id: "CPUBLIC", is_member: true } })
            : Response.json({ ok: false, error: "channel_not_found" });
      }
      if (method === "conversations.history")
        return Response.json({ ok: true, messages: [{ ts: "9000.1", user: "UFRIEND", text: "dm hello" }], has_more: false });
      if (method === "users.conversations")
        return Response.json({ ok: true, channels: [{ id: "DFRIEND", is_im: true, user: "UFRIEND" }, { id: "GGROUP", is_mpim: true, name: "mpdm-a--b-1" }] });
      throw new Error(`Unexpected personal Slack method ${method}`);
    });
  }

  const calls = (fetchImpl: ReturnType<typeof slackFetch>, method: string, auth: string) =>
    fetchImpl.mock.calls.filter(
      (call) => String(call[0]).endsWith(`/${method}`) && (call[1]?.headers as Record<string, string>).authorization === auth,
    );

  it("reads a DM the bot cannot see with the person's token when they opted in", async () => {
    dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
    await withAuthority(async (db) => {
      const fetchImpl = slackFetch();
      const result = await executeSlackTool(db, binding, "slack_history", { channel: "DFRIEND" }, fetchImpl as unknown as typeof fetch);
      expect(JSON.stringify(result)).toContain("dm hello");
      expect(calls(fetchImpl, "conversations.history", PERSON)).toHaveLength(1);
      expect(calls(fetchImpl, "conversations.history", BOT)).toHaveLength(0);
    });
  });

  it("keeps the original denial when the person did not opt in", async () => {
    dmAccessToken.mockResolvedValue(null);
    await withAuthority(async (db) => {
      const fetchImpl = slackFetch();
      await expect(executeSlackTool(db, binding, "slack_history", { channel: "DFRIEND" }, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403 });
      expect(calls(fetchImpl, "conversations.info", PERSON)).toHaveLength(0);
    });
  });

  it("never opens a channel that is not a DM or group DM with the person's token", async () => {
    dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
    await withAuthority(async (db) => {
      const fetchImpl = slackFetch();
      // A public channel id never reaches the person's token, even when they opted in.
      await expect(executeSlackTool(db, binding, "slack_history", { channel: "CPUBLIC" }, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403 });
      expect(calls(fetchImpl, "conversations.info", PERSON)).toHaveLength(0);
      // A DM id the person's token cannot open keeps the original denial.
      await expect(executeSlackTool(db, binding, "slack_history", { channel: "DNOTYOURS" }, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403 });
      expect(calls(fetchImpl, "conversations.history", PERSON)).toHaveLength(0);
    });
  });

  it("lists the person's own DMs only when they opted in", async () => {
    await withAuthority(async (db) => {
      dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
      await expect(executeSlackTool(db, binding, "slack_channels", {}, slackFetch() as unknown as typeof fetch)).resolves.toMatchObject({
        channels: expect.arrayContaining([
          expect.objectContaining({ id: "DFRIEND", direct: true, with: "UFRIEND", source: "personal_dm" }),
          expect.objectContaining({ id: "GGROUP", source: "personal_dm" }),
        ]),
      });
      dmAccessToken.mockResolvedValue(null);
      const without = (await executeSlackTool(db, binding, "slack_channels", {}, slackFetch() as unknown as typeof fetch)) as { channels: unknown[] };
      expect(without.channels).toEqual([]);
    });
  });
  it("records the DM read before returning content", async () => {
    dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
    await withAuthority(async (db) => {
      await executeSlackTool(db, binding, "slack_history", { channel: "DFRIEND" }, slackFetch() as unknown as typeof fetch);
      expect(db.inserted.some((row) => String(row.providerActionId).startsWith("slack-private-dm:issue:DFRIEND:U1") && row.payload.source === "personal_dm")).toBe(true);
    });
  });

  it("does not read personal DMs in a task started from a channel conversation", async () => {
    dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
    await withAuthority(async (db) => {
      const fetchImpl = slackFetch();
      await expect(executeSlackTool(db, binding, "slack_history", { channel: "DFRIEND" }, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403, details: { code: "slack_personal_dm_private" } });
      expect(calls(fetchImpl, "conversations.history", PERSON)).toHaveLength(0);
      expect(db.inserted.some((row) => String(row.providerActionId).startsWith("slack-private-dm:"))).toBe(false);
      // A private channel that is not a DM keeps its own denial, not the DM privacy message.
      await expect(executeSlackTool(db, binding, "slack_history", { channel: "GPRIVATE" }, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403, details: expect.not.objectContaining({ code: "slack_personal_dm_private" }) });
      // Nor does it list them.
      const listed = (await executeSlackTool(db, binding, "slack_channels", {}, slackFetch() as unknown as typeof fetch)) as { channels: unknown[] };
      expect(listed.channels).toEqual([]);
    }, { conversation: { id: "conversation", isDirectMessage: false, externalConversationId: "slack:C1" } });
  });

  it("reads personal DMs in a task started from a direct message", async () => {
    dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
    await withAuthority(async (db) => {
      const result = await executeSlackTool(db, binding, "slack_history", { channel: "DFRIEND" }, slackFetch() as unknown as typeof fetch);
      expect(JSON.stringify(result)).toContain("dm hello");
    }, { conversation: { id: "conversation", isDirectMessage: true, externalConversationId: "slack:DREQ" } });
  });

  it("lists personal DMs on the first page only", async () => {
    dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
    await withAuthority(async (db) => {
      const page = (await executeSlackTool(db, binding, "slack_channels", { cursor: "next" }, slackFetch() as unknown as typeof fetch)) as { channels: unknown[] };
      expect(page.channels).toEqual([]);
    });
  });

  describe("after a task read the person's DMs", () => {
    const writeApi = (channels: Record<string, Record<string, unknown>>) =>
      (async (method: string, args: Record<string, unknown> = {}) => {
        if (method === "users.info") return { user: { id: args.user, team_id: "T1" } };
        if (method === "conversations.info") return { channel: channels[String(args.channel)] };
        throw new Error(`Unexpected ${method}`);
      }) as any;
    const channels = {
      CPUBLIC: { id: "CPUBLIC", is_member: true },
      DREQ: { id: "DREQ", is_im: true, user: "U1" },
      DOTHER: { id: "DOTHER", is_im: true, user: "U9" },
    };

    it("allows writes only to the person's own DM with the bot", async () => {
      const db = mockDb({ readDms: true });
      const unregister = registerSlackTaskAuthority(db, async () => authority);
      try {
        await expect(authorizeSlackWrite(db, authority, writeApi(channels), "CPUBLIC", SLACK_OTHER_USER_DM_OPTIONS))
          .rejects.toMatchObject({ status: 403, details: { code: "slack_personal_dm_private" } });
        await expect(authorizeSlackWrite(db, authority, writeApi(channels), "DOTHER", SLACK_OTHER_USER_DM_OPTIONS))
          .rejects.toMatchObject({ status: 403, details: { code: "slack_personal_dm_private" } });
        await expect(authorizeSlackWrite(db, authority, writeApi(channels), "DREQ", SLACK_OTHER_USER_DM_OPTIONS))
          .resolves.toMatchObject({ id: "DREQ" });
      } finally {
        unregister();
      }
    });

    it("only allows the DM with the person whose DMs were read", async () => {
      // Someone else's DMs were read in this task: even the current requester's own DM is off limits.
      const db = mockDb({ readDms: true, reader: "U9" });
      const unregister = registerSlackTaskAuthority(db, async () => authority);
      try {
        await expect(authorizeSlackWrite(db, authority, writeApi(channels), "DREQ", SLACK_OTHER_USER_DM_OPTIONS))
          .rejects.toMatchObject({ status: 403, details: { code: "slack_personal_dm_private" } });
        await expect(authorizeSlackWrite(db, authority, writeApi(channels), "DOTHER", SLACK_OTHER_USER_DM_OPTIONS))
          .resolves.toMatchObject({ id: "DOTHER" });
      } finally {
        unregister();
      }
    });

    it("records listing the person's DMs as a personal DM read", async () => {
      dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
      await withAuthority(async (db) => {
        await executeSlackTool(db, binding, "slack_channels", {}, slackFetch() as unknown as typeof fetch);
        expect(db.inserted.some((row) => String(row.providerActionId).startsWith("slack-private-dm:issue:directory:U1"))).toBe(true);
      });
    });

    it("does not restrict writes when no personal DM was read", async () => {
      const db = mockDb();
      const unregister = registerSlackTaskAuthority(db, async () => authority);
      try {
        await expect(authorizeSlackWrite(db, authority, writeApi({ DOTHER: channels.DOTHER }), "DOTHER", SLACK_OTHER_USER_DM_OPTIONS))
          .resolves.toMatchObject({ id: "DOTHER" });
      } finally {
        unregister();
      }
    });

    it("blocks opening a DM with someone else and creating channels, but not the person's own DM", async () => {
      await withAuthority(async (db) => {
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
          const method = String(input).split("/").at(-1);
          if (method === "users.info") return Response.json({ ok: true, user: { id: "U1", team_id: "T1" } });
          if (method === "conversations.open") return Response.json({ ok: true, channel: { id: "DREQ" } });
          throw new Error(`Unexpected ${method}`);
        });
        await expect(executeSlackTool(db, binding, "slack_open_dm", { user: "U9", idempotencyKey: "00000000-0000-4000-8000-000000000011" }, fetchImpl as unknown as typeof fetch, "inv-1"))
          .rejects.toMatchObject({ status: 403, details: { code: "slack_personal_dm_private" } });
        await expect(executeSlackTool(db, binding, "slack_create_channel", { name: "leak", is_private: false, idempotencyKey: "00000000-0000-4000-8000-000000000012" }, fetchImpl as unknown as typeof fetch, "inv-1"))
          .rejects.toMatchObject({ status: 403, details: { code: "slack_personal_dm_private" } });
        expect(fetchImpl.mock.calls.some((call) => String(call[0]).endsWith("/conversations.open"))).toBe(false);
        await expect(executeSlackTool(db, binding, "slack_open_dm", { idempotencyKey: "00000000-0000-4000-8000-000000000013" }, fetchImpl as unknown as typeof fetch, "inv-1"))
          .resolves.toMatchObject({ channel: "DREQ" });
      }, { readDms: true });
    });
  });
});
