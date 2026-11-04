import { randomUUID } from "node:crypto";
import {
  agents,
  agentTaskSessions,
  cases,
  companies,
  createDb,
  documentAnnotationComments,
  documentAnnotationThreads,
  executionAdmissions,
  heartbeatRuns,
  issueComments,
  issueProjectReferences,
  issueThreadInteractions,
  issues,
  projectAccessMembers,
  projects,
  subscribeDatabaseWork,
} from "@paperclipai/db";
import { scanProjectMentions } from "@paperclipai/shared";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import type { AuthorizationActor } from "./authorization.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { documentService } from "./documents.js";
import { setIssueTitle } from "./issue-title.js";
import { issueService } from "./issues.js";
import {
  findTasksReferencingProject,
  readTaskProjectReferenceHint,
  resolveTaskProjectReferences,
  type ResolveTaskProjectReferencesInput,
} from "./task-project-references.js";

const support = await getEmbeddedPostgresTestSupport();
type TestDb = ReturnType<typeof createDb>;
const link = (projectId: string, label = "p") => `[${label}](project://${projectId})`;

describe.skipIf(!support.supported)("task project references", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: TestDb;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("task-project-references-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function fixture() {
    const prefix = `T${randomUUID().slice(0, 6)}`;
    const [company] = await db.insert(companies).values({ name: "References", issuePrefix: prefix }).returning();
    const [other] = await db.insert(companies).values({ name: "Foreign", issuePrefix: `F${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Writer", adapterType: "process" }).returning();
    const rows = await db.insert(projects).values(["A", "B", "C"].map(name => ({ companyId: company.id, name }))).returning();
    const [foreign] = await db.insert(projects).values({ companyId: other.id, name: "Foreign" }).returning();
    const [a, b, c] = rows.map(row => row.id);
    const actor: AuthorizationActor = { type: "agent", agentId: agent.id, companyId: company.id, keyScope: { kind: "standard" } };
    return { companyId: company.id, prefix, agentId: agent.id, a, b, c, foreign: foreign.id, actor };
  }

  const inTransaction = <T>(work: (tx: TestDb) => Promise<T>) => db.transaction(tx => work(tx as unknown as TestDb));
  const resolve = (input: ResolveTaskProjectReferencesInput) => inTransaction(tx => resolveTaskProjectReferences(tx, input));
  const revision = async (issueId: string) =>
    (await db.select({ revision: issues.contextReferenceRevision }).from(issues).where(eq(issues.id, issueId)))[0]?.revision;
  const candidates = async (issueId: string) => (await db.select({ kind: issueProjectReferences.sourceKind, projectId: issueProjectReferences.projectId })
    .from(issueProjectReferences).where(eq(issueProjectReferences.issueId, issueId))
    .orderBy(asc(issueProjectReferences.sourceKind), asc(issueProjectReferences.projectId))).map(row => `${row.kind}:${row.projectId}`);

  it("advances the revision and candidates in the statement of every issue, comment and document writer", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const docs = documentService(db);
    const task = await svc.create(f.companyId, { title: "Primaryless", description: `Uses ${link(f.b)} twice ${link(f.b)}` });
    expect(await candidates(task.id)).toEqual([`issue:${f.b}`]);
    let last = await revision(task.id);
    const advanced = async (expected: string[]) => {
      const next = await revision(task.id);
      expect(next).toBeGreaterThan(last!);
      last = next;
      expect(await candidates(task.id)).toEqual([...expected].sort());
    };

    await svc.update(task.id, { priority: "high" });
    expect(await revision(task.id)).toBe(last);
    await svc.update(task.id, { projectId: f.a });
    await advanced([`issue:${f.a}`, `issue:${f.b}`]);
    await inTransaction(tx => setIssueTitle(tx, f.companyId, task.id, { title: `Now ${link(f.c)}` }, { actorType: "user", actorId: "board" }));
    await advanced([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`]);

    const comment = await svc.addComment(task.id, `Also ${link(f.c)}`, { userId: "board" });
    await advanced([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`, `comment:${f.c}`]);
    await db.update(issueComments).set({ updatedAt: new Date() }).where(eq(issueComments.id, comment.id));
    expect(await revision(task.id)).toBe(last);
    await svc.tombstoneComment(comment.id, { actorType: "user", userId: "board" });
    await advanced([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`]);
    const removed = await svc.addComment(task.id, link(f.a), { userId: "board" });
    await advanced([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`, `comment:${f.a}`]);
    await svc.removeComment(removed.id);
    await advanced([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`]);

    const created = await docs.upsertIssueDocument({ issueId: task.id, key: "notes", format: "markdown", body: link(f.c), createdByUserId: "board" });
    const first = created.document.latestRevisionId!;
    await advanced([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`, `document:${f.c}`]);
    await docs.upsertIssueDocument({ issueId: task.id, key: "notes", format: "markdown", body: "no links", baseRevisionId: first, createdByUserId: "board" });
    await advanced([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`]);
    await docs.restoreIssueDocumentRevision({ issueId: task.id, key: "notes", revisionId: first, createdByUserId: "board" });
    await advanced([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`, `document:${f.c}`]);
    await docs.deleteIssueDocument(task.id, "notes");
    await advanced([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`]);
  });

  it("fences writers that bypass services: raw SQL, annotations, interactions, cases and cascades", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: link(f.a) }).returning();
    expect(await candidates(task.id)).toEqual([`issue:${f.a}`]);
    await db.execute(sql`update issues set description = ${link(f.b)} where id = ${task.id}`);
    expect(await revision(task.id)).toBe(1);
    const created = await documentService(db).upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: "plan" });
    const [thread] = await db.insert(documentAnnotationThreads).values({ companyId: f.companyId, issueId: task.id,
      documentId: created.document.id, documentKey: "plan", originalRevisionNumber: 1, currentRevisionNumber: 1, selectedText: "plan",
      normalizedStart: 0, normalizedEnd: 4, markdownStart: 0, markdownEnd: 4,
      anchorSelector: { quote: { exact: "plan", prefix: "", suffix: "" }, position: { normalizedStart: 0, normalizedEnd: 4, markdownStart: 0, markdownEnd: 4 } } })
      .returning();
    const before = await revision(task.id);
    const [note] = await db.insert(documentAnnotationComments).values({ companyId: f.companyId, threadId: thread.id, issueId: task.id,
      documentId: created.document.id, body: link(f.c), authorType: "user" }).returning();
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: task.id, kind: "ask_user_questions",
      payload: { version: 1, questions: [{ prompt: `Which? ${link(f.b)}` }] } as never });
    const [workflowCase] = await db.insert(cases).values({ companyId: f.companyId, caseNumber: 1, identifier: `${f.prefix}-C1`,
      caseType: "workflow", title: "Case", fields: { target: link(f.a) }, workIssueId: task.id }).returning();
    expect(await revision(task.id)).toBe(before! + 3);
    expect(await candidates(task.id)).toEqual([`annotation:${f.c}`, `case:${f.a}`, `interaction:${f.b}`, `issue:${f.a}`, `issue:${f.b}`].sort());
    await db.update(cases).set({ phase: "review" }).where(eq(cases.id, workflowCase.id));
    expect(await revision(task.id)).toBe(before! + 3);
    await db.update(cases).set({ fields: {} }).where(eq(cases.id, workflowCase.id));
    await db.delete(documentAnnotationComments).where(eq(documentAnnotationComments.id, note.id));
    expect(await revision(task.id)).toBe(before! + 5);
    expect(await candidates(task.id)).toEqual([`interaction:${f.b}`, `issue:${f.a}`, `issue:${f.b}`].sort());
    // Deleting the task cascades through every source trigger without error.
    await db.delete(cases).where(eq(cases.id, workflowCase.id));
    await db.delete(issues).where(eq(issues.id, task.id));
    expect(await candidates(task.id)).toEqual([]);
  });

  it("rolls back with the source write and signals waiting work only after the outer commit", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const task = await svc.create(f.companyId, { title: "Signals" });
    const events: string[] = [];
    const stop = subscribeDatabaseWork(db, DELIVERY_QUEUES.taskProjectReferences, (event, hints) => events.push(`${event}:${[...hints ?? []].join()}`));
    try {
      const start = await revision(task.id);
      await expect(inTransaction(async tx => {
        await tx.transaction(async savepoint => { await svc.addComment(task.id, link(f.a), { userId: "board" }, undefined, savepoint as never); });
        expect(events.filter(event => event.startsWith("settled"))).toEqual([]);
        throw new Error("rollback");
      })).rejects.toThrow("rollback");
      expect(await revision(task.id)).toBe(start);
      expect(await candidates(task.id)).toEqual([]);
      events.length = 0;
      await svc.addComment(task.id, link(f.a), { userId: "board" });
      expect(events).toContain(`settled:${f.companyId}:${task.id}`);
      expect(events.indexOf(`intent:${f.companyId}:${task.id}`)).toBeLessThan(events.indexOf(`settled:${f.companyId}:${task.id}`));
    } finally {
      stop();
    }
  });

  it("blocks a phantom comment behind a locked resolution and reports the changed revision", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Race", projectId: f.a }).returning();
    const hint = await readTaskProjectReferenceHint(db, { companyId: f.companyId, issueId: task.id });
    expect(hint).toEqual({ revision: 0, projectIds: [f.a] });
    let release!: () => void;
    const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
    let resolved!: () => void;
    const locked = new Promise<void>(resolveLocked => { resolved = resolveLocked; });
    const admission = inTransaction(async tx => {
      const result = await resolveTaskProjectReferences(tx, { companyId: f.companyId, issueId: task.id, actor: f.actor, expectedRevision: hint!.revision });
      resolved();
      await held;
      return result;
    });
    await locked;
    let committed = false;
    const phantom = db.insert(issueComments).values({ companyId: f.companyId, issueId: task.id, body: link(f.b) }).then(() => { committed = true; });
    await new Promise(wait => setTimeout(wait, 150));
    expect(committed).toBe(false);
    release();
    expect(await admission).toEqual({ kind: "resolved", revision: 0, primaryProjectId: f.a, projectIds: [f.a] });
    await phantom;
    expect(await resolve({ companyId: f.companyId, issueId: task.id, actor: f.actor, expectedRevision: hint!.revision }))
      .toEqual({ kind: "revision_changed", revision: 1 });
    const next = await readTaskProjectReferenceHint(db, { companyId: f.companyId, issueId: task.id });
    expect(await resolve({ companyId: f.companyId, issueId: task.id, actor: f.actor, expectedRevision: next!.revision }))
      .toEqual({ kind: "resolved", revision: 1, primaryProjectId: f.a, projectIds: [f.a, f.b].sort() });

    // A source write that is still uncommitted holds the task: resolution waits and then sees it.
    let insertComment!: () => void;
    const writerReady = new Promise<void>(ready => { insertComment = ready; });
    let finishWriter!: () => void;
    const writerHeld = new Promise<void>(done => { finishWriter = done; });
    const writer = inTransaction(async tx => {
      await tx.insert(issueComments).values({ companyId: f.companyId, issueId: task.id, body: link(f.c) });
      insertComment();
      await writerHeld;
    });
    await writerReady;
    const waiting = resolve({ companyId: f.companyId, issueId: task.id, actor: f.actor });
    setTimeout(finishWriter, 100);
    await writer;
    expect(await waiting).toMatchObject({ kind: "resolved", revision: 2, projectIds: [f.a, f.b, f.c].sort() });
  });

  it("resolves the complete set with typed outcomes and no shortened or leaked references", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const empty = await svc.create(f.companyId, { title: "Nothing" });
    expect(await resolve({ companyId: f.companyId, issueId: empty.id, actor: f.actor }))
      .toEqual({ kind: "resolved", revision: 0, primaryProjectId: null, projectIds: [] });
    expect(await resolve({ companyId: randomUUID(), issueId: empty.id, actor: f.actor })).toEqual({ kind: "not_found" });

    const task = await svc.create(f.companyId, { title: `T ${link(f.b.toUpperCase())}`, projectId: f.b,
      description: `${link(f.a)} ${link(f.a, "again")}` });
    await svc.addComment(task.id, `${"filler ".repeat(5_000)} ${link(f.c)}`, { userId: "board" });
    const plan = await documentService(db).upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: "first plan" });
    const accepted = plan.document.latestRevisionId!;
    await documentService(db).upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: "second plan", baseRevisionId: accepted });
    const all = [f.a, f.b, f.c].sort();
    expect(await resolve({ companyId: f.companyId, issueId: task.id, actor: f.actor }))
      .toMatchObject({ kind: "resolved", primaryProjectId: f.b, projectIds: all });
    expect(await resolve({ companyId: f.companyId, issueId: task.id, actor: f.actor, acceptedPlanRevisionId: randomUUID() }))
      .toEqual({ kind: "context_source_unavailable" });
    expect(await findTasksReferencingProject(db, { companyId: f.companyId, projectId: f.c })).toEqual([task.id]);

    // Malformed, missing and foreign references are counted, never dropped or named.
    await svc.addComment(task.id, `[bad](project://not-a-project) ${link(f.foreign)} ${link(randomUUID())}`, { userId: "board" });
    const invalid = await resolve({ companyId: f.companyId, issueId: task.id, actor: f.actor });
    expect(invalid).toEqual({ kind: "invalid_references", malformed: 1, unavailable: 2 });
    expect(JSON.stringify(invalid)).not.toContain(f.foreign);
    expect(await readTaskProjectReferenceHint(db, { companyId: f.companyId, issueId: task.id }))
      .toMatchObject({ projectIds: expect.arrayContaining([f.foreign]) });

    const privateTask = await svc.create(f.companyId, { title: link(f.c) });
    await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, f.c));
    expect(await resolve({ companyId: f.companyId, issueId: privateTask.id, actor: f.actor })).toEqual({ kind: "unauthorized", count: 1 });
    await db.insert(projectAccessMembers).values({ companyId: f.companyId, projectId: f.c, subjectType: "agent", subjectId: f.agentId });
    expect(await resolve({ companyId: f.companyId, issueId: privateTask.id, actor: f.actor })).toMatchObject({ kind: "resolved", projectIds: [f.c] });

    const crowded = await svc.create(f.companyId, { title: "Crowded",
      description: Array.from({ length: 101 }, () => link(randomUUID())).join(" ") });
    expect(await resolve({ companyId: f.companyId, issueId: crowded.id, actor: f.actor })).toEqual({ kind: "too_many_projects", count: 101, limit: 100 });
  });

  it("includes an accepted plan revision and every JSON text leaf of interactions and case facts", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Plan" }).returning();
    const first = await documentService(db).upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: link(f.a) });
    await documentService(db).upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: "edited",
      baseRevisionId: first.document.latestRevisionId });
    expect(await resolve({ companyId: f.companyId, issueId: task.id, actor: f.actor })).toMatchObject({ projectIds: [] });
    expect(await resolve({ companyId: f.companyId, issueId: task.id, actor: f.actor, acceptedPlanRevisionId: first.document.latestRevisionId }))
      .toMatchObject({ kind: "resolved", projectIds: [f.a] });
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: task.id, kind: "ask_user_questions",
      payload: { version: 1, questions: [{ options: [{ label: link(f.b) }] }] } as never, result: { answers: { [link(f.c)]: "yes" } } as never });
    expect(await resolve({ companyId: f.companyId, issueId: task.id, actor: f.actor })).toMatchObject({ projectIds: [f.b, f.c].sort() });
  });

  it("carries a retained session's admitted set and requires fresh context when that set is unknown", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: link(f.a) }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId }).returning();
    const session = async (lastRunId: string | null) => (await db.insert(agentTaskSessions).values({ companyId: f.companyId,
      agentId: f.agentId, adapterType: "process", taskKey: randomUUID(), lastRunId }).returning())[0].id;
    const input = (retainedSessionId: string) => ({ companyId: f.companyId, issueId: task.id, actor: f.actor, retainedSessionId });
    expect(await resolve(input(await session(null)))).toEqual({ kind: "fresh_context_required" });
    const resumed = await session(run.id);
    expect(await resolve(input(resumed))).toEqual({ kind: "fresh_context_required" });
    await db.insert(executionAdmissions).values({ id: randomUUID(), companyId: f.companyId, runId: run.id, attempt: 1,
      contextRevision: "issue:0", admittedProjectIds: [f.b] });
    expect(await resolve(input(resumed))).toMatchObject({ kind: "resolved", projectIds: [f.a, f.b].sort() });
    await db.delete(projects).where(eq(projects.id, f.b));
    expect(await resolve(input(resumed))).toEqual({ kind: "invalid_references", malformed: 0, unavailable: 1 });
  });

  it("extracts a superset of the structured parser's project references in SQL", async () => {
    const id = randomUUID();
    const corpus = [link(id), link(id.toUpperCase()), `[x](project:///${id}?c=fff)`, `[x](project://user@${id}:80)`,
      `[x](PROJECT://${id})`, `[x](project://a/../${id})`, `[x](project://${id}/extra)`, `<project://${id}>`, `[x](project://)`,
      `[x](project://%2e/${id})`, `\`[x](project://${id})\``];
    for (const text of corpus) {
      const [{ ids }] = (await db.execute(sql`select paperclip_project_reference_candidates(${text})::text[] as ids`)) as unknown as Array<{ ids: string[] }>;
      for (const projectId of scanProjectMentions(text).projectIds) expect(ids).toContain(projectId);
    }
  });
});
