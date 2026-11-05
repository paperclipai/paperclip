import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issueAccessGrants, issueComments, issues, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { canPublishIssueToChatAudience } from "../services/authorization.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { taskForbidsProviderOutput } from "../services/task-provider-output-policy.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("imported attachment authenticated agent reads and bound-run copies", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
  });

  async function fixture(restricted = true) {
    const f = await server.fixture({ connectionScenario: "fresh", disableWakeOnDemand: true });
    const body = Buffer.from("Synthetic restricted native input");
    const stored = await server.storage.putFile({ companyId: f.companyId, namespace: `issues/${f.issueId}`,
      originalFilename: "synthetic.txt", contentType: "text/plain", body });
    const input = { companyId: f.companyId, issueId: f.issueId,
      issueCommentId: null, ...stored, createdByAgentId: null, createdByUserId: null };
    if (restricted) await issueService(server.db).addImportedAttachments([input]);
    else await issueService(server.db).createAttachment(input);
    const [attachment] = await issueService(server.db).listAttachments(f.issueId);
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId);
    return { ...f, body, attachment, token };
  }

  function read(path: string, token: string, range?: string) {
    return fetch(`${server.apiUrl}/api${path}`, { headers: {
      authorization: `Bearer ${token}`, ...(range ? { range } : {}),
    } });
  }

  it.each(["attachment", "asset"] as const)("allows an authorized standard agent's %s read without granting output", async route => {
    const f = await fixture();
    const path = route === "attachment" ? `/attachments/${f.attachment.id}/content` : `/assets/${f.attachment.assetId}/content`;
    const response = await read(path, f.token!);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.body);
    expect(await taskForbidsProviderOutput(server.db, { companyId: f.companyId, issueId: f.issueId })).toBe(true);
  });

  it.each(["attachment", "asset"] as const)("denies a foreign-company agent's %s read before storage", async route => {
    const f = await fixture(), foreign = await server.fixture({ disableWakeOnDemand: true });
    const token = createLocalAgentJwt(foreign.agentId, foreign.companyId, "paperclip_runner", foreign.runId);
    const storageRead = vi.spyOn(server.storage, "getObject");
    try {
      const path = route === "attachment" ? `/attachments/${f.attachment.id}/content` : `/assets/${f.attachment.assetId}/content`;
      const response = await read(path, token!);
      expect([403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(f.body.toString());
      expect(storageRead).not.toHaveBeenCalled();
    } finally { storageRead.mockRestore(); }
  });

  it.each(["attachment", "asset"] as const)("rechecks the responsible user's private grant for %s byte ranges", async route => {
    const f = await fixture();
    await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issueId));
    const [grant] = await server.db.insert(issueAccessGrants).values({ issueId: f.issueId,
      subjectType: "user", subjectId: f.responsibleUserId!, source: "explicit" }).returning();
    const path = route === "attachment" ? `/attachments/${f.attachment.id}/content` : `/assets/${f.attachment.assetId}/content`;
    const allowed = await read(path, f.token!, "bytes=0-8");
    expect(allowed.status).toBe(206);
    expect(Buffer.from(await allowed.arrayBuffer())).toEqual(f.body.subarray(0, 9));
    await server.db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
    const storageRead = vi.spyOn(server.storage, "getObject");
    try {
      const denied = await read(path, f.token!, "bytes=0-8");
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain(f.body.toString());
      expect(storageRead).not.toHaveBeenCalled();
    } finally { storageRead.mockRestore(); }
  });

  it.each(["paused_agent", "cancelled_run"] as const)("rejects %s at the native authority before reading bytes", async variant => {
    const f = await fixture();
    if (variant === "paused_agent") await server.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    else await server.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    const storageRead = vi.spyOn(server.storage, "getObject");
    try {
      await expect(f.authority.execute({ tool: "call_api", callId: "read-revoked", arguments: {
        operationId: "GET /api/attachments/{attachmentId}/content", pathParams: { attachmentId: f.attachment.id },
      } })).rejects.toThrow("binding_not_authorized");
      expect(storageRead).not.toHaveBeenCalled();
    } finally { storageRead.mockRestore(); }
  });

  async function crossTaskReader(f: Awaited<ReturnType<typeof fixture>>) {
    const runId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId,
      agentId: f.agentId, responsibleUserId: f.responsibleUserId, status: "running",
      runtimeMode: "native", nativeIssueId: f.blockerId, invocationSource: "assignment",
      triggerDetail: "system", contextSnapshot: { issueId: f.blockerId } });
    await server.db.update(issues).set({ status: "in_progress", executionRunId: runId })
      .where(eq(issues.id, f.blockerId));
    return new PaperclipRunnerToolAuthority(server.db, { ...f.authority.binding, runId, issueId: f.blockerId });
  }

  it.each(["attachment", "asset"] as const)("preserves ordinary cross-task %s reads", async route => {
    const f = await fixture(false), reader = await crossTaskReader(f);
    const result = await reader.execute({ tool: "call_api", callId: "cross-task-ordinary", arguments: {
      operationId: route === "attachment" ? "GET /api/attachments/{attachmentId}/content" : "GET /api/assets/{assetId}/content",
      pathParams: route === "attachment" ? { attachmentId: f.attachment.id } : { assetId: f.attachment.assetId },
    } });
    expect(result).toMatchObject({ ok: true, status: route === "asset" ? 206 : 200, data: f.body.toString() });
    expect(await taskForbidsProviderOutput(server.db, { companyId: f.companyId, issueId: f.blockerId })).toBe(false);
  });

  it.each([
    ["attachment", "task"], ["asset", "task"],
    ["attachment", "ancestor"], ["asset", "ancestor"],
    ["attachment", "project"], ["asset", "project"],
  ] as const)("denies cross-task %s bytes behind private %s access before storage", async (route, boundary) => {
    const f = await fixture(), reader = await crossTaskReader(f);
    if (boundary === "task") {
      await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issueId));
    } else if (boundary === "ancestor") {
      const [parent] = await server.db.insert(issues).values({ companyId: f.companyId,
        title: "Private source ancestor", visibility: "private", status: "todo" }).returning();
      await server.db.update(issues).set({ privacyParentIssueId: parent.id }).where(eq(issues.id, f.issueId));
    } else {
      const [project] = await server.db.insert(projects).values({ companyId: f.companyId,
        name: "Private source project", visibility: "private", status: "in_progress" }).returning();
      await server.db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
    }
    const storageRead = vi.spyOn(server.storage, "getObject");
    try {
      const result = await reader.execute({ tool: "call_api", callId: "cross-task-denied", arguments: {
        operationId: route === "attachment" ? "GET /api/attachments/{attachmentId}/content" : "GET /api/assets/{assetId}/content",
        pathParams: route === "attachment" ? { attachmentId: f.attachment.id } : { assetId: f.attachment.assetId },
      } });
      expect(result).toMatchObject({ ok: false, status: 404 });
      expect(JSON.stringify(result)).not.toContain(f.body.toString());
      expect(storageRead).not.toHaveBeenCalled();
      expect(await taskForbidsProviderOutput(server.db, { companyId: f.companyId, issueId: f.issueId })).toBe(true);
      expect(await taskForbidsProviderOutput(server.db, { companyId: f.companyId, issueId: f.blockerId })).toBe(false);
    } finally { storageRead.mockRestore(); }
  });

  it.each([
    ["comment", true], ["document", true], ["task", true],
    ["comment", false], ["document", false], ["task", false],
  ] as const)("retains a bound reader run's %s copy policy (restricted=%s) through native dispatch and restart", async (kind, restricted) => {
    const f = await fixture(restricted);
    const readResult = await f.authority.execute({ tool: "call_api", callId: "read-input", arguments: {
      operationId: "GET /api/attachments/{attachmentId}/content", pathParams: { attachmentId: f.attachment.id },
    } });
    expect(readResult).toMatchObject({ ok: true, status: 200, data: f.body.toString() });
    expect(await taskForbidsProviderOutput(server.db, { companyId: f.companyId, issueId: f.blockerId })).toBe(false);
    const input = kind === "comment"
      ? { operationId: "POST /api/issues/{id}/comments", pathParams: { id: f.blockerId }, body: { body: f.body.toString() } }
      : kind === "document"
        ? { operationId: "PUT /api/issues/{id}/documents/{key}", pathParams: { id: f.blockerId, key: "derived" },
          body: { title: "Derived input", format: "markdown", body: f.body.toString(), baseRevisionId: null } }
        : { operationId: "POST /api/companies/{companyId}/issues", body: { title: "Derived input", description: f.body.toString() } };
    const call = { tool: "call_api", callId: "copy-input", arguments: input };
    const copied = await f.authority.execute(call) as { ok: boolean; status: number; data: { id: string } };
    expect(copied).toMatchObject({ ok: true });
    const destinationId = kind === "task" ? copied.data.id : f.blockerId;
    expect(await taskForbidsProviderOutput(server.db, { companyId: f.companyId, issueId: destinationId })).toBe(restricted);
    const restarted = new PaperclipRunnerToolAuthority(server.db, f.authority.binding);
    expect(await restarted.execute(call)).toEqual(copied);
    if (kind === "comment") {
      const comments = await server.db.select().from(issueComments).where(eq(issueComments.issueId, destinationId));
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ body: f.body.toString(), createdByRunId: f.runId });
    } else if (kind === "document") {
      expect(await documentService(server.db).getIssueDocumentByKey(destinationId, "derived"))
        .toMatchObject({ body: f.body.toString() });
    } else {
      expect(await issueService(server.db).getById(destinationId)).toMatchObject({ description: f.body.toString() });
    }
    // Keep the real audit FK intact; termination is not source-run deletion.
    await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect(await taskForbidsProviderOutput(server.db, { companyId: f.companyId, issueId: destinationId })).toBe(restricted);
    expect(await canPublishIssueToChatAudience(server.db, { companyId: f.companyId, issueId: destinationId,
      endpointId: randomUUID(), conversationId: randomUUID() })).toBe(!restricted);
  });
});
