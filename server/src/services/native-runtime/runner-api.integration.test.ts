import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, writeFile, symlink, mkdir, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { eq } from "drizzle-orm";
import { assets, documents, heartbeatRuns, issues, projects, routineDocuments, routines, runnerApiResponseReservations } from "@paperclipai/db";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { runnerApiCatalog } from "./runner-api-catalog.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { RUNNER_API_RESPONSE_MAX_BYTES, RUNNER_API_RESPONSE_RUN_MAX_BYTES } from "./runner-api-response-limits.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("runner API against real HTTP routes", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_RUNNER_API_TOOLS_ENABLED", undefined);
    vi.stubEnv("PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
  });

  it.skipIf(!process.env.PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION && !existsSync(defaultCapabilityRunnerdBinary())).each(["current", "legacy_http"])("runs runnerd → PRP → authority → actual authenticated HTTP (%s receipt)", async (receiptFormat) => {
    const fixture = await server.fixture();
    const provider = join(server.root, `scripted-api-provider-${receiptFormat}.mjs`);
    await writeFile(provider, `#!${process.execPath}
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let step = 0;
const calls = [{tool:'search_api',arguments:{query:'list projects'}},{tool:'call_api',arguments:{operationId:'GET /api/companies/{companyId}/projects'}},{tool:'call_api',arguments:{operationId:'GET /api/projects/{id}',pathParams:{id:'${fixture.foreignProjectId}'}}}];
const next = () => { const c=calls[step++]; if(c) send({id:'call-'+step,method:'item/tool/call',params:{threadId:'api-thread',turnId:'api-turn',itemId:'api-item-'+step,callId:'api-call-'+step,...c}}); else send({method:'turn/completed',params:{turn:{id:'api-turn',status:'completed'}}}); };
for await (const line of createInterface({input:process.stdin})) {
const m=JSON.parse(line);
if(!m.method) {if(String(m.id).startsWith('call-')) {
  if(step > 1) {
    const envelope=JSON.parse(m.result.contentItems[0].text);
    if(envelope.operationId!=='call_api'||envelope.callId!=='api-call-'+step) throw new Error('API receipt lost semantic call identity');
    const receipt=envelope.result;
    if(step===2 && (receipt.status!==200||receipt.data[0].name!=='Aurora')) throw new Error('Provider did not receive successful HTTP result');
    if(step===3 && (receipt.status!==404||receipt.ok!==false)) throw new Error('Provider did not receive HTTP denial');
  }
  next();
} continue;}
if(m.method==='initialize') send({id:m.id,result:{userAgent:'scripted-api-provider'}});
else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'api-thread',sessionId:'api-session'}}});
else if(m.method==='turn/start') {send({id:m.id,result:{turn:{id:'api-turn',status:'inProgress'}}});send({method:'turn/started',params:{turn:{id:'api-turn'}}});next();}
else if(m.id!==undefined) send({id:m.id,result:{}});
}
`);
    await chmod(provider, 0o700);
    const bundle = createRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: provider, codexArgs: [],
      stateDirectory: join(server.root, `scripted-runner-${receiptFormat}`), lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: { runnerInstanceId: "api-test", environmentLeaseId: "api-test-lease", runId: fixture.runId, normalizedSessionId: "api-test-session", turnId: "api-test-turn", itemId: "api-test-item" },
      controlPlaneRegistration: prp => registerRunnerPrpAuthority({ companyId: fixture.companyId, runId: fixture.runId, authority: prp }),
    });
    const results: any[] = [];
    bundle.transport.setServerRequestHandler(async request => {
      const params = request.params as any;
      const result = await fixture.authority.execute({ tool: params.tool, arguments: params.arguments, callId: params.callId });
      results.push(result);
      // Match production's dynamicToolResponse: an extra test-only envelope
      // hides collisions between API response fields and PRP tool identity.
      const { apiOperationId, ...receipt } = result as Record<string, unknown>;
      const wireResult = receiptFormat === "legacy_http" && params.tool === "call_api"
        ? { ...receipt, operationId: apiOperationId }
        : result;
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(wireResult) }] };
    });
    try {
      await bundle.transport.request("initialize", {});
      await bundle.transport.request("thread/start", { cwd: fixture.workspace, dynamicTools: await fixture.authority.definitions() });
      await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Find the project" }] });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => { for await (const notification of bundle.transport.notifications()) if (notification.method === "turn/completed") return; })(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Native provider did not continue after the API tool result")), 10_000); }),
        ]);
      } finally { clearTimeout(timeout); }
      expect(results).toHaveLength(3);
      expect(results[1]).toMatchObject({ status: 200, apiOperationId: "GET /api/companies/{companyId}/projects", data: [{ id: fixture.projectId, name: "Aurora" }] });
      expect(results[2]).toMatchObject({ ok: false, status: 404 });
      expect(bundle.evidence().diagnostics).toContain("runnerd authenticated to the durable PRP control plane");
    } finally { await bundle.transport.close(); }
  }, 30_000);

  it("cannot opt into API tools through a binding when the operator flag is false", async () => {
    const fixture = await server.fixture({ apiToolsEnabled: true });
    process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED = "false";
    try {
      const names = (await fixture.authority.definitions()).map(tool => tool.name);
      expect(names).toContain("get_task_context");
      expect(names).not.toContain("search_api");
      expect(names).not.toContain("call_api");
      await expect(fixture.authority.execute({ tool: "call_api", callId: "disabled", arguments: { operationId: "GET /api/companies/{companyId}/projects" } })).rejects.toThrow("not_advertised");
    } finally { delete process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED; }
  });

  it("rejects credential calls before any durable receipt or secret result exists", async () => {
    const fixture = await server.fixture();
    for (const operationId of ["POST /api/agents/me/secrets/{key}/value", "POST /api/agents/{id}/keys"]) {
      await expect(fixture.authority.execute({ tool: "call_api", callId: operationId, arguments: { operationId, pathParams: operationId.includes("{key}") ? { key: "EXAMPLE_SECRET" } : { id: fixture.agentId } } })).rejects.toThrow("credential broker");
    }
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect((run.resultJson as Record<string, unknown> | null)?.apiToolReceipts).toBeUndefined();
    expect((await fixture.snapshot()).activity.filter(row => row.action === "runner.api_called")).toEqual([]);
  });

  it("rejects issue lifecycle intents before dispatch or receipt creation", async () => {
    const fixture = await server.fixture();
    for (const field of ["reopen", "resume", "interrupt"]) {
      await expect(fixture.authority.execute({ tool: "call_api", callId: field, arguments: { operationId: "PATCH /api/issues/{id}", pathParams: { id: fixture.blockerId }, body: { [field]: true } } })).rejects.toThrow("lifecycle changes");
    }
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect((run.resultJson as Record<string, unknown> | null)?.apiToolReceipts).toBeUndefined();
    expect((await fixture.snapshot()).issues.find(row => row.id === fixture.blockerId)?.status).toBe("todo");
  });

  it("supports routine annotation collaboration without changing scheduling", async () => {
    const fixture = await server.fixture();
    const [document] = await server.db.select().from(documents).where(eq(documents.companyId, fixture.companyId));
    const [routine] = await server.db.insert(routines).values({ companyId: fixture.companyId, projectId: fixture.projectId, title: "Review schedule", description: document.latestBody, assigneeAgentId: fixture.agentId, status: "paused" }).returning();
    await server.db.insert(routineDocuments).values({ companyId: fixture.companyId, routineId: routine.id, documentId: document.id, key: "description" });
    const exact = "silver-wren", start = document.latestBody.indexOf(exact);
    const base = "/api/routines/{id}/description/annotations";
    const call = (callId: string, operationId: string, body: unknown, threadId?: string) => fixture.authority.execute({ tool: "call_api", callId, arguments: { operationId, pathParams: { id: routine.id, ...(threadId ? { threadId } : {}) }, body } }) as Promise<any>;
    const created = await call("annotation-create", `POST ${base}`, { baseRevisionId: document.latestRevisionId, baseRevisionNumber: document.latestRevisionNumber, selector: { quote: { exact, prefix: document.latestBody.slice(0, start), suffix: document.latestBody.slice(start + exact.length) }, position: { normalizedStart: start, normalizedEnd: start + exact.length, markdownStart: start, markdownEnd: start + exact.length } }, body: "Please clarify this note" });
    expect(created).toMatchObject({ status: 201, data: { routineId: routine.id, status: "open" } });
    const threadId = created.data.id;
    expect(await call("annotation-comment", `POST ${base}/{threadId}/comments`, { body: "Clarified note" }, threadId)).toMatchObject({ status: 201, data: { body: "Clarified note" } });
    expect(await call("annotation-resolve", `PATCH ${base}/{threadId}`, { status: "resolved" }, threadId)).toMatchObject({ status: 200, data: { status: "resolved" } });
    expect(await call("annotation-reopen", `PATCH ${base}/{threadId}`, { status: "open" }, threadId)).toMatchObject({ status: 200, data: { status: "open" } });
    const [unchanged] = await server.db.select().from(routines).where(eq(routines.id, routine.id));
    expect(unchanged).toMatchObject({ status: "paused", lastTriggeredAt: null, lastEnqueuedAt: null });
    expect((await fixture.snapshot()).activity).toEqual(expect.arrayContaining([expect.objectContaining({ action: "routine.document_annotation_thread_created", agentId: fixture.agentId, runId: fixture.runId })]));
  });

  it("rejects every restricted REST mutation before dispatch or durable receipt", async () => {
    const fixture = await server.fixture();
    const operations = runnerApiCatalog().filter(operation => operation.transport === "rest" && !["GET", "HEAD", "OPTIONS"].includes(operation.method) && operation.callPolicy === "restricted");
    expect(operations.length).toBeGreaterThan(5);
    for (const operation of operations) {
      await expect(fixture.authority.execute({ tool: "call_api", callId: operation.operationId, arguments: { operationId: operation.operationId } })).rejects.toThrow(/cannot bypass|credential broker/);
    }
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect((run.resultJson as Record<string, unknown> | null)?.apiToolReceipts).toBeUndefined();
  });

  it("preserves route validation, authorization and audit; replays mutations once", async () => {
    const fixture = await server.fixture();
    const call = (callId: string, args: unknown) => fixture.authority.execute({ tool: "call_api", callId, arguments: args });
    await expect(call("foreign", { operationId: "GET /api/projects/{id}", pathParams: { id: fixture.foreignProjectId } })).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(call("invalid", { operationId: "POST /api/companies/{companyId}/projects", body: {} })).resolves.toMatchObject({ ok: false, status: 400 });
    const args = { operationId: "POST /api/companies/{companyId}/projects", body: { name: "Created through HTTP" } };
    const result = await call("create", args);
    expect(result).toMatchObject({ status: 201, data: { name: "Created through HTTP" } });
    expect(await call("create", args)).toEqual(result);
    await expect(call("create", { ...args, body: { name: "Different" } })).rejects.toThrow("reused");
    const snapshot = await fixture.snapshot();
    expect(snapshot.projects.filter(p => p.name === "Created through HTTP")).toHaveLength(1);
    expect(snapshot.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "project.created", agentId: fixture.agentId }),
      expect.objectContaining({ action: "runner.api_called", agentId: fixture.agentId, runId: fixture.runId, details: expect.objectContaining({ operationId: args.operationId, status: 201 }) }),
    ]));
  });

  it("blocks stale bindings and Ask/Plan mutations before HTTP", async () => {
    for (const mode of ["ask", "planning"] as const) {
      const fixture = await server.fixture({ mode });
      await expect(fixture.authority.execute({ tool: "call_api", callId: "read", arguments: { operationId: "GET /api/companies/{companyId}/projects" } })).resolves.toMatchObject({ status: 200 });
      await expect(fixture.authority.execute({ tool: "call_api", callId: "write", arguments: { operationId: "POST /api/companies/{companyId}/projects", body: { name: "Denied" } } })).rejects.toThrow("only reads");
      await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, fixture.runId));
      await expect(fixture.authority.execute({ tool: "search_api", callId: "stale", arguments: { query: "projects" } })).rejects.toThrow("binding_not_authorized");
      expect((await fixture.snapshot()).projects.some(p => p.name === "Denied")).toBe(false);
    }
  });

  it("allows API-only options while protecting task completion", async () => {
    const fixture = await server.fixture();
    const call = (body: unknown) => fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: { operationId: "PATCH /api/issues/{id}", pathParams: { id: fixture.issueId }, body } });
    await expect(call({ billingCode: "API-EXTRA" })).resolves.toMatchObject({ status: 200 });
    await expect(call({ status: "done" })).rejects.toThrow("lifecycle");
    const [issue] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue.billingCode).toBe("API-EXTRA");
    expect(issue.status).toBe("in_progress");
    for (const id of [fixture.issueId.toUpperCase(), issue.identifier!.toLowerCase(), ` ${issue.identifier!.toLowerCase()} `]) {
      await expect(fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: { operationId: "DELETE /api/issues/{id}", pathParams: { id } } })).rejects.toThrow("cannot delete itself");
    }
    expect((await fixture.snapshot()).issues.some(row => row.id === fixture.issueId)).toBe(true);
  });

  it("revokes advertised API tools without disabling dedicated operations", async () => {
    const fixture = await server.fixture();
    expect(fixture.authority.definitions().some(tool => tool.name === "call_api")).toBe(true);
    vi.stubEnv("PAPERCLIP_RUNNER_API_TOOLS_ENABLED", "false");
    try {
      expect(fixture.authority.definitions().some(tool => tool.name === "search_api")).toBe(false);
      await expect(fixture.authority.execute({ tool: "call_api", callId: "revoked", arguments: {
        operationId: "POST /api/companies/{companyId}/projects", body: { name: "Must not exist" },
      } })).rejects.toThrow("not_advertised");
      await expect(fixture.authority.execute({ tool: "get_task_context", callId: "dedicated-after-stop", arguments: {} }))
        .resolves.toMatchObject({ activeTask: { id: fixture.issueId } });
      expect((await fixture.snapshot()).projects.some(project => project.name === "Must not exist")).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it("retains an uncertain mutation receipt without dispatching it again", async () => {
    const fixture = await server.fixture();
    const args = { operationId: "POST /api/companies/{companyId}/projects", body: { name: "Uncertain" } };
    let rejectNetwork!: (error: Error) => void;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((_resolve, reject) => { rejectNetwork = reject; }));
    try {
      const call = () => fixture.authority.execute({ tool: "call_api", callId: "uncertain", arguments: args });
      const pending = call();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      expect(await call()).toMatchObject({ status: null, outcome: "unknown", error: "api_outcome_unknown" });
      rejectNetwork(new Error("lost response"));
      const result = await pending;
      expect(result).toMatchObject({ status: null, outcome: "unknown" });
      expect(await call()).toEqual(result);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { fetcher.mockRestore(); }
    expect((await fixture.snapshot()).projects.some(p => p.name === "Uncertain")).toBe(false);
  });

  it("revalidates the active run after reading an upload", async () => {
    const fixture = await server.fixture();
    const original = server.storage.getObject.bind(server.storage);
    const getObject = vi.spyOn(server.storage, "getObject").mockImplementation(async (...args) => {
      const object = await original(...args);
      await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, fixture.runId));
      return object;
    });
    try {
      await expect(fixture.authority.execute({ tool: "call_api", callId: "expired-during-upload", arguments: {
        operationId: "POST /api/companies/{companyId}/issues/{issueId}/attachments", pathParams: { issueId: fixture.issueId }, files: [{ artifactId: fixture.artifactId }],
      } })).rejects.toThrow("binding_not_authorized");
      expect((await fixture.snapshot()).assets).toHaveLength(2);
    } finally { getObject.mockRestore(); }
  });

  it("retrieves every byte of a saved large response without creating an artifact loop", async () => {
    const fixture = await server.fixture();
    const foreign = await server.fixture();
    const text = JSON.stringify({ padding: "🧭é".repeat(6000), evidence: "last-field-is-readable" });
    const stored = await server.storage.putFile({ companyId: fixture.companyId, namespace: "eval", originalFilename: "evidence.json", contentType: "application/json", body: Buffer.from(text) });
    const [asset] = await server.db.insert(assets).values({ ...stored, companyId: fixture.companyId, createdByAgentId: fixture.agentId }).returning();
    const call = (authority: typeof fixture.authority, assetId: string, responseText?: object) => authority.execute({ tool: "call_api", callId: randomUUID(), arguments: { operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId }, ...(responseText ? { responseText } : {}) } }) as Promise<any>;
    const initial = await call(fixture.authority, asset.id);
    expect(initial).toMatchObject({ status: 206, artifact: { artifactId: asset.id, sha256: asset.sha256, byteSize: Buffer.byteLength(text) } });
    const before = (await fixture.snapshot()).assets.length;
    const reads = vi.spyOn(server.storage, "getObject");
    let offsetBytes = 0;
    let result = "";
    try {
      do {
        const page = await call(fixture.authority, initial.artifact.artifactId, { offsetBytes, limitBytes: 4096 });
        expect(page).toMatchObject({ status: 206, responseText: { offsetBytes, totalBytes: Buffer.byteLength(text) } });
        result += page.data;
        offsetBytes = page.responseText.nextOffsetBytes;
      } while (offsetBytes !== null);
      expect(JSON.parse(result)).toEqual(JSON.parse(text));
      expect(reads.mock.calls.length).toBeGreaterThan(1);
      expect(reads.mock.calls.every(([, , options]) => options?.range)).toBe(true);
      const storageBytes = reads.mock.calls.reduce((total, [, , options]) => total + options!.range!.end - options!.range!.start + 1, 0);
      expect(storageBytes).toBeLessThan(Buffer.byteLength(text) + reads.mock.calls.length * 5);
      expect((await fixture.snapshot()).assets).toHaveLength(before);
      expect(await call(foreign.authority, initial.artifact.artifactId, { offsetBytes: 0 })).toMatchObject({ ok: false, status: 404 });
    } finally {
      reads.mockRestore();
    }
  });

  it("captures a live response above ten MiB and reads its saved snapshot to EOF", async () => {
    const fixture = await server.fixture();
    const foreign = await server.fixture();
    const description = "A".repeat(12 * 1024 * 1024) + "END-OF-LARGE-RESPONSE";
    await server.db.update(projects).set({ description }).where(eq(projects.id, fixture.projectId));
    const initial: any = await fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/projects/{id}", pathParams: { id: fixture.projectId }, responseText: { limitBytes: 8192 },
    } });
    expect(initial).toMatchObject({ ok: true, status: 200, responseText: { offsetBytes: 0, nextOffsetBytes: 8192 } });
    expect(initial.artifact.byteSize).toBeGreaterThan(12 * 1024 * 1024);
    const saved = await server.db.select().from(assets).where(eq(assets.id, initial.artifact.artifactId)).then(rows => rows[0]);
    const object = await server.storage.getObject(fixture.companyId, saved.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(chunk);
    const expected = Buffer.concat(chunks);
    expect(JSON.parse(expected.toString()).description).toBe(description);
    const before = (await fixture.snapshot()).assets.length;
    for (const offsetBytes of [0, 10 * 1024 * 1024 + 1, expected.length - 8192, expected.length]) {
      const page: any = await fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
        operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: saved.id }, responseText: { offsetBytes, limitBytes: 8192 },
      } });
      expect(page).toMatchObject({ ok: true, status: 206, data: expected.subarray(offsetBytes, offsetBytes + 8192).toString(),
        responseText: { offsetBytes, totalBytes: expected.length, nextOffsetBytes: offsetBytes + 8192 < expected.length ? offsetBytes + 8192 : null } });
      expect(page.artifact).toBeUndefined();
    }
    expect((await fixture.snapshot()).assets).toHaveLength(before);
    expect(await foreign.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: saved.id }, responseText: { offsetBytes: 10 * 1024 * 1024 + 1 },
    } })).toMatchObject({ ok: false, status: 404 });
    const mutation = { tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "PATCH /api/projects/{id}", pathParams: { id: fixture.projectId }, body: { name: "Updated once" },
    } };
    const receipt: any = await fixture.authority.execute(mutation);
    expect(receipt).toMatchObject({ ok: true, status: 200, artifact: { contentType: "application/json; charset=utf-8" } });
    expect(receipt.artifact.byteSize).toBeGreaterThan(12 * 1024 * 1024);
    expect(await fixture.authority.execute(mutation)).toEqual(receipt);
    const after = await fixture.snapshot();
    expect(after.assets).toHaveLength(before + 1);
    expect(after.activity.filter(row => row.action === "project.updated")).toHaveLength(1);
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect((run.resultJson as Record<string, unknown>).apiResponseCaptureBytes).toBe(initial.artifact.byteSize + receipt.artifact.byteSize);
  }, 30_000);

  it("enforces the durable run budget while permitting small reads and saved pages", async () => {
    const fixture = await server.fixture();
    await server.db.update(heartbeatRuns).set({ resultJson: { apiResponseCaptureBytes: RUNNER_API_RESPONSE_RUN_MAX_BYTES } }).where(eq(heartbeatRuns.id, fixture.runId));
    const call = () => fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/projects/{id}", pathParams: { id: fixture.projectId },
    } });
    expect(await call()).toMatchObject({ ok: true });
    await server.db.update(projects).set({ description: "x".repeat(32 * 1024) }).where(eq(projects.id, fixture.projectId));
    const before = (await fixture.snapshot()).assets.length;
    expect(await call()).toMatchObject({ ok: false, error: "api_response_capture_limit", outcome: "read_failed" });
    expect((await fixture.snapshot()).assets).toHaveLength(before);
    expect(await fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: fixture.artifactId }, responseText: { limitBytes: 4 },
    } })).toMatchObject({ ok: true });
  });

  it("reserves the run budget atomically across simultaneous captures", async () => {
    const fixture = await server.fixture();
    const used = RUNNER_API_RESPONSE_RUN_MAX_BYTES - RUNNER_API_RESPONSE_MAX_BYTES;
    await server.db.update(heartbeatRuns).set({ resultJson: { apiResponseCaptureBytes: used } }).where(eq(heartbeatRuns.id, fixture.runId));
    await server.db.update(projects).set({ description: "x".repeat(32 * 1024) }).where(eq(projects.id, fixture.projectId));
    let unblock!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const saving = new Promise<void>(resolve => { started = resolve; });
    const putFile = server.storage.putFile.bind(server.storage);
    const spy = vi.spyOn(server.storage, "putFile").mockImplementation(async input => {
      if (input.namespace === "runner-api") { started(); await gate; }
      return putFile(input);
    });
    const call = () => fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/projects/{id}", pathParams: { id: fixture.projectId },
    } });
    const first = call();
    try {
      await saving;
      expect(await call()).toMatchObject({ ok: false, error: "api_response_capture_limit" });
    } finally { unblock(); spy.mockRestore(); }
    const result: any = await first;
    expect(result).toMatchObject({ ok: true });
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect((run.resultJson as Record<string, unknown>).apiResponseCaptureBytes).toBe(used + result.artifact.byteSize);
    expect(await call()).toMatchObject({ ok: false, error: "api_response_capture_limit" });
  });

  it("counts old snapshots and other-run reservations against the company quota, and reclaims deletions", async () => {
    const fixture = await server.fixture();
    vi.stubEnv("PAPERCLIP_RUNNER_API_COMPANY_CAPTURE_MAX_BYTES", String(2 * RUNNER_API_RESPONSE_MAX_BYTES));
    const [oldSnapshot] = await server.db.insert(assets).values({ companyId: fixture.companyId, provider: "local_disk",
      objectKey: `${fixture.companyId}/runner-api/old-snapshot`, contentType: "text/plain", byteSize: RUNNER_API_RESPONSE_MAX_BYTES,
      sha256: "old-snapshot", createdByAgentId: fixture.agentId }).returning();
    const [reservation] = await server.db.insert(runnerApiResponseReservations).values({ companyId: fixture.companyId, runId: null, reservedBytes: RUNNER_API_RESPONSE_MAX_BYTES }).returning();
    await server.db.update(projects).set({ description: "x".repeat(32 * 1024) }).where(eq(projects.id, fixture.projectId));
    // A fresh authority instance cannot reset reservations from another run/process.
    const authority = new PaperclipRunnerToolAuthority(server.db, fixture);
    const call = () => authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/projects/{id}", pathParams: { id: fixture.projectId },
    } });
    expect(await call()).toMatchObject({ ok: false, error: "api_response_company_storage_limit" });
    await server.db.delete(assets).where(eq(assets.id, oldSnapshot.id));
    const first: any = await call();
    expect(first).toMatchObject({ ok: true });
    expect(await call()).toMatchObject({ ok: false, error: "api_response_company_storage_limit" });
    await server.db.delete(assets).where(eq(assets.id, first.artifact.artifactId));
    expect(await server.db.select().from(runnerApiResponseReservations).where(eq(runnerApiResponseReservations.companyId, fixture.companyId))).toEqual([expect.objectContaining({ id: reservation.id })]);
    expect(await call()).toMatchObject({ ok: true });
  });

  it("keeps company storage reserved after an ambiguous upload failure", async () => {
    const fixture = await server.fixture();
    await server.db.update(projects).set({ description: "x".repeat(32 * 1024) }).where(eq(projects.id, fixture.projectId));
    const spy = vi.spyOn(server.storage, "putFile").mockRejectedValueOnce(new Error("storage disconnected"));
    try {
      await expect(fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
        operationId: "GET /api/projects/{id}", pathParams: { id: fixture.projectId },
      } })).rejects.toThrow("storage disconnected");
    } finally { spy.mockRestore(); }
    expect(await server.db.select().from(runnerApiResponseReservations).where(eq(runnerApiResponseReservations.companyId, fixture.companyId))).toEqual([
      expect.objectContaining({ assetId: null, reservedBytes: RUNNER_API_RESPONSE_MAX_BYTES }),
    ]);
  });

  it.each([false, true])("reconciles metadata failure without losing committed assets (commit=%s)", async committed => {
    const fixture = await server.fixture();
    await server.db.update(projects).set({ description: "x".repeat(32 * 1024) }).where(eq(projects.id, fixture.projectId));
    const putFile = server.storage.putFile.bind(server.storage);
    const transaction = server.db.transaction.bind(server.db);
    let objectKey = "";
    let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
    const spy = vi.spyOn(server.storage, "putFile").mockImplementationOnce(async input => {
      const saved = await putFile(input);
      objectKey = saved.objectKey;
      transactionSpy = vi.spyOn(server.db, "transaction").mockImplementationOnce(async (fn, config) => {
        if (committed) await transaction(fn, config);
        throw new Error("metadata transaction failed");
      });
      return saved;
    });
    try {
      await expect(fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
        operationId: "GET /api/projects/{id}", pathParams: { id: fixture.projectId },
      } })).rejects.toThrow("metadata transaction failed");
    } finally { spy.mockRestore(); transactionSpy?.mockRestore(); }
    const reservations = await server.db.select().from(runnerApiResponseReservations).where(eq(runnerApiResponseReservations.companyId, fixture.companyId));
    expect(reservations).toHaveLength(committed ? 1 : 0);
    if (committed) expect(reservations[0].assetId).toBeTruthy();
    expect((await server.storage.headObject(fixture.companyId, objectKey)).exists).toBe(committed);
  });

  it("shares company admission across simultaneous runs", async () => {
    const fixture = await server.fixture();
    vi.stubEnv("PAPERCLIP_RUNNER_API_COMPANY_CAPTURE_MAX_BYTES", String(RUNNER_API_RESPONSE_MAX_BYTES));
    const otherRunId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: otherRunId, companyId: fixture.companyId, agentId: fixture.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: fixture.blockerId, contextSnapshot: { issueId: fixture.blockerId } });
    await server.db.update(issues).set({ status: "in_progress", executionRunId: otherRunId }).where(eq(issues.id, fixture.blockerId));
    const other = new PaperclipRunnerToolAuthority(server.db, { ...fixture, issueId: fixture.blockerId, runId: otherRunId });
    await server.db.update(projects).set({ description: "x".repeat(32 * 1024) }).where(eq(projects.id, fixture.projectId));
    const arguments_ = { operationId: "GET /api/projects/{id}", pathParams: { id: fixture.projectId } };
    const results: any[] = await Promise.all([fixture.authority, other].map(authority => authority.execute({ tool: "call_api", callId: randomUUID(), arguments: arguments_ })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ error: "api_response_company_storage_limit" });
  });

  it("releases a cleaned failed capture's company reservation but retains its run charge", async () => {
    const fixture = await server.fixture();
    let emitted = false;
    const stream = new ReadableStream({
      async pull(target) {
        if (!emitted) { emitted = true; target.enqueue(Buffer.alloc(32 * 1024)); }
        else { await new Promise(resolve => setTimeout(resolve, 100)); target.error(new Error("connection reset")); }
      },
    });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/plain" } }));
    try {
      expect(await fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
        operationId: "GET /api/projects/{id}", pathParams: { id: fixture.projectId },
      } })).toMatchObject({ ok: false, error: "api_transport_failure" });
    } finally { spy.mockRestore(); }
    expect(await server.db.select().from(runnerApiResponseReservations).where(eq(runnerApiResponseReservations.companyId, fixture.companyId))).toEqual([]);
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect((run.resultJson as Record<string, unknown>).apiResponseCaptureBytes).toBe(RUNNER_API_RESPONSE_MAX_BYTES);
  });

  it("persists and range-reads asset sizes above two GiB", async () => {
    const fixture = await server.fixture();
    const offsetBytes = 3 * 1024 * 1024 * 1024;
    const objectKey = `${fixture.companyId}/eval/sparse-large-response.txt`;
    const path = join(server.root, "storage", objectKey);
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, "wx");
    try { await file.write(Buffer.from("readable"), 0, 8, offsetBytes); }
    finally { await file.close(); }
    const [asset] = await server.db.insert(assets).values({ companyId: fixture.companyId, provider: "local_disk", objectKey,
      contentType: "text/plain", byteSize: offsetBytes + 8, sha256: "sparse-fixture", createdByAgentId: fixture.agentId }).returning();
    expect(asset.byteSize).toBe(offsetBytes + 8);
    const page = await fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: asset.id }, responseText: { offsetBytes, limitBytes: 8 },
    } });
    expect(page).toMatchObject({ ok: true, data: "readable", responseText: { offsetBytes, totalBytes: offsetBytes + 8, nextOffsetBytes: null } });
  });

  it("contains workspace files, checks artifact ownership, and persists downloads", async () => {
    const fixture = await server.fixture();
    const foreign = await server.fixture();
    const upload = (files: unknown) => fixture.authority.execute({ tool: "call_api", callId: randomUUID(), arguments: { operationId: "POST /api/companies/{companyId}/issues/{issueId}/attachments", pathParams: { issueId: fixture.issueId }, files } });
    await expect(upload([{ artifactId: foreign.artifactId }])).rejects.toThrow("not available");
    await expect(upload([{ path: "../outside.txt" }])).rejects.toThrow();
    const outside = join(server.root, "outside.txt");
    await writeFile(outside, "must-not-upload");
    await symlink(outside, join(fixture.workspace, "escape.txt"));
    await expect(upload([{ path: "escape.txt" }])).rejects.toThrow();
    await expect(upload([{ path: "sample.txt" }])).resolves.toMatchObject({ status: 201 });
    const download = await fixture.authority.execute({ tool: "call_api", callId: "download", arguments: { operationId: "GET /api/assets/{assetId}/content", pathParams: { assetId: fixture.binaryArtifactId } } }) as any;
    expect(download).toMatchObject({ status: 206, byteSize: 32000, artifact: { artifactId: fixture.binaryArtifactId, byteSize: 32000 } });
    expect((await fixture.snapshot()).assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: download.artifact.artifactId, companyId: fixture.companyId, createdByAgentId: fixture.agentId })]));
  });

  it("does not accept caller-supplied identity in an API comment", async () => {
    const fixture = await server.fixture();
    const result = await fixture.authority.execute({ tool: "call_api", callId: "comment", arguments: { operationId: "POST /api/issues/{id}/comments", pathParams: { id: fixture.issueId }, body: { body: "Identity proof", authorAgentId: randomUUID(), authorUserId: "spoofed", runId: randomUUID() } } });
    expect(result).toMatchObject({ status: 201 });
    expect((await fixture.snapshot()).comments).toEqual(expect.arrayContaining([expect.objectContaining({ body: "Identity proof", authorAgentId: fixture.agentId, authorUserId: null })]));
  });

  it("rejects a stale source-run question over public HTTP and accepts it from the next run", async () => {
    const localTrustedServer = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
    try {
      const fixture = await localTrustedServer.fixture({
        disableWakeOnDemand: true,
        contextSnapshot: { paperclipWake: { comments: [] } },
      });
      const sourceToken = createLocalAgentJwt(
        fixture.agentId,
        fixture.companyId,
        "paperclip_runner",
        fixture.runId,
      );
      expect(sourceToken).toBeTruthy();
      const requestHeaders = (token: string) => ({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-paperclip-run-id": fixture.runId,
      });
      const humanCommentResponse = await fetch(
        `${fixture.apiUrl}/api/issues/${fixture.issueId}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Human direction committed after the old wake." }),
        },
      );
      expect(humanCommentResponse.status).toBe(201);
      const humanComment = await humanCommentResponse.json() as { id: string; authorUserId?: string | null; authorAgentId?: string | null; createdByRunId?: string | null };
      expect(humanComment).toMatchObject({ authorUserId: "local-board", authorAgentId: null, createdByRunId: null });

      const questionPayload = {
        kind: "ask_user_questions",
        idempotencyKey: `stale-source-question-${fixture.runId}`,
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          title: "One real question",
          questions: [{
            id: "scope",
            prompt: "Choose a scope.",
            selectionMode: "single",
            required: true,
            options: [{ id: "small", label: "Small" }],
          }],
        },
      };
      const staleResponse = await fetch(
        `${fixture.apiUrl}/api/issues/${fixture.issueId}/interactions`,
        { method: "POST", headers: requestHeaders(sourceToken!), body: JSON.stringify(questionPayload) },
      );
      expect(staleResponse.status).toBe(409);
      const staleBody = await staleResponse.json() as { details?: { reason?: string; commentIds?: string[] } };
      expect(staleBody.details).toMatchObject({ reason: "newer_comment_not_delivered", commentIds: [humanComment.id] });
      const afterStale = await fetch(`${fixture.apiUrl}/api/issues/${fixture.issueId}/interactions`);
      expect(afterStale.status).toBe(200);
      expect(await afterStale.json()).toEqual([]);

      const successorRunId = randomUUID();
      await localTrustedServer.db.insert(heartbeatRuns).values({
        id: successorRunId,
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: fixture.issueId,
        invocationSource: "continuation",
        triggerDetail: "comment",
        contextSnapshot: { issueId: fixture.issueId, paperclipWake: { comments: [{ id: humanComment.id }] } },
      });
      await localTrustedServer.db.update(issues).set({ executionRunId: successorRunId, checkoutRunId: successorRunId }).where(eq(issues.id, fixture.issueId));
      const successorToken = createLocalAgentJwt(
        fixture.agentId,
        fixture.companyId,
        "paperclip_runner",
        successorRunId,
      );
      expect(successorToken).toBeTruthy();
      const acceptedResponse = await fetch(
        `${fixture.apiUrl}/api/issues/${fixture.issueId}/interactions`,
        {
          method: "POST",
          headers: { ...requestHeaders(successorToken!), "x-paperclip-run-id": successorRunId },
          body: JSON.stringify({ ...questionPayload, idempotencyKey: `fresh-source-question-${successorRunId}` }),
        },
      );
      const acceptedText = await acceptedResponse.text();
      expect(acceptedResponse.status, acceptedText).toBe(201);
      const accepted = JSON.parse(acceptedText) as { id: string; status: string; sourceRunId: string };
      expect(accepted).toMatchObject({ status: "pending", sourceRunId: successorRunId });
      const answerResponse = await fetch(
        `${fixture.apiUrl}/api/issues/${fixture.issueId}/interactions/${accepted.id}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: [{ questionId: "scope", optionIds: ["small"] }] }),
        },
      );
      expect(answerResponse.status).toBe(200);
      expect((await answerResponse.json() as { status: string }).status).toBe("answered");
    } finally {
      await localTrustedServer.close();
    }
  });

  it("creates child tasks after seeding and preserves company numbering", async () => {
    const fixture = await server.fixture();
    await expect(fixture.authority.execute({ tool: "create_task", callId: "child", arguments: { title: "Verify release notes", description: "Check before shipping.", assigneeActorId: null, idempotencyKey: "child" } })).resolves.toBeDefined();
    const children = (await fixture.snapshot()).issues.filter(issue => issue.parentId === fixture.issueId);
    expect(children).toHaveLength(1);
    expect(children[0].issueNumber).toBe(3);
  });

  it("resets fixture data and identities for paired comparisons", async () => {
    const baseline = await server.fixture({ reset: true, apiToolsEnabled: false });
    await server.db.update(issues).set({ billingCode: "previous-attempt" }).where(eq(issues.id, baseline.issueId));
    const treatment = await server.fixture({ reset: true });
    expect(treatment.companyId).toBe(baseline.companyId);
    expect(treatment.issueId).toBe(baseline.issueId);
    expect((await treatment.snapshot()).issues[0].billingCode).toBeNull();
    const originalTools = (await baseline.authority.definitions()).map(tool => tool.name);
    const treatmentTools = (await treatment.authority.definitions()).map(tool => tool.name);
    const apiTools = ["hire_agent", "search_api", "call_api", "get_task", "comment_on_task", "list_task_documents", "read_task_document", "write_task_document"];
    expect(treatmentTools.filter(name => !originalTools.includes(name))).toEqual(apiTools);
    expect(treatmentTools.filter(name => !apiTools.includes(String(name)))).toEqual(originalTools);
  });
});
