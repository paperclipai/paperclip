import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, externalObjectMentions, heartbeatRuns, issues } from "@paperclipai/db";
import { createChildIssueSchema, createIssueSchema, setIssueTitleSchema } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { issueService } from "../services/issues.js";
import { externalObjectService } from "../services/external-objects.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("task titles", () => {
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
  const token = (f: Fixture) => createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
  const request = (f: Fixture, path: string, method: string, body: unknown) => fetch(`${server.apiUrl}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token(f)}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const rename = (f: Fixture, input: Record<string, unknown> = {}) => f.authority.execute({
    tool: "set_task_title", callId: randomUUID(),
    arguments: { idempotencyKey: "initial-title", title: "Fix sign-in redirect", onlyIfProvisional: true, ...input },
  });
  async function provisional(f: Fixture) {
    await server.db.update(issues).set({ title: "Please investigate", description: "Please investigate the sign-in redirect", titleNeedsGeneration: true }).where(eq(issues.id, f.issueId));
  }

  it("creates a provisional title from the prompt through the API and preserves the full description", async () => {
    const f = await server.fixture();
    const description = "  Investigate\n the sign-in redirect. " + "Keep this detail. ".repeat(20);
    const response = await request(f, `/companies/${f.companyId}/issues`, "POST", { description, status: "backlog" });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    expect(result).toMatchObject({ title: description.trim().replace(/\s+/g, " ").slice(0, 120), description, titleNeedsGeneration: true });
    expect(await issueService(server.db).create(f.companyId, { title: "Chosen title", description })).toMatchObject({ title: "Chosen title", titleNeedsGeneration: false });
    expect(createIssueSchema.safeParse({ title: "  ", description: "\n " }).success).toBe(false);
    expect(createIssueSchema.safeParse({ description: "A request" }).success).toBe(true);
    expect(setIssueTitleSchema.safeParse({ title: "  " }).success).toBe(false);
    expect(setIssueTitleSchema.safeParse({ title: "x".repeat(241) }).success).toBe(false);
  });

  it("removes leading Markdown before truncating a provisional title", async () => {
    const f = await server.fixture();
    const description = [
      "![Screenshot](https://example.com/a-very-long-image-name.png)",
      "# Fix the [sign-in redirect](https://example.com/issues/42)",
      "Keep `returnTo` working with **saved sessions**.",
    ].join("\n\n");
    const result = await issueService(server.db).create(f.companyId, { description });
    expect(result).toMatchObject({
      title: "Fix the sign-in redirect Keep returnTo working with saved sessions.",
      description,
      titleNeedsGeneration: true,
    });
    await expect(issueService(server.db).create(f.companyId, {
      description: "![Error dialog](https://example.com/error.png)",
    })).resolves.toMatchObject({ title: "Error dialog", titleNeedsGeneration: true });
    await expect(issueService(server.db).create(f.companyId, {
      description: "![](https://example.com/image.png)",
    })).resolves.toMatchObject({ title: "Image", titleNeedsGeneration: true });
    await expect(issueService(server.db).create(f.companyId, {
      description: "![Map](https://example.com/Map_(1).png)",
    })).resolves.toMatchObject({ title: "Map", titleNeedsGeneration: true });
    await expect(issueService(server.db).create(f.companyId, {
      description: "Fix `set_task_title`",
    })).resolves.toMatchObject({ title: "Fix set_task_title", titleNeedsGeneration: true });
    await expect(issueService(server.db).create(f.companyId, {
      description: "![Screenshot][img]\n\n[img]: https://example.com/image.png\n\nFix login",
    })).resolves.toMatchObject({ title: "Fix login", titleNeedsGeneration: true });
  });

  it("creates prompt-only children and still accepts explicit child titles", async () => {
    const f = await server.fixture();
    const description = "Investigate the child sign-in redirect";
    const response = await request(f, `/issues/${f.issueId}/children`, "POST", { description, status: "backlog" });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    expect(result).toMatchObject({ parentId: f.issueId, title: description, description, titleNeedsGeneration: true });
    const explicit = await request(f, `/issues/${f.issueId}/children`, "POST", { title: "Chosen child title", description, status: "backlog" });
    expect(explicit.status).toBe(201);
    expect(await explicit.json()).toMatchObject({ title: "Chosen child title", titleNeedsGeneration: false });
    expect(createChildIssueSchema.safeParse({ title: "  ", description: "\n " }).success).toBe(false);
  });

  it("bounds title receipts without evicting replay protection across native and HTTP calls", async () => {
    const f = await server.fixture();
    const input = { title: "Original agent title", onlyIfProvisional: false, idempotencyKey: "original" };
    const original = await rename(f, input);
    await issueService(server.db).update(f.issueId, { title: "Later user title" });
    for (let i = 1; i < 64; i++) {
      await rename(f, { idempotencyKey: `bounded-${i}` });
    }
    await expect(rename(f, { idempotencyKey: "overflow" })).rejects.toThrow(/limit/);
    const overflow = await request(f, `/issues/${f.issueId}/title`, "PUT", { ...input, idempotencyKey: "overflow" });
    expect(overflow.status).toBe(409);
    expect(await rename(f, input)).toEqual(original);
    const replay = await request(f, `/issues/${f.issueId}/title`, "PUT", input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(original);
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(Object.keys(run.resultJson?.taskTitleReceipts ?? {})).toHaveLength(64);
    expect(await issueService(server.db).getById(f.issueId)).toMatchObject({ title: "Later user title" });
  });

  it("keeps distinct prompts with the same prefix and replays creation keys after naming", async () => {
    const f = await server.fixture();
    const prefix = "Please investigate ".repeat(10);
    const svc = issueService(server.db);
    const first = await svc.create(f.companyId, { description: prefix + "the login flow", allowDuplicate: false, idempotencyKey: "prompt-request" });
    const second = await svc.create(f.companyId, { description: prefix + "the signup flow", allowDuplicate: false });
    expect(first.title).toBe(second.title);
    expect(first.id).not.toBe(second.id);
    await svc.update(first.id, { title: "Fix login" });
    expect((await svc.create(f.companyId, { description: prefix + "the login flow", idempotencyKey: "prompt-request" })).id).toBe(first.id);
  });

  it.each(["standard", "ask", "planning"] as const)("names the active task once in %s mode without changing execution", async mode => {
    const f = await server.fixture({ mode });
    await provisional(f);
    expect(f.authority.definitions().some(tool => tool.name === "set_task_title")).toBe(true);
    expect(projectToolDefinitions(mode, true).some(tool => tool.name === "set_task_title")).toBe(true);
    const [before] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    const first = await rename(f);
    expect(first).toMatchObject({ id: f.issueId, title: "Fix sign-in redirect", titleNeedsGeneration: false, changed: true });
    expect(await rename(f)).toEqual(first);
    const [after] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(after).toMatchObject({ status: before.status, statusVersion: before.statusVersion, workMode: mode, executionRunId: before.executionRunId, assigneeAgentId: before.assigneeAgentId, description: before.description });
    const audit = await server.db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, "issue.updated")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ runId: f.runId, actorId: f.agentId, details: { title: "Fix sign-in redirect", previous: { title: "Please investigate" } } });
    await expect(rename(f, { title: "Conflicting retry" })).rejects.toThrow(/idempotency/);
  });

  it("preserves a user edit and supports intentional renaming through the shared MCP/API path", async () => {
    const f = await server.fixture({ mode: "ask" });
    await provisional(f);
    await issueService(server.db).update(f.issueId, { title: "My chosen title" });
    expect(await rename(f)).toMatchObject({ title: "My chosen title", changed: false });
    const result = await callProjectTool({ name: "set_task_title", arguments: { title: "Intentional new title", onlyIfProvisional: false, idempotencyKey: "rename" }, apiUrl: server.apiUrl, token: token(f), companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, conversation: false });
    expect(result).toMatchObject({ title: "Intentional new title", changed: true });
    const retry = await request(f, `/issues/${f.issueId}/title`, "PUT", { title: "Intentional new title" });
    expect(await retry.json()).toMatchObject({ changed: false });
    await issueService(server.db).update(f.issueId, { title: "User edit after the response" });
    const replay = await request(f, `/issues/${f.issueId}/title`, "PUT", { title: "Intentional new title", onlyIfProvisional: false, idempotencyKey: "rename" });
    expect(await replay.json()).toEqual(result);
    expect(await issueService(server.db).getById(f.issueId)).toMatchObject({ title: "User edit after the response" });
    expect((await request(f, `/issues/${f.issueId}/title`, "PUT", { title: "Conflicting retry", idempotencyKey: "rename" })).status).toBe(409);
  });

  it("fences simultaneous initial titles and later retries", async () => {
    const f = await server.fixture();
    await provisional(f);
    const results = await Promise.all([
      rename(f, { idempotencyKey: "a", title: "First title" }),
      rename(f, { idempotencyKey: "b", title: "Second title" }),
    ]) as Array<{ changed: boolean; title: string }>;
    expect(results.filter(result => result.changed)).toHaveLength(1);
    expect(new Set(results.map(result => result.title)).size).toBe(1);
  });

  it.each(["native", "http"] as const)("shares %s title receipts with the other surface without overwriting later user edits", async firstSurface => {
    const f = await server.fixture();
    const input = { title: "Intentional rename", onlyIfProvisional: false, idempotencyKey: "shared-title-retry" };
    const httpRename = async () => {
      const response = await request(f, `/issues/${f.issueId}/title`, "PUT", input);
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = await (firstSurface === "native" ? rename(f, input) : httpRename());
    await issueService(server.db).update(f.issueId, { title: "Keep this user edit" });
    expect(await (firstSurface === "native" ? httpRename() : rename(f, input))).toEqual(first);
    expect(await issueService(server.db).getById(f.issueId)).toMatchObject({ title: "Keep this user edit" });
    expect((await request(f, `/issues/${f.issueId}/title`, "PUT", { ...input, title: "Conflicting retry" })).status).toBe(409);
    await expect(rename(f, { ...input, title: "Conflicting retry" })).rejects.toThrow(/idempotency/);
  });

  it("refreshes external title links through native and REST renames while preserving description links", async () => {
    const f = await server.fixture();
    await instanceSettingsService(server.db).updateExperimental({ enableExternalObjects: true });
    try {
      await server.db.update(issues).set({
        title: "Review https://github.com/acme/app/pull/42",
        titleNeedsGeneration: true,
        description: "Keep https://github.com/acme/app/issues/7",
      }).where(eq(issues.id, f.issueId));
      await externalObjectService(server.db).syncIssue(f.issueId);
      const mentions = () => server.db.select().from(externalObjectMentions).where(eq(externalObjectMentions.sourceIssueId, f.issueId));
      expect(await mentions()).toHaveLength(2);
      await rename(f);
      expect(await mentions()).toMatchObject([{ sourceKind: "description", sanitizedDisplayUrl: "https://github.com/acme/app/issues/7" }]);
      const response = await request(f, `/issues/${f.issueId}/title`, "PUT", { title: "Review https://github.com/acme/app/pull/43" });
      expect(response.status).toBe(200);
      expect(await mentions()).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceKind: "title", sanitizedDisplayUrl: "https://github.com/acme/app/pull/43" }),
        expect.objectContaining({ sourceKind: "description", sanitizedDisplayUrl: "https://github.com/acme/app/issues/7" }),
      ]));
      expect(await mentions()).toHaveLength(2);
    } finally {
      await instanceSettingsService(server.db).updateExperimental({ enableExternalObjects: false });
    }
  });

  it("rejects unrelated tasks, stale runs, and malformed title mutations", async () => {
    const f = await server.fixture();
    await provisional(f);
    const other = await issueService(server.db).create(f.companyId, { title: "Unrelated task" });
    expect((await request(f, `/issues/${other.id}/title`, "PUT", { title: "Wrong" })).status).toBe(403);
    const foreign = await issueService(server.db).create(f.foreignCompanyId, { title: "Foreign task" });
    expect([403, 404]).toContain((await request(f, `/issues/${foreign.id}/title`, "PUT", { title: "Wrong" })).status);
    expect((await request(f, `/issues/${f.issueId}/title`, "PUT", { title: "Wrong", status: "done" })).status).toBe(400);
    await expect(rename(f, { title: "  " })).rejects.toThrow();
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(rename(f)).rejects.toThrow(/authorized/);
    expect((await request(f, `/issues/${f.issueId}/title`, "PUT", { title: "Stale" })).status).toBe(403);
    expect(await issueService(server.db).getById(f.issueId)).toMatchObject({ title: "Please investigate", titleNeedsGeneration: true });
  });
});
