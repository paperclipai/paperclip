import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, documents, heartbeatRuns, issueComments, issueThreadInteractions, issueWorkProducts, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { buildAgentMentionHref } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { workProductService } from "../services/work-products.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { withPluginInteractionOrigin } from "../services/plugin-interaction-context.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";

describe("agent interaction mutation boundaries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-interaction-mutations-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), sender = randomUUID(), recipient = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Interactions", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: sender, companyId, name: "Sender", adapterType: "process", status: "idle", permissions: {} },
      { id: recipient, companyId, name: "Recipient", adapterType: "process", status: "idle", permissions: {} },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Original", status: "todo", assigneeAgentId: recipient });
    return { companyId, sender, recipient, issueId };
  }
  async function restrict(agentId: string, interactions: Record<string, boolean>) {
    await db.update(agents).set({ permissions: { interactions } }).where(eq(agents.id, agentId));
  }
  const denied = (permission: string) => ({ status: 403, details: expect.objectContaining({ code: "agent_interaction_denied", permission }) });

  it("keeps unrestricted peer comments and edits working without persisting defaults", async () => {
    const f = await seed(), svc = issueService(db);
    await svc.addComment(f.issueId, "Peer reply", { agentId: f.sender });
    await svc.update(f.issueId, { title: "Edited", actorAgentId: f.sender });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const rows = await db.select().from(agents).where(eq(agents.companyId, f.companyId));
    expect(task.title).toBe("Edited");
    expect(rows.every(row => Object.keys(row.permissions).length === 0)).toBe(true);
  });

  it("blocks incoming comments before saving anything, including through plugin host services", async () => {
    const f = await seed();
    await restrict(f.recipient, { canReceiveCommentsFromAgents: false });
    const services = buildHostServices(db, "interaction-test", "interaction-test", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as any);
    try {
      await expect(services.issues.createComment({ companyId: f.companyId, issueId: f.issueId,
        body: "Blocked plugin reply", authorAgentId: f.sender })).rejects.toMatchObject(denied("canReceiveCommentsFromAgents"));
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toEqual([]);
    } finally { services.dispose(); }
  });

  it("rejects an outgoing comment on an unassigned task but permits self comments", async () => {
    const f = await seed(), svc = issueService(db);
    await restrict(f.sender, { canCommentOnOtherTasks: false });
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    await expect(svc.addComment(f.issueId, "No", { agentId: f.sender })).rejects.toMatchObject(denied("canCommentOnOtherTasks"));
    await db.update(issues).set({ assigneeAgentId: f.sender }).where(eq(issues.id, f.issueId));
    await svc.addComment(f.issueId, "Own work", { agentId: f.sender });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
  });

  it("rejects structured forbidden mentions even on the sender's own task", async () => {
    const f = await seed(), svc = issueService(db);
    await db.update(issues).set({ assigneeAgentId: f.sender }).where(eq(issues.id, f.issueId));
    await restrict(f.recipient, { canReceiveMentionsFromAgents: false });
    const mention = `[@Recipient](${buildAgentMentionHref(f.recipient)})`;
    await expect(svc.addComment(f.issueId, mention, { agentId: f.sender })).rejects.toMatchObject(denied("canReceiveMentionsFromAgents"));
    await expect(svc.update(f.issueId, { description: mention, actorAgentId: f.sender })).rejects.toMatchObject(denied("canReceiveMentionsFromAgents"));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.description).toBeNull();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toEqual([]);
    await svc.addComment(f.issueId, "Plain prose about Recipient", { agentId: f.sender });
  });

  it("blocks peer edits and reassignment-to-self against the current owner", async () => {
    const f = await seed(), svc = issueService(db);
    await restrict(f.recipient, { canReceiveTaskEditsFromAgents: false });
    await expect(svc.update(f.issueId, { description: "New instructions", actorAgentId: f.sender })).rejects.toMatchObject(denied("canReceiveTaskEditsFromAgents"));
    await expect(svc.update(f.issueId, { assigneeAgentId: f.sender, actorAgentId: f.sender })).rejects.toMatchObject(denied("canReceiveTaskEditsFromAgents"));
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].assigneeAgentId).toBe(f.recipient);
  });

  it("keeps comments independent from task-edit permission", async () => {
    const f = await seed(), svc = issueService(db);
    await restrict(f.sender, { canEditOtherTasks: false });
    await svc.addComment(f.issueId, "Allowed comment", { agentId: f.sender });
    await svc.update(f.issueId, { actorAgentId: f.sender });
    await expect(svc.update(f.issueId, { title: "No", actorAgentId: f.sender })).rejects.toMatchObject(denied("canEditOtherTasks"));
  });

  it("rejects creating work for a protected recipient without inserting a task", async () => {
    const f = await seed();
    await restrict(f.recipient, { canReceiveAssignmentsFromAgents: false });
    await expect(issueService(db).create(f.companyId, { title: "Blocked new work", createdByAgentId: f.sender,
      assigneeAgentId: f.recipient, status: "todo" })).rejects.toMatchObject(denied("canReceiveAssignmentsFromAgents"));
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
  });

  it("allows initial plan content under assignment authority without requiring peer edit permission", async () => {
    const f = await seed();
    await restrict(f.sender, { canEditOtherTasks: false });
    await restrict(f.recipient, { canReceiveTaskEditsFromAgents: false });
    const created = await issueService(db).create(f.companyId, { title: "New assigned work", createdByAgentId: f.sender,
      assigneeAgentId: f.recipient, initialPlan: "Initial instructions", status: "todo" });
    expect((await documentService(db).getIssueDocumentByKey(created.id, "plan"))?.body).toBe("Initial instructions");
    await expect(documentService(db).upsertIssueDocument({ issueId: created.id, key: "notes", format: "markdown",
      body: "Later instructions", createdByAgentId: f.sender })).rejects.toMatchObject(denied("canEditOtherTasks"));
  });

  it("checks assignment restrictions on native create_task before saving tasks or enqueueing wakes", async () => {
    const f = await seed(), runId = randomUUID(), wakes = vi.fn();
    await db.update(issues).set({ assigneeAgentId: f.sender, status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.update(agents).set({ adapterType: "paperclip_runner", status: "active" }).where(eq(agents.id, f.sender));
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.sender,
      status: "running", runtimeMode: "native", nativeIssueId: f.issueId,
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    await restrict(f.recipient, { canReceiveAssignmentsFromAgents: false });
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.sender,
      issueId: f.issueId, runId, enqueueWakeup: wakes });
    await expect(authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      idempotencyKey: "protected-recipient", title: "Delegated", assigneeActorId: f.recipient,
    } })).rejects.toMatchObject(denied("canReceiveAssignmentsFromAgents"));
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect(wakes).not.toHaveBeenCalled();
  });

  it("treats an agent-addressed review as assignment even when task ownership stays unchanged", async () => {
    const f = await seed();
    await db.update(issues).set({ assigneeAgentId: f.sender }).where(eq(issues.id, f.issueId));
    await restrict(f.recipient, { canReceiveAssignmentsFromAgents: false });
    await expect(issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", resolverPolicy: "board_or_agents", addresseeAgentId: f.recipient,
      continuationPolicy: "wake_assignee", payload: { version: 1,
        questions: [{ id: "review", prompt: "Review?", selectionMode: "single", options: [{ id: "yes", label: "Yes" }] }] },
    }, { agentId: f.sender })).rejects.toMatchObject(denied("canReceiveAssignmentsFromAgents"));
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toEqual([]);
  });

  it("rejects a native reassignment reason before stopping the currently running recipient", async () => {
    const f = await seed(), runId = randomUUID(), targetRunId = randomUUID(), stop = vi.fn(), wake = vi.fn();
    await db.update(issues).set({ assigneeAgentId: f.sender, status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.update(agents).set({ adapterType: "paperclip_runner", status: "active" }).where(eq(agents.id, f.sender));
    const [target] = await db.insert(issues).values({ companyId: f.companyId, title: "Running peer task",
      status: "in_progress", assigneeAgentId: f.recipient }).returning();
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId: f.companyId, agentId: f.sender, status: "running", runtimeMode: "native", nativeIssueId: f.issueId,
        invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.issueId } },
      { id: targetRunId, companyId: f.companyId, agentId: f.recipient, status: "running", runtimeMode: "native", nativeIssueId: target.id,
        invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: target.id } },
    ]);
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    await db.update(issues).set({ executionRunId: targetRunId }).where(eq(issues.id, target.id));
    await restrict(f.recipient, { canReceiveCommentsFromAgents: false });
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.sender,
      issueId: f.issueId, runId, enqueueWakeup: wake, stopTaskForReassignment: stop });
    await expect(authority.execute({ tool: "reassign_task", callId: randomUUID(), arguments: {
      idempotencyKey: "protected-reason", taskId: target.id, assigneeActorId: f.sender,
      expectedAssigneeActorId: f.recipient, expectedAssigneeUserId: null, expectedStatusVersion: target.statusVersion,
      reason: "Taking over your task",
    } })).rejects.toMatchObject(denied("canReceiveCommentsFromAgents"));
    expect(stop).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, targetRunId)))[0].status).toBe("running");
    expect((await db.select().from(issues).where(eq(issues.id, target.id)))[0].assigneeAgentId).toBe(f.recipient);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, target.id))).toEqual([]);
  });

  it("protects peer configuration suggestions before creating a confirmation card", async () => {
    const f = await seed();
    await db.update(issues).set({ assigneeAgentId: f.sender }).where(eq(issues.id, f.issueId));
    await restrict(f.recipient, { canReceiveConfigurationChangesFromAgents: false });
    await expect(issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, {
      kind: "request_confirmation", payload: { version: 1, prompt: "Change instructions?",
        target: { type: "custom", key: `agent:${f.recipient}:instructions`, revisionId: "proposed" } },
    }, { agentId: f.sender })).rejects.toMatchObject(denied("canReceiveConfigurationChangesFromAgents"));
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toEqual([]);
  });

  it("preserves trusted plugin origin despite a supplied human comment actor", async () => {
    const f = await seed();
    const write = () => withPluginInteractionOrigin({ companyId: f.companyId, agentId: f.sender }, () =>
      issueService(db).addComment(f.issueId, "Plugin reply", { userId: "local-board" }));
    const comment = await write();
    expect(comment.authorAgentId).toBe(f.sender);
    expect(comment.authorUserId).toBeNull();
    await restrict(f.recipient, { canReceiveCommentsFromAgents: false });
    await expect(write()).rejects.toMatchObject(denied("canReceiveCommentsFromAgents"));
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
  });

  it("blocks plugin authorization-policy writes to a protected task", async () => {
    const f = await seed();
    await restrict(f.recipient, { canReceiveTaskEditsFromAgents: false });
    const services = buildHostServices(db, "interaction-test", "interaction-test", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as any);
    try {
      await expect(withPluginInteractionOrigin({ companyId: f.companyId, agentId: f.sender }, () =>
        services.authorization.updatePolicy({ companyId: f.companyId, resourceType: "issue", resourceId: f.issueId,
          policy: { example: "policy" } }))).rejects.toMatchObject(denied("canReceiveTaskEditsFromAgents"));
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionPolicy).toBeNull();
    } finally { services.dispose(); }
  });

  it("blocks parent influence when creating a child even if the child is self-assigned", async () => {
    const f = await seed();
    await restrict(f.recipient, { canReceiveTaskEditsFromAgents: false });
    await expect(issueService(db).create(f.companyId, { title: "Child", createdByAgentId: f.sender,
      assigneeAgentId: f.sender, parentId: f.issueId, status: "todo" })).rejects.toMatchObject(denied("canReceiveTaskEditsFromAgents"));
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
  });

  it("protects document writes and restores without adding revisions", async () => {
    const f = await seed(), svc = documentService(db);
    const original = await svc.upsertIssueDocument({ issueId: f.issueId, key: "plan", format: "markdown", body: "Original" });
    await restrict(f.recipient, { canReceiveTaskEditsFromAgents: false });
    await expect(svc.upsertIssueDocument({ issueId: f.issueId, key: "plan", format: "markdown", body: "Peer instructions",
      baseRevisionId: original.document.latestRevisionId, createdByAgentId: f.sender })).rejects.toMatchObject(denied("canReceiveTaskEditsFromAgents"));
    await expect(svc.deleteIssueDocument(f.issueId, "plan", f.sender)).rejects.toMatchObject(denied("canReceiveTaskEditsFromAgents"));
    expect((await svc.getIssueDocumentByKey(f.issueId, "plan"))?.body).toBe("Original");
  });

  it("checks mentions in documents and work products, and permits a human write", async () => {
    const f = await seed(), docs = documentService(db), products = workProductService(db);
    await restrict(f.sender, { canMentionAgents: false });
    const mention = `[@Recipient](${buildAgentMentionHref(f.recipient)})`;
    await expect(docs.upsertIssueDocument({ issueId: f.issueId, key: "notes", format: "markdown", body: mention,
      createdByAgentId: f.sender })).rejects.toMatchObject(denied("canMentionAgents"));
    await expect(products.createForIssue(f.issueId, f.companyId, { type: "artifact", provider: "external", status: "ready", title: mention }, f.sender))
      .rejects.toMatchObject(denied("canMentionAgents"));
    expect(await db.select().from(documents).where(eq(documents.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId))).toEqual([]);
    await docs.upsertIssueDocument({ issueId: f.issueId, key: "notes", format: "markdown", body: mention });
  });

  it("does not rescan an untouched historical mention when only unrelated fields change", async () => {
    const f = await seed();
    await db.update(issues).set({ description: `[@Recipient](${buildAgentMentionHref(f.recipient)})` }).where(eq(issues.id, f.issueId));
    await restrict(f.sender, { canMentionAgents: false });
    await issueService(db).update(f.issueId, { priority: "high", actorAgentId: f.sender });
    expect((await db.select().from(issues).where(and(eq(issues.id, f.issueId), eq(issues.companyId, f.companyId))))[0].priority).toBe("high");
  });

  it("checks a work product's destination task when moving it from the sender's own task", async () => {
    const f = await seed(), products = workProductService(db);
    const [own] = await db.insert(issues).values({ companyId: f.companyId, title: "Own task", assigneeAgentId: f.sender }).returning();
    const product = await products.createForIssue(own.id, f.companyId,
      { type: "artifact", provider: "external", status: "ready", title: "Own output" }, f.sender);
    await restrict(f.recipient, { canReceiveTaskEditsFromAgents: false });
    await expect(products.update(product!.id, { issueId: f.issueId }, f.sender))
      .rejects.toMatchObject(denied("canReceiveTaskEditsFromAgents"));
    expect((await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id)))[0].issueId).toBe(own.id);
  });

  it("checks bulk import assignments before reserving issue numbers or inserting tasks", async () => {
    const f = await seed();
    const [before] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    await restrict(f.recipient, { canReceiveAssignmentsFromAgents: false });
    await expect(issueService(db).importIssues(f.companyId, [{ id: randomUUID(), ref: "imported", title: "Imported task",
      projectId: null, projectWorkspaceId: null, description: "New initial instructions", assigneeAgentId: f.recipient,
      status: "todo", priority: "medium", billingCode: null, assigneeAdapterOverrides: null,
      executionWorkspaceSettings: null, labelIds: [], monitorNotes: null, monitorScheduledBy: null,
    }], f.sender)).rejects.toMatchObject(denied("canReceiveAssignmentsFromAgents"));
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].issueCounter).toBe(before.issueCounter);
  });

  it("waits for company accounting before locking actors during task creation", async () => {
    const f = await seed();
    let creation: Promise<unknown> | undefined;
    try {
      await db.transaction(async importer => {
        await importer.select({ id: companies.id }).from(companies).where(eq(companies.id, f.companyId)).for("no key update");
        let started!: (pid: number) => void;
        const creatorPid = new Promise<number>(resolve => { started = resolve; });
        creation = db.transaction(async creator => {
          const rows = await creator.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
          started(rows[0].pid);
          return issueService(db).create(f.companyId, { title: "Concurrent creation", assigneeAgentId: f.recipient,
            createdByAgentId: f.sender, status: "todo" }, creator);
        });
        const pid = await creatorPid;
        let waitingQuery = "";
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const rows = await db.execute<{ query: string; wait_event_type: string | null }>(
            sql`select query, wait_event_type from pg_stat_activity where pid = ${pid}`);
          if (rows[0]?.wait_event_type === "Lock") { waitingQuery = rows[0].query; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waitingQuery).toContain('"companies"');
        await importer.execute(sql`select id from ${agents} where id in (${f.sender}, ${f.recipient}) for no key update nowait`);
      });
    } finally { await creation; }
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(2);
  });
});
