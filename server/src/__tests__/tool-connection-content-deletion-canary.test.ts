import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  assets,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueConnectionContentDeletions,
  issues,
  issueThreadInteractions,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolConnections,
  toolInvocations,
  toolMcpAppViews,
  runnerApiResponseReservations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createConnectionContentDeletion } from "../services/tool-access/connections/content-deletion.js";
import { composeRunLogStore, createDurableRunLogStore, type RunLogHandle, type RunLogStore } from "../services/run-log-store.js";
import { createObjectRunLogStore } from "../services/object-run-log-store.js";
import { summarizeToolValue } from "../services/tool-content-guards.js";
import type { StorageProvider } from "../storage/types.js";
import { createStorageService } from "../storage/service.js";
import { issueService } from "../services/issues.js";
import { deleteCompany } from "../services/company-deletion.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OUT_OF_SCOPE_COLUMNS = new Map([
  ["issue_comments.body", "Comments an agent wrote into the task. The user removes them by editing or deleting the comment or the task."],
]);
const TASK_FILE_NAMESPACE = "/issues/";

function memoryProvider() {
  const objects = new Map<string, Buffer>();
  const etag = (bytes: Buffer) => String(bytes.length) + ":" + bytes.toString("base64").slice(0, 32);
  const read = async (body: Buffer | AsyncIterable<Uint8Array>) => {
    if (Buffer.isBuffer(body)) return Buffer.from(body);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  const provider: StorageProvider = {
    id: "s3",
    async putObject(input) { objects.set(input.objectKey, await read(input.body)); },
    async putObjectConditional(input) {
      const old = objects.get(input.objectKey);
      if (input.ifNoneMatch ? old : !old || etag(old) !== input.ifMatch)
        throw Object.assign(new Error("conflict"), { name: "PreconditionFailed" });
      const bytes = await read(input.body);
      objects.set(input.objectKey, bytes);
      return { etag: etag(bytes) };
    },
    async getObject(input) {
      const bytes = objects.get(input.objectKey);
      if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      const slice = input.range ? bytes.subarray(input.range.start, input.range.end + 1) : bytes;
      return { stream: Readable.from([slice]), contentLength: slice.length, etag: etag(bytes) };
    },
    async headObject(input) {
      const bytes = objects.get(input.objectKey);
      return bytes ? { exists: true, contentLength: bytes.length, etag: etag(bytes) } : { exists: false };
    },
    async deleteObject(input) { objects.delete(input.objectKey); },
    async listObjects(input) { return { keys: [...objects.keys()].filter((key) => key.startsWith(input.prefix)) }; },
  };
  return { provider, objects };
}

async function filesContaining(dir: string, marker: string): Promise<string[]> {
  const hits: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...await filesContaining(full, marker));
    else if ((await fs.readFile(full)).includes(marker)) hits.push(full);
  }
  return hits;
}

describeEmbeddedPostgres("deleting a connection's stored content leaves no copy behind", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let baseDir = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-content-canary-");
    db = createDb(tempDb.connectionString);
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "content-canary-"));
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  function stores(dir: string) {
    const mirror = memoryProvider();
    const objects = memoryProvider();
    const local = createDurableRunLogStore({ basePath: dir, s3: { provider: mirror.provider } });
    const external = createObjectRunLogStore({ provider: objects.provider, keyPrefix: "run-logs", assertWriterAuthority: async () => undefined });
    const files = memoryProvider();
    return { dir, mirror, objects, files, storage: createStorageService(files.provider), local, external, store: composeRunLogStore(local, external) };
  }

  async function writeLog(store: RunLogStore, ids: { companyId: string; agentId: string; runId: string }, text: string) {
    const handle = await store.begin(ids);
    await store.append(handle, { stream: "stdout", chunk: text, ts: new Date().toISOString(), seq: 1 });
    await store.finalize(handle);
    return handle;
  }

  async function seedCompany() {
    const [company] = await db.insert(companies).values({ name: `Canary ${randomUUID()}`, issuePrefix: `CN${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "Canary agent", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company!.id, name: `Docs ${randomUUID().slice(0, 6)}`, type: "mcp_http" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Summarise the drive" }).returning();
    return { company: company!, agent: agent!, application: application!, issue: issue! };
  }

  async function seedConnectionFlow(
    base: Awaited<ReturnType<typeof seedCompany>>,
    logs: ReturnType<typeof stores>,
    marker: string,
  ) {
    const companyId = base.company.id;
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: base.application.id, name: `Docs ${marker}`.slice(0, 40), uid: randomUUID(), transport: "mcp_remote", status: "active",
    }).returning();
    const finishedAt = new Date(Date.now() - 60_000);
    const created = new Date(Date.now() - 30_000);

    const callingRunId = randomUUID();
    const callingLog = await writeLog(logs.store, { companyId, agentId: base.agent.id, runId: callingRunId },
      JSON.stringify({ tool: "read_doc", output: `Document says ${marker}` }));
    await db.insert(heartbeatRuns).values({
      id: callingRunId, companyId, agentId: base.agent.id, issueId: base.issue.id, status: "succeeded", finishedAt, runtimeMode: "native",
      logStore: callingLog.store, logRef: callingLog.logRef, stdoutExcerpt: `read_doc -> ${marker}`,
      resultJson: {
        summary: `The drive says ${marker}`,
        finalizationPhase: "committed",
        nativeResult: { schema: "paperclip.run_result.v1", summary: `Answer quoting ${marker}`, reportedWorkDisposition: "completed",
          continuation: { kind: "response_wake", summary: `Continue with ${marker}`, idempotencyKey: "k1" } },
      },
    });
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId: callingRunId, agentId: base.agent.id, seq: 1, eventType: "lifecycle", message: "run started", payload: { phase: "start" } },
      { companyId, runId: callingRunId, agentId: base.agent.id, seq: 2, eventType: "tool.execution.started", message: "read_doc", payload: { arguments: { query: marker } } },
      { companyId, runId: callingRunId, agentId: base.agent.id, seq: 3, eventType: "tool.execution.completed", message: marker, payload: { output: marker } },
      { companyId, runId: callingRunId, agentId: base.agent.id, seq: 4, eventType: "item.completed", payload: { prpEvent: { payload: { kind: "assistant_message", text: `I found ${marker}` } } } },
    ]);

    const args = summarizeToolValue({ query: marker });
    const result = summarizeToolValue({ text: `Result ${marker}` });
    const [readCall, writeCall] = await db.insert(toolInvocations).values([
      { companyId, connectionId: connection!.id, runId: callingRunId, agentId: base.agent.id, issueId: base.issue.id, toolName: "read_doc", status: "succeeded",
        argumentsSummary: args, argumentsHash: args.sha256, resultSummary: result, resultHash: result.sha256, resultSizeBytes: result.sizeBytes,
        progress: { message: `Reading ${marker}` } as never, createdAt: created },
      { companyId, connectionId: connection!.id, runId: callingRunId, agentId: base.agent.id, issueId: base.issue.id, toolName: "send_doc", status: "succeeded",
        approvalState: "approved", argumentsSummary: args, resultSummary: result, createdAt: created },
    ]).returning();
    await db.insert(toolCallEvents).values([
      { companyId, connectionId: connection!.id, runId: callingRunId, invocationId: readCall!.id, eventType: "call_started", argumentsSummary: args, requestSummary: args, createdAt: created },
      { companyId, connectionId: connection!.id, runId: callingRunId, invocationId: readCall!.id, eventType: "call_completed", resultSummary: result, resultHash: result.sha256, createdAt: created },
    ]);
    await db.insert(toolAccessAuditEvents).values({
      companyId, connectionId: connection!.id, action: "tool_access.policy_decision", outcome: "success", createdAt: created,
      details: { decision: "allow", runId: callingRunId, toolName: "read_doc", argumentsSummary: args, redactionPlan: { redactedFieldCount: 0 } },
    });

    const [card] = await db.insert(issueThreadInteractions).values({
      companyId, issueId: base.issue.id, kind: "request_confirmation", status: "resolved",
      payload: { version: 1, prompt: "Approve send_doc?", detailsMarkdown: `Will send ${marker}`,
        toolAction: { version: 1, toolName: "send_doc", previewMarkdown: `Preview ${marker}`, argumentsSummaryJson: args.summary } } as never,
      result: { version: 1, outcome: "accepted", toolAction: { version: 1, status: "executed", resultSummary: result.summary } } as never,
    }).returning();
    const [actionRequest] = await db.insert(toolActionRequests).values({
      companyId, invocationId: writeCall!.id, issueId: base.issue.id, interactionId: card!.id, status: "executed",
      canonicalArgumentsHash: "args", canonicalArgumentsSummary: args, signedArguments: `signed:${marker}`, previewMarkdown: `Preview ${marker}`,
    }).returning();

    await db.insert(toolMcpAppViews).values({
      companyId, connectionId: connection!.id, issueId: base.issue.id, runId: callingRunId, invocationId: readCall!.id,
      applicationName: "Docs", toolName: "read_doc", upstreamToolName: "read_doc", resourceUri: "ui://docs/view",
      toolInput: { query: marker }, toolResult: { content: [{ type: "text", text: marker }] },
      modelContext: { content: [{ type: "text", text: marker }] } as never, createdAt: created,
    });

    await db.insert(issueComments).values({ companyId, issueId: base.issue.id, authorAgentId: base.agent.id, body: `Agent note: ${marker}` });

    const saved = await logs.storage.putFile({ companyId, namespace: "runner-api", originalFilename: "response.json", contentType: "application/json",
      body: Buffer.from(JSON.stringify({ text: `Oversized result ${marker}` })) });
    const [savedAsset] = await db.insert(assets).values({ companyId, ...saved, createdByAgentId: base.agent.id }).returning();
    await db.insert(runnerApiResponseReservations).values({ companyId, runId: callingRunId, assetId: savedAsset!.id, reservedBytes: saved.byteSize });
    const attached = await logs.storage.putFile({ companyId, namespace: "issues", originalFilename: "notes.txt", contentType: "text/plain",
      body: Buffer.from(`Attached copy of ${marker}`) });
    const [attachedAsset] = await db.insert(assets).values({ companyId, ...attached, createdByAgentId: base.agent.id }).returning();
    await db.insert(issueAttachments).values({ companyId, issueId: base.issue.id, assetId: attachedAsset!.id });

    return { connection: connection!, actionRequest: actionRequest!, result, callingRunId };
  }

  async function seedDeliveryRun(
    base: Awaited<ReturnType<typeof seedCompany>>,
    logs: ReturnType<typeof stores>,
    delivered: Array<{ actionRequestId: string; marker: string }>,
  ) {
    const companyId = base.company.id;
    const runId = randomUUID();
    const ids = { companyId, agentId: base.agent.id, runId };
    const text = delivered.map((entry) => `Approved result ${entry.marker}`).join("\n");
    await writeLog(logs.local, ids, text);
    const migrated = await writeLog(logs.external, ids, text);
    const actions = delivered.map((entry) => ({ actionRequestId: entry.actionRequestId, toolName: "send_doc", resultSummary: `Result ${entry.marker}` }));
    const context = {
      issueId: base.issue.id, toolAction: actions[0], toolActions: actions, toolActionRequestIds: delivered.map((entry) => entry.actionRequestId),
      paperclipAgentMessage: { text: "There are recorded connection outcomes.", untrustedToolResults: actions },
    };
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: base.agent.id, issueId: base.issue.id, status: "succeeded", finishedAt: new Date(Date.now() - 10_000),
      logStore: migrated.store, logRef: migrated.logRef, contextSnapshot: context, resultJson: { summary: text },
    });
    await db.insert(agentWakeupRequests).values({
      companyId, agentId: base.agent.id, source: "automation", status: "completed",
      payload: { issueId: base.issue.id, _paperclipWakeContext: context },
    });
    return runId;
  }

  async function scan(markers: string[], logs: ReturnType<typeof stores>, options: { taskOwnedCopies?: boolean } = {}) {
    const columns = await db.execute(sql`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type in ('text', 'character varying', 'jsonb', 'json')`);
    const hits: string[] = [];
    for (const row of columns as unknown as Array<{ table_name: string; column_name: string }>) {
      const name = `${row.table_name}.${row.column_name}`;
      if (!options.taskOwnedCopies && OUT_OF_SCOPE_COLUMNS.has(name)) continue;
      for (const marker of markers) {
        const found = await db.execute(sql`select 1 from ${sql.identifier(row.table_name)}
          where ${sql.identifier(row.column_name)}::text like ${`%${marker}%`} limit 1`);
        if ((found as unknown as unknown[]).length > 0) hits.push(`${name} contains ${marker}`);
      }
    }
    for (const marker of markers) {
      for (const [label, objects] of [["object store", logs.objects.objects], ["legacy mirror", logs.mirror.objects], ["file storage", logs.files.objects]] as const) {
        for (const [key, bytes] of objects) {
          if (!options.taskOwnedCopies && key.includes(TASK_FILE_NAMESPACE)) continue;
          if (bytes.includes(marker)) hits.push(`${label} ${key} contains ${marker}`);
        }
      }
      for (const file of await filesContaining(logs.dir, marker)) hits.push(`file ${file} contains ${marker}`);
    }
    return hits;
  }

  async function outOfScopeStillHolds(marker: string, logs: ReturnType<typeof stores>) {
    const rows = await db.execute(sql`select 1 from issue_comments where body like ${`%${marker}%`}`);
    return (rows as unknown as unknown[]).length > 0
      && [...logs.files.objects].some(([key, bytes]) => key.includes(TASK_FILE_NAMESPACE) && bytes.includes(marker));
  }

  async function drainPending(service: ReturnType<typeof createConnectionContentDeletion>) {
    for (let i = 0; i < 200 && await service.nextDeadline() !== null; i++) {
      await service.processPending(new AbortController().signal);
    }
    expect(await service.nextDeadline()).toBeNull();
  }

  async function drain(service: ReturnType<typeof createConnectionContentDeletion>, deletionIds: string[]) {
    for (let i = 0; i < 200; i++) {
      const jobs = await Promise.all(deletionIds.map((id) => service.process(id, new AbortController().signal)));
      if (jobs.every((job) => job?.status === "completed")) return;
    }
    throw new Error("deletion did not finish");
  }

  async function seenBefore(markers: string[], logs: ReturnType<typeof stores>) {
    const hits = await scan(markers, logs);
    for (const marker of markers) expect(hits.some((hit) => hit.includes(marker))).toBe(true);
    expect(hits.some((hit) => hit.startsWith("object store"))).toBe(true);
    expect(hits.some((hit) => hit.startsWith("legacy mirror"))).toBe(true);
    expect(hits.some((hit) => hit.startsWith("file "))).toBe(true);
  }

  it("leaves the marker nowhere after a deletion runs to completion", async () => {
    const logs = stores(path.join(baseDir, "complete"));
    const base = await seedCompany();
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    const flow = await seedConnectionFlow(base, logs, marker);
    await seedDeliveryRun(base, logs, [{ actionRequestId: flow.actionRequest.id, marker }]);
    await seenBefore([marker], logs);

    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    const before = await service.storedContent(flow.connection);
    expect(before.stored).toMatchObject({ toolCalls: 2, approvals: 1, appViews: 1, runs: 2, runsInProgress: 0 });
    const { deletion } = await service.request(flow.connection, { actorType: "user", actorId: "board-user" });
    await drain(service, [deletion.id]);

    expect(await scan([marker], logs)).toEqual([]);
    expect(await outOfScopeStillHolds(marker, logs)).toBe(true);
    expect((await service.storedContent(flow.connection)).stored).toEqual({ toolCalls: 0, approvals: 0, appViews: 0, runs: 0, runsInProgress: 0 });
  });

  it("leaves the marker nowhere after the task is deleted, and keeps another task's content", async () => {
    const logs = stores(path.join(baseDir, "task"));
    const base = await seedCompany();
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    const kept = `CANARY${randomUUID().replace(/-/g, "")}`;
    const flow = await seedConnectionFlow(base, logs, marker);
    await seedDeliveryRun(base, logs, [{ actionRequestId: flow.actionRequest.id, marker }]);
    const [otherIssue] = await db.insert(issues).values({ companyId: base.company.id, title: "Another task" }).returning();
    const otherBase = { ...base, issue: otherIssue! };
    const otherFlow = await seedConnectionFlow(otherBase, logs, kept);
    await seedDeliveryRun(otherBase, logs, [{ actionRequestId: otherFlow.actionRequest.id, marker: kept }]);
    await seenBefore([marker, kept], logs);
    expect((await scan([marker], logs, { taskOwnedCopies: true })).filter((hit) => hit.startsWith("file storage"))).toHaveLength(2);

    await issueService(db).remove(base.issue.id);
    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    await drainPending(service);

    expect(await scan([marker], logs, { taskOwnedCopies: true })).toEqual([]);
    const remaining = await scan([kept], logs, { taskOwnedCopies: true });
    expect(remaining.some((hit) => hit.startsWith("tool_invocations."))).toBe(true);
    expect(remaining.some((hit) => hit.startsWith("object store"))).toBe(true);
    expect(remaining.some((hit) => hit.startsWith("file storage"))).toBe(true);
    const [activity] = await db.execute(sql`select entity_type, entity_id, details from activity_log
      where company_id = ${base.company.id} and action = 'issue.connection_content_deleted'`) as unknown as Array<{ entity_type: string; entity_id: string; details: Record<string, number> }>;
    expect(activity).toMatchObject({ entity_type: "issue", entity_id: base.issue.id });
    expect(activity!.details).toMatchObject({ toolCalls: 2, runs: 2 });
  });

  it("leaves the marker nowhere after deleting a task whose connection call had no run", async () => {
    const logs = stores(path.join(baseDir, "task-runless"));
    const base = await seedCompany();
    const companyId = base.company.id;
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: base.application.id, name: "Docs runless", uid: randomUUID(), transport: "mcp_remote", status: "active",
    }).returning();
    const args = summarizeToolValue({ query: marker });
    const result = summarizeToolValue({ text: `Result ${marker}` });
    const [call] = await db.insert(toolInvocations).values({
      companyId, connectionId: connection!.id, runId: null, issueId: base.issue.id, toolName: "read_doc", status: "succeeded",
      argumentsSummary: args, resultSummary: result, createdAt: new Date(Date.now() - 30_000),
    }).returning();
    await db.insert(toolCallEvents).values([
      { companyId, connectionId: connection!.id, issueId: base.issue.id, eventType: "policy_decision", argumentsSummary: args },
      { companyId, connectionId: connection!.id, issueId: base.issue.id, invocationId: call!.id, eventType: "call_completed", resultSummary: result },
    ]);
    await db.insert(toolAccessAuditEvents).values({
      companyId, connectionId: connection!.id, action: "tool_access.policy_decision", outcome: "success",
      details: { decision: "allow", issueId: base.issue.id, runId: null, toolName: "read_doc", argumentsSummary: args },
    });
    expect((await scan([marker], logs)).length).toBeGreaterThan(0);

    await issueService(db).remove(base.issue.id);
    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    await drainPending(service);
    expect(await scan([marker], logs, { taskOwnedCopies: true })).toEqual([]);
  });

  it("removes content a run of the task writes after the task is deleted", async () => {
    const logs = stores(path.join(baseDir, "task-late"));
    const base = await seedCompany();
    const companyId = base.company.id;
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: base.application.id, name: "Docs late", uid: randomUUID(), transport: "mcp_remote", status: "active",
    }).returning();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: base.agent.id, issueId: base.issue.id, status: "running" });

    await issueService(db).remove(base.issue.id);
    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    await service.processPending(new AbortController().signal);

    const summary = summarizeToolValue({ text: `Late ${marker}` });
    await db.insert(toolInvocations).values({
      companyId, connectionId: connection!.id, runId, agentId: base.agent.id, toolName: "read_doc", status: "succeeded",
      argumentsSummary: summary, resultSummary: summary,
    });
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId: base.agent.id, seq: 1, eventType: "tool.execution.completed", message: marker, payload: { output: marker } });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), stdoutExcerpt: `read_doc -> ${marker}` }).where(eq(heartbeatRuns.id, runId));
    expect((await scan([marker], logs)).length).toBeGreaterThan(0);
    await db.update(issueConnectionContentDeletions).set({ notBefore: new Date() }).where(eq(issueConnectionContentDeletions.issueId, base.issue.id));
    await drainPending(service);
    expect(await scan([marker], logs, { taskOwnedCopies: true })).toEqual([]);
  });

  it("waits for a run that is still going when the task is deleted, then removes its content", async () => {
    const logs = stores(path.join(baseDir, "task-live"));
    const base = await seedCompany();
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    const flow = await seedConnectionFlow(base, logs, marker);
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, flow.callingRunId));

    await issueService(db).remove(base.issue.id);
    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    await service.processPending(new AbortController().signal);
    const [waiting] = await db.select().from(issueConnectionContentDeletions).where(eq(issueConnectionContentDeletions.issueId, base.issue.id));
    expect(waiting).toMatchObject({ status: "pending", lastError: null });
    expect(waiting!.notBefore.getTime()).toBeGreaterThan(Date.now());
    expect((await scan([marker], logs)).some((hit) => hit.startsWith("object store"))).toBe(true);

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, flow.callingRunId));
    await db.update(issueConnectionContentDeletions).set({ notBefore: new Date() }).where(eq(issueConnectionContentDeletions.id, waiting!.id));
    await drainPending(service);
    expect(await scan([marker], logs, { taskOwnedCopies: true })).toEqual([]);
  });

  it("stops waiting a day after the task was deleted and records what was still in progress", async () => {
    const logs = stores(path.join(baseDir, "task-stuck"));
    const base = await seedCompany();
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    const flow = await seedConnectionFlow(base, logs, marker);
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, flow.callingRunId));
    await issueService(db).remove(base.issue.id);
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    await db.update(issueConnectionContentDeletions).set({ requestedAt: old }).where(eq(issueConnectionContentDeletions.issueId, base.issue.id));

    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    await drainPending(service);
    const [job] = await db.select().from(issueConnectionContentDeletions).where(eq(issueConnectionContentDeletions.issueId, base.issue.id));
    expect(job!.status).toBe("completed");
    const [activity] = await db.execute(sql`select details from activity_log
      where company_id = ${base.company.id} and action = 'issue.connection_content_deletion_incomplete'`) as unknown as Array<{ details: Record<string, number> }>;
    expect(activity!.details.runsInProgress + activity!.details.itemsInProgress).toBeGreaterThan(0);
  });

  it("finishes without an activity entry when the deleted task's open run never calls a connection", async () => {
    const logs = stores(path.join(baseDir, "task-open-quiet"));
    const base = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: base.company.id, agentId: base.agent.id, issueId: base.issue.id, status: "running" });
    await issueService(db).remove(base.issue.id);
    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    await service.processPending(new AbortController().signal);
    const [waiting] = await db.select().from(issueConnectionContentDeletions).where(eq(issueConnectionContentDeletions.issueId, base.issue.id));
    expect(waiting!.status).toBe("pending");

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(issueConnectionContentDeletions).set({ notBefore: new Date() }).where(eq(issueConnectionContentDeletions.id, waiting!.id));
    await drainPending(service);
    const [finished] = await db.select().from(issueConnectionContentDeletions).where(eq(issueConnectionContentDeletions.id, waiting!.id));
    expect(finished!.status).toBe("completed");
    expect(await db.execute(sql`select 1 from activity_log where company_id = ${base.company.id}
      and action like 'issue.connection_content_%'`)).toHaveLength(0);
  });

  it("queues nothing when the deleted task never used a connection", async () => {
    const base = await seedCompany();
    await issueService(db).remove(base.issue.id);
    expect(await db.select().from(issueConnectionContentDeletions).where(eq(issueConnectionContentDeletions.issueId, base.issue.id))).toEqual([]);
  });

  it("wakes the cleanup worker when the deleted task has files but never used a connection", async () => {
    const logs = stores(path.join(baseDir, "task-files"));
    const base = await seedCompany();
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    const attached = await logs.storage.putFile({ companyId: base.company.id, namespace: "issues", originalFilename: "notes.txt", contentType: "text/plain",
      body: Buffer.from(`Attached copy of ${marker}`) });
    const [asset] = await db.insert(assets).values({ companyId: base.company.id, ...attached }).returning();
    await db.insert(issueAttachments).values({ companyId: base.company.id, issueId: base.issue.id, assetId: asset!.id });
    let woken = 0;
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.toolConnectionContentDeletion, () => { woken += 1; });
    try {
      await issueService(db).remove(base.issue.id);
    } finally {
      unsubscribe();
    }
    expect(woken).toBeGreaterThan(0);
    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    await drainPending(service);
    expect(await scan([marker], logs, { taskOwnedCopies: true })).toEqual([]);
  });

  it("leaves the marker nowhere after the company is deleted, and keeps another company's content", async () => {
    const logs = stores(path.join(baseDir, "company"));
    const base = await seedCompany();
    const otherBase = await seedCompany();
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    const kept = `CANARY${randomUUID().replace(/-/g, "")}`;
    const flow = await seedConnectionFlow(base, logs, marker);
    await seedDeliveryRun(base, logs, [{ actionRequestId: flow.actionRequest.id, marker }]);
    const otherFlow = await seedConnectionFlow(otherBase, logs, kept);
    await seedDeliveryRun(otherBase, logs, [{ actionRequestId: otherFlow.actionRequest.id, marker: kept }]);
    await seenBefore([marker, kept], logs);

    await db.update(agents).set({ lifecycleState: "terminated" }).where(eq(agents.companyId, base.company.id));
    await deleteCompany(db, base.company.id);
    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    await drainPending(service);

    expect(await scan([marker], logs, { taskOwnedCopies: true })).toEqual([]);
    const remaining = await scan([kept], logs, { taskOwnedCopies: true });
    expect(remaining.some((hit) => hit.startsWith("object store"))).toBe(true);
    expect(remaining.some((hit) => hit.startsWith("file storage"))).toBe(true);
    expect(remaining.some((hit) => hit.startsWith("file "))).toBe(true);
  });

  it("finishes removing a deleted company's files after storage fails once", async () => {
    const logs = stores(path.join(baseDir, "company-retry"));
    const base = await seedCompany();
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    await seedConnectionFlow(base, logs, marker);
    await db.update(agents).set({ lifecycleState: "terminated" }).where(eq(agents.companyId, base.company.id));
    await deleteCompany(db, base.company.id);

    let failures = 1;
    const flaky = {
      ...logs.storage,
      deleteObject: async (...args: Parameters<typeof logs.storage.deleteObject>) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("object storage unavailable");
        }
        return logs.storage.deleteObject(...args);
      },
    };
    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => flaky, objectRetryMs: 0 });
    await expect(service.processPending(new AbortController().signal)).rejects.toThrow("object storage unavailable");
    expect(await service.nextDeadline()).not.toBeNull();
    await drainPending(service);
    expect(await scan([marker], logs, { taskOwnedCopies: true })).toEqual([]);
  });

  it("leaves the marker nowhere after an interrupted deletion resumes", async () => {
    const logs = stores(path.join(baseDir, "interrupted"));
    const base = await seedCompany();
    const marker = `CANARY${randomUUID().replace(/-/g, "")}`;
    const flow = await seedConnectionFlow(base, logs, marker);
    await seedDeliveryRun(base, logs, [{ actionRequestId: flow.actionRequest.id, marker }]);
    await seenBefore([marker], logs);

    let failures = 2;
    const flaky: RunLogStore = {
      ...logs.store,
      remove: async (handle: RunLogHandle, signal?: AbortSignal) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("object storage unavailable");
        }
        return logs.store.remove!(handle, signal);
      },
    };
    const service = createConnectionContentDeletion(db, { runLogStore: () => flaky, storage: () => logs.storage });
    const { deletion } = await service.request(flow.connection, { actorType: "user", actorId: "board-user" });
    let interrupted = 0;
    for (let i = 0; i < 200; i++) {
      const job = await service.process(deletion.id, new AbortController().signal).catch(() => {
        interrupted += 1;
        return null;
      });
      if (job?.status === "completed") break;
    }
    expect(interrupted).toBe(2);
    expect(await scan([marker], logs)).toEqual([]);
    expect(await outOfScopeStillHolds(marker, logs)).toBe(true);
  });

  it("leaves no marker after two deletions for different connections run at the same time on one task", async () => {
    const logs = stores(path.join(baseDir, "concurrent"));
    const base = await seedCompany();
    const first = `CANARY${randomUUID().replace(/-/g, "")}`;
    const second = `CANARY${randomUUID().replace(/-/g, "")}`;
    const flowOne = await seedConnectionFlow(base, logs, first);
    const flowTwo = await seedConnectionFlow(base, logs, second);
    await seedDeliveryRun(base, logs, [
      { actionRequestId: flowOne.actionRequest.id, marker: first },
      { actionRequestId: flowTwo.actionRequest.id, marker: second },
    ]);
    await seenBefore([first, second], logs);

    const service = createConnectionContentDeletion(db, { runLogStore: () => logs.store, storage: () => logs.storage });
    const one = await service.request(flowOne.connection, { actorType: "user", actorId: "board-user" });
    const two = await service.request(flowTwo.connection, { actorType: "user", actorId: "board-user" });
    await drain(service, [one.deletion.id, two.deletion.id]);

    expect(await scan([first, second], logs)).toEqual([]);
    expect(await outOfScopeStillHolds(first, logs)).toBe(true);
    expect(await outOfScopeStillHolds(second, logs)).toBe(true);
  });
});
