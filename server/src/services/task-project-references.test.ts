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
import { documentAnnotationService } from "./document-annotations.js";
import { documentService } from "./documents.js";
import { setIssueTitle } from "./issue-title.js";
import { issueService } from "./issues.js";
import {
  MAX_TASK_REFERENCE_SOURCE_BYTES,
  findTasksReferencingProject,
  readTaskProjectReferenceHint,
  resolveTaskProjectReferences,
  type TaskContextSelection,
} from "./task-project-references.js";

const support = await getEmbeddedPostgresTestSupport();
type TestDb = ReturnType<typeof createDb>;
const link = (projectId: string, label = "p") => `[${label}](project://${projectId})`;
const NONE: TaskContextSelection = { acceptedPlanRevisionId: null, retainedSession: null, instructions: "none", runOutput: "none" };

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
    const rows = await db.insert(projects).values(["A", "B", "C", "D"].map(name => ({ companyId: company.id, name }))).returning();
    const [foreign] = await db.insert(projects).values({ companyId: other.id, name: "Foreign" }).returning();
    const [a, b, c, d] = rows.map(row => row.id);
    const actor: AuthorizationActor = { type: "agent", agentId: agent.id, companyId: company.id, keyScope: { kind: "standard" } };
    return { companyId: company.id, prefix, agentId: agent.id, a, b, c, d, foreign: foreign.id, actor };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const inTransaction = <T>(work: (tx: TestDb) => Promise<T>) => db.transaction(tx => work(tx as unknown as TestDb));
  const hint = (f: Fixture, issueId: string, selection = NONE) => readTaskProjectReferenceHint(db, { companyId: f.companyId, issueId, selection });
  /** Resolves the way C2 will: lock the hint's projects, then resolve against them. */
  const resolve = async (f: Fixture, issueId: string, selection = NONE, locked?: string[], tx?: TestDb) => {
    const lockedProjectIds = locked ?? (await hint(f, issueId, selection))?.projectIds ?? [];
    const input = { companyId: f.companyId, issueId, actor: f.actor, selection, lockedProjectIds };
    return tx ? resolveTaskProjectReferences(tx, input) : inTransaction(work => resolveTaskProjectReferences(work, input));
  };
  const revision = async (f: Fixture, issueId: string) => {
    const result = await resolve(f, issueId);
    return result.kind === "resolved" ? result.contextRevision : result.kind;
  };
  const candidates = async (issueId: string) => (await db.select({ kind: issueProjectReferences.sourceKind, projectId: issueProjectReferences.projectId })
    .from(issueProjectReferences).where(eq(issueProjectReferences.issueId, issueId))
    .orderBy(asc(issueProjectReferences.sourceKind), asc(issueProjectReferences.projectId))).map(row => `${row.kind}:${row.projectId}`);
  const sorted = (...values: string[]) => [...values].sort();

  it("projects every issue, comment and document writer and revises only when a reference changes", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const docs = documentService(db);
    const task = await svc.create(f.companyId, { title: "Primaryless", description: `Uses ${link(f.b)} twice ${link(f.b)}` });
    expect(await candidates(task.id)).toEqual([`issue:${f.b}`]);
    const seen = [await revision(f, task.id)];
    const changed = async (expected: string[]) => {
      expect(await candidates(task.id)).toEqual(sorted(...expected));
      const next = await revision(f, task.id);
      expect(seen).not.toContain(next);
      seen.push(next);
    };

    await svc.update(task.id, { priority: "high" });
    expect(await revision(f, task.id)).toBe(seen.at(-1));
    await svc.update(task.id, { projectId: f.a });
    await changed([`issue:${f.a}`, `issue:${f.b}`]);
    await inTransaction(tx => setIssueTitle(tx, f.companyId, task.id, { title: `Now ${link(f.c)}` }, { actorType: "user", actorId: "board" }));
    await changed([`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`]);
    const base = [`issue:${f.a}`, `issue:${f.b}`, `issue:${f.c}`];

    // A comment repeating an included project is projected but leaves the reference outcome unchanged.
    const repeated = await svc.addComment(task.id, `Also ${link(f.c)}`, { userId: "board" });
    expect(await candidates(task.id)).toEqual(sorted(...base, `comment:${f.c}`));
    expect(await revision(f, task.id)).toBe(seen.at(-1));
    await svc.tombstoneComment(repeated.id, { actorType: "user", userId: "board" });
    expect(await candidates(task.id)).toEqual(sorted(...base));
    const added = await svc.addComment(task.id, link(f.d), { userId: "board" });
    await changed([...base, `comment:${f.d}`]);
    await db.update(issueComments).set({ updatedAt: new Date() }).where(eq(issueComments.id, added.id));
    expect(await revision(f, task.id)).toBe(seen.at(-1));
    await svc.removeComment(added.id);
    expect(await candidates(task.id)).toEqual(sorted(...base));
    expect(await revision(f, task.id)).toBe(seen.at(-2));

    const created = await docs.upsertIssueDocument({ issueId: task.id, key: "notes", format: "markdown", body: link(f.d), createdByUserId: "board" });
    const first = created.document.latestRevisionId!;
    expect(await candidates(task.id)).toEqual(sorted(...base, `document:${f.d}`));
    // The same outcome as when the comment referenced D: the revision addresses the outcome, not the writer.
    expect(await revision(f, task.id)).toBe(seen.at(-1));
    await docs.upsertIssueDocument({ issueId: task.id, key: "notes", format: "markdown", body: "no links", baseRevisionId: first, createdByUserId: "board" });
    expect(await candidates(task.id)).toEqual(sorted(...base));
    await docs.restoreIssueDocumentRevision({ issueId: task.id, key: "notes", revisionId: first, createdByUserId: "board" });
    expect(await candidates(task.id)).toEqual(sorted(...base, `document:${f.d}`));
    await docs.deleteIssueDocument(task.id, "notes");
    expect(await candidates(task.id)).toEqual(sorted(...base));
  });

  it("projects annotations, interactions, cases, accepted plans and raw SQL writers, and removes rows with the task", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: link(f.a) }).returning();
    await db.execute(sql`update issues set description = ${link(f.b)} where id = ${task.id}`);
    const docs = documentService(db);
    const plan = await docs.upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: `plan ${link(f.d)}` });
    const accepted = plan.document.latestRevisionId!;
    await docs.upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: "plan", baseRevisionId: accepted });
    const [thread] = await db.insert(documentAnnotationThreads).values({ companyId: f.companyId, issueId: task.id,
      documentId: plan.document.id, documentKey: "plan", originalRevisionNumber: 1, currentRevisionNumber: 1, selectedText: "plan",
      normalizedStart: 0, normalizedEnd: 4, markdownStart: 0, markdownEnd: 4,
      anchorSelector: { quote: { exact: "plan", prefix: "", suffix: "" }, position: { normalizedStart: 0, normalizedEnd: 4, markdownStart: 0, markdownEnd: 4 } } })
      .returning();
    const [note] = await db.insert(documentAnnotationComments).values({ companyId: f.companyId, threadId: thread.id, issueId: task.id,
      documentId: plan.document.id, body: link(f.c), authorType: "user" }).returning();
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: task.id, kind: "ask_user_questions",
      payload: { version: 1, questions: [{ prompt: `Which? ${link(f.b)}` }] } as never });
    const [confirmation] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: task.id, kind: "request_confirmation",
      payload: { version: 1, prompt: "Accept?", target: { type: "issue_document", issueId: task.id, documentId: plan.document.id, key: "plan",
        revisionId: accepted, revisionNumber: 1 } } as never }).returning();
    const [workflowCase] = await db.insert(cases).values({ companyId: f.companyId, caseNumber: 1, identifier: `${f.prefix}-C1`,
      caseType: "workflow", title: "Case", fields: { target: link(f.a) }, workIssueId: task.id }).returning();
    const current = [`annotation:${f.c}`, `case:${f.a}`, `interaction:${f.b}`, `issue:${f.a}`, `issue:${f.b}`];
    expect(await candidates(task.id)).toEqual(sorted(...current));
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, confirmation.id));
    expect(await candidates(task.id)).toEqual(sorted(...current, `accepted_plan:${f.d}`));
    expect(await findTasksReferencingProject(db, { companyId: f.companyId, projectId: f.d })).toEqual([task.id]);

    await db.update(cases).set({ phase: "review" }).where(eq(cases.id, workflowCase.id));
    expect(await candidates(task.id)).toContain(`case:${f.a}`);
    await db.update(cases).set({ fields: {} }).where(eq(cases.id, workflowCase.id));
    await db.delete(documentAnnotationComments).where(eq(documentAnnotationComments.id, note.id));
    expect(await candidates(task.id)).toEqual(sorted(`interaction:${f.b}`, `issue:${f.a}`, `issue:${f.b}`, `accepted_plan:${f.d}`));
    await db.delete(cases).where(eq(cases.id, workflowCase.id));
    await db.delete(issues).where(eq(issues.id, task.id));
    expect(await candidates(task.id)).toEqual([]);
  });

  it("adds no lock-order edge for writers that hold their source row while another transaction holds the task", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Locks" }).returning();
    const [record] = await db.insert(cases).values({ companyId: f.companyId, caseNumber: 1, identifier: `${f.prefix}-C1`,
      caseType: "workflow", title: "Case", workIssueId: task.id }).returning();
    const [question] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: task.id,
      kind: "ask_user_questions", payload: { version: 1, questions: [] } as never }).returning();
    // Board case PATCH locks the case (authorizeCaseMutation) and then writes it, while handoff apply
    // locks the task and then the case (case-handoffs.ts). Interaction expiry writes the interaction,
    // while accept locks the task and then the interaction (issue-thread-interactions.ts).
    const pairs = [
      { table: "cases", id: record.id, write: `update cases set title = $2 where id = $1`, body: link(f.a), expected: `case:${f.a}` },
      { table: "issue_thread_interactions", id: question.id, write: `update issue_thread_interactions set summary = $2 where id = $1`,
        body: link(f.b), expected: `interaction:${f.b}` },
    ];
    for (const pair of pairs) {
      const writer = await db.$client.reserve(), owner = await db.$client.reserve();
      try {
        await writer`begin`;
        await owner`begin`;
        await writer.unsafe(`select id from ${pair.table} where id = $1 for update`, [pair.id]);
        await owner`select id from issues where id = ${task.id} for update`;
        // Both statements reach the server now, so a lock cycle would be reported as 40P01.
        const write = writer.unsafe(pair.write, [pair.id, pair.body]).execute();
        const ownerLock = owner.unsafe(`select id from ${pair.table} where id = $1 for update`, [pair.id]).execute();
        await write;
        await writer`commit`;
        await ownerLock;
        await owner`commit`;
      } finally {
        writer.release();
        owner.release();
      }
      expect(await candidates(task.id)).toContain(pair.expected);
    }
  });

  it("detects phantom and in-flight writes by revision, rolls back with the source and signals after the outer commit", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const task = await svc.create(f.companyId, { title: "Race", projectId: f.a });
    const comment = await svc.addComment(task.id, "plain", { userId: "board" });
    const before = await revision(f, task.id);

    // A write that commits while a resolution is open neither waits nor escapes: the revision differs afterwards.
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    let opened!: () => void;
    const open = new Promise<void>(done => { opened = done; });
    const admission = inTransaction(async tx => {
      const result = await resolve(f, task.id, NONE, [f.a], tx);
      opened();
      await held;
      return result;
    });
    await open;
    await db.update(issueComments).set({ body: link(f.b) }).where(eq(issueComments.id, comment.id));
    release();
    expect(await admission).toMatchObject({ kind: "resolved", contextRevision: before, projectIds: [f.a] });
    expect(await resolve(f, task.id, NONE, [f.a])).toEqual({ kind: "lock_set_changed", missing: 1 });
    expect(await revision(f, task.id)).not.toBe(before);

    // An uncommitted writer is not waited for; its commit changes the revision.
    const afterPhantom = await revision(f, task.id);
    let finish!: () => void;
    const writerHeld = new Promise<void>(done => { finish = done; });
    let wrote!: () => void;
    const written = new Promise<void>(done => { wrote = done; });
    const writer = inTransaction(async tx => {
      await tx.update(issueComments).set({ body: link(f.c) }).where(eq(issueComments.id, comment.id));
      wrote();
      await writerHeld;
    });
    await written;
    expect(await revision(f, task.id)).toBe(afterPhantom);
    finish();
    await writer;
    expect(await revision(f, task.id)).not.toBe(afterPhantom);

    const events: string[] = [];
    const stop = subscribeDatabaseWork(db, DELIVERY_QUEUES.taskProjectReferences, (event, hints) => events.push(`${event}:${[...hints ?? []].join()}`));
    try {
      const committed = await revision(f, task.id), rows = await candidates(task.id);
      await expect(inTransaction(async tx => {
        await tx.transaction(async savepoint => { await svc.addComment(task.id, link(f.d), { userId: "board" }, undefined, savepoint as never); });
        expect(events.filter(event => event.startsWith("settled"))).toEqual([]);
        throw new Error("rollback");
      })).rejects.toThrow("rollback");
      expect(await candidates(task.id)).toEqual(rows);
      expect(await revision(f, task.id)).toBe(committed);
      events.length = 0;
      const key = `${f.companyId}:${task.id}`;
      await svc.addComment(task.id, link(f.d), { userId: "board" });
      expect(events.indexOf(`intent:${key}`)).toBeLessThan(events.indexOf(`settled:${key}`));
      events.length = 0;
      const plan = await documentService(db).upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: "Alpha selected text omega" });
      expect(events).toContain(`settled:${key}`);
      events.length = 0;
      await documentAnnotationService(db).createThread(task.id, "plan", { baseRevisionId: plan.document.latestRevisionId!,
        baseRevisionNumber: plan.document.latestRevisionNumber, body: link(f.d),
        selector: { quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
          position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 } } },
      { actorType: "user", actorId: "board", userId: "board" });
      expect(events).toContain(`settled:${key}`);
      expect(await candidates(task.id)).toContain(`annotation:${f.d}`);
    } finally {
      stop();
    }
  });

  it("hints and resolves the whole selected context and refuses a result outside the locked set", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const parent = await svc.create(f.companyId, { title: `Parent ${link(f.c)}` });
    const task = await svc.create(f.companyId, { title: "Child", parentId: parent.id, description: link(f.a) });
    const first = await documentService(db).upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: link(f.b) });
    await documentService(db).upsertIssueDocument({ issueId: task.id, key: "plan", format: "markdown", body: "edited",
      baseRevisionId: first.document.latestRevisionId });
    const oldPlan = { ...NONE, acceptedPlanRevisionId: first.document.latestRevisionId };

    // Copied ancestor titles are supplied text; an old accepted plan is absent from the current projection.
    expect(await hint(f, task.id)).toEqual({ projectIds: sorted(f.a, f.c) });
    expect(await resolve(f, task.id)).toMatchObject({ kind: "resolved", projectIds: sorted(f.a, f.c) });
    expect(await hint(f, task.id, oldPlan)).toEqual({ projectIds: sorted(f.a, f.b, f.c) });
    expect(await resolve(f, task.id, oldPlan, sorted(f.a, f.c))).toEqual({ kind: "lock_set_changed", missing: 1 });
    const withPlan = await resolve(f, task.id, oldPlan);
    expect(withPlan).toMatchObject({ kind: "resolved", projectIds: sorted(f.a, f.b, f.c) });
    expect(withPlan).not.toMatchObject({ contextRevision: (await resolve(f, task.id) as { contextRevision: string }).contextRevision });
    expect(await findTasksReferencingProject(db, { companyId: f.companyId, projectId: f.c })).toEqual(sorted(parent.id, task.id));

    const otherTask = await svc.create(f.companyId, { title: "Other" });
    const foreignPlan = await documentService(db).upsertIssueDocument({ issueId: otherTask.id, key: "plan", format: "markdown", body: "x" });
    expect(await resolve(f, task.id, { ...NONE, acceptedPlanRevisionId: foreignPlan.document.latestRevisionId }))
      .toEqual({ kind: "context_source_unavailable" });
  });

  it("validates a retained session's pinned session, run and admission and carries only that admitted set", async () => {
    const f = await fixture();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: link(f.a) }).returning();
    const [otherTask] = await db.insert(issues).values({ companyId: f.companyId, title: "Other" }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "process" }).returning();
    const run = async (issueId = task.id, agentId = f.agentId) =>
      (await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, issueId }).returning())[0].id;
    const session = async (lastRunId: string, agentId = f.agentId, taskKey = task.id) => (await db.insert(agentTaskSessions).values({
      companyId: f.companyId, agentId, adapterType: randomUUID(), taskKey, lastRunId }).returning())[0].id;
    const admit = async (runId: string, admittedProjectIds: string[] | null) => {
      const id = randomUUID();
      await db.insert(executionAdmissions).values({ id, companyId: f.companyId, runId, attempt: 1, contextRevision: "task-refs:v1:fixture",
        admittedProjectIds, ...(admittedProjectIds ? {} : { settlementId: randomUUID(), settledAt: new Date() }) });
      return id;
    };
    const retained = (sessionId: string, runId: string, admissionId: string) => ({ ...NONE, retainedSession: { sessionId, runId, admissionId } });

    const runId = await run(), sessionId = await session(runId), admissionId = await admit(runId, [f.b]);
    const resumed = retained(sessionId, runId, admissionId);
    expect(await hint(f, task.id, resumed)).toEqual({ projectIds: sorted(f.a, f.b) });
    expect(await resolve(f, task.id, resumed)).toMatchObject({ kind: "resolved", projectIds: sorted(f.a, f.b) });
    expect(await resolve(f, task.id, resumed, [f.a])).toEqual({ kind: "lock_set_changed", missing: 1 });

    const laterRun = await run(), laterAdmission = await admit(laterRun, [f.c]);
    const otherAgentRun = await run(task.id, otherAgent.id);
    const otherTaskRun = await run(otherTask.id);
    for (const mismatch of [
      retained(sessionId, laterRun, laterAdmission),                                       // the session has not advanced to that run
      retained(sessionId, runId, laterAdmission),                                          // an admission of another run
      retained(await session(otherAgentRun, otherAgent.id), otherAgentRun, await admit(otherAgentRun, [])), // another agent's session
      retained(await session(otherTaskRun, f.agentId, otherTask.id), otherTaskRun, await admit(otherTaskRun, [])), // another task
      retained(randomUUID(), runId, admissionId),
    ]) {
      expect(await resolve(f, task.id, mismatch)).toEqual({ kind: "retained_context_mismatch" });
    }
    const unknownRun = await run();
    expect(await resolve(f, task.id, retained(await session(unknownRun), unknownRun, await admit(unknownRun, null))))
      .toEqual({ kind: "fresh_context_required" });
    await db.delete(projects).where(eq(projects.id, f.b));
    expect(await resolve(f, task.id, resumed)).toEqual({ kind: "invalid_references", malformed: 0, unavailable: 1 });
  });

  it("resolves the complete set with typed, bounded outcomes and no shortened or leaked references", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const empty = await svc.create(f.companyId, { title: "Nothing" });
    expect(await resolve(f, empty.id)).toMatchObject({ kind: "resolved", primaryProjectId: null, projectIds: [] });
    expect(await inTransaction(tx => resolveTaskProjectReferences(tx, { companyId: randomUUID(), issueId: empty.id, actor: f.actor,
      selection: NONE, lockedProjectIds: [] }))).toEqual({ kind: "not_found" });
    expect(await resolve(f, empty.id, { ...NONE, instructions: { bundleDigest: "sha256:fixture" }, runOutput: { runIds: [randomUUID()] } }))
      .toEqual({ kind: "unprojected_context_source", sources: ["agent_instructions", "run_output"] });

    const task = await svc.create(f.companyId, { title: `T ${link(f.b.toUpperCase())}`, projectId: f.b,
      description: `${link(f.a)} ${link(f.a, "again")}` });
    await svc.addComment(task.id, `${"filler ".repeat(5_000)} ${link(f.c)}`, { userId: "board" });
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: task.id, kind: "ask_user_questions",
      payload: { version: 1, questions: [{ options: [{ label: link(f.d) }] }] } as never, result: { answers: { [link(f.c)]: "yes" } } as never });
    expect(await resolve(f, task.id)).toMatchObject({ kind: "resolved", primaryProjectId: f.b, projectIds: sorted(f.a, f.b, f.c, f.d) });

    // Malformed (including empty), missing and foreign references are counted, never dropped or named.
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: task.id,
      body: `[bad](project://not-a-project) [empty](project://) ${link(f.foreign)} ${link(randomUUID())}` });
    const invalid = await resolve(f, task.id);
    expect(invalid).toEqual({ kind: "invalid_references", malformed: 2, unavailable: 2 });
    expect(JSON.stringify(invalid)).not.toContain(f.foreign);
    expect(await hint(f, task.id)).toMatchObject({ projectIds: expect.arrayContaining([f.foreign]) });

    const privateTask = await svc.create(f.companyId, { title: link(f.c) });
    await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, f.c));
    expect(await resolve(f, privateTask.id)).toEqual({ kind: "unauthorized", count: 1 });
    await db.insert(projectAccessMembers).values({ companyId: f.companyId, projectId: f.c, subjectType: "agent", subjectId: f.agentId });
    expect(await resolve(f, privateTask.id)).toMatchObject({ kind: "resolved", projectIds: [f.c] });

    const crowded = await svc.create(f.companyId, { title: "Crowded", description: Array.from({ length: 101 }, () => link(randomUUID())).join(" ") });
    expect(await resolve(f, crowded.id)).toEqual({ kind: "too_many_projects", count: 101, limit: 100 });
    const large = await svc.create(f.companyId, { title: "Large" });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: large.id, body: `${link(f.a)} ${"x".repeat(MAX_TASK_REFERENCE_SOURCE_BYTES)}` });
    expect(await resolve(f, large.id)).toEqual({ kind: "context_too_large", limit: MAX_TASK_REFERENCE_SOURCE_BYTES });
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
