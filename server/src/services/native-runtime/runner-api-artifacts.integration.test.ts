import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { assets, runnerApiResponseReservations } from "@paperclipai/db";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("authorized read artifacts through real routes and storage", () => {
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

  it.each([200, 204])("returns an explicit empty HTTP %s receipt without storage or quota reservations", async status => {
    const fixture = await server.fixture();
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...fixture, storage: server.storage, workspaceRoot: fixture.workspace });
    const before = await server.db.select().from(assets).where(eq(assets.companyId, fixture.companyId));
    // Inject only the upstream empty response; storage and reservation writes
    // remain real so production's empty-file rejection cannot be hidden.
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    try {
      const receipt = await authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
        operationId: "GET /api/issues/{id}", pathParams: { id: fixture.issueId }, saveResponse: true,
      } });
      expect(receipt).toMatchObject({ ok: true, status, empty: true, byteSize: 0, data: null });
      expect(receipt).not.toHaveProperty("artifact");
    } finally { spy.mockRestore(); }
    expect(await server.db.select().from(assets).where(eq(assets.companyId, fixture.companyId))).toEqual(before);
    expect(await server.db.select().from(runnerApiResponseReservations).where(eq(runnerApiResponseReservations.companyId, fixture.companyId))).toEqual([]);
  });

  it("preserves exact HTTP bytes in the immutable asset and downloaded helper input", async () => {
    const fixture = await server.fixture();
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...fixture, workspaceRoot: fixture.workspace });
    const execute = (tool: string, args: object) => authority.execute({ tool, callId: randomUUID(), arguments: args }) as Promise<any>;
    const body = '# Evidence\n\né🧭 "quoted" \\escaped\n```json\n{"empty":[]}\n```';
    await execute("call_api", { operationId: "PUT /api/issues/{id}/documents/{key}", pathParams: { id: fixture.issueId, key: "evidence" }, body: { title: "Evidence", format: "markdown", body, baseRevisionId: null } });
    const originalFetch = globalThis.fetch;
    let source: Buffer | undefined;
    let requests = 0;
    // Observe real authorized HTTP bytes without replacing the server or storage.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await originalFetch(...args);
      requests++;
      source = Buffer.from(await response.clone().arrayBuffer());
      return response;
    });
    let receipt: any;
    try {
      receipt = await execute("save_api_response", { operationId: "GET /api/issues/{id}/documents/{key}", pathParams: { id: fixture.issueId, key: "evidence" } });
    } finally { spy.mockRestore(); }
    expect(requests).toBe(1);
    expect(receipt).toMatchObject({ ok: true, artifact: { byteSize: source!.length, sha256: createHash("sha256").update(source!).digest("hex") } });
    expect(receipt).not.toHaveProperty("data");
    expect(receipt).not.toHaveProperty("preview");
    const [asset] = await server.db.select().from(assets).where(eq(assets.id, receipt.artifact.artifactId));
    const stored = await server.storage.getObject(fixture.companyId, asset.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stored.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(source);
    await execute("download_artifact", { artifactId: receipt.artifact.artifactId, byteSize: receipt.artifact.byteSize, sha256: receipt.artifact.sha256, destination: "helper-response.json" });
    const downloaded = await readFile(join(fixture.workspace, "helper-response.json"));
    expect(downloaded).toEqual(source);
    expect(JSON.parse(downloaded.toString()).body).toBe(body);

    for (const args of [
      { ...receipt.artifact, sha256: "0".repeat(64), destination: "forged.json" },
      { ...receipt.artifact, destination: "../escape.json" },
    ]) {
      const { url, contentType, ...input } = args;
      await expect(execute("download_artifact", input)).rejects.toThrow();
    }
    const foreign = await server.fixture();
    const denied = await execute("save_api_response", { operationId: "GET /api/issues/{id}", pathParams: { id: foreign.issueId } });
    expect(denied.ok).toBe(false);
    expect(denied).not.toHaveProperty("artifact");
    // The save tool is read-only: a write operation or a body never reaches the API.
    for (const args of [
      { operationId: "PUT /api/issues/{id}/documents/{key}", pathParams: { id: fixture.issueId, key: "evidence" } },
      { operationId: "GET /api/issues/{id}", pathParams: { id: fixture.issueId }, body: { title: "x" } },
    ]) expect(await execute("save_api_response", args)).toMatchObject({ outcome: "failed", code: "runner_bridge_invalid_arguments" });
  });
});
