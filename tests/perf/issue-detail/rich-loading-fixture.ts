import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { eq } from "../../../server/node_modules/drizzle-orm/index.js";

export interface RichLoadingFixture {
  companyId: string;
  prefix: string;
  id: string;
  identifier: string;
  title: string;
  lastCommentId: string;
  interactionId: string;
}

const fixturePath = path.resolve("test-results/rich-loading-fixture.json");

export async function richLoadingFixture(request: APIRequestContext): Promise<RichLoadingFixture> {
  const databaseUrl = process.env.PAPERCLIP_ISSUE_PERF_DATABASE_URL;
  if (!databaseUrl) throw new Error("The rich loading fixture requires a disposable PostgreSQL database");
  const target = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !target.pathname.endsWith("_test")) {
    throw new Error("Use a disposable loopback database ending in _test");
  }
  const saved = await fs.readFile(fixturePath, "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (saved) {
    const response = await request.get(`/api/issues/${saved.id}`);
    if (response.ok()) {
      const issue = await response.json();
      expect(issue.companyId).toBe(saved.companyId);
      const agentResponse = await request.get(`/api/agents/${issue.assigneeAgentId}`);
      expect(agentResponse.ok(), await agentResponse.text()).toBeTruthy();
      const agent = await agentResponse.json();
      const heartbeat = agent.runtimeConfig?.heartbeat ?? {};
      if (heartbeat.enabled !== false || heartbeat.wakeOnDemand !== false) {
        const update = await request.patch(`/api/agents/${agent.id}`, { data: {
          runtimeConfig: { ...agent.runtimeConfig, heartbeat: { ...heartbeat, enabled: false, wakeOnDemand: false } },
        } });
        expect(update.ok(), await update.text()).toBeTruthy();
      }
      return saved;
    }
    expect(response.status(), await response.text()).toBe(404);
  }
  const create = async (url: string, data: unknown) => {
    const response = await request.post(url, { data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const company = await create("/api/companies", { name: "FrameLab" });
  const agent = await create(`/api/companies/${company.id}/agents`, {
    name: "Investigation author", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: {},
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  });
  const project = await create(`/api/companies/${company.id}/projects`, { name: "Loading verification" });
  const title = "[Investigation] Failed query selecting a saved task record from a long-running workspace investigation after restoring the archived state (workspace-investigation.ts)";
  const issue = await create(`/api/companies/${company.id}/issues`, {
    title, status: "backlog", projectId: project.id,
    description: "## Investigate the saved workspace\n\n" +
      "Keep the current task, its saved findings, and the requested review together. ".repeat(12) +
      "\n\n- Inspect the original report.\n- Check the saved evidence.\n- Retain the complete conversation for the reviewer.\n\n" +
      "The investigation contains a long thread, rich document cards, a scheduled monitor, and a pending decision.",
  });
  for (const [key, label] of [["plan", "Investigation plan"], ["analysis", "Saved analysis"], ["verification", "Verification results"]]) {
    const response = await request.put(`/api/issues/${issue.id}/documents/${key}`, { data: {
      title: label, format: "markdown", body: `# ${label}\n\n${"Preserve the saved investigation and verify the expected behavior. ".repeat(20)}`,
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await create(`/api/issues/${issue.id}/work-products`, {
    type: "pull_request", provider: "github", title: "Saved investigation patch", status: "active",
    url: "https://github.com/example/layout-fixture/pull/42", metadata: { repository: "example/layout-fixture", number: 42 },
  });
  const interaction = await create(`/api/issues/${issue.id}/interactions`, {
    kind: "request_confirmation", title: "Approve the investigation patch", continuationPolicy: "none",
    payload: { version: 1, prompt: "Review the saved investigation and approve the proposed patch?", acceptLabel: "Approve patch", rejectLabel: "Request changes", detailsMarkdown: "The saved plan and verification results are available in this task." },
  });
  const { createDb, closeRegisteredClients, issues, issueComments } = await import("../../../packages/db/src/index");
  const db = createDb(databaseUrl);
  const base = Date.now() - 30 * 24 * 3600_000;
  const comments = Array.from({ length: 200 }, (_, index) => ({
    id: randomUUID(), companyId: company.id, issueId: issue.id, authorType: "agent", authorAgentId: agent.id,
    body: `## ${index === 199 ? "Latest investigation findings" : `Investigation update ${index}`}\n\n` +
      "Verified the saved workspace, inspected the reported behavior, and checked that the evidence still matches the current revision. ".repeat(index === 199 ? 12 : 5) +
      (index === 199 ? "\n\n[Read the saved analysis](#document-analysis) and [verification results](#document-verification).\n\n| Check | Result |\n|---|---|\n| Saved evidence | Complete |\n| Review | Waiting for your decision |" : ""),
    createdAt: new Date(base + index * 60_000), updatedAt: new Date(base + index * 60_000),
  }));
  const nextCheckAt = new Date(Date.now() + 2 * 24 * 3600_000);
  try {
    await db.insert(issueComments).values(comments);
    await db.update(issues).set({
      assigneeAgentId: agent.id, status: "in_review", monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount: 12, monitorNotes: "Watching the investigation patch", monitorScheduledBy: "assignee",
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: {
        nextCheckAt: nextCheckAt.toISOString(), serviceName: "Review", externalRef: "Investigation patch", scheduledBy: "assignee",
      } },
    }).where(eq(issues.id, issue.id));
  } finally { await closeRegisteredClients(databaseUrl); }
  const fixture = { companyId: company.id, prefix: company.issuePrefix, id: issue.id, identifier: issue.identifier, title, lastCommentId: comments.at(-1)!.id, interactionId: interaction.id };
  await fs.mkdir(path.dirname(fixturePath), { recursive: true });
  await fs.writeFile(fixturePath, JSON.stringify(fixture, null, 2));
  return fixture;
}
