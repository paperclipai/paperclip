import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  channelMembers,
  channelMessages,
  channels,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
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
    await db.delete(issueThreadInteractions);
    await db.update(issues).set({ executionRunId: null });
    await db.delete(heartbeatRuns);
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

  it("moves a task root into the new project channel and leaves a stub", async () => {
    const { company, project } = await seedCompany();
    const destination = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Orion" })
      .returning()
      .then((rows) => rows[0]);
    const svc = channelService(db, { enqueueWakeup: async () => undefined });
    const fromChannel = await svc.ensureProjectChannel(company.id, project.id, project.name);
    const toChannel = await svc.ensureProjectChannel(company.id, destination.id, destination.name);

    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        projectId: project.id,
        title: "Auth fix",
        status: "todo",
        identifier: "PAP-88",
      })
      .returning()
      .then((rows) => rows[0]);

    const root = await svc.ensureTaskRootMessage(company.id, {
      id: issue.id,
      projectId: project.id,
      title: issue.title,
    });
    expect(root?.channelId).toBe(fromChannel.id);

    await svc.postMessage({
      companyId: company.id,
      channelId: fromChannel.id,
      authorType: "user",
      authorId: "user-1",
      body: "working on it",
      threadRootId: root!.id,
      issueId: issue.id,
    });

    await svc.moveIssueToProject({
      companyId: company.id,
      issueId: issue.id,
      title: issue.title,
      identifier: issue.identifier,
      fromProjectId: project.id,
      toProjectId: destination.id,
    });

    const moved = await svc.getTaskRootForIssue(company.id, issue.id);
    expect(moved?.channelId).toBe(toChannel.id);

    const oldRoots = await svc.listRootMessages(fromChannel.id, { includeCompleted: true });
    expect(oldRoots.messages.some((message) => message.cardKind === "stub")).toBe(true);

    const thread = await svc.listThreadMessages(moved!.id);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]?.body).toBe("working on it");
  });

  it("posts a child link card into the parent thread and mints a child root", async () => {
    const { company, project } = await seedCompany();
    const svc = channelService(db, { enqueueWakeup: async () => undefined });
    await svc.ensureProjectChannel(company.id, project.id, project.name);

    const [parent, child] = await db
      .insert(issues)
      .values([
        { companyId: company.id, projectId: project.id, title: "Parent", status: "todo", identifier: "PAP-1" },
        { companyId: company.id, projectId: project.id, title: "Child", status: "todo", identifier: "PAP-2" },
      ])
      .returning();

    await svc.ensureTaskRootMessage(company.id, {
      id: parent.id,
      projectId: project.id,
      title: parent.title,
    });

    await svc.linkChildIssueInParentThread({
      companyId: company.id,
      parentIssueId: parent.id,
      child: {
        id: child.id,
        title: child.title,
        identifier: child.identifier,
        projectId: project.id,
      },
    });

    const childRoot = await svc.getTaskRootForIssue(company.id, child.id);
    expect(childRoot).not.toBeNull();

    const parentRoot = await svc.getTaskRootForIssue(company.id, parent.id);
    const thread = await svc.listThreadMessages(parentRoot!.id);
    expect(thread.messages.some((message) => (
      message.cardKind === "stub" && message.body.includes("PAP-2")
    ))).toBe(true);
  });

  it("projects HITL interactions as thread cards", async () => {
    const { company, project } = await seedCompany();
    const svc = channelService(db, { enqueueWakeup: async () => undefined });
    await svc.ensureProjectChannel(company.id, project.id, project.name);
    const issue = await db
      .insert(issues)
      .values({ companyId: company.id, projectId: project.id, title: "Ask me", status: "todo" })
      .returning()
      .then((rows) => rows[0]);
    const root = await svc.ensureTaskRootMessage(company.id, {
      id: issue.id,
      projectId: project.id,
      title: issue.title,
    });

    const interaction = await db
      .insert(issueThreadInteractions)
      .values({
        companyId: company.id,
        issueId: issue.id,
        kind: "ask_user_questions",
        payload: { questions: [] },
        title: "Which provider?",
      })
      .returning()
      .then((rows) => rows[0]);

    const card = await svc.postInteractionCard({
      companyId: company.id,
      issueId: issue.id,
      interactionId: interaction.id,
      kind: "ask_user_questions",
      title: "Which provider?",
    });
    expect(card?.cardKind).toBe("questions");
    expect(card?.threadRootId).toBe(root!.id);

    // Idempotent on the same interaction id.
    expect(await svc.postInteractionCard({
      companyId: company.id,
      issueId: issue.id,
      interactionId: interaction.id,
      kind: "ask_user_questions",
      title: "Which provider?",
    })).toBeNull();
  });

  it("posts a busy-mention system line when the agent is already running", async () => {
    const { company, agent, project } = await seedCompany();
    const svc = channelService(db, { enqueueWakeup: async () => undefined });
    const channel = await svc.ensureProjectChannel(company.id, project.id, project.name);
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        projectId: project.id,
        title: "Live work",
        status: "in_progress",
        identifier: "PAP-9",
        assigneeAgentId: agent.id,
      })
      .returning()
      .then((rows) => rows[0]);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        invocationSource: "on_demand",
        triggerDetail: "manual",
        startedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]);
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));

    await svc.postMessage({
      companyId: company.id,
      channelId: channel.id,
      authorType: "user",
      authorId: "user-1",
      body: "@ada-lovelace ping",
      channelWorkMode: "ask",
    });

    const roots = await svc.listRootMessages(channel.id, { includeCompleted: true });
    expect(roots.messages.some((message) => (
      message.messageType === "system"
      && message.body.includes("busy on PAP-9")
      && message.body.includes("queued")
    ))).toBe(true);
  });
});
