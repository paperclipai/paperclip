import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, assets, companies, createDb, heartbeatRuns, issueAttachments, issues, runnerApiResponseReservations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import type { StorageService } from "../../storage/types.js";
import { TaskAttachmentReadCache } from "./runner-task-attachments.js";
import { runnerApiCatalog } from "./runner-api-catalog.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
describe("Dot assigned-task attachment reading", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("dot-task-files-"); db = createDb(temporary.connectionString); });
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  async function fixture(body = Buffer.from("only in the file 🌍"), enabled = true) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Files", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dot", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "openai_dot", dotAttachmentAccess: enabled, dotWorkspaceAccess: false } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Inspect file", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const [asset] = await db.insert(assets).values({ companyId, provider: "local_disk", objectKey: `${companyId}/private-file`, originalFilename: "proof.txt", contentType: "text/plain", byteSize: body.length, sha256: sha(body) }).returning();
    const [attachment] = await db.insert(issueAttachments).values({ companyId, issueId, assetId: asset!.id }).returning();
    const getObject = vi.fn().mockImplementation(async () => ({ stream: Readable.from([body]) }));
    const storage = { provider: "local_disk", getObject } as unknown as StorageService;
    const assertBridgeAuthority = vi.fn().mockResolvedValue(undefined);
    const binding = { companyId, agentId, issueId, runId, dotRuntime: true, taskAttachmentRead: enabled, storage, assertBridgeAuthority };
    const authority = new PaperclipRunnerToolAuthority(db, binding);
    const call = (tool: string, args: unknown = {}) => authority.execute({ tool, callId: randomUUID(), arguments: args });
    return { ...binding, authority, call, asset: asset!, attachment: attachment!, body, getObject };
  }
  it("keeps the grant off by default and independent of workspace commands", async () => {
    const f = await fixture();
    expect(f.authority.definitions().map(t => t.name)).toContain("read_task_attachment");
    expect(f.authority.definitions().map(t => t.name)).not.toContain("workspace_run");
    const off = await fixture(Buffer.from("disabled"), false);
    expect(off.authority.definitions().map(t => t.name)).not.toContain("read_task_attachment");
    await expect(off.call("read_task_attachment", { attachmentId: off.attachment.id })).rejects.toThrow("not enabled");
    expect(off.getObject).not.toHaveBeenCalled();
  });
  it("reads verified file contents without paths or storage keys and audits metadata only", async () => {
    const f = await fixture();
    expect(await f.call("list_task_attachments")).toMatchObject({ attachments: [{ attachmentId: f.attachment.id, filename: "proof.txt", readable: true }] });
    const result = await f.call("read_task_attachment", { attachmentId: f.attachment.id });
    expect(result).toMatchObject({ content: f.body.toString(), sha256: sha(f.body), byteSize: f.body.length, nextOffset: null, contentTrust: "untrusted_attachment" });
    expect(JSON.stringify(result)).not.toContain("private-file");
    expect(f.getObject).toHaveBeenCalledWith(f.companyId, f.asset.objectKey);
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "dot.attachment_read", runId: f.runId });
    expect(JSON.stringify(logs)).not.toContain(f.body.toString());
  });
  it("rejects another task, another company, and caller-supplied scope", async () => {
    const f = await fixture(), foreign = await fixture();
    expect(await f.call("read_task_attachment", { attachmentId: foreign.attachment.id })).toMatchObject({ outcome: "failed", code: "runner_attachment_not_found" });
    const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other", status: "todo", assigneeAgentId: f.agentId }).returning();
    await db.update(issueAttachments).set({ issueId: other!.id }).where(eq(issueAttachments.id, f.attachment.id));
    expect(await f.call("list_task_attachments")).toMatchObject({ attachments: [] });
    expect(await f.call("read_task_attachment", { attachmentId: f.attachment.id })).toMatchObject({ outcome: "failed", code: "runner_attachment_not_found" });
    expect(await f.call("read_task_attachment", { attachmentId: foreign.attachment.id, taskId: foreign.issueId })).toMatchObject({ outcome: "failed", code: "runner_attachment_invalid_arguments" });
    expect(f.getObject).not.toHaveBeenCalled();
  });
  it.each(["disabled", "reassigned", "cancelled", "connection_revoked"])("fences a read when %s during storage acquisition", async reason => {
    const f = await fixture();
    f.getObject.mockImplementationOnce(async () => {
      if (reason === "disabled") await db.update(agents).set({ adapterConfig: { provider: "openai_dot", dotAttachmentAccess: false } }).where(eq(agents.id, f.agentId));
      if (reason === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      if (reason === "cancelled") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
      if (reason === "connection_revoked") f.assertBridgeAuthority.mockRejectedValue(new Error("revoked"));
      return { stream: Readable.from([f.body]) };
    });
    expect(await f.call("read_task_attachment", { attachmentId: f.attachment.id })).toMatchObject({ outcome: "failed" });
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
  });
  it.each(["corrupt", "oversized", "deleted", "changed", "storage_error"])("settles %s input without sending bytes", async reason => {
    const f = await fixture();
    if (reason === "oversized") await db.update(assets).set({ byteSize: 16 * 1024 * 1024 + 1 }).where(eq(assets.id, f.asset.id));
    else f.getObject.mockImplementationOnce(async () => {
      if (reason === "deleted") await db.delete(issueAttachments).where(eq(issueAttachments.id, f.attachment.id));
      if (reason === "changed") await db.update(assets).set({ objectKey: `${f.companyId}/changed` }).where(eq(assets.id, f.asset.id));
      if (reason === "storage_error") throw new Error("PRIVATE STORAGE SECRET");
      return { stream: Readable.from([reason === "corrupt" ? Buffer.alloc(f.body.length) : f.body]) };
    });
    const result = await f.call("read_task_attachment", { attachmentId: f.attachment.id });
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result).not.toHaveProperty("content");
    expect(JSON.stringify(result)).not.toContain("PRIVATE STORAGE SECRET");
    if (reason === "oversized") expect(f.getObject).not.toHaveBeenCalled();
  });
  it("paginates UTF-8 across an emoji boundary using byte offsets and a stable hash", async () => {
    const f = await fixture(Buffer.from("x".repeat(11999) + "🌍tail"));
    const first = await f.call("read_task_attachment", { attachmentId: f.attachment.id }) as any;
    expect(first).toMatchObject({ returnedBytes: 11999, nextOffset: 11999, content: "x".repeat(11999) });
    const second = await f.call("read_task_attachment", { attachmentId: f.attachment.id, offset: first.nextOffset, expectedSha256: first.sha256 });
    expect(second).toMatchObject({ content: "🌍tail", nextOffset: null, returnedBytes: 8 });
    expect(f.getObject).toHaveBeenCalledTimes(1);
    expect(await f.call("read_task_attachment", { attachmentId: f.attachment.id, offset: 12000 })).toMatchObject({ outcome: "failed", code: "runner_attachment_offset_invalid" });
    expect(await f.call("read_task_attachment", { attachmentId: f.attachment.id, expectedSha256: "0".repeat(64) })).toMatchObject({ outcome: "failed", code: "runner_attachment_changed" });
  });
  it("clears cached bytes on closure and checks deleted attachment links on cached pages", async () => {
    const f = await fixture();
    await f.call("read_task_attachment", { attachmentId: f.attachment.id });
    await db.delete(issueAttachments).where(eq(issueAttachments.id, f.attachment.id));
    expect(await f.call("read_task_attachment", { attachmentId: f.attachment.id })).toMatchObject({ code: "runner_attachment_not_found" });
    expect(f.getObject).toHaveBeenCalledTimes(1);
    const closed = await fixture();
    await closed.call("read_task_attachment", { attachmentId: closed.attachment.id });
    closed.authority.close();
    expect(await closed.call("read_task_attachment", { attachmentId: closed.attachment.id })).toMatchObject({ code: "runner_attachment_scope_closed" });
    expect(closed.getObject).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("prevents generic API attachment and workspace downloads with attachment grant %s", async enabled => {
    const f = await fixture(Buffer.from("private input"), enabled);
    for (const [path, pathParams] of [
      ["/api/attachments/{attachmentId}/content", { attachmentId: f.attachment.id }],
      ["/api/assets/{assetId}/content", { assetId: f.asset.id }],
      ["/api/issues/{issueId}/file-resources/content", { issueId: f.issueId }],
    ] as const) {
      const operation = runnerApiCatalog().find(o => o.method === "GET" && o.path === path)!;
      await expect(f.call("call_api", { operationId: operation.operationId, pathParams })).rejects.toThrow(/Dot must use|Dot may read/);
    }
    const upload = runnerApiCatalog().find(o => o.method === "POST" && o.path === "/api/companies/{companyId}/issues/{issueId}/attachments")!;
    await expect(f.call("call_api", { operationId: upload.operationId, pathParams: { companyId: f.companyId, issueId: f.issueId }, contentType: "multipart/form-data", files: [{ path: "private.txt" }] })).rejects.toThrow("workspace access");
    await expect(f.call("call_api", { operationId: upload.operationId, pathParams: { companyId: f.companyId, issueId: f.issueId }, contentType: "multipart/form-data", files: [{ artifactId: f.asset.id }] })).rejects.toThrow("this run only");
    expect(f.getObject).not.toHaveBeenCalled();
  });
  it("retains pagination of this run's API captures while rejecting another run's capture", async () => {
    const f = await fixture(Buffer.from("captured")), other = await fixture();
    await db.insert(runnerApiResponseReservations).values([
      { companyId: f.companyId, runId: f.runId, assetId: f.asset.id, reservedBytes: f.body.length },
      { companyId: other.companyId, runId: other.runId, assetId: other.asset.id, reservedBytes: other.body.length },
    ]);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-test-key-not-a-live-credential");
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:3217");
    const fetch = vi.fn().mockResolvedValue(new Response(f.body, { status: 206, headers: { "Content-Type": "text/plain", "Content-Range": `bytes 0-${f.body.length - 1}/${f.body.length}` } }));
    vi.stubGlobal("fetch", fetch);
    const operation = runnerApiCatalog().find(o => o.method === "GET" && o.path === "/api/assets/{assetId}/content")!;
    expect(await f.call("call_api", { operationId: operation.operationId, pathParams: { assetId: f.asset.id } })).toMatchObject({ ok: true, data: "captured" });
    await expect(f.call("call_api", { operationId: operation.operationId, pathParams: { assetId: other.asset.id } })).rejects.toThrow("this run only");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("deduplicates concurrent verification and clears a read still pending on closure", async () => {
    const cache = new TaskAttachmentReadCache();
    let resolve!: (body: Buffer) => void;
    const load = vi.fn(() => new Promise<Buffer>(done => { resolve = done; }));
    const first = cache.read("file", "v1", load), second = cache.read("file", "v1", load);
    resolve(Buffer.from("verified"));
    expect((await first).toString()).toBe("verified");
    expect((await second).toString()).toBe("verified");
    expect(load).toHaveBeenCalledTimes(1);
    const pending = cache.read("later", "v1", load);
    cache.close(); resolve(Buffer.from("must not retain"));
    await expect(pending).rejects.toThrow("scope_closed");
    await expect(cache.read("file", "v1", load)).rejects.toThrow("scope_closed");
  });
  it("evicts verified copies when the per-run memory budget is reached", async () => {
    const cache = new TaskAttachmentReadCache(), first = vi.fn(async () => Buffer.alloc(8 * 1024 * 1024));
    await cache.read("first", "v1", first);
    await cache.read("second", "v1", async () => Buffer.alloc(8 * 1024 * 1024));
    await cache.read("third", "v1", async () => Buffer.from("x"));
    await cache.read("first", "v1", first);
    expect(first).toHaveBeenCalledTimes(2);
    cache.close();
  });
  it("reads binary pages explicitly as base64 and supports empty files", async () => {
    const f = await fixture(Buffer.from([0xff, 0x00, 0x81]));
    expect(await f.call("read_task_attachment", { attachmentId: f.attachment.id })).toMatchObject({ outcome: "failed", code: "runner_attachment_use_base64" });
    expect(await f.call("read_task_attachment", { attachmentId: f.attachment.id, encoding: "base64" })).toMatchObject({ content: f.body.toString("base64"), encoding: "base64", nextOffset: null });
    const empty = await fixture(Buffer.alloc(0));
    expect(await empty.call("read_task_attachment", { attachmentId: empty.attachment.id })).toMatchObject({ content: "", byteSize: 0, nextOffset: null });
  });
});
