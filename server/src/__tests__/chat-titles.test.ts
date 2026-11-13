import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { issueService } from "../services/issues.js";
import { chatAwaitsFirstAgentTurn, chatTitleFromMessage, setProvisionalChatTitle } from "../services/chat-titles.js";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat/task-markdown.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("chat title from a first message", () => {
  it("uses the first line without markdown, cut at a word boundary", () => {
    expect(chatTitleFromMessage("\n\n# How do I **reset** my [password](https://example.com)?\nMore detail")).toBe("How do I reset my password?");
    expect(chatTitleFromMessage("Wie kann ich die Rechnungen für das dritte Quartal exportieren und archivieren?"))
      .toBe("Wie kann ich die Rechnungen für das dritte…");
    expect(chatTitleFromMessage("   \n  ")).toBeNull();
    expect(chatTitleFromMessage("![](https://example.com/a.png)")).toBeNull();
  });
});

describe("chat title directive", () => {
  const chat = { id: "chat-1", identifier: null, title: "Reset my password", titleNeedsGeneration: true, workMode: "standard" as const, conversationAgentId: "agent" };
  it("asks the agent to name the chat only on its first turn while the title is provisional", () => {
    expect(buildPaperclipTaskMarkdown({ issue: chat, chatTitleRequested: true })).toContain("Chat title directive:");
    expect(buildPaperclipTaskMarkdown({ issue: chat, chatTitleRequested: false })).not.toContain("Chat title directive:");
    expect(buildPaperclipTaskMarkdown({ issue: { ...chat, titleNeedsGeneration: false }, chatTitleRequested: true })).not.toContain("Chat title directive:");
    // Chats never get the task naming directive.
    expect(buildPaperclipTaskMarkdown({ issue: chat, chatTitleRequested: true })).not.toContain("Task title directive:");
  });
});

describe("agent-named chats", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });
  type Fixture = Awaited<ReturnType<typeof server.fixture>>;
  const chatFixture = async (titleNeedsGeneration = true) => {
    const f = await server.fixture({ conversation: true });
    await server.db.update(issues).set({ title: "Chat with Eval", titleNeedsGeneration }).where(eq(issues.id, f.issueId));
    return f;
  };
  const name = (f: Fixture, title: string, key = randomUUID()) => f.authority.execute({
    tool: "set_task_title", callId: randomUUID(), arguments: { idempotencyKey: key, title },
  });
  const current = async (f: Fixture) => (await server.db.select({ title: issues.title, titleNeedsGeneration: issues.titleNeedsGeneration })
    .from(issues).where(eq(issues.id, f.issueId)))[0]!;

  it("names a new chat after the first message only, and keeps it provisional for the agent", async () => {
    const f = await chatFixture();
    const svc = issueService(server.db);
    const first = await svc.addComment(f.issueId, "How do I reset my password?", { userId: f.responsibleUserId! }, { authorType: "user" });
    await server.db.transaction(tx => setProvisionalChatTitle(tx as never, { companyId: f.companyId, issueId: f.issueId, commentId: first.id,
      body: "How do I reset my password?", actor: { actorType: "user", actorId: f.responsibleUserId! } }, []));
    expect(await current(f)).toEqual({ title: "How do I reset my password?", titleNeedsGeneration: true });
    const second = await svc.addComment(f.issueId, "Also my email", { userId: f.responsibleUserId! }, { authorType: "user" });
    await server.db.transaction(tx => setProvisionalChatTitle(tx as never, { companyId: f.companyId, issueId: f.issueId, commentId: second.id,
      body: "Also my email", actor: { actorType: "user", actorId: f.responsibleUserId! } }, []));
    expect((await current(f)).title).toBe("How do I reset my password?");
    expect(await chatAwaitsFirstAgentTurn(server.db, f.companyId, f.issueId)).toBe(true);
    await svc.addComment(f.issueId, "Here is how.", { agentId: f.agentId, runId: f.runId });
    expect(await chatAwaitsFirstAgentTurn(server.db, f.companyId, f.issueId)).toBe(false);
  });

  it("asks for a title on the agent's first turn after the person's first message, also in a chat the agent opened", async () => {
    const f = await chatFixture();
    const svc = issueService(server.db);
    expect(await chatAwaitsFirstAgentTurn(server.db, f.companyId, f.issueId)).toBe(false);
    await svc.addComment(f.issueId, "I found a regression in the export.", { agentId: f.agentId, runId: f.runId });
    expect(await chatAwaitsFirstAgentTurn(server.db, f.companyId, f.issueId)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 5));
    await svc.addComment(f.issueId, "Which export?", { userId: f.responsibleUserId! }, { authorType: "user" });
    expect(await chatAwaitsFirstAgentTurn(server.db, f.companyId, f.issueId)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    await svc.addComment(f.issueId, "The CSV export.", { agentId: f.agentId, runId: f.runId });
    expect(await chatAwaitsFirstAgentTurn(server.db, f.companyId, f.issueId)).toBe(false);
  });

  it("names the chat after the first real message when a /new reset came first", async () => {
    const f = await chatFixture();
    const svc = issueService(server.db);
    await svc.addComment(f.issueId, "/new", { userId: f.responsibleUserId! }, { authorType: "user" });
    expect(await chatAwaitsFirstAgentTurn(server.db, f.companyId, f.issueId)).toBe(false);
    const first = await svc.addComment(f.issueId, "Plan the Q3 offsite", { userId: f.responsibleUserId! }, { authorType: "user" });
    await server.db.transaction(tx => setProvisionalChatTitle(tx as never, { companyId: f.companyId, issueId: f.issueId, commentId: first.id,
      body: "Plan the Q3 offsite", actor: { actorType: "user", actorId: f.responsibleUserId! } }, []));
    expect(await current(f)).toEqual({ title: "Plan the Q3 offsite", titleNeedsGeneration: true });
    expect(await chatAwaitsFirstAgentTurn(server.db, f.companyId, f.issueId)).toBe(true);
  });

  it("lets the chat's agent name it once, and logs the rename", async () => {
    const f = await chatFixture();
    await name(f, "Password reset help");
    expect(await current(f)).toEqual({ title: "Password reset help", titleNeedsGeneration: false });
    await name(f, "Something else");
    expect((await current(f)).title).toBe("Password reset help");
    const activity = await server.db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId));
    expect(activity.some(entry => entry.action === "issue.updated" && (entry.details as { title?: string })?.title === "Password reset help")).toBe(true);
  });

  it("never overwrites a chat the person renamed, neither from the first message nor by the agent", async () => {
    const f = await chatFixture();
    await issueService(server.db).update(f.issueId, { title: "My own title" });
    expect(await current(f)).toEqual({ title: "My own title", titleNeedsGeneration: false });
    const first = await issueService(server.db).addComment(f.issueId, "A question", { userId: f.responsibleUserId! }, { authorType: "user" });
    await server.db.transaction(tx => setProvisionalChatTitle(tx as never, { companyId: f.companyId, issueId: f.issueId, commentId: first.id,
      body: "A question", actor: { actorType: "user", actorId: f.responsibleUserId! } }, []));
    await name(f, "Agent title");
    expect((await current(f)).title).toBe("My own title");
  });

  it("refuses titles from other agents and other companies", async () => {
    const f = await chatFixture();
    const other = await server.fixture();
    const token = createLocalAgentJwt(other.agentId, other.companyId, "paperclip_runner", other.runId, other.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}/title`, { method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Hijacked", onlyIfProvisional: true }) });
    expect([403, 404]).toContain(response.status);
    expect((await current(f)).title).toBe("Chat with Eval");
  });
});
