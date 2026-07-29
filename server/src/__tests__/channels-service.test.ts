import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  channelMembers,
  channelMessages,
  channels,
  companies,
  createDb,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { channelService, dmFingerprint, extractMentionTokens } from "../services/channels.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres channel service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("channel mention parsing", () => {
  it("extracts normalized mention tokens", () => {
    expect(extractMentionTokens("hey @Ada-Lovelace and @bob, ping @Ada-Lovelace"))
      .toEqual(["adalovelace", "bob"]);
  });

  it("ignores email-like text", () => {
    expect(extractMentionTokens("mail me at someone@example.com")).toEqual([]);
  });

  it("produces an order-independent dm fingerprint", () => {
    const a = { principalType: "user" as const, principalId: "u1" };
    const b = { principalType: "agent" as const, principalId: "a1" };
    expect(dmFingerprint([a, b])).toBe(dmFingerprint([b, a]));
  });
});

describeEmbeddedPostgres("channel service", () => {
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-channels-service-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(channelMessages);
    await db.delete(channelMembers);
    await db.delete(channels);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedCompany() {
    const company = await db
      .insert(companies)
      .values({ name: `Channels ${randomUUID().slice(0, 8)}`, issuePrefix: randomUUID().slice(0, 6).toUpperCase() })
      .returning()
      .then((rows) => rows[0]);
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Ada Lovelace" })
      .returning()
      .then((rows) => rows[0]);
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Apollo" })
      .returning()
      .then((rows) => rows[0]);
    return { company, agent, project };
  }

  it("creates one project channel and joins company agents", async () => {
    const { company, agent, project } = await seedCompany();
    const svc = channelService(db, { enqueueWakeup: async () => undefined });

    const first = await svc.ensureProjectChannel(company.id, project.id, project.name);
    const second = await svc.ensureProjectChannel(company.id, project.id, project.name);
    expect(second.id).toBe(first.id);

    const members = await svc.listCompanyPrincipals(company.id);
    expect(members).toContainEqual({ principalType: "agent", principalId: agent.id });
  });

  it("materializes task roots for non-terminal issues only", async () => {
    const { company, project } = await seedCompany();
    const svc = channelService(db, { enqueueWakeup: async () => undefined });
    const channel = await svc.ensureProjectChannel(company.id, project.id, project.name);

    await db.insert(issues).values([
      { companyId: company.id, projectId: project.id, title: "Open work", status: "todo" },
      { companyId: company.id, projectId: project.id, title: "Finished work", status: "done" },
    ]);

    const created = await svc.materializeProjectTaskRoots(channel.id);
    expect(created).toBe(1);

    // Re-running must not duplicate the card.
    expect(await svc.materializeProjectTaskRoots(channel.id)).toBe(0);

    const page = await svc.listRootMessages(channel.id);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.body).toBe("Open work");
  });

  it("wakes mentioned agents and counts thread replies", async () => {
    const { company, agent, project } = await seedCompany();
    const woken: string[] = [];
    const svc = channelService(db, {
      enqueueWakeup: async (agentId) => {
        woken.push(agentId);
      },
    });
    const channel = await svc.ensureProjectChannel(company.id, project.id, project.name);

    const root = await svc.postMessage({
      companyId: company.id,
      channelId: channel.id,
      authorType: "user",
      authorId: "user-1",
      body: "@ada-lovelace can you take this?",
    });
    expect(root.mentionedAgentIds).toEqual([agent.id]);
    expect(woken).toEqual([agent.id]);

    await svc.postMessage({
      companyId: company.id,
      channelId: channel.id,
      authorType: "agent",
      authorId: agent.id,
      body: "On it.",
      threadRootId: root.id,
    });

    const thread = await svc.listThreadMessages(root.id);
    expect(thread.messages).toHaveLength(1);

    const roots = await svc.listRootMessages(channel.id);
    expect(roots.messages[0]?.replyCount).toBe(1);
  });

  it("pages root messages backwards without gaps or repeats", async () => {
    const { company, project } = await seedCompany();
    const svc = channelService(db, { enqueueWakeup: async () => undefined });
    const channel = await svc.ensureProjectChannel(company.id, project.id, project.name);

    for (let index = 0; index < 5; index += 1) {
      await svc.postMessage({
        companyId: company.id,
        channelId: channel.id,
        authorType: "user",
        authorId: "user-1",
        body: `message ${index}`,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof svc.listRootMessages>> =
        await svc.listRootMessages(channel.id, { cursor, limit: 2 });
      seen.unshift(...page.messages.map((message) => message.body));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
    ]);
  });

  it("reuses a direct message channel regardless of participant order", async () => {
    const { company, agent } = await seedCompany();
    const svc = channelService(db, { enqueueWakeup: async () => undefined });
    const user = { principalType: "user" as const, principalId: "user-1" };
    const target = { principalType: "agent" as const, principalId: agent.id };

    const dm = await svc.getOrCreateDm(company.id, user, target);
    const again = await svc.getOrCreateDm(company.id, target, user);
    expect(again.id).toBe(dm.id);
  });

  it("tracks unread counts until the channel is marked read", async () => {
    const { company, agent, project } = await seedCompany();
    const svc = channelService(db, { enqueueWakeup: async () => undefined });
    const channel = await svc.ensureProjectChannel(company.id, project.id, project.name);
    const reader = { principalType: "agent" as const, principalId: agent.id };

    const message = await svc.postMessage({
      companyId: company.id,
      channelId: channel.id,
      authorType: "user",
      authorId: "user-1",
      body: "status?",
    });

    const before = await svc.listChannels(company.id, reader);
    expect(before.find((entry) => entry.id === channel.id)?.unreadCount).toBe(1);

    await svc.markRead(company.id, channel.id, reader, message.id);

    const after = await svc.listChannels(company.id, reader);
    expect(after.find((entry) => entry.id === channel.id)?.unreadCount).toBe(0);
  });
});
