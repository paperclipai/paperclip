import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agentApiKeys, assets, documents, issueDocuments, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { documentService } from "../documents.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

const operationId = "GET /api/companies/{companyId}/issue-documents";

describe("bulk issue documents through native API tools", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60000);
  afterAll(async () => {
    await server?.close();
    if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
  });

  async function saveCases() {
    const f = await server.fixture();
    const ids = Array.from({ length: 146 }, () => randomUUID());
    await server.db.insert(issues).values(ids.map(id => ({ id, companyId: f.companyId, title: "Sync case", status: "todo" })));
    const rows = await server.db.insert(documents).values(ids.map((id, index) => ({
      companyId: f.companyId, format: "markdown", title: "Case", latestBody: `Case ${index}: é🧭\n\"quoted\" \\escaped`,
    }))).returning();
    await server.db.insert(issueDocuments).values(rows.map((row, index) => ({ companyId: f.companyId, issueId: ids[index], documentId: row.id, key: "sentry-case" })));
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, workspaceRoot: f.workspace });
    const execute = (tool: string, args: object) => authority.execute({ tool, callId: randomUUID(), arguments: args }) as Promise<any>;
    const found = await execute("search_api", { query: "bulk issue documents by key", limit: 10 });
    expect(JSON.stringify(found)).toContain(operationId);
    const saved = await execute("save_api_response", { operationId, pathParams: { companyId: f.companyId }, query: { key: "sentry-case", issueIds: ids.join(",") } });
    expect(saved).toMatchObject({ ok: true, status: 200, artifact: { byteSize: expect.any(Number), sha256: expect.any(String) } });
    const [asset] = await server.db.select().from(assets).where(eq(assets.id, saved.artifact.artifactId));
    const object = await server.storage.getObject(f.companyId, asset.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
    return { f, ids, rows, saved, execute, bytes: Buffer.concat(chunks) };
  }

  it("saves 146 complete documents in one lossless response artifact", async () => {
    const { ids, rows, saved, bytes } = await saveCases();
    expect(bytes.length).toBe(saved.artifact.byteSize);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(saved.artifact.sha256);
    const result = JSON.parse(bytes.toString());
    expect(result.key).toBe("sentry-case");
    expect(result.items.map((item: any) => item.issueId)).toEqual(ids);
    expect(result.items.map((item: any) => item.document.body)).toEqual(rows.map(row => row.latestBody));
    for (const item of result.items) expect(item.document).toMatchObject({ issueId: item.issueId, key: "sentry-case", latestRevisionNumber: expect.any(Number), updatedAt: expect.any(String) });
  });

  it.skipIf(process.platform !== "linux")("downloads all 146 documents in one native transfer with the saved hash and size", async () => {
    const { f, saved, execute, bytes } = await saveCases();
    await execute("download_artifact", { artifactId: saved.artifact.artifactId, byteSize: saved.artifact.byteSize, sha256: saved.artifact.sha256, destination: "cases.json" });
    expect(await readFile(join(f.workspace, "cases.json"))).toEqual(bytes);
  });

  it("returns current revision metadata without bodies and identifies readable tasks with no document", async () => {
    const f = await server.fixture();
    const service = documentService(server.db);
    const first = await service.getIssueDocumentByKey(f.issueId, "notes");
    await service.upsertIssueDocument({ issueId: f.issueId, key: "notes", format: "markdown", body: "Updated content", baseRevisionId: first!.latestRevisionId });
    const current = await service.getIssueDocumentByKey(f.issueId, "notes");
    const receipt = await f.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId, pathParams: { companyId: f.companyId }, query: { key: " NOTES ", issueIds: [f.blockerId, f.issueId, f.issueId].join(","), includeBody: false },
    } }) as any;
    expect(receipt).toMatchObject({ ok: true, data: { key: "notes", items: [
      { issueId: f.blockerId, document: null },
      { issueId: f.issueId, document: { latestRevisionId: current!.latestRevisionId, latestRevisionNumber: 2 } },
    ] } });
    expect(receipt.data.items[1].document).not.toHaveProperty("body");
  });

  it("omits private, hidden, foreign and missing tasks without disclosing which exist", async () => {
    const f = await server.fixture();
    const foreign = await server.fixture();
    const privateId = randomUUID(), hiddenId = randomUUID(), missingId = randomUUID();
    await server.db.insert(issues).values([
      { id: privateId, companyId: f.companyId, title: "Private", visibility: "private", status: "todo" },
      { id: hiddenId, companyId: f.companyId, title: "Hidden", hiddenAt: new Date(), status: "todo" },
    ]);
    for (const id of [privateId, hiddenId]) await documentService(server.db).upsertIssueDocument({ issueId: id, key: "notes", format: "markdown", body: "Never leak" });
    const result = await f.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId, pathParams: { companyId: f.companyId }, query: { key: "notes", issueIds: [f.issueId, privateId, hiddenId, foreign.issueId, missingId].join(",") },
    } }) as any;
    expect(result).toMatchObject({ ok: true, data: { items: [{ issueId: f.issueId, document: { body: "Document verification code: silver-wren." } }] } });
    expect(JSON.stringify(result)).not.toContain("Never leak");
    await expect(f.authority.execute({ tool: "save_api_response", callId: randomUUID(), arguments: {
      operationId, pathParams: { companyId: foreign.companyId }, query: { key: "notes", issueIds: foreign.issueId },
    } })).rejects.toMatchObject({ status: 403 });
    const anonymous = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/issue-documents?key=notes&issueIds=${f.issueId}`);
    expect(anonymous.status).toBe(401);
  });

  it("enforces company boundaries and denies task bridge keys on the HTTP route", async () => {
    const f = await server.fixture({ connectionScenario: "fresh", disableWakeOnDemand: true });
    const token = `pcp_fixture_${randomUUID()}`;
    const [key] = await server.db.insert(agentApiKeys).values({
      companyId: f.companyId, agentId: f.agentId, name: "Batch fixture",
      keyHash: createHash("sha256").update(token).digest("hex"), responsibleUserId: f.responsibleUserId,
    }).returning();
    const get = (companyId: string) => fetch(`${server.apiUrl}/api/companies/${companyId}/issue-documents?key=notes&issueIds=${f.issueId}`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await get(f.companyId)).status).toBe(200);
    expect((await get(f.foreignCompanyId)).status).toBe(403);
    await server.db.update(agentApiKeys).set({ scopeConfig: { kind: "task_bridge", projectId: f.projectId } }).where(eq(agentApiKeys.id, key.id));
    expect((await get(f.companyId)).status).toBe(403);
  });

  it.each([
    {}, { key: "notes" }, { key: "notes", issueIds: "" }, { key: "notes", issueIds: "not-a-uuid" },
    { key: "notes", issueIds: Array.from({ length: 201 }, () => randomUUID()).join(",") },
    { key: "../notes", issueIds: randomUUID() }, { key: "notes", issueIds: randomUUID(), includeBody: "yes" },
    { key: "notes", issueIds: randomUUID(), breakGlass: true },
  ])("rejects invalid or unbounded query %#", async query => {
    const f = await server.fixture();
    const result = await f.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: { operationId, pathParams: { companyId: f.companyId }, query } }) as any;
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects an oversized batch without saving a partial artifact, while metadata remains readable", async () => {
    const f = await server.fixture();
    const document = await documentService(server.db).getIssueDocumentByKey(f.issueId, "notes");
    // Escaping expands these bodies in JSON. The cap must use wire bytes.
    await server.db.update(documents).set({ latestBody: "\"".repeat(4 * 1024 * 1024) }).where(eq(documents.id, document!.id));
    const query = { key: "notes", issueIds: f.issueId };
    const result = await f.authority.execute({ tool: "save_api_response", callId: randomUUID(), arguments: { operationId, pathParams: { companyId: f.companyId }, query } }) as any;
    expect(result).toMatchObject({ ok: false, status: 413 });
    expect(result).not.toHaveProperty("artifact");
    const metadata = await f.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: { operationId, pathParams: { companyId: f.companyId }, query: { ...query, includeBody: false } } }) as any;
    expect(metadata).toMatchObject({ ok: true, data: { items: [{ issueId: f.issueId, document: { latestRevisionId: document!.latestRevisionId } }] } });
    expect(metadata.data.items[0].document).not.toHaveProperty("body");
  });
});
