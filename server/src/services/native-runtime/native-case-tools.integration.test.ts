import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, caseAccessSources, caseDocuments, caseEvents, caseHandoffs, caseIssueLinks, cases, documents, heartbeatRuns, issues, pipelineCases, pipelines, pipelineStages, workflows } from "@paperclipai/db";
import { SYSTEM_ISSUE_DOCUMENT_KEYS } from "@paperclipai/shared";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { instanceSettingsService } from "../instance-settings.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { documentService } from "../documents.js";

describe("native case tools through authenticated production routes", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const priorSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
    await instanceSettingsService(server.db).updateExperimental({ enableCases: true });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (priorSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = priorSecret;
  });
  async function fixture(mode: "standard" | "planning" | "ask" = "standard") {
    const f = await server.fixture({ apiToolsEnabled: false, disableWakeOnDemand: true, mode });
    await server.db.update(heartbeatRuns).set({ issueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
    const [record] = await server.db.insert(cases).values({ companyId: f.companyId, caseNumber: 1,
      identifier: `C-${randomUUID()}`, caseType: "receipt", title: "Receipt case", summary: "Two items at $3",
      fields: { total: 6, obsolete: true }, workIssueId: f.issueId }).returning();
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: true, workMode: mode });
    const call = (tool: string, input: Record<string, unknown> = {}, callId = randomUUID()) => authority.execute({ tool, callId, arguments: input });
    return { ...f, record: record!, authority, call };
  }
  type CaseFixture = Awaited<ReturnType<typeof fixture>>;
  type CaseDocument = { id: string; key: string; body: string; latestRevisionId: string; latestRevisionNumber: number };
  type DocumentPage = { ok: boolean; status: number; data: { id: string; handoffVersion: number; phase: string | null;
    workIssue: { statusVersion: number }; readPage: { mode: "json_text"; section: "document"; text: string;
      snapshot: string; offsetBytes: number; nextOffsetBytes: number | null; totalBytes: number } } };
  const documentBody = "Exact receipt 🧾\n\"quoted\" \\ escaped\tend\r\n".repeat(1_500);

  async function saveCaseDocument(f: CaseFixture, key: string, body: string, baseRevisionId?: string) {
    const response = await fetch(`${server.apiUrl}/api/cases/${f.record.id}/documents/${key}`, {
      method: "PUT", headers: { Authorization: `Bearer ${createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId)}`,
        "Content-Type": "application/json" }, body: JSON.stringify({ title: `Case ${key}`, format: "markdown", body, baseRevisionId }),
    });
    expect(response.status).toBe(200);
    return await response.json() as { document: { id: string; latestRevisionId: string; latestRevisionNumber: number } };
  }

  async function documentFixture(kind: "case" | "primary" | "linked", body: string) {
    const f = await fixture(), key = "reference-notes";
    if (kind === "linked") await server.db.insert(caseIssueLinks).values({ companyId: f.companyId, caseId: f.record.id,
      issueId: f.blockerId, role: "reference" });
    const issueId = kind === "primary" ? f.issueId : kind === "linked" ? f.blockerId : undefined;
    const saved = kind === "case" ? await saveCaseDocument(f, key, body) : await documentService(server.db).upsertIssueDocument({
      issueId: issueId!, key, title: `Task ${key}`, format: "markdown", body, createdByAgentId: f.agentId,
    });
    return { ...f, key, kind, saved, selector: { section: "document", documentKey: key, ...(issueId ? { documentIssueId: issueId } : {}) } };
  }

  async function readCompleteDocument(f: CaseFixture, selector: Record<string, unknown>, first?: DocumentPage) {
    let page = first ?? await f.call("read_case", selector) as DocumentPage;
    let text = "", offsetBytes = 0;
    const initial = page;
    const snapshot = page.data.readPage.snapshot;
    const routing = { phase: page.data.phase, handoffVersion: page.data.handoffVersion, workIssue: page.data.workIssue };
    for (let count = 0; ; count++) {
      expect(count).toBeLessThan(100);
      expect(page).toMatchObject({ ok: true, status: 200, data: { id: f.record.id, ...routing,
        readPage: { mode: "json_text", section: "document", snapshot, offsetBytes } } });
      expect(page).not.toHaveProperty("artifact");
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(24 * 1024);
      expect(Buffer.byteLength(page.data.readPage.text)).toBeLessThanOrEqual(8 * 1024);
      text += page.data.readPage.text;
      const next = page.data.readPage.nextOffsetBytes;
      if (next === null) {
        expect(Buffer.byteLength(text)).toBe(page.data.readPage.totalBytes);
        return { document: JSON.parse(text) as CaseDocument, first: initial, pages: count + 1 };
      }
      expect(next).toBeGreaterThan(offsetBytes);
      offsetBytes = next;
      page = await f.call("read_case", { ...selector, offsetBytes, snapshot }) as DocumentPage;
    }
  }
  it.each(["update_case", "create_workflow", "update_workflow"])("recovers a committed %s result without repeating its write", async tool => {
    const f = await fixture();
    const key = `lost-${tool}`;
    let input: Record<string, unknown>;
    if (tool === "update_case") input = { idempotencyKey: key, title: "Recovered case" };
    else if (tool === "create_workflow") input = { idempotencyKey: key, name: "Recovered workflow", prompt: "Preserve this procedure." };
    else {
      const created = await f.call("create_workflow", { idempotencyKey: "seed", name: "Before", prompt: "Preserve this procedure." }) as { data: { id: string } };
      input = { idempotencyKey: key, workflowId: created.data.id, name: "Recovered workflow" };
    }
    const original = await f.call(tool, input);
    expect(original).toMatchObject({ ok: true });
    const snapshot = async () => ({
      cases: await server.db.select().from(cases).where(eq(cases.id, f.record.id)),
      events: await server.db.select().from(caseEvents).where(eq(caseEvents.caseId, f.record.id)),
      workflows: await server.db.select().from(workflows).where(eq(workflows.companyId, f.companyId)),
    });
    const before = await snapshot();
    const replacement = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: true, workMode: "standard" });
    const recover = (arguments_: unknown = input) => replacement.recover({ tool, callId: "lost-provider-response", arguments: arguments_ });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Recovery must not dispatch HTTP"));
    try {
      expect(await recover()).toEqual({ result: original });
      expect(await recover({ ...input, idempotencyKey: "no-receipt" })).toBeNull();
      expect(await recover({ ...input, ...(tool === "update_case" ? { title: "Different" } : { name: "Different" }) })).toBeNull();
      const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const completed = run!.resultJson!;
      const receipts = completed.apiToolReceipts as Record<string, Record<string, unknown>>;
      await server.db.update(heartbeatRuns).set({ resultJson: { ...completed, apiToolReceipts:
        Object.fromEntries(Object.entries(receipts).map(([id, receipt]) => [id, { ...receipt, state: "pending" }])) } }).where(eq(heartbeatRuns.id, f.runId));
      expect(await recover()).toBeNull();
      await server.db.update(heartbeatRuns).set({ resultJson: completed }).where(eq(heartbeatRuns.id, f.runId));
      const disabled = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: false, workMode: "standard" });
      await expect(disabled.recover({ tool, callId: "lost-provider-response", arguments: input })).rejects.toThrow("Cases are disabled");
      await server.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
      await expect(recover()).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
      expect(await snapshot()).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it("exposes case facts and creation without a second document tool surface", async () => {
    const f = await fixture();
    const names = f.authority.definitions().map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["create_case", "read_case", "update_case", "handoff_case", "read_document", "write_document"]));
    expect(names).not.toContain("read_case_document"); expect(names).not.toContain("write_case_document");
    expect(names).not.toContain("call_api");
    expect(await f.call("read_case")).toMatchObject({ ok: true, status: 200, data: { id: f.record.id, fields: { total: 6 } } });
    const update = { idempotencyKey: "receipt-facts", summary: "Verified", fields: { total: 6, currency: "USD" } };
    const updated = await f.call("update_case", update);
    expect(updated).toMatchObject({ status: 200, data: { summary: "Verified", fields: { total: 6, currency: "USD" } } });
    expect(await f.call("update_case", update)).toEqual(updated);
    const saved = (await server.db.select().from(cases).where(eq(cases.id, f.record.id)))[0]!;
    expect(saved.fields).toEqual({ total: 6, currency: "USD" }); expect(saved.workIssueId).toBe(f.issueId);
    await expect(f.call("update_case", { ...update, summary: "different" })).rejects.toThrow("reused with different");
    const sources = await server.db.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, f.record.id));
    expect(sources).toEqual(expect.arrayContaining([expect.objectContaining({ sourceKind: "issue", sourceId: f.issueId })]));
    const events = await server.db.select().from(caseEvents).where(eq(caseEvents.caseId, f.record.id));
    expect(events.filter(event => event.kind === "fields_changed")).toHaveLength(1);
  });
  it("authors, pages, reuses and protects workflows with generic APIs disabled", async () => {
    const f = await fixture();
    expect(f.authority.definitions().map(tool => tool.name)).toEqual(expect.arrayContaining([
      "list_workflows", "read_workflow", "create_workflow", "update_workflow",
    ]));
    const prompt = "Reusable 🧾 instructions\n".repeat(2000);
    const input = { idempotencyKey: "workflow-create", name: "Receipt procedure", prompt };
    const created = await f.call("create_workflow", input) as { ok: boolean; data: { id: string } };
    expect(created).toMatchObject({ ok: true, status: 201, data: { name: input.name } });
    expect(created.data).not.toHaveProperty("prompt");
    expect(await f.call("create_workflow", input)).toEqual(created);
    expect(await f.call("list_workflows")).toMatchObject({ ok: true, data: [{ id: created.data.id, name: input.name }] });
    let offsetBytes = 0, text = "", snapshot: string | undefined;
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(20);
      const page = await f.call("read_workflow", { workflowId: created.data.id, snapshot, responseText: { offsetBytes, limitBytes: 8192 } }) as {
        ok: boolean; data: string; snapshot: string; responseText: { nextOffsetBytes: number | null };
      };
      expect(page.ok).toBe(true);
      expect(page.snapshot).toMatch(/^[a-f0-9]{64}$/);
      snapshot ??= page.snapshot;
      expect(page.snapshot).toBe(snapshot);
      expect(Buffer.byteLength(page.data)).toBeLessThanOrEqual(8192);
      text += page.data;
      if (page.responseText.nextOffsetBytes === null) break;
      offsetBytes = page.responseText.nextOffsetBytes;
    }
    expect(JSON.parse(text)).toMatchObject({ id: created.data.id, prompt });
    const receipt = await f.call("create_case", { idempotencyKey: "reusable-kickoff", title: "Reusable receipt", caseType: "loose",
      workflowId: created.data.id, kickoff: { toAgentId: f.agentId, phase: "custom phase", instructions: "Read workflow" } }) as { taskId: string; caseId: string };
    expect((await documentService(server.db).getIssueDocumentByKey(receipt.taskId, "workflow"))?.body).toBe(prompt);
    await expect(f.call("read_workflow", { workflowId: created.data.id, responseText: { offsetBytes: 8192 } })).rejects.toThrow("Invalid workflow arguments");
    expect(await f.call("update_workflow", { workflowId: created.data.id, idempotencyKey: "workflow-edit", prompt: prompt.replaceAll("Reusable", "Adjusted") })).toMatchObject({ ok: true });
    expect(await f.call("read_workflow", { workflowId: created.data.id, snapshot, responseText: { offsetBytes: 8192 } })).toMatchObject({ ok: false, status: 409 });
    const restarted = await f.call("read_workflow", { workflowId: created.data.id, responseText: { limitBytes: 4 } }) as { ok: boolean; data: string; snapshot: string };
    expect(restarted.ok).toBe(true);
    expect(restarted.snapshot).toMatch(/^[a-f0-9]{64}$/);
    expect(restarted.snapshot).not.toBe(snapshot);
    expect(Buffer.byteLength(restarted.data)).toBeLessThanOrEqual(4);
    expect((await documentService(server.db).getIssueDocumentByKey(receipt.taskId, "workflow"))?.body).toBe(prompt);
    const foreign = await fixture();
    expect(await foreign.call("read_workflow", { workflowId: created.data.id })).toMatchObject({ ok: false, status: 404 });
    expect(await foreign.call("update_workflow", { workflowId: created.data.id, idempotencyKey: "foreign", name: "No" })).toMatchObject({ ok: false, status: 404 });
    await server.db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await f.call("update_workflow", { workflowId: created.data.id, idempotencyKey: "stopped-workflow", name: "No" })).toMatchObject({ ok: false, status: 403 });
    await instanceSettingsService(server.db).updateExperimental({ enableCases: false });
    try { await expect(foreign.call("list_workflows")).rejects.toThrow("Cases are disabled"); }
    finally { await instanceSettingsService(server.db).updateExperimental({ enableCases: true }); }
  });
  it("requires kickoff before any case, task, comment, document or wake side effect", async () => {
    const f = await fixture();
    const snapshot = async () => ({ ...await f.snapshot(),
      cases: await server.db.select().from(cases).where(eq(cases.companyId, f.companyId)),
      handoffs: await server.db.select().from(caseHandoffs).where(eq(caseHandoffs.companyId, f.companyId)),
      wakes: await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)),
      runs: await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)),
    });
    const before = await snapshot();
    const input = { idempotencyKey: "missing-kickoff", caseType: "receipt", title: "Receipt facts", fields: { note: "private-data" },
      workflow_document_text: "Triage the receipt, implement corrections, verify, then hand off to done." };
    await expect(f.call("create_case", input)).rejects.toThrow("kickoff");
    for (const extra of [{ initialDocuments: [] }, { initialDocuments: [{ key: "brief", title: "Brief", body: "No kickoff" }] },
      { kickoff: null }, { kickoff: { phase: "triage" } }]) {
      await expect(f.call("create_case", { ...input, ...extra })).rejects.toThrow();
    }
    const kickoff = { toAgentId: f.agentId, phase: "triage", instructions: "Read the brief" };
    for (const extra of [{ status: "done" }, { key: "upsert" }, { responsibleUserId: randomUUID() }, { runId: f.runId }]) {
      await expect(f.call("create_case", { ...input, kickoff, ...extra })).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });
  it("does not publish contained run instructions into company workflows", async () => {
    const f = await fixture();
    await server.db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: {
      trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", rootIssueId: f.issueId } },
    } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await f.call("create_workflow", { idempotencyKey: "contained", name: "Do not publish", prompt: "Untrusted instructions" }))
      .toMatchObject({ ok: false, status: 403 });
  });
  it("requires explicit nonblank workflow text before native creation has any side effects", async () => {
    const f = await fixture();
    const snapshot = async () => ({ ...await f.snapshot(),
      cases: await server.db.select().from(cases).where(eq(cases.companyId, f.companyId)),
      handoffs: await server.db.select().from(caseHandoffs).where(eq(caseHandoffs.companyId, f.companyId)),
      wakes: await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)),
      runs: await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)),
    });
    const before = await snapshot();
    const input = { idempotencyKey: "missing-workflow", caseType: "receipt", title: "Check receipt",
      kickoff: { toAgentId: f.agentId, phase: "triage", instructions: "Read the workflow" } };
    await expect(f.call("create_case", input)).rejects.toThrow("workflow_document_text");
    for (const workflow_document_text of [null, "", " \n\t", "x".repeat(200_001)]) {
      await expect(f.call("create_case", { ...input, workflow_document_text })).rejects.toThrow();
    }
    await expect(f.call("create_case", { ...input, workflow_document_text: "Triage then verify.",
      initialDocuments: [{ key: " WORKFLOW ", title: "Override", body: "Unexpected routing" }] })).rejects.toThrow();
    await expect(f.call("create_case", { ...input, workflow_document_text: "x".repeat(200_000),
      initialDocuments: [{ key: "brief", title: "Brief", body: "Over the shared budget" }] })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("kicks off through the durable handoff service with initial ordinary task documents", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const input = { idempotencyKey: "kickoff-case", caseType: "receipt", title: "Check receipt", summary: "Validate the brief",
      workflow_document_text: "  # Receipt workflow\n\nTriage → implementation → verification → done.\n\n```mermaid\nstateDiagram-v2\n  [*] --> triage\n  triage --> implementation\n```\n",
      kickoff: { toAgentId: f.agentId, phase: "triage", instructions: "Read the brief" },
      initialDocuments: [{ key: " BRIEF ", title: " Brief ", body: "Objective\\nDetails" }] };
    const receipt = await f.call("create_case", input) as { caseId: string; taskId: string; handoffId: string };
    expect(receipt).toMatchObject({ caseId: expect.any(String), taskId: expect.any(String), handoffId: expect.any(String), callerMustYield: false });
    expect(receipt.taskId).not.toBe(f.issueId);
    expect(await f.call("create_case", input)).toMatchObject({ ...receipt, replayed: true });
    const saved = await f.snapshot();
    expect(saved.issues).toHaveLength(before.issues.length + 1);
    expect(saved.documents).toHaveLength(before.documents.length + 2);
    expect(saved.documentRevisions).toHaveLength(before.documentRevisions.length + 2);
    expect(saved.comments).toHaveLength(before.comments.length + 1);
    expect(saved.documentRevisions.filter(revision => revision.createdByRunId === f.runId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ revisionNumber: 1, createdByAgentId: f.agentId })]));
    const { documentService } = await import("../documents.js");
    expect(await documentService(server.db).getIssueDocumentByKey(receipt.taskId, "brief")).toMatchObject({ title: "Brief", body: "Objective\nDetails" });
    expect(await documentService(server.db).getIssueDocumentByKey(receipt.taskId, "workflow"))
      .toMatchObject({ issueId: receipt.taskId, key: "workflow", title: "Workflow", format: "markdown", body: input.workflow_document_text, latestRevisionNumber: 1 });
    expect(await server.db.select().from(caseDocuments).where(eq(caseDocuments.caseId, receipt.caseId))).toHaveLength(0);
    expect(await server.db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, receipt.caseId))).toHaveLength(1);
    expect(await server.db.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, receipt.caseId)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ sourceKind: "issue", sourceId: receipt.taskId })]));
    const laterRunId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: laterRunId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId } });
    await server.db.update(issues).set({ executionRunId: laterRunId }).where(eq(issues.id, f.issueId));
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    const later = new PaperclipRunnerToolAuthority(server.db, { ...f, runId: laterRunId, casesEnabled: true, workMode: "standard" });
    expect(await later.execute({ tool: "create_case", callId: randomUUID(), arguments: input })).toMatchObject({ ...receipt, replayed: true });
    await expect(later.execute({ tool: "create_case", callId: randomUUID(), arguments: { ...input, workflow_document_text: "Changed routing" } }))
      .rejects.toThrow("Idempotency key was used for a different handoff");
    await expect(f.call("create_case", { ...input, initialDocuments: [{ key: "brief", title: "Changed", body: "Other" }] })).rejects.toThrow("Idempotency key was used for a different handoff");
    const afterReplay = await f.snapshot();
    expect(afterReplay.issues).toHaveLength(saved.issues.length);
    expect(afterReplay.documents).toHaveLength(saved.documents.length);
    expect(afterReplay.documentRevisions).toHaveLength(saved.documentRevisions.length);
    expect(afterReplay.comments).toHaveLength(saved.comments.length);
    await server.db.insert(caseAccessSources).values({ companyId: f.companyId, caseId: receipt.caseId, sourceKind: "issue", sourceId: f.blockerId });
    await server.db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    await expect(later.execute({ tool: "create_case", callId: randomUUID(), arguments: input })).rejects.toThrow("Case not found");
  });
  it("rejects unsupported fields and reads only explicit standalone cases in the authorized company", async () => {
    const f = await fixture();
    for (const extra of [{ status: "done" }, { phase: "done" }, { workIssueId: f.blockerId }, { responsibleUserId: randomUUID() }]) {
      await expect(f.call("update_case", { idempotencyKey: randomUUID(), title: "No", ...extra })).rejects.toThrow("Invalid case tool arguments");
    }
    await expect(f.call("update_case", { idempotencyKey: "empty" })).rejects.toThrow("Invalid case tool arguments");
    await expect(f.call("write_case_document", { key: "receipt", body: "No" })).rejects.toThrow();
    const [foreign] = await server.db.insert(cases).values({ companyId: f.foreignCompanyId, caseNumber: 1,
      identifier: `C-${randomUUID()}`, caseType: "private", title: "foreign-data-must-not-leak" }).returning();
    await expect(f.call("read_case", { caseId: foreign!.id })).rejects.toThrow("Case not found");
    await expect(f.call("read_case", { caseId: randomUUID() })).rejects.toThrow("Case not found");
    const [pipeline] = await server.db.insert(pipelines).values({ companyId: f.companyId, key: "separate", name: "Separate experimental model" }).returning();
    const [stage] = await server.db.insert(pipelineStages).values({ pipelineId: pipeline!.id, key: "triage", name: "Triage", kind: "working", position: 0 }).returning();
    const [pipelineCase] = await server.db.insert(pipelineCases).values({ companyId: f.companyId, pipelineId: pipeline!.id,
      stageId: stage!.id, caseKey: "pipeline-only", title: "pipeline-data-must-not-leak" }).returning();
    await expect(f.call("read_case", { caseId: pipelineCase!.id })).rejects.toThrow("Case not found");
    const other = await fixture();
    await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.blockerId));
    await server.db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    const [hidden] = await server.db.insert(cases).values({ companyId: f.companyId, caseNumber: 2,
      identifier: `C-${randomUUID()}`, caseType: "private", title: "hidden-case-canary" }).returning();
    await server.db.insert(caseAccessSources).values({ companyId: f.companyId, caseId: hidden!.id, sourceKind: "issue", sourceId: f.blockerId });
    await expect(f.call("read_case", { caseId: hidden!.id })).rejects.toThrow("Case not found");
    expect(await other.call("read_case")).toMatchObject({ status: 200, data: { id: other.record.id } });
  });
  it("reads every large case field and current routing version through the dedicated native tool", async () => {
    const f = await fixture();
    const fields = { notes: "🧾\n\"".repeat(8_000), rows: Array.from({ length: 800 }, (_, index) => ({ index, exact: "row" })),
      ["long-key-".repeat(2_000)]: ["exact final value", null] };
    await server.db.update(cases).set({ fields, summary: "Large summary 🧾".repeat(400), phase: "verification", handoffVersion: 5 }).where(eq(cases.id, f.record.id));
    await server.db.update(issues).set({ statusVersion: 9 }).where(eq(issues.id, f.issueId));
    expect(f.authority.definitions().map(tool => tool.name)).not.toContain("call_api");
    // Reproduce the existing generic transport's >24KiB asset-only response.
    // The dedicated reader below must remain usable with generic API disabled.
    const generic = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: true, apiToolsEnabled: true });
    const baseline = await generic.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/cases/{id}", pathParams: { id: f.record.id }, query: { includeDocumentBodies: false },
    } });
    expect(baseline).toMatchObject({ ok: true, artifact: { artifactId: expect.any(String) } });
    expect(baseline).not.toHaveProperty("data");
    const before = await f.snapshot();
    type Page = { ok: boolean; status: number; data: { id: string; handoffVersion: number;
      workIssue: { statusVersion: number }; readPage: { mode: "json_text"; text: string; snapshot: string; nextOffsetBytes: number | null } } };
    const first = await f.call("read_case") as Page;
    expect(first).toMatchObject({ ok: true, status: 200, data: { id: f.record.id, handoffVersion: 5, phase: "verification", workIssue: { statusVersion: 9 }, readPage: { mode: "json_text" } } });
    expect(first).not.toHaveProperty("artifact");
    for (const section of ["case", "fields"] as const) {
      let page = section === "case" ? first : await f.call("read_case", { section }) as Page;
      let text = "";
      for (let count = 0; ; count++) {
        expect(count).toBeLessThan(100);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(24 * 1024);
        expect(page).toMatchObject({ ok: true, status: 200, data: { id: f.record.id, handoffVersion: 5, workIssue: { statusVersion: 9 } } });
        expect(page).not.toHaveProperty("artifact");
        text += page.data.readPage.text;
        const { nextOffsetBytes, snapshot } = page.data.readPage;
        if (nextOffsetBytes === null) break;
        page = await f.call("read_case", { section, offsetBytes: nextOffsetBytes, snapshot }) as Page;
      }
      const recovered = JSON.parse(text);
      expect(section === "case" ? recovered.fields : recovered).toEqual(fields);
    }
    expect((await f.snapshot()).assets).toEqual(before.assets);
    const snapshot = first.data.readPage.snapshot;
    await server.db.update(issues).set({ statusVersion: 10 }).where(eq(issues.id, f.issueId));
    expect(await f.call("read_case", { section: "case", offsetBytes: first.data.readPage.nextOffsetBytes, snapshot }))
      .toMatchObject({ ok: false, status: 409 });
    expect(await f.call("read_case")).toMatchObject({ data: { workIssue: { statusVersion: 10 } } });
    // An ordinary facts mutation can still return its established capture;
    // dedicated reads recover current facts without replaying that mutation.
    await f.call("update_case", { idempotencyKey: "large-new-value", fields });
    expect(await f.call("read_case", { section: "fields" })).toMatchObject({ ok: true, data: { readPage: { mode: "json_text" } } });
    await server.db.insert(caseAccessSources).values({ companyId: f.companyId, caseId: f.record.id, sourceKind: "issue", sourceId: f.blockerId });
    await server.db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    await expect(f.call("read_case", { section: "case", offsetBytes: first.data.readPage.nextOffsetBytes, snapshot })).rejects.toThrow("Case not found");
  });

  it.each(["case", "primary", "linked"] as const)("reads small and paged %s document bodies with generic API disabled", async kind => {
    const f = await documentFixture(kind, "Small exact body 🧾\n\"quoted\" \\tail");
    expect(f.authority.definitions().map(tool => tool.name)).not.toContain("call_api");
    const before = await f.snapshot();
    const small = await readCompleteDocument(f, f.selector);
    expect(small.document).toMatchObject({ id: f.saved.document.id, body: "Small exact body 🧾\n\"quoted\" \\tail",
      latestRevisionId: f.saved.document.latestRevisionId, latestRevisionNumber: 1 });
    expect(small.pages).toBe(1);
    const saved = kind === "case" ? await saveCaseDocument(f, f.key, documentBody, f.saved.document.latestRevisionId)
      : await documentService(server.db).upsertIssueDocument({ issueId: f.selector.documentIssueId!, key: f.key,
        title: `Task ${f.key}`, format: "markdown", body: documentBody, baseRevisionId: f.saved.document.latestRevisionId });
    await server.db.update(cases).set({ phase: "verification", handoffVersion: 7 }).where(eq(cases.id, f.record.id));
    await server.db.update(issues).set({ statusVersion: 12 }).where(eq(issues.id, f.issueId));
    const first = await f.call("read_case", f.selector) as DocumentPage;
    expect(first).toMatchObject({ data: { phase: "verification", handoffVersion: 7, workIssue: { statusVersion: 12 } } });
    const large = await readCompleteDocument(f, f.selector, first);
    expect(large.pages).toBeGreaterThan(1);
    expect(large.document).toMatchObject({ id: saved.document.id, body: documentBody,
      latestRevisionId: saved.document.latestRevisionId, latestRevisionNumber: 2 });
    expect((await f.snapshot()).assets).toEqual(before.assets);
    // The established active-task document tool remains independently usable.
    expect(await f.call("read_document", { key: "notes" })).toMatchObject({ document: { key: "notes" } });
  });

  it("keeps same-key case and task documents distinct and rejects unrelated, foreign, or inaccessible task sources", async () => {
    const f = await documentFixture("case", "Legacy case notes");
    const primary = await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: f.key,
      title: "Primary notes", format: "markdown", body: "Current task notes" });
    expect((await readCompleteDocument(f, f.selector)).document).toMatchObject({ id: f.saved.document.id, body: "Legacy case notes" });
    expect((await readCompleteDocument(f, { ...f.selector, documentIssueId: f.issueId })).document)
      .toMatchObject({ id: primary.document.id, body: "Current task notes" });
    const [unlinked] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Unlinked source" }).returning();
    const [foreign] = await server.db.insert(issues).values({ companyId: f.foreignCompanyId, title: "Foreign source" }).returning();
    await server.db.insert(caseIssueLinks).values({ companyId: f.companyId, caseId: f.record.id, issueId: f.blockerId, role: "reference" });
    await server.db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    for (const issueId of [unlinked!.id, foreign!.id, f.blockerId]) {
      await documentService(server.db).upsertIssueDocument({ issueId, key: f.key, format: "markdown", body: "HIDDEN_DOCUMENT_BODY_CANARY" });
      const denied = await f.call("read_case", { ...f.selector, documentIssueId: issueId });
      expect(denied).toMatchObject({ ok: false, status: 404 });
      expect(JSON.stringify(denied)).not.toContain("HIDDEN_DOCUMENT_BODY_CANARY");
    }
  });

  it.each(["revoke", "unlink"] as const)("rechecks linked document authority after %s between pages", async change => {
    const f = await documentFixture("linked", documentBody);
    const first = await f.call("read_case", f.selector) as DocumentPage;
    expect(first).toMatchObject({ ok: true, status: 200 });
    expect(first.data.readPage.nextOffsetBytes).not.toBeNull();
    if (change === "revoke") await server.db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    else await server.db.delete(caseIssueLinks).where(and(eq(caseIssueLinks.caseId, f.record.id), eq(caseIssueLinks.issueId, f.blockerId)));
    const denied = await f.call("read_case", { ...f.selector, offsetBytes: first.data.readPage.nextOffsetBytes, snapshot: first.data.readPage.snapshot });
    expect(denied).toMatchObject({ ok: false, status: 404 });
    expect(JSON.stringify(denied)).not.toContain("Exact receipt");
  });

  it("does not expose system task documents or quarantined case and task bodies", async () => {
    const f = await documentFixture("case", "QUARANTINED_LEGACY_BODY_CANARY");
    await server.db.update(documents).set({ sourceTrust: { preset: "low_trust_review", disposition: "quarantined" } })
      .where(eq(documents.id, f.saved.document.id));
    const task = await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: f.key, format: "markdown",
      body: "QUARANTINED_TASK_BODY_CANARY", sourceTrust: { preset: "low_trust_review", disposition: "quarantined" } });
    expect(task.document.id).not.toBe(f.saved.document.id);
    for (const selector of [f.selector, { ...f.selector, documentIssueId: f.issueId }]) {
      const denied = await f.call("read_case", selector);
      expect(denied).toMatchObject({ ok: false, status: 404 });
      expect(JSON.stringify(denied)).not.toMatch(/QUARANTINED_(LEGACY|TASK)_BODY_CANARY/);
    }
    for (const key of SYSTEM_ISSUE_DOCUMENT_KEYS) {
      await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key, format: "markdown", body: "SYSTEM_BODY_CANARY" });
      const denied = await f.call("read_case", { ...f.selector, documentKey: key, documentIssueId: f.issueId });
      expect(denied).toMatchObject({ ok: false, status: 404 });
      expect(JSON.stringify(denied)).not.toContain("SYSTEM_BODY_CANARY");
    }
  });

  it("reauthorizes the case itself on a document continuation", async () => {
    const f = await documentFixture("primary", documentBody);
    await server.db.insert(caseAccessSources).values({ companyId: f.companyId, caseId: f.record.id, sourceKind: "issue", sourceId: f.blockerId });
    const first = await f.call("read_case", f.selector) as DocumentPage;
    expect(first).toMatchObject({ ok: true, status: 200 });
    await server.db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    await expect(f.call("read_case", { ...f.selector, offsetBytes: first.data.readPage.nextOffsetBytes, snapshot: first.data.readPage.snapshot }))
      .rejects.toThrow("Case not found");
  });

  it.each(["case", "linked"] as const)("rejects a changed %s document snapshot and restarts at its current revision", async kind => {
    const f = await documentFixture(kind, documentBody);
    const first = await f.call("read_case", f.selector) as DocumentPage;
    expect(first.data.readPage.nextOffsetBytes).not.toBeNull();
    const body = `${documentBody}New revision 🧾`;
    const updated = kind === "case" ? await saveCaseDocument(f, f.key, body, f.saved.document.latestRevisionId)
      : await documentService(server.db).upsertIssueDocument({ issueId: f.blockerId, key: f.key, format: "markdown",
        body, baseRevisionId: f.saved.document.latestRevisionId });
    expect(await f.call("read_case", { ...f.selector, offsetBytes: first.data.readPage.nextOffsetBytes, snapshot: first.data.readPage.snapshot }))
      .toMatchObject({ ok: false, status: 409 });
    const current = await readCompleteDocument(f, f.selector);
    expect(current.document).toMatchObject({ id: updated.document.id, body,
      latestRevisionId: updated.document.latestRevisionId, latestRevisionNumber: 2 });
  });

  it("retains case privacy on spilled response assets after source access is revoked", async () => {
    const f = await fixture();
    await server.db.insert(caseAccessSources).values({ companyId: f.companyId, caseId: f.record.id, sourceKind: "issue", sourceId: f.blockerId });
    const saved = await f.call("update_case", { idempotencyKey: "large-fields", fields: { canary: "private-case-canary ".repeat(2_000) } }) as { artifact: { artifactId: string; url: string } };
    expect(saved).toMatchObject({ ok: true, status: 200, artifact: { artifactId: expect.any(String) } });
    const asset = (await f.snapshot()).assets.find(asset => asset.id === saved.artifact.artifactId)!;
    expect(asset.objectKey).toContain(`/cases/${f.record.id}/runner-api/`);
    const headers = { Authorization: `Bearer ${createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId)}` };
    const readable = await fetch(`${server.apiUrl}${saved.artifact.url}`, { headers });
    expect(readable.status).toBe(200); await readable.body?.cancel();
    const readerId = randomUUID(), readerRunId = randomUUID();
    await server.db.insert(agents).values({ id: readerId, companyId: f.companyId, name: "Another case reader", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: { heartbeat: { enabled: false } } });
    const [readerTask] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Another task",
      status: "in_progress", assigneeAgentId: readerId }).returning();
    await server.db.insert(heartbeatRuns).values({ id: readerRunId, companyId: f.companyId, agentId: readerId,
      nativeIssueId: readerTask!.id, status: "running", runtimeMode: "native", contextSnapshot: { issueId: readerTask!.id } });
    await server.db.update(issues).set({ executionRunId: readerRunId }).where(eq(issues.id, readerTask!.id));
    const readerHeaders = { Authorization: `Bearer ${createLocalAgentJwt(readerId, f.companyId, "paperclip_runner", readerRunId)}` };
    const sameCase = await fetch(`${server.apiUrl}/api/cases/${f.record.id}`, { headers: readerHeaders });
    expect(sameCase.status).toBe(200); await sameCase.body?.cancel();
    const otherRunCapture = await fetch(`${server.apiUrl}${saved.artifact.url}`, { headers: readerHeaders });
    expect(otherRunCapture.status).toBe(404); await otherRunCapture.body?.cancel();
    const generic = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: true, apiToolsEnabled: true });
    const genericRead = await generic.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/cases/{id}", pathParams: { id: f.record.id },
    } }) as { artifact: { artifactId: string; url: string } };
    const genericAsset = (await f.snapshot()).assets.find(asset => asset.id === genericRead.artifact.artifactId)!;
    expect(genericAsset.objectKey).toContain(`/cases/${f.record.id}/runner-api/`);
    await server.db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    await expect(f.call("read_case")).rejects.toThrow("Case not found");
    const denied = await fetch(`${server.apiUrl}${saved.artifact.url}`, { headers });
    expect(denied.status).toBe(404); await denied.body?.cancel();
    const genericDenied = await fetch(`${server.apiUrl}${genericRead.artifact.url}`, { headers });
    expect(genericDenied.status).toBe(404); await genericDenied.body?.cancel();
  });
  it("keeps feature and work-mode gates authoritative", async () => {
    const f = await fixture();
    for (const mode of ["planning", "ask"] as const) {
      const other = await fixture(mode);
      expect(other.authority.definitions().map(tool => tool.name)).not.toContain("read_case");
      await expect(other.call("read_case")).rejects.toThrow("mode_denied");
    }
    const disabled = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: false });
    expect(disabled.definitions().map(tool => tool.name)).not.toContain("read_case");
    await expect(disabled.execute({ tool: "read_case", callId: randomUUID(), arguments: {} })).rejects.toThrow("Cases are disabled");
    const review = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: true,
      nativeReview: { nativeReviewInteractionId: randomUUID(), nativeReviewDecisionId: randomUUID() } });
    expect(review.definitions().map(tool => tool.name)).not.toContain("read_case");
    await expect(review.execute({ tool: "update_case", callId: randomUUID(), arguments: { idempotencyKey: "review", title: "No" } })).rejects.toThrow("may only inspect");
    await server.db.update(issues).set({ workMode: "skill_test" }).where(eq(issues.id, f.issueId));
    await expect(f.call("read_case")).rejects.toThrow("mode_denied");
    await server.db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, f.issueId));
    await instanceSettingsService(server.db).updateExperimental({ enableCases: false });
    try { await expect(f.call("read_case")).rejects.toThrow("Cases are disabled"); }
    finally { await instanceSettingsService(server.db).updateExperimental({ enableCases: true }); }
  });
  it("fences committed outgoing handoffs before a case write reaches the route", async () => {
    const f = await fixture();
    await server.db.insert(caseHandoffs).values({ companyId: f.companyId, caseId: f.record.id, issueId: f.issueId,
      version: 1, fromAgentId: f.agentId, toAgentId: f.agentId, phase: "verification", instructions: "Verify",
      actorType: "agent", actorId: f.agentId, sourceRunId: f.runId, wakeupRequestId: randomUUID(),
      idempotencyKey: "outgoing", inputFingerprint: "fixture", state: "awaiting_release" });
    await expect(f.call("update_case", { idempotencyKey: "too-late", title: "No" })).rejects.toThrow("handed off");
    await expect(f.call("create_case", { idempotencyKey: "too-late-create", caseType: "test", title: "No",
      workflow_document_text: "Triage then done.",
      kickoff: { toAgentId: f.agentId, phase: "triage", instructions: "No" } })).rejects.toThrow("handed off");
    expect((await server.db.select().from(cases).where(eq(cases.id, f.record.id)))[0]?.title).toBe("Receipt case");
    expect(await server.db.select().from(caseDocuments).where(eq(caseDocuments.caseId, f.record.id))).toHaveLength(0);
  });
  it("keeps cancelled runs from writing", async () => {
    const f = await fixture();
    await server.db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await f.call("update_case", { idempotencyKey: "stopped", title: "No" })).toMatchObject({ ok: false, status: 403 });
    await expect(f.call("create_case", { idempotencyKey: "stopped-create", caseType: "test", title: "No",
      workflow_document_text: "Triage then done.",
      kickoff: { toAgentId: f.agentId, phase: "triage", instructions: "No" } })).rejects.toThrow("cancelled");
    expect((await server.db.select().from(cases).where(and(eq(cases.id, f.record.id), eq(cases.companyId, f.companyId))))[0]?.title).toBe("Receipt case");
  });
  it("rechecks the handoff fence inside the route after HTTP dispatch was prepared", async () => {
    const f = await fixture();
    const [target] = await server.db.insert(cases).values({ companyId: f.companyId, caseNumber: 2,
      identifier: `C-${randomUUID()}`, caseType: "passive", title: "Untouched passive case" }).returning();
    const realFetch = globalThis.fetch;
    let arrived!: () => void, release!: () => void;
    const preparing = new Promise<void>(resolve => { arrived = resolve; });
    const continueRequest = new Promise<void>(resolve => { release = resolve; });
    const intercepted = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (...args) => {
      arrived(); await continueRequest; return realFetch(...args);
    });
    try {
      const pending = f.call("update_case", { caseId: target!.id, idempotencyKey: "race", title: "No" });
      await preparing;
      await server.db.insert(caseHandoffs).values({ companyId: f.companyId, caseId: f.record.id, issueId: f.issueId,
        version: 1, fromAgentId: f.agentId, toAgentId: f.agentId, phase: "verification", instructions: "Verify",
        actorType: "agent", actorId: f.agentId, sourceRunId: f.runId, wakeupRequestId: randomUUID(),
        idempotencyKey: "outgoing-race", inputFingerprint: "fixture", state: "awaiting_release" });
      release();
      expect(await pending).toMatchObject({ ok: false, status: 403 });
      expect((await server.db.select().from(cases).where(eq(cases.id, target!.id)))[0]?.title).toBe("Untouched passive case");
      expect(await server.db.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, target!.id))).toHaveLength(0);
    } finally { release(); intercepted.mockRestore(); }
  });
});
