import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentApiKeys, agentWakeupRequests, agents, authSessions, authUsers, boardApiKeys, companyMemberships, principalPermissionGrants, caseAccessSources, caseEvents, caseHandoffs, caseIssueLinks, cases, companies, createDb, documentRevisions, documents, dotAgentBindings, heartbeatRuns, issueComments, issueDocuments, issues, issueWorkProducts } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { caseHandoffRoutes } from "../routes/case-handoffs.js";
import { errorHandler } from "../middleware/error-handler.js";
import { resolveCloudTenantActor } from "../middleware/auth.js";
import { caseHandoffService } from "./case-handoffs.js";
import { caseHandoffDeliveryService } from "./case-handoff-delivery.js";
import { completeTerminalCaseHandoffsForIssue, pendingCaseHandoffForRun, recordCaseHandoffExecutionReleased } from "./heartbeat/case-handoff-lifecycle.js";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { instanceSettingsService } from "./instance-settings.js";
import { getCaseExecutionContext } from "./case-context.js";
import { canActorReadCase, retainCaseAccessSource } from "./case-access.js";
import { buildNativeExecutionInput } from "./native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import { buildLowTrustSourceTrust } from "./source-trust.js";
import { issueService } from "./issues.js";
import { documentService } from "./documents.js";
import type { AuthorizationActor } from "./authorization.js";
import { recoveryService } from "./recovery/service.js";
import { enrichCaseWork } from "./case-work-summary.js";
import { workflowService } from "./workflows.js";

describe("durable same-task case handoffs", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const board = { type: "board" as const, source: "local_implicit" as const };
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("case-handoffs-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
  });
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(caseHandoffs); await db.delete(caseIssueLinks); await db.delete(cases);
    await db.delete(documentRevisions); await db.delete(documents);
    await db.delete(issues); await db.delete(heartbeatRuns); await db.delete(agentWakeupRequests);
    await db.delete(agentApiKeys); await db.delete(boardApiKeys); await db.delete(authSessions);
    await db.delete(principalPermissionGrants); await db.delete(companyMemberships); await db.delete(authUsers);
    await db.delete(agents); await db.delete(companies);
  });

  async function fixture() {
    const companyId = randomUUID(), triage = randomUUID(), engineer = randomUUID(), verifier = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Factory", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: triage, companyId, name: "Triage", role: "ceo", status: "active", adapterType: "process" },
      { id: engineer, companyId, name: "Engineer", role: "engineer", status: "active", adapterType: "process", reportsTo: triage },
      { id: verifier, companyId, name: "Verifier", role: "engineer", status: "active", adapterType: "process", reportsTo: triage },
    ]);
    const service = caseHandoffService(db);
    const input = { idempotencyKey: randomUUID(), case: { create: { caseType: "work", title: "Implement the feature", summary: "Overall objective", fields: { acceptance: "Verified" } } },
      toAgentId: triage, phase: "triage", instructions: "Research and decide the next step",
      workflow_document_text: "# Workflow\nTriage → implementation → verification → corrections → done." };
    return { companyId, triage, engineer, verifier, service, input };
  }

  function queue(now: () => Date, crashAfterCommit = false) {
    const wakeup = vi.fn(async (agentId: string, options: any) => {
      const receipt = options.durableCaseHandoffRequest;
      await db.insert(agentWakeupRequests).values({ id: receipt.wakeupRequestId, companyId: (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.companyId,
        agentId, source: options.source, status: "queued", reason: options.reason, payload: options.payload, idempotencyKey: options.idempotencyKey }).onConflictDoNothing();
      if (crashAfterCommit) throw new Error("Connection lost after queue commit");
      return { id: receipt.wakeupRequestId };
    });
    return { wakeup, worker: caseHandoffDeliveryService(db, { heartbeat: { wakeup } as any, now }) };
  }

  async function sourceRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "legacy", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
    await db.update(issues).set({ status: "in_progress", executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    return runId;
  }

  async function delayedTransfer(prepare?: (f: Awaited<ReturnType<typeof fixture>>, taskId: string, runId: string) => Promise<AuthorizationActor | void>) {
    const f = await fixture();
    let at = new Date(Date.now() + 60_000);
    const q = queue(() => at);
    const first = await f.service.handoff(f.companyId, board, f.input);
    await q.worker.sweepPending();
    const runId = await sourceRun(f.companyId, f.triage, first.taskId);
    const actor = await prepare?.(f, first.taskId, runId) ?? {
      type: "agent", agentId: f.triage, companyId: f.companyId, runId, source: "agent_jwt",
    } satisfies AuthorizationActor;
    const [task] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const receipt = await f.service.handoff(f.companyId, actor, { case: { id: first.caseId }, idempotencyKey: randomUUID(),
      expectedHandoffVersion: 1, expectedIssueStatusVersion: task!.statusVersion,
      toAgentId: f.engineer, phase: "implementation", instructions: "Use the saved findings" });
    expect(receipt.state).toBe("awaiting_release");
    return { ...f, first, runId, actor, task: task!, receipt, q,
      async release() {
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
        await recordCaseHandoffExecutionReleased(db, runId, first.taskId);
      },
      async sweep() { at = new Date(at.getTime() + 60_000); await q.worker.sweepPending(); },
      async assertHeld(message: RegExp) {
        const [handoff] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId));
        expect(handoff).toMatchObject({ state: "awaiting_release", lastErrorCode: "access_or_admission_blocked" });
        expect(handoff!.lastError).toMatch(message);
        expect((await db.select().from(issues).where(eq(issues.id, first.taskId)))[0])
          .toMatchObject({ assigneeAgentId: f.triage, status: task!.status, statusVersion: task!.statusVersion });
        expect((await db.select().from(cases).where(eq(cases.id, first.caseId)))[0]!.phase).toBe("triage");
        expect(q.wakeup).toHaveBeenCalledTimes(1);
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, handoff!.wakeupRequestId))).toEqual([]);
      },
    };
  }

  async function cloudTransfer() {
    const userId = randomUUID(), stackId = `stack-${randomUUID()}`, stackSlug = "handoff-cloud";
    const state: { role: string; status: number; body?: unknown; afterResponse?: () => void } = { role: "owner", status: 200 };
    const requests: Array<{ path: string; userId: string | undefined; stackId: string | undefined; authenticated: boolean }> = [];
    const backend = createServer((req, res) => {
      requests.push({ path: req.url!, userId: req.headers["x-paperclip-cloud-user-id"] as string | undefined,
        stackId: req.headers["x-paperclip-cloud-stack-id"] as string | undefined,
        authenticated: req.headers.authorization === "Bearer cloud-authority-test-token" });
      res.writeHead(state.status, { "content-type": "application/json" });
      res.end(JSON.stringify(state.body ?? { stacks: [{ stackSlug, role: state.role, isCurrent: true }] }));
      state.afterResponse?.();
    });
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "cloud-authority-test-token");
    vi.stubEnv("PAPERCLIP_CLOUD_API_ORIGIN", `http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", stackId);
    vi.stubEnv("PAPERCLIP_STACK_SLUG", stackSlug);
    const flag = (enabled: boolean) => vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "test",
      features: { enableCases: true, enableOwnerInstanceAdmin: enabled }, plugins: { autoInstall: [] } }));
    flag(true);
    const close = async () => { await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve())); vi.unstubAllEnvs(); };
    try {
      const f = await delayedTransfer(async (f) => {
        await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
        await db.update(agents).set({ permissions: { authorizationPolicy: { protectedAgent: { blockAssignment: true } } } }).where(eq(agents.id, f.engineer));
        const headers: Record<string, string> = { "x-paperclip-cloud-tenant-token": "cloud-authority-test-token", "x-paperclip-cloud-user-id": userId,
          "x-paperclip-cloud-user-email": `${userId}@example.test`, "x-paperclip-cloud-stack-id": stackId, "x-paperclip-cloud-stack-role": "owner" };
        const actor = await resolveCloudTenantActor(db, { header: name => headers[name] });
        expect(actor).toMatchObject({ type: "board", source: "cloud_tenant", userId, isInstanceAdmin: true });
        return actor!;
      });
      expect(requests).toHaveLength(0); // Remote revalidation belongs to delayed apply.
      return { ...f, state, requests, stackSlug, stackId, userId, flag, close };
    } catch (error) { await close(); throw error; }
  }

  async function terminalFixture() {
    const f = await fixture(), q = queue(() => new Date(Date.now() + 60_000));
    const first = await f.service.handoff(f.companyId, board, { ...f.input, toAgentId: f.engineer });
    await q.worker.sweepPending();
    const runId = await sourceRun(f.companyId, f.engineer, first.taskId);
    const actor = { type: "agent" as const, companyId: f.companyId, agentId: f.engineer, runId, source: "agent_key" as const };
    const [issue] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const input = { to: "done" as const, phase: "done" as const, case: { id: first.caseId }, idempotencyKey: randomUUID(),
      instructions: "The saved findings are ready; close the case after ordinary task completion.",
      expectedHandoffVersion: 1, expectedIssueStatusVersion: issue!.statusVersion };
    return { ...f, q, first, runId, actor, input };
  }

  it("reuses definitions, moves A → B → A, refreshes, and detaches without replacing the task", async () => {
    const f = await fixture(), q = queue(() => new Date(Date.now() + 60_000));
    const definitions = workflowService(db), docs = documentService(db);
    const a = await definitions.write(f.companyId, board, { name: "Research", prompt: "Research the question." });
    const b = await definitions.write(f.companyId, board, { name: "Delivery", prompt: "Deliver the findings." });
    const { workflow_document_text: _inline, ...kickoff } = f.input;
    const first = await f.service.handoff(f.companyId, board, { ...kickoff, workflowId: a.id });
    const second = await f.service.handoff(f.companyId, board, { ...kickoff, idempotencyKey: randomUUID(), workflowId: a.id });
    await q.worker.sweepPending();
    await definitions.write(f.companyId, board, { name: "Research renamed", prompt: "Research with citations." }, a.id);
    expect((await docs.getIssueDocumentByKey(first.taskId, "workflow"))?.body).toBe(a.prompt);
    expect((await docs.getIssueDocumentByKey(second.taskId, "workflow"))?.body).toBe(a.prompt);
    for (const [index, workflowId] of [b.id, a.id, a.id, null].entries()) {
      const [task] = await db.select().from(issues).where(eq(issues.id, first.taskId));
      const input = { case: { id: first.caseId }, idempotencyKey: randomUUID(), workflowId,
        expectedHandoffVersion: index + 1, expectedIssueStatusVersion: task!.statusVersion,
        toAgentId: f.triage, phase: `custom phase ${index}`, instructions: "Continue with this procedure." };
      const accepted = await f.service.handoff(f.companyId, board, input);
      expect(accepted.taskId).toBe(first.taskId);
      expect(await f.service.handoff(f.companyId, board, input)).toMatchObject({ handoffId: accepted.handoffId, replayed: true });
      await q.worker.sweepPending();
    }
    const [current] = await db.select().from(cases).where(eq(cases.id, first.caseId));
    expect(current).toMatchObject({ workflowId: null, phase: "custom phase 3", workIssueId: first.taskId });
    expect((await docs.getIssueDocumentByKey(first.taskId, "workflow"))?.body).toBe("Research with citations.");
    expect(await docs.listIssueDocumentRevisions(first.taskId, "workflow")).toHaveLength(4);
    const history = await f.service.list(board, first.caseId);
    expect(history.items).toHaveLength(5);
    expect(history.items.at(-1)?.workflowTransition?.to.name).toBe("Research");
    expect(history.items[1]?.workflowTransition?.to.name).toBe("Research renamed");
    expect(history.items.every(item => !("workflowPrompt" in item) && !("baseWorkflowDocumentRevisionId" in item))).toBe(true);
  });

  it("captures pending prompts, preserves intervening edits, and cancels without adopting", async () => {
    const f = await fixture(), docs = documentService(db), definitions = workflowService(db);
    let at = new Date(Date.now() + 60_000);
    const q = queue(() => at);
    const first = await f.service.handoff(f.companyId, board, f.input);
    await q.worker.sweepPending();
    const workflow = await definitions.write(f.companyId, board, { name: "New procedure", prompt: "Accepted prompt" });
    const runId = await sourceRun(f.companyId, f.triage, first.taskId);
    const [task] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const receipt = await f.service.handoff(f.companyId, board, { case: { id: first.caseId }, workflowId: workflow.id,
      idempotencyKey: randomUUID(), expectedHandoffVersion: 1, expectedIssueStatusVersion: task!.statusVersion,
      toAgentId: f.engineer, phase: "arbitrary next phase", instructions: "Adopt on transfer" });
    expect(receipt.state).toBe("awaiting_release");
    await definitions.write(f.companyId, board, { prompt: "Edited shared prompt" }, workflow.id);
    const original = await docs.getIssueDocumentByKey(first.taskId, "workflow");
    await docs.upsertIssueDocument({ issueId: first.taskId, key: "workflow", format: "markdown",
      body: "Intervening case edit", baseRevisionId: original!.latestRevisionId });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await recordCaseHandoffExecutionReleased(db, runId, first.taskId);
    at = new Date(at.getTime() + 60_000);
    await q.worker.sweepPending();
    const [pending] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId));
    expect(pending).toMatchObject({ workflowPrompt: "Accepted prompt", assignmentAppliedAt: null });
    expect(pending!.lastError).toBe("Document was updated by someone else");
    expect((await db.select().from(cases).where(eq(cases.id, first.caseId)))[0]).toMatchObject({ workflowId: null, phase: "triage" });
    await f.service.cancel(board, first.caseId, receipt.handoffId);
    expect((await docs.getIssueDocumentByKey(first.taskId, "workflow"))?.body).toBe("Intervening case edit");
    expect(await docs.listIssueDocumentRevisions(first.taskId, "workflow")).toHaveLength(2);
    const next = await caseHandoffService(db).handoff(f.companyId, board, { case: { id: first.caseId }, workflowId: workflow.id,
      idempotencyKey: randomUUID(), expectedHandoffVersion: 2, expectedIssueStatusVersion: task!.statusVersion,
      toAgentId: f.engineer, phase: "retry with current document", instructions: "Adopt after re-reading" });
    await definitions.write(f.companyId, board, { prompt: "Changed after acceptance again" }, workflow.id);
    at = new Date(at.getTime() + 60_000);
    await queue(() => at, true).worker.sweepPending();
    at = new Date(at.getTime() + 120_000);
    await queue(() => at).worker.sweepPending();
    expect((await docs.getIssueDocumentByKey(first.taskId, "workflow"))?.body).toBe("Edited shared prompt");
    expect(await docs.listIssueDocumentRevisions(first.taskId, "workflow")).toHaveLength(3);
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, next.handoffId)))[0]).toMatchObject({ state: "delivered" });
  });

  it("creates one initial task through REST and replays lost responses without title dedupe", async () => {
    const f = await fixture();
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = board; next(); });
    app.use("/api", caseHandoffRoutes(db)); app.use(errorHandler);
    const first = await request(app).post(`/api/companies/${f.companyId}/case-handoffs`).send(f.input).expect(202);
    const replay = await request(app).post(`/api/companies/${f.companyId}/case-handoffs`).send(f.input).expect(200);
    expect(replay.body).toMatchObject({ taskId: first.body.taskId, handoffId: first.body.handoffId, replayed: true });
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, first.body.taskId))).toHaveLength(1);
    expect(await documentService(db).getIssueDocumentByKey(first.body.taskId, "workflow"))
      .toMatchObject({ key: "workflow", title: "Workflow", format: "markdown", body: f.input.workflow_document_text, latestRevisionNumber: 1 });
    expect(await documentService(db).listIssueDocumentRevisions(first.body.taskId, "workflow")).toHaveLength(1);
    await request(app).post(`/api/companies/${f.companyId}/case-handoffs`).send({ ...f.input, workflow_document_text: "Changed workflow" }).expect(409);
    const second = await f.service.handoff(f.companyId, board, { ...f.input, idempotencyKey: randomUUID() });
    expect(second.taskId).not.toBe(first.body.taskId);
    await request(app).post(`/api/companies/${f.companyId}/case-handoffs`).send({ ...f.input, instructions: "Different" }).expect(409);
  });

  it("rejects missing, blank, colliding or oversized workflow seed inputs through REST without side effects", async () => {
    const f = await fixture();
    const app = express(); app.use(express.json({ limit: "1mb" })); app.use((req, _res, next) => { req.actor = board; next(); });
    app.use("/api", caseHandoffRoutes(db)); app.use(errorHandler);
    for (const override of [{ workflow_document_text: undefined }, { workflow_document_text: " \n\t " },
      { workflow_document_text: "x".repeat(200_001) },
      { initialDocuments: [{ key: " Workflow ", title: "Conflicting workflow", body: "Do something else" }] },
      { workflow_document_text: "x".repeat(200_000), initialDocuments: [{ key: "brief", title: "Brief", body: "x" }] }]) {
      await request(app).post(`/api/companies/${f.companyId}/case-handoffs`).send({ ...f.input, ...override }).expect(400);
    }
    for (const table of [cases, issues, documents, documentRevisions, caseHandoffs, caseEvents, issueComments, activityLog, agentWakeupRequests]) {
      expect(await db.select().from(table).where(eq(table.companyId, f.companyId))).toHaveLength(0);
    }
  });

  it("requires a workflow when starting a passive case but leaves legacy task binding available", async () => {
    const f = await fixture();
    const [passive] = await db.insert(cases).values({ companyId: f.companyId, caseNumber: 1,
      identifier: `${f.companyId}-C1`, caseType: "work", title: "Legacy passive case" }).returning();
    const { workflow_document_text: _workflow, ...base } = f.input;
    const input = { ...base, case: { id: passive!.id }, expectedHandoffVersion: 0 };
    await expect(f.service.handoff(f.companyId, board, input)).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(documents).where(eq(documents.companyId, f.companyId))).toHaveLength(0);
    expect((await db.select().from(cases).where(eq(cases.id, passive!.id)))[0]).toMatchObject({ workIssueId: null, handoffVersion: 0 });
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Existing task", status: "todo", assigneeAgentId: f.triage }).returning();
    const bound = await f.service.handoff(f.companyId, board, { ...input, bindIssueId: task!.id, expectedIssueStatusVersion: task!.statusVersion });
    expect(bound.taskId).toBe(task!.id);
    expect(await documentService(db).listIssueDocuments(task!.id)).toEqual([]);
  });

  it("seeds the workflow on a newly created case's bound task and replays exactly one revision", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Keep this title", description: "Keep this objective",
      status: "todo", assigneeAgentId: f.triage }).returning();
    const input = { ...f.input, bindIssueId: task!.id, expectedIssueStatusVersion: task!.statusVersion };
    const first = await f.service.handoff(f.companyId, board, input);
    expect(await f.service.handoff(f.companyId, board, input)).toMatchObject({ taskId: task!.id, caseId: first.caseId, replayed: true });
    expect((await db.select().from(issues).where(eq(issues.id, task!.id)))[0]).toMatchObject({ title: task!.title, description: task!.description });
    expect(await documentService(db).getIssueDocumentByKey(task!.id, "workflow")).toMatchObject({ title: "Workflow", body: input.workflow_document_text });
    expect(await documentService(db).listIssueDocumentRevisions(task!.id, "workflow")).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
  });

  it("rolls back new-case binding if the task already has a workflow document", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Existing task", status: "todo", assigneeAgentId: f.triage }).returning();
    const before = await documentService(db).upsertIssueDocument({ issueId: task!.id, key: "workflow", title: "Original workflow", format: "markdown", body: "Keep this workflow" });
    await expect(f.service.handoff(f.companyId, board, { ...f.input, bindIssueId: task!.id,
      expectedIssueStatusVersion: task!.statusVersion })).rejects.toMatchObject({ status: 409 });
    expect(await documentService(db).getIssueDocumentByKey(task!.id, "workflow")).toMatchObject({ body: "Keep this workflow", latestRevisionId: before.document.latestRevisionId });
    expect(await documentService(db).listIssueDocumentRevisions(task!.id, "workflow")).toHaveLength(1);
    for (const table of [cases, caseHandoffs, caseEvents, issueComments, activityLog, agentWakeupRequests]) {
      expect(await db.select().from(table).where(eq(table.companyId, f.companyId))).toHaveLength(0);
    }
    expect((await db.select().from(issues).where(eq(issues.id, task!.id)))[0]).toMatchObject({ statusVersion: task!.statusVersion, assigneeAgentId: f.triage });
  });

  it("rejects workflow replacement on an existing primary task without changing its document", async () => {
    const f = await fixture(), first = await f.service.handoff(f.companyId, board, f.input);
    const [task] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    await expect(f.service.handoff(f.companyId, board, { ...f.input, case: { id: first.caseId }, idempotencyKey: randomUUID(),
      expectedHandoffVersion: 1, expectedIssueStatusVersion: task!.statusVersion, workflow_document_text: "Overwrite it" })).rejects.toMatchObject({ status: 422 });
    expect(await documentService(db).getIssueDocumentByKey(first.taskId, "workflow")).toMatchObject({ body: f.input.workflow_document_text, latestRevisionNumber: 1 });
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, first.caseId))).toHaveLength(1);
  });

  it("commits ordinary task documents before wake delivery and replays without extra revisions", async () => {
    const f = await fixture();
    const input = { ...f.input, workflow_document_text: "  # Workflow\r\nPreserve literal \\n in the example.\n ",
      initialDocuments: [{ key: " Brief ", title: "Brief", body: "Research the receipt" },
      { key: "plan", title: "Plan", body: "Validate\\nImplement" }] };
    const first = await f.service.handoff(f.companyId, board, input);
    const observed = vi.fn(async (_agentId: string, options: any) => {
      expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, first.taskId))).toHaveLength(3);
      expect(await db.select().from(documentRevisions).where(eq(documentRevisions.companyId, f.companyId))).toHaveLength(3);
      expect(await documentService(db).getIssueDocumentByKey(first.taskId, "workflow"))
        .toMatchObject({ title: "Workflow", body: input.workflow_document_text, latestRevisionNumber: 1 });
      const receipt = options.durableCaseHandoffRequest;
      await db.insert(agentWakeupRequests).values({ id: receipt.wakeupRequestId, companyId: f.companyId,
        agentId: f.triage, source: options.source, status: "queued", reason: options.reason, payload: options.payload,
        idempotencyKey: options.idempotencyKey });
      return { id: receipt.wakeupRequestId };
    });
    await caseHandoffDeliveryService(db, { heartbeat: { wakeup: observed } as any,
      now: () => new Date(Date.now() + 60_000) }).sweepPending();
    expect(observed).toHaveBeenCalledTimes(1);
    const replay = await f.service.handoff(f.companyId, board, input);
    expect(replay).toMatchObject({ handoffId: first.handoffId, caseId: first.caseId, taskId: first.taskId, replayed: true });
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(documents).where(eq(documents.companyId, f.companyId))).toHaveLength(3);
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.companyId, f.companyId))).toHaveLength(3);
    expect((await db.select().from(documents).where(eq(documents.title, "Plan")))[0]).toMatchObject({ latestBody: "Validate\nImplement",
      latestRevisionNumber: 1 });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "issue.document_created")))).toHaveLength(3);
    await expect(f.service.handoff(f.companyId, board, { ...input,
      initialDocuments: [{ key: "brief", title: "Brief", body: "Changed" }] })).rejects.toMatchObject({ status: 409 });
  });

  it("starts a passive case with documents without making another case", async () => {
    const f = await fixture();
    const [passive] = await db.insert(cases).values({ companyId: f.companyId, caseNumber: 1,
      identifier: `${f.companyId}-C1`, caseType: "work", title: "Passive research" }).returning();
    const first = await f.service.handoff(f.companyId, board, { ...f.input, case: { id: passive!.id }, expectedHandoffVersion: 0,
      initialDocuments: [{ key: "research", title: "Research", body: "Initial findings" }] });
    expect(first.caseId).toBe(passive!.id);
    expect(await db.select().from(cases).where(eq(cases.companyId, f.companyId))).toHaveLength(1);
    expect((await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, first.taskId))).map(row => row.key).sort()).toEqual(["research", "workflow"]);
  });

  it("preserves source-run attribution and normal private task ownership for initial documents", async () => {
    const f = await fixture(), sourceId = randomUUID();
    await db.insert(issues).values({ id: sourceId, companyId: f.companyId, title: "Private intake",
      visibility: "private", assigneeAgentId: f.triage });
    const runId = await sourceRun(f.companyId, f.triage, sourceId);
    const actor = { type: "agent" as const, companyId: f.companyId, agentId: f.triage, runId, source: "agent_key" as const };
    const first = await f.service.handoff(f.companyId, actor, { ...f.input, toAgentId: f.engineer,
      initialDocuments: [{ key: "brief", title: "Brief", body: "Private findings" }] });
    expect((await db.select().from(issues).where(eq(issues.id, first.taskId)))[0]).toMatchObject({ parentId: sourceId,
      visibility: "private", assigneeAgentId: f.engineer, originRunId: runId });
    expect((await db.select().from(documents).where(eq(documents.companyId, f.companyId)))[0])
      .toMatchObject({ createdByAgentId: f.triage, createdByUserId: null, sourceTrust: null });
    expect((await db.select().from(documentRevisions).where(eq(documentRevisions.companyId, f.companyId)))[0])
      .toMatchObject({ createdByAgentId: f.triage, createdByUserId: null, createdByRunId: runId, revisionNumber: 1 });
    expect(await canActorReadCase(db, { type: "agent", companyId: f.companyId, agentId: f.verifier },
      { id: first.caseId, companyId: f.companyId })).toBe(false);
  });

  it("rolls back case, task, earlier document, revision, history and audit if a document write fails", async () => {
    const f = await fixture();
    await db.execute(sql`alter table documents add constraint case_initial_document_test_failure check (title <> 'Reject document')`);
    try {
      await expect(f.service.handoff(f.companyId, board, { ...f.input, initialDocuments: [
        { key: "first", title: "First", body: "This insert succeeds before the controlled fault" },
        { key: "fail", title: "Reject document", body: "This insert fails" },
      ] })).rejects.toThrow();
      for (const table of [cases, issues, documents, documentRevisions, caseHandoffs, caseEvents, issueComments, activityLog, agentWakeupRequests]) {
        expect(await db.select().from(table).where(eq(table.companyId, f.companyId))).toHaveLength(0);
      }
    } finally {
      await db.execute(sql`alter table documents drop constraint case_initial_document_test_failure`);
    }
  });

  it("rejects initial documents on existing work without mutating its documents or routing", async () => {
    const f = await fixture(), first = await f.service.handoff(f.companyId, board, f.input);
    const [issue] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    await expect(f.service.handoff(f.companyId, board, { ...f.input, idempotencyKey: randomUUID(), case: { id: first.caseId },
      expectedHandoffVersion: 1, expectedIssueStatusVersion: issue!.statusVersion,
      initialDocuments: [{ key: "late", title: "Late", body: "Must not be attached" }] })).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, first.taskId))).toMatchObject([{ key: "workflow" }]);
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, first.caseId))).toHaveLength(1);
    expect((await db.select().from(cases).where(eq(cases.id, first.caseId)))[0]).toMatchObject({ handoffVersion: 1 });
  });

  it.each(["unknown", "pending_approval", "terminated"] as const)("rejects an %s recipient with 422 before creating case work", async status => {
    const f = await fixture();
    const toAgentId = status === "unknown" ? randomUUID() : f.triage;
    if (status !== "unknown") await db.update(agents).set({ status }).where(eq(agents.id, toAgentId));
    await expect(f.service.handoff(f.companyId, board, { ...f.input, toAgentId })).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(cases).where(eq(cases.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.companyId, f.companyId))).toHaveLength(0);
  });

  it.each(["protected", "cycle"] as const)("keeps an implicit %s source parent from creating an unauthorized child", async reason => {
    const f = await fixture(), sourceId = randomUUID();
    await db.insert(issues).values({ id: sourceId, companyId: f.companyId, title: "Intake task", assigneeAgentId: f.triage,
      createdByAgentId: reason === "cycle" ? f.engineer : null,
      executionPolicy: reason === "protected" ? { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } : null });
    const runId = await sourceRun(f.companyId, f.triage, sourceId);
    const kickoff = await f.service.handoff(f.companyId, { type: "agent", companyId: f.companyId, agentId: f.triage, runId, source: "agent_key" }, {
      ...f.input, toAgentId: f.engineer,
    });
    const [task] = await db.select().from(issues).where(eq(issues.id, kickoff.taskId));
    expect(task).toMatchObject({ parentId: null, originRunId: runId, assigneeAgentId: f.engineer });
    expect(await db.select().from(issues).where(eq(issues.parentId, sourceId))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(2);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, kickoff.taskId))).toHaveLength(1);
  });

  it("does not discard a retained private parent when child assignment is protected", async () => {
    const f = await fixture(), sourceId = randomUUID(), caseId = randomUUID();
    await db.insert(issues).values({ id: sourceId, companyId: f.companyId, title: "Private retained source", visibility: "private", assigneeAgentId: f.triage,
      executionPolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } });
    await db.insert(cases).values({ id: caseId, companyId: f.companyId, caseNumber: 1, identifier: `${f.companyId}-C1`, caseType: "work", title: "Private research" });
    await retainCaseAccessSource(db, { companyId: f.companyId, caseId, sourceKind: "issue", sourceId });
    const runId = await sourceRun(f.companyId, f.triage, sourceId);
    await expect(f.service.handoff(f.companyId, { type: "agent", companyId: f.companyId, agentId: f.triage, runId, source: "agent_key" }, {
      case: { id: caseId }, expectedHandoffVersion: 0, idempotencyKey: randomUUID(), toAgentId: f.engineer, phase: "triage", instructions: "Confidential findings",
      workflow_document_text: f.input.workflow_document_text,
    })).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, caseId))).toHaveLength(0);
    expect((await db.select().from(cases).where(eq(cases.id, caseId)))[0]).toMatchObject({ workIssueId: null, handoffVersion: 0 });
  });

  it("serializes concurrent routing and keeps the same task through correction rounds", async () => {
    const f = await fixture(); let at = new Date(Date.now() + 60_000); const q = queue(() => at);
    const first = await f.service.handoff(f.companyId, board, f.input);
    await q.worker.sweepPending();
    const [initial] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const next = { idempotencyKey: randomUUID(), case: { id: first.caseId }, expectedHandoffVersion: 1,
      expectedIssueStatusVersion: initial!.statusVersion, toAgentId: f.engineer, phase: "implementation", instructions: "Implement the researched solution" };
    const raced = await Promise.allSettled([f.service.handoff(f.companyId, board, next), f.service.handoff(f.companyId, board, { ...next, idempotencyKey: randomUUID() })]);
    expect(raced.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter(item => item.status === "rejected")).toHaveLength(1);
    await q.worker.sweepPending();
    for (const [phase, toAgentId] of [["verification", f.verifier], ["implementation", f.engineer]] as const) {
      const [caseRow] = await db.select().from(cases).where(eq(cases.id, first.caseId));
      const [issue] = await db.select().from(issues).where(eq(issues.id, first.taskId));
      const handoff = await f.service.handoff(f.companyId, board, { case: { id: first.caseId }, idempotencyKey: randomUUID(),
        expectedHandoffVersion: caseRow!.handoffVersion, expectedIssueStatusVersion: issue!.statusVersion,
        toAgentId, phase, instructions: `Continue ${phase}` });
      expect(handoff.taskId).toBe(first.taskId); at = new Date(at.getTime() + 60_000); await q.worker.sweepPending();
    }
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect((await db.select().from(cases).where(eq(cases.id, first.caseId)))[0]).toMatchObject({ phase: "implementation", handoffVersion: 4, status: "draft" });
    expect((await f.service.list(board, first.caseId)).items[0]).toMatchObject({ toAgentName: "Engineer", canControl: false });
    const resumedRun = await sourceRun(f.companyId, f.engineer, first.taskId);
    const productId = randomUUID();
    await db.insert(issueWorkProducts).values({ id: productId, companyId: f.companyId, issueId: first.taskId, type: "pull_request", provider: "github",
      title: "Implementation pull request", status: "ready", url: "https://example.test/pull/1" });
    const referenceContext = await getCaseExecutionContext(db, { companyId: f.companyId, issueId: first.taskId, agentId: f.engineer, runId: resumedRun });
    expect(JSON.parse(referenceContext!.data).workProducts).toEqual(expect.arrayContaining([expect.objectContaining({ id: productId,
      readPath: `/api/issues/${first.taskId}/work-products` })]));
    await db.update(cases).set({ fields: { result: "x".repeat(20_000) } }).where(eq(cases.id, first.caseId));
    const context = await getCaseExecutionContext(db, { companyId: f.companyId, issueId: first.taskId, agentId: f.engineer, runId: resumedRun });
    expect(context).toMatchObject({ phase: "implementation", handoffVersion: 4, taskId: first.taskId, omitted: true });
    expect(context!.incomingHandoff!.instructions).toContain("Continue implementation");
    expect(context!.data.length).toBeLessThanOrEqual(12_000);
    expect(context!.issueStatusVersion).toBe((await db.select().from(issues).where(eq(issues.id, first.taskId)))[0]!.statusVersion);
  });

  it("waits for authoritative process settlement and survives a worker restart", async () => {
    const f = await fixture(); let at = new Date(Date.now() + 60_000); const q = queue(() => at);
    const first = await f.service.handoff(f.companyId, board, f.input); await q.worker.sweepPending();
    const runId = await sourceRun(f.companyId, f.triage, first.taskId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const next = await f.service.handoff(f.companyId, board, { case: { id: first.caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 1,
      expectedIssueStatusVersion: issue!.statusVersion, toAgentId: f.engineer, phase: "implementation", instructions: "Use these findings" });
    expect(next.state).toBe("awaiting_release");
    await q.worker.sweepPending(); expect(q.wakeup).toHaveBeenCalledTimes(1);
    // A terminal DB status is deliberately insufficient while a process or its
    // workspace might still be alive.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    at = new Date(at.getTime() + 60_000); await q.worker.sweepPending(); expect(q.wakeup).toHaveBeenCalledTimes(1);
    await recordCaseHandoffExecutionReleased(db, runId, first.taskId);
    at = new Date(at.getTime() + 60_000);
    const restarted = queue(() => at); await restarted.worker.sweepPending();
    expect(restarted.wakeup).toHaveBeenCalledTimes(1);
    expect((await db.select().from(issues).where(eq(issues.id, first.taskId)))[0]).toMatchObject({ assigneeAgentId: f.engineer, status: "todo", executionRunId: null, checkoutRunId: null });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, next.handoffId)))[0]!.state).toBe("delivered");
  });

  it("excludes awaiting and cancelled self-handoff instructions from execution context", async () => {
    const f = await fixture(), q = queue(() => new Date(Date.now() + 60_000));
    const first = await f.service.handoff(f.companyId, board, f.input); await q.worker.sweepPending();
    const runId = await sourceRun(f.companyId, f.triage, first.taskId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const instructions = "UNAPPLIED_SELF_HANDOFF_INSTRUCTIONS";
    const next = await f.service.handoff(f.companyId, { type: "agent", companyId: f.companyId, agentId: f.triage, runId, source: "agent_key" }, {
      case: { id: first.caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 1,
      expectedIssueStatusVersion: issue!.statusVersion, toAgentId: f.triage, phase: "specification", instructions,
    });
    expect(next.state).toBe("awaiting_release");
    const awaiting = await getCaseExecutionContext(db, { companyId: f.companyId, issueId: first.taskId, agentId: f.triage, runId });
    expect(awaiting).toMatchObject({ phase: "triage", handoffVersion: 2, incomingHandoff: null });
    expect(JSON.stringify(awaiting)).not.toContain(instructions);

    expect(await f.service.cancel(board, first.caseId, next.handoffId)).toMatchObject({ state: "cancelled" });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
    await recordCaseHandoffExecutionReleased(db, runId, first.taskId);
    const resumedRunId = await sourceRun(f.companyId, f.triage, first.taskId);
    const resumed = await getCaseExecutionContext(db, { companyId: f.companyId, issueId: first.taskId, agentId: f.triage, runId: resumedRunId });
    expect(resumed).toMatchObject({ phase: "triage", handoffVersion: 2, incomingHandoff: null });
    expect(JSON.stringify(resumed)).not.toContain(instructions);

    await db.update(issues).set({ workMode: "skill_test" }).where(eq(issues.id, first.taskId));
    expect(await getCaseExecutionContext(db, { companyId: f.companyId, issueId: first.taskId, agentId: f.triage, runId: resumedRunId })).toBeNull();
    await db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, first.taskId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: first.taskId, paperclipAgentJwtScope: { kind: "skill_test", issueId: first.taskId } } })
      .where(eq(heartbeatRuns.id, resumedRunId));
    expect(await getCaseExecutionContext(db, { companyId: f.companyId, issueId: first.taskId, agentId: f.triage, runId: resumedRunId })).toBeNull();
  });

  it("withdraws deleted incoming instruction comments without copying their retained old body", async () => {
    const f = await fixture(), q = queue(() => new Date(Date.now() + 60_000));
    const original = "DELETED_CASE_HANDOFF_SOURCE_BODY";
    const first = await f.service.handoff(f.companyId, board, { ...f.input, instructions: original });
    await q.worker.sweepPending();
    const runId = await sourceRun(f.companyId, f.triage, first.taskId);
    const [handoff] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, first.handoffId));
    const before = await getCaseExecutionContext(db, { companyId: f.companyId, issueId: first.taskId, agentId: f.triage, runId });
    expect(before!.incomingHandoff!.instructions).toContain(original);
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, handoff!.commentId!));
    const after = await getCaseExecutionContext(db, { companyId: f.companyId, issueId: first.taskId, agentId: f.triage, runId });
    expect(after!.incomingHandoff).toMatchObject({ commentId: handoff!.commentId, sourceCommentDeleted: true });
    expect(after!.incomingHandoff!.instructions).toContain("withdrawn");
    expect(JSON.stringify(after)).not.toContain(original);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, handoff!.commentId!)))[0]!.body).toContain(original);
  });

  it.each(["queued", "failed", "cancelled"])("recovers a queue-commit/ack crash after receipt becomes %s without a duplicate wake", async receiptStatus => {
    const f = await fixture(); let at = new Date(Date.now() + 60_000); const first = await f.service.handoff(f.companyId, board, f.input);
    const crashing = queue(() => at, true); await crashing.worker.sweepPending();
    const row = (await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, first.handoffId)))[0]!;
    expect(row.state).toBe("pending_dispatch");
    if (receiptStatus !== "queued") {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.triage, status: receiptStatus,
        wakeupRequestId: row.wakeupRequestId, invocationSource: "assignment", contextSnapshot: { issueId: first.taskId } });
      await db.update(agentWakeupRequests).set({ status: receiptStatus, runId }).where(eq(agentWakeupRequests.id, row.wakeupRequestId));
    }
    at = new Date(at.getTime() + 60_000);
    const recovered = queue(() => at); await recovered.worker.sweepPending();
    expect(recovered.wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, row.wakeupRequestId))).toHaveLength(1);
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, row.id)))[0]!.state).toBe("delivered");
  });

  it("preserves immediate readiness when source cleanup races the waiting worker's retry", async () => {
    const f = await fixture(), at = new Date(Date.now() + 60_000), q = queue(() => at);
    const first = await f.service.handoff(f.companyId, board, f.input); await q.worker.sweepPending();
    const runId = await sourceRun(f.companyId, f.triage, first.taskId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const next = await f.service.handoff(f.companyId, board, { case: { id: first.caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 1,
      expectedIssueStatusVersion: issue!.statusVersion, toAgentId: f.engineer, phase: "implementation", instructions: "Continue" });
    const racing = caseHandoffDeliveryService(db, { now: () => at, heartbeat: { wakeup: q.wakeup,
      requestCaseHandoffYield: async () => {
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
        await recordCaseHandoffExecutionReleased(db, runId, first.taskId);
      },
    } as any });
    await racing.sweepPending();
    const [ready] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, next.handoffId));
    expect(ready!.nextAttemptAt.getTime()).toBeLessThanOrEqual(at.getTime());
    await queue(() => at).worker.sweepPending();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, next.handoffId)))[0]!.state).toBe("delivered");
  });

  it("reclaims expired worker leases and does not dispatch superseded assignments", async () => {
    const f = await fixture(); let at = new Date(Date.now() + 60_000); const first = await f.service.handoff(f.companyId, board, f.input);
    await db.update(caseHandoffs).set({ leaseExpiresAt: new Date(at.getTime() + 60_000) }).where(eq(caseHandoffs.id, first.handoffId));
    const q = queue(() => at); await q.worker.sweepPending(); expect(q.wakeup).not.toHaveBeenCalled();
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, first.taskId));
    at = new Date(at.getTime() + 120_000); await q.worker.sweepPending();
    expect(q.wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, first.handoffId)))[0]!.state).toBe("cancelled");
  });

  it("lets only one of two delivery workers claim a handoff", async () => {
    const f = await fixture(), at = new Date(Date.now() + 60_000);
    await f.service.handoff(f.companyId, board, f.input);
    const first = queue(() => at), second = queue(() => at);
    await Promise.all([first.worker.sweepPending(), second.worker.sweepPending()]);
    expect(first.wakeup.mock.calls.length + second.wakeup.mock.calls.length).toBe(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
  });

  it("binds a passive case once and rejects additional primary ownership", async () => {
    const f = await fixture(), caseId = randomUUID(), issueId = randomUUID();
    await db.insert(cases).values({ id: caseId, companyId: f.companyId, caseNumber: 1, identifier: `${f.companyId}-C1`, caseType: "work", title: "Passive" });
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Existing work", status: "todo", assigneeAgentId: f.triage });
    const bound = await f.service.handoff(f.companyId, board, { case: { id: caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 0,
      bindIssueId: issueId, expectedIssueStatusVersion: 0, toAgentId: f.engineer, phase: "implementation", instructions: "Start implementation" });
    expect(bound.taskId).toBe(issueId);
    expect(await db.select().from(caseIssueLinks).where(and(eq(caseIssueLinks.caseId, caseId), eq(caseIssueLinks.issueId, issueId)))).toHaveLength(1);
    await expect(f.service.handoff(f.companyId, board, { ...f.input, bindIssueId: issueId, expectedIssueStatusVersion: 1 })).rejects.toThrow("already the primary");
  });

  it("starts work for a passive case with multiple open references while preserving all retained sources", async () => {
    const f = await fixture(), caseId = randomUUID(), firstRef = randomUUID(), secondRef = randomUUID();
    await db.insert(cases).values({ id: caseId, companyId: f.companyId, caseNumber: 1, identifier: `${f.companyId}-C1`, caseType: "work", title: "Open reference research" });
    await db.insert(issues).values([
      { id: firstRef, companyId: f.companyId, title: "First research reference", visibility: "open" },
      { id: secondRef, companyId: f.companyId, title: "Second research reference", visibility: "open" },
    ]);
    for (const sourceId of [firstRef, secondRef]) {
      await retainCaseAccessSource(db, { companyId: f.companyId, caseId, sourceKind: "issue", sourceId });
      await db.insert(caseIssueLinks).values({ companyId: f.companyId, caseId, issueId: sourceId, role: "reference" });
    }
    const kickoff = await f.service.handoff(f.companyId, board, { case: { id: caseId }, expectedHandoffVersion: 0, idempotencyKey: randomUUID(),
      toAgentId: f.triage, phase: "triage", instructions: "Combine the research references", workflow_document_text: f.input.workflow_document_text });
    expect([firstRef, secondRef]).not.toContain(kickoff.taskId);
    expect(await db.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, caseId))).toHaveLength(3);
    expect(await db.select().from(caseIssueLinks).where(eq(caseIssueLinks.caseId, caseId))).toHaveLength(3);
  });

  it("preserves private same-task access and prevents copying case instructions into wider work", async () => {
    const f = await fixture(), caseId = randomUUID(), privateId = randomUUID(), openId = randomUUID();
    await db.insert(issues).values([
      { id: privateId, companyId: f.companyId, title: "Private work", status: "todo", visibility: "private", assigneeAgentId: f.triage },
      { id: openId, companyId: f.companyId, title: "Company-open work", status: "todo", assigneeAgentId: f.triage },
    ]);
    await db.insert(cases).values({ id: caseId, companyId: f.companyId, caseNumber: 1, identifier: `${f.companyId}-C1`, caseType: "work", title: "Private case" });
    await retainCaseAccessSource(db, { companyId: f.companyId, caseId, sourceKind: "issue", sourceId: privateId });
    const owner = { type: "agent" as const, companyId: f.companyId, agentId: f.triage, source: "agent_key" as const };
    const input = { case: { id: caseId }, expectedHandoffVersion: 0, expectedIssueStatusVersion: 0,
      idempotencyKey: randomUUID(), toAgentId: f.triage, phase: "triage", instructions: "Confidential findings" };
    await expect(f.service.handoff(f.companyId, owner, { ...input, bindIssueId: openId })).rejects.toThrow("private task boundary");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, openId))).toHaveLength(0);
    await f.service.handoff(f.companyId, owner, { ...input, idempotencyKey: randomUUID(), bindIssueId: privateId, toAgentId: f.engineer });
    expect(await canActorReadCase(db, { ...owner, agentId: f.engineer }, caseId)).toBe(true);
    expect(await canActorReadCase(db, { ...owner, agentId: f.verifier }, caseId)).toBe(false);
    await expect(f.service.list({ ...owner, agentId: f.verifier }, caseId)).rejects.toThrow("Case not found");
  });

  it("revalidates retained-source trust at acceptance, assignment, and wake dispatch", async () => {
    const f = await fixture(), caseId = randomUUID(), sourceId = randomUUID(), q = queue(() => new Date(Date.now() + 60_000));
    const quarantine = buildLowTrustSourceTrust({ issueId: sourceId });
    await db.insert(issues).values({ id: sourceId, companyId: f.companyId, title: "Retained research", sourceTrust: quarantine });
    await db.insert(cases).values({ id: caseId, companyId: f.companyId, caseNumber: 1, identifier: `${f.companyId}-C1`, caseType: "work", title: "Persistent research" });
    await retainCaseAccessSource(db, { companyId: f.companyId, caseId, sourceKind: "issue", sourceId });
    const input = { case: { id: caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 0,
      toAgentId: f.triage, phase: "triage", instructions: "Review the research", workflow_document_text: f.input.workflow_document_text };
    await expect(f.service.handoff(f.companyId, board, input)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, caseId))).toHaveLength(0);

    await db.update(issues).set({ sourceTrust: null }).where(eq(issues.id, sourceId));
    const first = await f.service.handoff(f.companyId, board, input);
    await db.update(issues).set({ sourceTrust: quarantine }).where(eq(issues.id, sourceId));
    await expect(f.service.authorizePendingDispatch(first.handoffId)).rejects.toMatchObject({ status: 403 });
    expect(q.wakeup).not.toHaveBeenCalled();
    await db.update(issues).set({ sourceTrust: null }).where(eq(issues.id, sourceId));
    await q.worker.sweepPending();

    const runId = await sourceRun(f.companyId, f.triage, first.taskId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const next = await f.service.handoff(f.companyId, board, { case: { id: caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 1,
      expectedIssueStatusVersion: issue!.statusVersion, toAgentId: f.engineer, phase: "implementation", instructions: "Build the solution" });
    await db.update(issues).set({ sourceTrust: quarantine }).where(eq(issues.id, sourceId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await recordCaseHandoffExecutionReleased(db, runId, first.taskId);
    await expect(f.service.applyPending(next.handoffId)).rejects.toMatchObject({ status: 403 });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, next.handoffId)))[0]!.state).toBe("awaiting_release");
    expect((await db.select().from(issues).where(eq(issues.id, first.taskId)))[0]!.assigneeAgentId).toBe(f.triage);
    expect((await db.select().from(cases).where(eq(cases.id, caseId)))[0]!.phase).toBe("triage");
    expect(q.wakeup).toHaveBeenCalledTimes(1);
  });

  it("respects review gates and permits cancellation while the experiment is disabled", async () => {
    const f = await fixture(), first = await f.service.handoff(f.companyId, board, f.input);
    await instanceSettingsService(db).updateExperimental({ enableCases: false });
    try {
      await expect(f.service.handoff(f.companyId, board, { ...f.input, idempotencyKey: randomUUID() })).rejects.toThrow("Cases are disabled");
      expect(await f.service.cancel(board, first.caseId, first.handoffId)).toMatchObject({ state: "cancelled" });
    } finally { await instanceSettingsService(db).updateExperimental({ enableCases: true }); }
    await db.update(issues).set({ executionState: { status: "pending" } }).where(eq(issues.id, first.taskId));
    await expect(f.service.handoff(f.companyId, board, { case: { id: first.caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 1,
      expectedIssueStatusVersion: 0, toAgentId: f.engineer, phase: "implementation", instructions: "Skip review" })).rejects.toThrow("review");
    expect((await db.select().from(cases).where(eq(cases.id, first.caseId)))[0]!.handoffVersion).toBe(1);
  });

  it("continues outgoing yield cleanup while disabled without transferring or waking successor work", async () => {
    const f = await fixture(), at = new Date(Date.now() + 60_000), q = queue(() => at);
    const first = await f.service.handoff(f.companyId, board, f.input); await q.worker.sweepPending();
    const runId = await sourceRun(f.companyId, f.triage, first.taskId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const next = await f.service.handoff(f.companyId, board, { case: { id: first.caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 1,
      expectedIssueStatusVersion: issue!.statusVersion, toAgentId: f.engineer, phase: "implementation", instructions: "Continue when enabled" });
    const requestCaseHandoffYield = vi.fn().mockResolvedValue(undefined);
    const disabledWorker = caseHandoffDeliveryService(db, { now: () => at, heartbeat: { wakeup: q.wakeup, requestCaseHandoffYield } as any });
    await instanceSettingsService(db).updateExperimental({ enableCases: false });
    try {
      await disabledWorker.sweepPending();
      expect(requestCaseHandoffYield).toHaveBeenCalledExactlyOnceWith({ runId, issueId: first.taskId, handoffId: next.handoffId });
      expect(q.wakeup).toHaveBeenCalledTimes(1);
      expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, next.handoffId)))[0]!.state).toBe("awaiting_release");
      expect((await db.select().from(issues).where(eq(issues.id, first.taskId)))[0]!.assigneeAgentId).toBe(f.triage);
    } finally { await instanceSettingsService(db).updateExperimental({ enableCases: true }); }
  });

  it("does not advance a settled source whose pinned external binding was revoked", async () => {
    const f = await fixture(), at = new Date(Date.now() + 60_000), q = queue(() => at);
    const first = await f.service.handoff(f.companyId, board, f.input); await q.worker.sweepPending();
    const runId = await sourceRun(f.companyId, f.triage, first.taskId), bindingId = randomUUID();
    const [issue] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const next = await f.service.handoff(f.companyId, board, { case: { id: first.caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 1,
      expectedIssueStatusVersion: issue!.statusVersion, toAgentId: f.engineer, phase: "implementation", instructions: "Continue" });
    const pinned = buildNativeExecutionInput({ companyId: f.companyId, runId, agentId: f.triage,
      issue: { id: first.taskId, identifier: issue!.identifier, title: issue!.title, description: issue!.description, workMode: "standard" },
      taskPrompt: "Handoff", provider: "openai_dot", dotBinding: { companyId: f.companyId, agentId: f.triage, bindingId, bindingGeneration: 1,
        acceptByUnixMs: Date.now() + 60_000, expiresAtUnixMs: Date.now() + 120_000 },
      workspace: { id: randomUUID(), cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: null,
      runtimeContext: nativeRuntimeContextFixture(), completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Handoff", criteria: [{ id: "work", requirement: "Continue the task" }] } },
    });
    await db.insert(dotAgentBindings).values({ id: bindingId, companyId: f.companyId, agentId: f.triage, operatorId: "operator", status: "revoked", revokedAt: new Date() });
    await db.update(heartbeatRuns).set({ status: "succeeded", driverKind: "openai_dot_mcp", runnerProfileJson: { nativeExecutionInput: pinned } }).where(eq(heartbeatRuns.id, runId));
    await recordCaseHandoffExecutionReleased(db, runId, first.taskId);
    await q.worker.sweepPending();
    const [waiting] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, next.handoffId));
    expect(waiting).toMatchObject({ state: "awaiting_release", lastErrorCode: "access_or_admission_blocked" });
    expect(q.wakeup).toHaveBeenCalledTimes(1);
    expect((await db.select().from(issues).where(eq(issues.id, first.taskId)))[0]!.assigneeAgentId).toBe(f.triage);
  });

  it("holds delayed assignment after recipient policy revocation and resumes when restored", async () => {
    const f = await fixture();
    let at = new Date(Date.now() + 60_000);
    const q = queue(() => at);
    const first = await f.service.handoff(f.companyId, board, f.input);
    await q.worker.sweepPending();
    const runId = await sourceRun(f.companyId, f.triage, first.taskId);
    const actor = { type: "agent" as const, agentId: f.triage, companyId: f.companyId, runId, source: "agent_jwt" as const };
    const [before] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    const next = await f.service.handoff(f.companyId, actor, {
      case: { id: first.caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 1,
      expectedIssueStatusVersion: before!.statusVersion, toAgentId: f.engineer,
      phase: "implementation", instructions: "Implement the saved findings after release.",
    });
    expect(next).toMatchObject({ state: "awaiting_release", callerMustYield: true });
    await db.update(agents).set({ permissions: { authorizationPolicy: { protectedAgent: { blockAssignment: true } } } })
      .where(eq(agents.id, f.engineer));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await recordCaseHandoffExecutionReleased(db, runId, first.taskId);
    const [settled] = await db.select().from(issues).where(eq(issues.id, first.taskId));
    expect(settled!.statusVersion).toBe(before!.statusVersion);
    await q.worker.sweepPending();
    const [held] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, next.handoffId));
    expect(held).toMatchObject({ state: "awaiting_release", lastErrorCode: "access_or_admission_blocked" });
    expect(held!.lastError).toMatch(/protected-agent policy/);
    expect((await db.select().from(issues).where(eq(issues.id, first.taskId)))[0])
      .toMatchObject({ assigneeAgentId: f.triage, status: "in_progress", statusVersion: before!.statusVersion });
    expect((await db.select().from(cases).where(eq(cases.id, first.caseId)))[0]!.phase).toBe("triage");
    expect(q.wakeup).toHaveBeenCalledTimes(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, held!.wakeupRequestId))).toEqual([]);
    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, f.engineer));
    at = new Date(at.getTime() + 60_000);
    await queue(() => at).worker.sweepPending();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, next.handoffId)))[0]!.state).toBe("delivered");
    expect((await db.select().from(issues).where(eq(issues.id, first.taskId)))[0])
      .toMatchObject({ id: first.taskId, status: "todo", assigneeAgentId: f.engineer });
    expect((await db.select().from(cases).where(eq(cases.id, first.caseId)))[0]!.phase).toBe("implementation");
  });

  it("rechecks the original agent's current assignment grant on a protected task", async () => {
    let grantId = "";
    const f = await delayedTransfer(async (f, taskId) => {
      await db.update(issues).set({ executionPolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).where(eq(issues.id, taskId));
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: f.triage, status: "active", membershipRole: "member" });
      const [grant] = await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.triage, permissionKey: "tasks:assign" }).returning();
      grantId = grant!.id;
    });
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, grantId));
    await f.release(); await f.sweep();
    await f.assertHeld(/protected|assignment|permission/i);
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.triage, permissionKey: "tasks:assign" });
    await f.sweep();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId)))[0]!.state).toBe("delivered");
  });

  it("rechecks the original agent's active authority after settlement", async () => {
    const f = await delayedTransfer();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.triage));
    await f.release(); await f.sweep(); await f.assertHeld(/actor agent.*not active/i);
  });

  it.each(["revoked", "scope", "responsible_user"] as const)("retains and revalidates the original agent key (%s)", async reason => {
    const keyId = randomUUID(), userId = randomUUID();
    const f = await delayedTransfer(async (f, _taskId, runId) => {
      await db.insert(authUsers).values({ id: userId, name: "Responsible operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
      await db.insert(agentApiKeys).values({ id: keyId, companyId: f.companyId, agentId: f.triage, name: "Intake key", keyHash: randomUUID(), responsibleUserId: userId, scopeConfig: { kind: "standard" } });
      return { type: "agent", agentId: f.triage, companyId: f.companyId, runId, source: "agent_key", keyId, keyScope: { kind: "standard" }, onBehalfOfUserId: userId };
    });
    await db.update(agentApiKeys).set(reason === "revoked" ? { revokedAt: new Date() } : reason === "scope" ?
      { scopeConfig: { kind: "skill_test", issueId: f.first.taskId } } : { responsibleUserId: randomUUID() }).where(eq(agentApiKeys.id, keyId));
    await f.release(); await f.sweep(); await f.assertHeld(/key was revoked or its scope changed/i);
  });

  it.each([true, false])("preserves a current agent key's accepted authority (run header: %s)", async withRunHeader => {
    const userId = randomUUID(), keyId = randomUUID();
    const f = await delayedTransfer(async (f, taskId, runId) => {
      await db.insert(authUsers).values({ id: userId, name: "Key owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
      await db.insert(agentApiKeys).values({ id: keyId, companyId: f.companyId, agentId: f.triage, name: "Assignment key", keyHash: randomUUID(), responsibleUserId: userId });
      // A checkout may outlast execution ownership. An ordinary authenticated
      // key can hand it off without claiming a JWT-bound run identity.
      if (!withRunHeader) await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, taskId));
      return { type: "agent", companyId: f.companyId, agentId: f.triage, source: "agent_key", keyId,
        onBehalfOfUserId: userId, ...(withRunHeader ? { runId } : {}) };
    });
    await f.release(); await f.sweep();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId)))[0]!.state).toBe("delivered");
    expect((await db.select().from(issues).where(eq(issues.id, f.first.taskId)))[0]).toMatchObject({ assigneeAgentId: f.engineer, status: "todo" });
  });

  it("does not drop an external authorizer's current permission ceiling", async () => {
    const userId = randomUUID();
    const f = await delayedTransfer(async (f, _taskId, runId) => {
      await db.insert(authUsers).values({ id: userId, name: "Authorizing operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
      return { type: "agent", agentId: f.triage, companyId: f.companyId, runId, source: "agent_jwt", authorizingUserId: userId };
    });
    await db.delete(companyMemberships).where(eq(companyMemberships.principalId, userId));
    await f.release(); await f.sweep(); await f.assertHeld(/actor.*access|authoriz|permission|membership/i);
  });

  it.each(["missing", "identity", "scope", "run"] as const)("fails closed on %s retained actor provenance", async reason => {
    const f = await delayedTransfer();
    const [row] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId));
    await db.update(caseHandoffs).set({ actorContext: reason === "missing" ? null : reason === "identity" ?
      { ...row!.actorContext, actorId: f.engineer } : reason === "run" ? { ...row!.actorContext, runId: randomUUID() } : { ...row!.actorContext, keyScope: { kind: "invented" } } }).where(eq(caseHandoffs.id, f.receipt.handoffId));
    await f.release(); await f.sweep(); await f.assertHeld(reason === "run" ? /execution identity changed/i : /original actor context is unavailable/i);
  });

  it("rechecks board membership without promoting its sentinel identity to local authority", async () => {
    const userId = "board";
    const f = await delayedTransfer(async f => {
      await db.insert(authUsers).values({ id: userId, name: "Authenticated board", email: "board@example.test", createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
      const sessionId = randomUUID();
      await db.insert(authSessions).values({ id: sessionId, userId, token: randomUUID(), createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
      return { type: "board", userId, source: "session", sessionId, companyIds: [f.companyId] };
    });
    await db.delete(companyMemberships).where(eq(companyMemberships.principalId, userId));
    await f.release(); await f.sweep(); await f.assertHeld(/actor.*access|permission|membership|grant/i);
  });

  it("restores a current trusted Cloud owner's elevation for the delayed assignment", async () => {
    const f = await cloudTransfer();
    try {
      const [stored] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId));
      expect(stored!.actorContext).not.toHaveProperty("isInstanceAdmin");
      expect(stored!.actorContext).not.toHaveProperty("stackRole");
      await f.release(); await f.sweep();
      expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId)))[0]!.state).toBe("delivered");
      expect((await db.select().from(issues).where(eq(issues.id, f.first.taskId)))[0]).toMatchObject({ assigneeAgentId: f.engineer, status: "todo" });
      expect(f.requests).toEqual([{ path: "/v1/tenant/portfolio", userId: f.userId, stackId: f.stackId, authenticated: true }]);
    } finally { await f.close(); }
  });

  it.each(["admin", "member", "support", "viewer"])("checks current Cloud role %s and the live managed elevation flag", async role => {
    const f = await cloudTransfer();
    try {
      // The local company membership remains owner throughout; it cannot
      // substitute for current Cloud stack ownership or grant elevation.
      f.state.role = role;
      await f.release(); await f.sweep(); await f.assertHeld(role === "viewer" ? /membership does not allow task assignment/i : /protected-agent policy/i);
      expect((await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.userId))))[0]!.membershipRole).toBe("owner");
      f.state.role = "owner"; f.flag(false);
      await f.sweep(); await f.assertHeld(/protected-agent policy/i);
      f.flag(true);
      await f.sweep();
      expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId)))[0]!.state).toBe("delivered");
      expect(f.requests).toHaveLength(3); // Every attempt revalidates; no portfolio cache.
    } finally { await f.close(); }
  });

  it.each(["forbidden", "upstream", "malformed", "ambiguous", "mismatched", "config_changed", "flag_changed"])("fails closed on %s current Cloud authority", async failure => {
    const f = await cloudTransfer();
    try {
      if (failure === "forbidden") f.state.status = 403;
      else if (failure === "upstream") f.state.status = 503;
      else if (failure === "malformed") f.state.body = { stacks: [{ stackSlug: f.stackSlug, role: {}, isCurrent: true }] };
      else if (failure === "ambiguous") f.state.body = { stacks: [1, 2].map(() => ({ stackSlug: f.stackSlug, role: "owner", isCurrent: true })) };
      else if (failure === "mismatched") f.state.body = { stacks: [{ stackSlug: "different-stack", role: "owner", isCurrent: true }] };
      else if (failure === "config_changed") f.state.afterResponse = () => vi.stubEnv("PAPERCLIP_STACK_SLUG", "different-stack");
      else f.state.afterResponse = () => f.flag(false);
      await f.release(); await f.sweep();
      await f.assertHeld(failure === "flag_changed" ? /protected-agent policy/i : /Current Cloud tenant authority is unavailable/i);
      expect(f.requests).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("does not let current Cloud ownership replace revoked local company membership", async () => {
    const f = await cloudTransfer();
    try {
      await db.delete(companyMemberships).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.userId)));
      await f.release(); await f.sweep(); await f.assertHeld(/not a current company member/i);
    } finally { await f.close(); }
  });

  it.each(["board_key_revoked", "board_key_expired", "session_deleted", "session_expired"] as const)("revalidates original board credentials (%s)", async reason => {
    const userId = randomUUID(), credentialId = randomUUID();
    const key = reason.startsWith("board_key");
    const f = await delayedTransfer(async f => {
      await db.insert(authUsers).values({ id: userId, name: "Board operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
      if (key) await db.insert(boardApiKeys).values({ id: credentialId, userId, name: "CLI operator", keyHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
      else await db.insert(authSessions).values({ id: credentialId, userId, token: randomUUID(), createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
      return { type: "board", userId, companyIds: [f.companyId], ...(key ? { source: "board_key", keyId: credentialId } : { source: "session", sessionId: credentialId }) };
    });
    if (reason === "board_key_revoked") await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, credentialId));
    else if (reason === "board_key_expired") await db.update(boardApiKeys).set({ expiresAt: new Date(0) }).where(eq(boardApiKeys.id, credentialId));
    else if (reason === "session_deleted") await db.delete(authSessions).where(eq(authSessions.id, credentialId));
    else await db.update(authSessions).set({ expiresAt: new Date(0) }).where(eq(authSessions.id, credentialId));
    await f.release(); await f.sweep(); await f.assertHeld(/board (key|session) was revoked or expired/i);
  });

  it("cannot restore recorded local board authority in a managed Cloud instance", async () => {
    const f = await delayedTransfer(async () => board);
    await f.release();
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "test-cloud-instance");
    try { await f.sweep(); await f.assertHeld(/local board authority is unavailable/i); }
    finally { vi.unstubAllEnvs(); }
  });

  it("preserves private ownership transfer and does not reauthorize the old owner after assignment", async () => {
    const f = await delayedTransfer(async (_f, taskId) => { await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, taskId)); });
    await f.release();
    expect(await f.service.applyPending(f.receipt.handoffId)).toMatchObject({ state: "pending_dispatch" });
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, f.first.caseId));
    expect(await canActorReadCase(db, f.actor, caseRow!)).toBe(false);
    await expect(f.service.authorizePendingDispatch(f.receipt.handoffId)).resolves.toBeUndefined();
    await f.sweep();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId)))[0]!.state).toBe("delivered");
    expect((await db.select().from(issues).where(eq(issues.id, f.first.taskId)))[0])
      .toMatchObject({ id: f.first.taskId, visibility: "private", assigneeAgentId: f.engineer, status: "todo" });
  });

  it("omits server-only actor provenance from REST history, retry, cancel, and execution context", async () => {
    const f = await delayedTransfer();
    const [stored] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId));
    expect(stored!.actorContext).toMatchObject({ schema: "paperclip.case-handoff-actor.v1", actorId: f.triage, source: "agent_jwt", runId: f.runId });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = board; next(); });
    app.use("/api", caseHandoffRoutes(db)); app.use(errorHandler);
    const history = await request(app).get(`/api/cases/${f.first.caseId}/handoffs`).expect(200);
    expect(history.body.items).toHaveLength(2);
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, f.first.caseId));
    const summary = await enrichCaseWork(db, f.companyId, [caseRow!], board);
    expect(summary[0]!.pendingHandoff).toMatchObject({ id: f.receipt.handoffId });
    expect(summary[0]!.pendingHandoff).not.toHaveProperty("actorContext");
    for (const row of history.body.items) expect(row).not.toHaveProperty("actorContext");
    const retry = await request(app).post(`/api/cases/${f.first.caseId}/handoffs/${f.receipt.handoffId}/retry`).expect(200);
    expect(retry.body).not.toHaveProperty("actorContext");
    const context = await getCaseExecutionContext(db, { companyId: f.companyId, issueId: f.first.taskId, agentId: f.triage, runId: f.runId });
    expect(JSON.stringify(context)).not.toContain("paperclip.case-handoff-actor");
    const events = await db.select().from(caseEvents).where(eq(caseEvents.caseId, f.first.caseId));
    expect(JSON.stringify(events)).not.toContain("actorContext");
    const cancelled = await request(app).post(`/api/cases/${f.first.caseId}/handoffs/${f.receipt.handoffId}/cancel`).expect(200);
    expect(cancelled.body).toMatchObject({ state: "cancelled" });
    expect(cancelled.body).not.toHaveProperty("actorContext");
    const replayCancel = await request(app).post(`/api/cases/${f.first.caseId}/handoffs/${f.receipt.handoffId}/cancel`).expect(200);
    expect(replayCancel.body).not.toHaveProperty("actorContext");
  });

  it("records terminal intent without assignment authority, source yield, task completion, or another wake", async () => {
    const f = await terminalFixture();
    await db.update(issues).set({ executionPolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } })
      .where(eq(issues.id, f.first.taskId));
    const [before] = await db.select().from(issues).where(eq(issues.id, f.first.taskId));
    const receipt = await f.service.handoff(f.companyId, f.actor, f.input);
    expect(receipt).toMatchObject({ destinationKind: "done", state: "awaiting_completion", completedAt: null,
      taskId: f.first.taskId, handoffVersion: 2, callerMustYield: false, replayed: false });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.first.taskId));
    expect(task).toMatchObject({ status: before!.status, statusVersion: before!.statusVersion, assigneeAgentId: f.engineer,
      executionRunId: f.runId, checkoutRunId: f.runId, description: before!.description });
    expect((await db.select().from(cases).where(eq(cases.id, f.first.caseId)))[0]).toMatchObject({ status: "draft", phase: "triage", handoffVersion: 2, completedAt: null });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId)))[0]).toMatchObject({
      destinationKind: "done", toAgentId: null, sourceRunId: f.runId, assignmentAppliedAt: null, deliveredAt: null });
    expect(await pendingCaseHandoffForRun(db, f.runId)).toBeNull();
    await db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, f.companyId, { agentId: f.engineer, runId: f.runId }));
    expect(await f.service.retry(f.actor, f.first.caseId, receipt.handoffId)).toMatchObject({ state: "awaiting_completion" });
    await f.q.worker.sweepPending();
    expect(f.q.wakeup).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.first.taskId))).toHaveLength(2);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  });

  it.each(["sweep", "locked_escalation"] as const)(
    "retains ordinary %s recovery after a terminal-intent source crashes before task completion",
    async mode => {
      const f = await terminalFixture();
      const receipt = await f.service.handoff(f.companyId, f.actor, f.input);
      expect(receipt).toMatchObject({ state: "awaiting_completion", callerMustYield: false });
      // The source stopped before completing the ordinary task. A terminal
      // intent owns no successor run: paused-owner recovery must stay visible.
      const [failedRun] = await db.update(heartbeatRuns).set({
        status: "failed", errorCode: "process_lost", error: "Source crashed after recording terminal intent",
        finishedAt: new Date(),
      }).where(eq(heartbeatRuns.id, f.runId)).returning();
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.engineer));
      const [observed] = await db.select().from(issues).where(eq(issues.id, f.first.taskId));
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      if (mode === "sweep") {
        expect(await recovery.reconcileStrandedAssignedIssues())
          .toMatchObject({ escalated: 1, issueIds: [f.first.taskId] });
      } else {
        expect(await recovery.escalateStrandedAssignedIssue({
          issue: observed!, previousStatus: "in_progress", latestRun: failedRun!,
          comment: "The source stopped before the task completed and its assignee is paused.",
        })).toMatchObject({ id: f.first.taskId, status: "blocked" });
      }
      expect((await db.select().from(issues).where(eq(issues.id, f.first.taskId)))[0])
        .toMatchObject({ status: "blocked", assigneeAgentId: f.engineer, completedAt: null });
      expect((await db.select().from(cases).where(eq(cases.id, f.first.caseId)))[0])
        .toMatchObject({ status: "draft", completedAt: null });
      expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId)))[0])
        .toMatchObject({ state: "awaiting_completion", destinationKind: "done", completedAt: null });
      expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
      expect(enqueueWakeup).not.toHaveBeenCalled();
      expect(f.q.wakeup).toHaveBeenCalledTimes(1);

      // Existing task controls resolve the visible hold. The original intent
      // closes the same case only when ordinary task completion is accepted.
      await db.update(agents).set({ status: "active" }).where(eq(agents.id, f.engineer));
      await issueService(db).update(f.first.taskId, { status: "done" });
      expect((await db.select().from(issues).where(eq(issues.id, f.first.taskId)))[0])
        .toMatchObject({ id: f.first.taskId, status: "done" });
      expect((await db.select().from(cases).where(eq(cases.id, f.first.caseId)))[0])
        .toMatchObject({ status: "done", phase: "done", completedAt: expect.any(Date) });
      expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId)))[0])
        .toMatchObject({ state: "completed", completedAt: expect.any(Date) });
      expect(f.q.wakeup).toHaveBeenCalledTimes(1);
    },
  );

  it("commits task and terminal case completion atomically through the ordinary issue service", async () => {
    const f = await terminalFixture(), receipt = await f.service.handoff(f.companyId, f.actor, f.input);
    await expect(db.transaction(async tx => {
      await issueService(tx as unknown as typeof db).update(f.first.taskId, { status: "done", actorAgentId: f.engineer,
        actorRunId: f.runId }, tx as unknown as typeof db);
      throw new Error("Crash before commit");
    })).rejects.toThrow("Crash before commit");
    expect((await db.select().from(issues).where(eq(issues.id, f.first.taskId)))[0]!.status).toBe("in_progress");
    expect((await db.select().from(cases).where(eq(cases.id, f.first.caseId)))[0]!.status).toBe("draft");
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId)))[0]!.state).toBe("awaiting_completion");
    await issueService(db).update(f.first.taskId, { status: "done", actorAgentId: f.engineer, actorRunId: f.runId });
    const [completedCase] = await db.select().from(cases).where(eq(cases.id, f.first.caseId));
    const [completed] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId));
    expect(completedCase).toMatchObject({ status: "done", phase: "done", handoffVersion: 2 });
    expect(completedCase!.completedAt).toBeInstanceOf(Date);
    expect(completed).toMatchObject({ destinationKind: "done", state: "completed", toAgentId: null });
    expect(completed!.completedAt).toBeInstanceOf(Date);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.first.caseId), eq(activityLog.action, "case.handoff_completed")))).toHaveLength(1);
    expect(await completeTerminalCaseHandoffsForIssue(db, { companyId: f.companyId, issueId: f.first.taskId })).toBe(0);
    expect(await f.service.handoff(f.companyId, f.actor, f.input)).toMatchObject({ handoffId: receipt.handoffId,
      state: "completed", callerMustYield: false, replayed: true });
    expect(f.q.wakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["todo", "in_review", "blocked"] as const)("leaves %s work and its review or blocker unresolved when terminal intent is recorded", async status => {
    const f = await terminalFixture();
    await db.update(issues).set({ status, executionState: status === "in_review" ? { status: "pending" } : null })
      .where(eq(issues.id, f.first.taskId));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.first.taskId));
    const receipt = await f.service.handoff(f.companyId, board, { ...f.input, expectedIssueStatusVersion: task!.statusVersion });
    expect(receipt).toMatchObject({ state: "awaiting_completion", callerMustYield: false });
    expect(await completeTerminalCaseHandoffsForIssue(db, { companyId: f.companyId, issueId: f.first.taskId })).toBe(0);
    expect((await db.select().from(issues).where(eq(issues.id, f.first.taskId)))[0]!.status).toBe(status);
    expect((await db.select().from(cases).where(eq(cases.id, f.first.caseId)))[0]!.status).toBe("draft");
    await instanceSettingsService(db).updateExperimental({ enableCases: false });
    try { expect(await f.service.cancel(board, f.first.caseId, receipt.handoffId)).toMatchObject({ state: "cancelled" }); }
    finally { await instanceSettingsService(db).updateExperimental({ enableCases: true }); }
    await db.update(issues).set({ status: "done", executionState: null }).where(eq(issues.id, f.first.taskId));
    expect(await completeTerminalCaseHandoffsForIssue(db, { companyId: f.companyId, issueId: f.first.taskId })).toBe(0);
    expect((await db.select().from(cases).where(eq(cases.id, f.first.caseId)))[0]!.status).toBe("draft");
  });

  it("settles a terminal intent immediately for an already completed primary task", async () => {
    const f = await terminalFixture();
    await db.update(issues).set({ status: "done", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.first.taskId));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.first.taskId));
    const receipt = await f.service.handoff(f.companyId, board, { ...f.input, expectedIssueStatusVersion: task!.statusVersion });
    expect(receipt).toMatchObject({ state: "completed", destinationKind: "done", callerMustYield: false });
    expect(receipt.completedAt).toBeInstanceOf(Date);
    expect((await db.select().from(cases).where(eq(cases.id, f.first.caseId)))[0]).toMatchObject({ status: "done", phase: "done" });
    expect(f.q.wakeup).toHaveBeenCalledTimes(1);
  });

  it("serializes terminal and agent handoffs into one routing decision", async () => {
    const f = await terminalFixture();
    const accepted = await Promise.allSettled([
      f.service.handoff(f.companyId, board, f.input),
      f.service.handoff(f.companyId, board, { case: f.input.case, idempotencyKey: randomUUID(),
        expectedHandoffVersion: 1, expectedIssueStatusVersion: f.input.expectedIssueStatusVersion,
        toAgentId: f.verifier, phase: "verification", instructions: "Review the saved work" }),
    ]);
    expect(accepted.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(accepted.find(row => row.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect((await db.select().from(cases).where(eq(cases.id, f.first.caseId)))[0]!.handoffVersion).toBe(2);
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, f.first.caseId))).toHaveLength(2);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.first.taskId))).toHaveLength(2);
  });

  it("replays terminal intent after ownership changes without granting fresh mutation authority", async () => {
    const f = await terminalFixture(), receipt = await f.service.handoff(f.companyId, f.actor, f.input);
    await issueService(db).update(f.first.taskId, { assigneeAgentId: f.verifier });
    expect(await f.service.handoff(f.companyId, f.actor, f.input)).toMatchObject({ handoffId: receipt.handoffId, replayed: true,
      state: "cancelled", callerMustYield: false });
    await expect(f.service.handoff(f.companyId, f.actor, { ...f.input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.first.taskId))).toHaveLength(2);
  });

  it("normalizes terminal REST phase defaults and replays the same receipt without duplicating comments", async () => {
    const f = await terminalFixture(), app = express();
    app.use(express.json()); app.use((req, _res, next) => { req.actor = f.actor; next(); });
    app.use("/api", caseHandoffRoutes(db)); app.use(errorHandler);
    const path = `/api/companies/${f.companyId}/case-handoffs`;
    const first = await request(app).post(path).send({ ...f.input, phase: undefined }).expect(202);
    const replay = await request(app).post(path).send(f.input).expect(200);
    expect(first.body).toMatchObject({ destinationKind: "done", state: "awaiting_completion", callerMustYield: false, completedAt: null });
    expect(replay.body).toMatchObject({ handoffId: first.body.handoffId, replayed: true });
    await request(app).post(path).send({ ...f.input, instructions: "A different request" }).expect(409);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.first.taskId))).toHaveLength(2);
  });

  it("enforces terminal destination-state constraints and pending uniqueness in the real database", async () => {
    const f = await terminalFixture(), receipt = await f.service.handoff(f.companyId, f.actor, f.input);
    const [row] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId));
    await expect(db.insert(caseHandoffs).values({ ...row!, id: randomUUID(), version: 3, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(db.update(caseHandoffs).set({ toAgentId: f.verifier }).where(eq(caseHandoffs.id, row!.id)))
      .rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(db.update(caseHandoffs).set({ state: "pending_dispatch" }).where(eq(caseHandoffs.id, row!.id)))
      .rejects.toMatchObject({ cause: { code: "23514" } });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, row!.id)))[0]).toMatchObject({
      destinationKind: "done", toAgentId: null, state: "awaiting_completion" });
  });

  it("reauthorizes terminal receipt replay against newly retained private sources", async () => {
    const f = await terminalFixture(), receipt = await f.service.handoff(f.companyId, f.actor, f.input), privateId = randomUUID();
    await db.insert(issues).values({ id: privateId, companyId: f.companyId, title: "Private retained findings", visibility: "private", assigneeAgentId: f.verifier });
    await retainCaseAccessSource(db, { companyId: f.companyId, caseId: f.first.caseId, sourceKind: "issue", sourceId: privateId });
    await expect(f.service.handoff(f.companyId, f.actor, f.input)).rejects.toMatchObject({ status: 404 });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId)))[0]!.state).toBe("awaiting_completion");
  });

  it.each(["cancelled", "planning", "conversation", "passive", "wrong_owner", "stale_version", "quarantine"] as const)(
    "rejects unsupported terminal %s without recording or closing work", async reason => {
      const f = await terminalFixture();
      if (reason === "cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.first.taskId));
      if (reason === "planning") await db.update(issues).set({ workMode: "planning" }).where(eq(issues.id, f.first.taskId));
      if (reason === "conversation") await db.update(issues).set({ conversationAgentId: f.engineer,
        conversationUserId: "fixture-user", conversationState: "active" }).where(eq(issues.id, f.first.taskId));
      if (reason === "passive") await db.update(cases).set({ workIssueId: null }).where(eq(cases.id, f.first.caseId));
      if (reason === "quarantine") await db.update(issues).set({ sourceTrust: buildLowTrustSourceTrust({ issueId: f.first.taskId }) }).where(eq(issues.id, f.first.taskId));
      const actor = reason === "wrong_owner" ? { ...f.actor, agentId: f.verifier, runId: undefined } : board;
      const [task] = await db.select().from(issues).where(eq(issues.id, f.first.taskId));
      const input = { ...f.input, expectedIssueStatusVersion: task!.statusVersion + Number(reason === "stale_version") };
      const status = reason === "wrong_owner" || reason === "quarantine" ? 403 : reason === "stale_version" ? 409 : 422;
      await expect(f.service.handoff(f.companyId, actor, input)).rejects.toMatchObject({ status });
      expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, f.first.caseId))).toHaveLength(1);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.first.taskId))).toHaveLength(1);
      expect((await db.select().from(cases).where(eq(cases.id, f.first.caseId)))[0]).toMatchObject({ status: "draft", handoffVersion: 1 });
    });
});
