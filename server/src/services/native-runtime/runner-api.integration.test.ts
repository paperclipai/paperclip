import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { documents, heartbeatRuns, issues, routineDocuments, routines } from "@paperclipai/db";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { runnerApiCatalog } from "./runner-api-catalog.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";

describe("runner API against real HTTP routes", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const oldEnabled = process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED = "true";
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
    if (oldEnabled === undefined) delete process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
    else process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED = oldEnabled;
  });

  it.skipIf(!process.env.PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION && !existsSync(defaultCapabilityRunnerdBinary()))("runs runnerd → PRP → authority → actual authenticated HTTP", async () => {
    const fixture = await server.fixture();
    const provider = join(server.root, "scripted-api-provider.mjs");
    await writeFile(provider, `#!${process.execPath}
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let step = 0;
const calls = [{tool:'search_api',arguments:{query:'list projects'}},{tool:'call_api',arguments:{operationId:'GET /api/companies/{companyId}/projects'}}];
const next = () => { const c=calls[step++]; if(c) send({id:'call-'+step,method:'item/tool/call',params:{threadId:'api-thread',turnId:'api-turn',itemId:'api-item-'+step,callId:'api-call-'+step,...c}}); else send({method:'turn/completed',params:{turn:{id:'api-turn',status:'completed'}}}); };
for await (const line of createInterface({input:process.stdin})) {
const m=JSON.parse(line);
if(!m.method) {if(String(m.id).startsWith('call-')) next(); continue;}
if(m.method==='initialize') send({id:m.id,result:{userAgent:'scripted-api-provider'}});
else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'api-thread',sessionId:'api-session'}}});
else if(m.method==='turn/start') {send({id:m.id,result:{turn:{id:'api-turn',status:'inProgress'}}});send({method:'turn/started',params:{turn:{id:'api-turn'}}});next();}
else if(m.id!==undefined) send({id:m.id,result:{}});
}
`);
    await chmod(provider, 0o700);
    const bundle = createRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: provider, codexArgs: [],
      stateDirectory: join(server.root, "scripted-runner"), lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: { runnerInstanceId: "api-test", environmentLeaseId: "api-test-lease", runId: fixture.runId, normalizedSessionId: "api-test-session", turnId: "api-test-turn", itemId: "api-test-item" },
      controlPlaneRegistration: prp => registerRunnerPrpAuthority({ companyId: fixture.companyId, runId: fixture.runId, authority: prp }),
    });
    const results: any[] = [];
    bundle.transport.setServerRequestHandler(async request => {
      const params = request.params as any;
      const result = await fixture.authority.execute({ tool: params.tool, arguments: params.arguments, callId: params.callId });
      results.push(result);
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, result }) }] };
    });
    try {
      await bundle.transport.request("initialize", {});
      await bundle.transport.request("thread/start", { cwd: fixture.workspace, dynamicTools: await fixture.authority.definitions() });
      await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Find the project" }] });
      for await (const notification of bundle.transport.notifications()) if (notification.method === "turn/completed") break;
      expect(results).toHaveLength(2);
      expect(results[1]).toMatchObject({ status: 200, data: [{ id: fixture.projectId, name: "Aurora" }] });
      expect(bundle.evidence().diagnostics).toContain("runnerd authenticated to the durable PRP control plane");
    } finally { await bundle.transport.close(); }
  }, 30_000);

  it("cannot opt into API tools through a binding when the operator flag is absent", async () => {
    const fixture = await server.fixture({ apiToolsEnabled: true });
    delete process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
    try {
      const names = (await fixture.authority.definitions()).map(tool => tool.name);
      expect(names).toContain("get_task_context");
      expect(names).not.toContain("search_api");
      expect(names).not.toContain("call_api");
      await expect(fixture.authority.execute({ tool: "call_api", callId: "disabled", arguments: { operationId: "GET /api/companies/{companyId}/projects" } })).rejects.toThrow("not_advertised");
    } finally { process.env.PAPERCLIP_RUNNER_API_TOOLS_ENABLED = "true"; }
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
    expect(download).toMatchObject({ status: 200, byteSize: 32000, artifact: { byteSize: 32000 } });
    expect((await fixture.snapshot()).assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: download.artifact.artifactId, companyId: fixture.companyId, createdByAgentId: fixture.agentId })]));
  });

  it("does not accept caller-supplied identity in an API comment", async () => {
    const fixture = await server.fixture();
    const result = await fixture.authority.execute({ tool: "call_api", callId: "comment", arguments: { operationId: "POST /api/issues/{id}/comments", pathParams: { id: fixture.issueId }, body: { body: "Identity proof", authorAgentId: randomUUID(), authorUserId: "spoofed", runId: randomUUID() } } });
    expect(result).toMatchObject({ status: 201 });
    expect((await fixture.snapshot()).comments).toEqual(expect.arrayContaining([expect.objectContaining({ body: "Identity proof", authorAgentId: fixture.agentId, authorUserId: null })]));
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
    expect((await treatment.authority.definitions()).filter(tool => !["call_api", "search_api"].includes(String(tool.name))).map(tool => tool.name)).toEqual(originalTools);
  });
});
