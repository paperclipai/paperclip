import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";

export interface ChatFixture {
  company: { id: string; issuePrefix: string };
  agent: { id: string };
  issue: { id: string };
  comments: { id: string; body: string }[];
}
export async function longChatFixture(request: APIRequestContext, suffix = "", options: { delayedImage?: boolean } = {}): Promise<ChatFixture> {
  const count = Number(process.env.PAPERCLIP_CHAT_PERF_MESSAGES ?? 600);
  if (!Number.isSafeInteger(count) || count < 100 || count > 10_000) throw new Error("Use 100–10000 synthetic messages");
  const baseFile = process.env.PAPERCLIP_CHAT_PERF_SEED_FILE ?? `test-results/agent-chat/fixture-${count}.json`;
  const file = suffix ? `${baseFile}.${suffix}.json` : baseFile;
  const saved: ChatFixture | null = await fs.readFile(file, "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (saved && (await request.get(`/api/issues/${saved.issue.id}`)).ok()) return saved;
  const databaseUrl = process.env.PAPERCLIP_CHAT_PERF_DATABASE_URL;
  if (!databaseUrl) throw new Error("Set PAPERCLIP_CHAT_PERF_DATABASE_URL for a disposable local PostgreSQL database, or retain a seed file");
  const target = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !target.pathname.endsWith("_test"))
    throw new Error("The chat fixture requires a disposable loopback database ending in _test");
  const { createDb, closeRegisteredClients, heartbeatRuns, heartbeatRunEvents, issueComments, activityLog } = await import("../../../packages/db/src/index");
  const companyResponse = await request.post("/api/companies", { data: { name: `Long chat ${count}` } });
  expect(companyResponse.ok(), await companyResponse.text()).toBeTruthy();
  const company = await companyResponse.json();
  const agentResponse = await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "History Fixture", role: "engineer", status: "paused", adapterType: "process", adapterConfig: { command: "/usr/bin/true" },
  } });
  expect(agentResponse.ok(), await agentResponse.text()).toBeTruthy();
  const agent = await agentResponse.json();
  const chatResponse = await request.post(`/api/companies/${company.id}/chats/${agent.id}`, { data: {} });
  expect(chatResponse.ok(), await chatResponse.text()).toBeTruthy();
  const issue = await chatResponse.json();
  const db = createDb(databaseUrl);
  const comments: (typeof issueComments.$inferInsert)[] = [];
  const runs: (typeof heartbeatRuns.$inferInsert)[] = [];
  const events: (typeof heartbeatRunEvents.$inferInsert)[] = [];
  const activity: (typeof activityLog.$inferInsert)[] = [];
  const base = Date.now() - 30 * 24 * 3600_000;
  for (let index = 0; index < count; index++) {
    const human = index % 2 === 0, id = randomUUID(), runId = human ? null : randomUUID();
    const createdAt = new Date(base + index * 60_000);
    let body = `History message ${index}. ` + (human ? "Please investigate these findings." : "The investigation is complete.\n\n- Checked the saved evidence.\n- Verified the result.\n\n" + "Saved findings and verification details. ".repeat(index % 7 + 2));
    if (options.delayedImage && index === count - 10) body += "\n\nInline evidence: ![Delayed evidence](/__chat-history-image.svg)";
    if (runId) {
      runs.push({ id: runId, companyId: company.id, agentId: agent.id, issueId: issue.id, runtimeMode: "native", status: "succeeded",
        createdAt: new Date(+createdAt - 1000), startedAt: new Date(+createdAt - 900), finishedAt: createdAt, contextSnapshot: { issueId: issue.id, conversationSessionGeneration: issue.conversationSessionGeneration, wakeCommentId: comments.at(-1)?.id } });
      events.push({ companyId: company.id, agentId: agent.id, runId, seq: 1, eventType: "item.completed", createdAt,
        payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, eventType: "item.completed", runId,
          emittedAt: createdAt.toISOString(), itemId: `answer-${runId}`, payload: { kind: "agentMessage", text: body } } } });
    }
    comments.push({ id, companyId: company.id, issueId: issue.id, authorType: human ? "user" : "agent", authorUserId: human ? issue.conversationUserId : null,
      authorAgentId: human ? null : agent.id, createdByRunId: runId, body, createdAt, updatedAt: createdAt });
    activity.push({ companyId: company.id, actorType: human ? "user" : "agent", actorId: human ? issue.conversationUserId : agent.id,
      agentId: human ? null : agent.id, runId, entityType: "issue", entityId: issue.id, action: "issue.comment_added", details: { commentId: id }, createdAt });
  }
  try {
    for (let start = 0; start < runs.length; start += 100) await db.insert(heartbeatRuns).values(runs.slice(start, start + 100));
    for (let start = 0; start < comments.length; start += 100) await db.insert(issueComments).values(comments.slice(start, start + 100));
    for (let start = 0; start < events.length; start += 100) await db.insert(heartbeatRunEvents).values(events.slice(start, start + 100));
    for (let start = 0; start < activity.length; start += 100) await db.insert(activityLog).values(activity.slice(start, start + 100));
  } finally { await closeRegisteredClients(databaseUrl); }
  const fixture = { company, agent, issue, comments: comments.map(({ id, body }) => ({ id: id!, body })) };
  await fs.mkdir("test-results/agent-chat", { recursive: true });
  await fs.writeFile(file, JSON.stringify(fixture));
  return fixture;
}
