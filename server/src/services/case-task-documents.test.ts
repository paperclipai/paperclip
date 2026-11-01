import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, caseDocuments, caseIssueLinks, cases, companies, createDb, documents, heartbeatRuns, issueDocuments, issues } from "@paperclipai/db";
import { SYSTEM_ISSUE_DOCUMENT_KEYS } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { listCaseTaskDocuments } from "./case-task-documents.js";
import { getCaseExecutionContext } from "./case-context.js";

describe("case task document references", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    temporary = await startEmbeddedPostgresTestDatabase("case-task-documents-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { vi.unstubAllEnvs(); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
    const caseId = randomUUID(), taskId = randomUUID(), linkedId = randomUUID(), privateId = randomUUID(), unrelatedId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Document factory", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(agents).values([agentId, otherAgentId].map(id => ({ id, companyId, name: id, role: "engineer", status: "active", adapterType: "process" })));
    await db.insert(issues).values([
      { id: taskId, companyId, title: "Primary task", identifier: `${companyId}-1`, assigneeAgentId: agentId },
      { id: linkedId, companyId, title: "Linked task", identifier: `${companyId}-2` },
      { id: privateId, companyId, title: "Private task", visibility: "private", assigneeAgentId: otherAgentId },
      { id: unrelatedId, companyId, title: "Unrelated task" },
    ]);
    await db.insert(cases).values({ id: caseId, companyId, caseNumber: 1, identifier: `${companyId}-C1`, caseType: "work", title: "Shared findings", workIssueId: taskId });
    await db.insert(caseIssueLinks).values([linkedId, privateId].map(issueId => ({ companyId, caseId, issueId, role: "reference" })));
    const actor = { type: "agent" as const, companyId, agentId, keyScope: { kind: "standard" as const } };
    return { companyId, agentId, caseId, taskId, linkedId, privateId, unrelatedId, actor };
  }
  async function document(companyId: string, taskId: string, key: string, title: string, quarantined = false) {
    const id = randomUUID(), revisionId = randomUUID();
    await db.insert(documents).values({ id, companyId, title, latestBody: `BODY_CANARY ${title}`, latestRevisionId: revisionId,
      ...(quarantined ? { sourceTrust: { preset: "low_trust_review" as const, disposition: "quarantined" as const } } : {}) });
    await db.insert(issueDocuments).values({ companyId, issueId: taskId, documentId: id, key });
    return { id, revisionId };
  }

  it("rolls up primary and readable linked task metadata with distinct keys, never copies or bodies", async () => {
    const f = await fixture();
    const primary = await document(f.companyId, f.taskId, "plan", "Primary plan");
    await document(f.companyId, f.linkedId, "plan", "Linked plan");
    await document(f.companyId, f.privateId, "plan", "PRIVATE_TITLE_CANARY");
    await document(f.companyId, f.unrelatedId, "notes", "UNRELATED_TITLE_CANARY");
    const result = await listCaseTaskDocuments(db, { companyId: f.companyId, caseId: f.caseId, workIssueId: f.taskId, actor: f.actor });
    expect(result.taskDocuments).toHaveLength(2);
    expect(result.taskDocuments[0]).toMatchObject({ id: `issue:${f.taskId}:plan`, taskId: f.taskId, scope: "primary", key: "plan", document: { id: primary.id, latestRevisionId: primary.revisionId }, readPath: `/api/issues/${f.taskId}/documents/plan` });
    expect(new Set(result.taskDocuments.map(ref => ref.id)).size).toBe(2);
    expect(JSON.stringify(result)).not.toMatch(/BODY_CANARY|PRIVATE_TITLE_CANARY|UNRELATED_TITLE_CANARY|latestBody/);
    expect(await db.select().from(caseDocuments).where(eq(caseDocuments.caseId, f.caseId))).toHaveLength(0);
    expect(result.taskDocumentsOmitted).toBe(false);
  });

  it("filters quarantined references before the visible document limit and refreshes permissions", async () => {
    const f = await fixture();
    await document(f.companyId, f.taskId, "a-quarantine", "QUARANTINE_TITLE_CANARY", true);
    await document(f.companyId, f.taskId, "b-visible", "Visible finding");
    for (const key of SYSTEM_ISSUE_DOCUMENT_KEYS) await document(f.companyId, f.taskId, key, "SYSTEM_TITLE_CANARY");
    const first = await listCaseTaskDocuments(db, { companyId: f.companyId, caseId: f.caseId, workIssueId: f.taskId, actor: f.actor, limit: 1 });
    expect(first.taskDocuments.map(ref => ref.key)).toEqual(["b-visible"]);
    expect(first.taskDocumentsOmitted).toBe(false);
    const board = await listCaseTaskDocuments(db, { companyId: f.companyId, caseId: f.caseId, workIssueId: f.taskId,
      actor: { type: "board", source: "local_implicit" }, limit: 2 });
    expect(board.taskDocuments.map(ref => ref.key)).toEqual(["a-quarantine", "b-visible"]);
    expect(board.taskDocumentsOmitted).toBe(false);
    await db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, f.taskId));
    expect((await listCaseTaskDocuments(db, { companyId: f.companyId, caseId: f.caseId, workIssueId: f.taskId, actor: f.actor })).taskDocuments).toEqual([]);
  });

  it("keeps the primary workflow reference visible before the context budget without injecting its body", async () => {
    const f = await fixture(), runId = randomUUID();
    for (let index = 0; index < 20; index++) await document(f.companyId, f.taskId, `a-${index}`, `Finding ${index}`);
    const workflow = await document(f.companyId, f.taskId, "workflow", "Workflow");
    await document(f.companyId, f.linkedId, "workflow", "Linked workflow");
    const first = await listCaseTaskDocuments(db, { companyId: f.companyId, caseId: f.caseId, workIssueId: f.taskId, actor: f.actor, limit: 1 });
    expect(first.taskDocuments).toHaveLength(1);
    expect(first.taskDocuments[0]).toMatchObject({ taskId: f.taskId, key: "workflow", document: { id: workflow.id } });
    expect(first.taskDocumentsOmitted).toBe(true);
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, issueId: f.taskId,
      status: "running", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.taskId } });
    const context = await getCaseExecutionContext(db, { companyId: f.companyId, issueId: f.taskId, agentId: f.agentId, runId });
    expect(JSON.parse(context!.data).documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "issue", taskId: f.taskId, key: "workflow", revisionId: workflow.revisionId }),
    ]));
    expect(context!.data).not.toContain("BODY_CANARY");
  });

  it("fresh wake context includes owner task and revision references alongside historical case documents", async () => {
    const f = await fixture(), runId = randomUUID();
    const primary = await document(f.companyId, f.taskId, "receipt", "Receipt");
    const legacyId = randomUUID();
    await db.insert(documents).values({ id: legacyId, companyId: f.companyId, title: "Historical receipt", latestBody: "LEGACY_BODY_CANARY" });
    await db.insert(caseDocuments).values({ companyId: f.companyId, caseId: f.caseId, documentId: legacyId, key: "receipt" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, issueId: f.taskId,
      status: "running", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.taskId } });
    const read = () => getCaseExecutionContext(db, { companyId: f.companyId, issueId: f.taskId, agentId: f.agentId, runId });
    const before = await read(), refs = JSON.parse(before!.data).documents;
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "issue", taskId: f.taskId, key: "receipt", revisionId: primary.revisionId }),
      expect.objectContaining({ sourceKind: "case", caseId: f.caseId, key: "receipt" }),
    ]));
    expect(new Set(refs.map((ref: { id: string }) => ref.id)).size).toBe(2);
    expect(before!.data).not.toMatch(/BODY_CANARY|LEGACY_BODY_CANARY/);
    await db.update(documents).set({ latestRevisionId: randomUUID() }).where(eq(documents.id, primary.id));
    const after = await read();
    expect(after!.factsSha256).not.toBe(before!.factsSha256);
    expect(await db.select().from(caseDocuments).where(eq(caseDocuments.documentId, legacyId))).toHaveLength(1);
  });
});
