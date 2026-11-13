import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueComments, issues, principalPermissionGrants, runIdentityContexts,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { authorizeInstructionCommit, resolveInstructionActor } from "../services/agent-instruction-authorization.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { authorizationService } from "../services/authorization.js";
import { initializeRunIdentity } from "../services/run-identity.js";

describe("owner-chat instruction authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const initial = "# Ralph\nOriginal instructions\n";

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "owner-chat-instructions-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("owner-chat-instructions-db-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) {
      const makeWritable = async (dir: string) => {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) await makeWritable(path.join(dir, entry.name));
        }
      };
      await makeWritable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
    const root = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Ralph", adapterConfig: {} });
    await db.insert(companies).values({ id: companyId, name: "Owner chat", issuePrefix: companyId.slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const permissions = { trustPreset: "low_trust_review", authorizationPolicy: {
      trustBoundary: { mode: "low_trust_review", companyId, rootIssueId: randomUUID() },
    } };
    await db.insert(agents).values({ id: agentId, companyId, name: "Ralph", status: "active", permissions,
      adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    const [chat] = await db.insert(issues).values({ companyId, title: "Owner chat", status: "in_progress",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", conversationSessionGeneration: 0 }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: chat.id,
      authorUserId: userId, clientRequestId: randomUUID(), body: "Update your AGENTS.md to remember the project conventions." }).returning();
    const context = { issueId: chat.id, conversationSessionGeneration: 0, wakeCommentId: message.id, source: "issue.comment" };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      idempotencyKey: `conversation-comment:${message.id}`,
      reason: "issue_commented", status: "claimed", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId: chat.id, commentId: message.id, _paperclipWakeContext: context } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", responsibleUserId: userId,
      wakeupRequestId: wake.id, invocationSource: "automation", contextSnapshot: context }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, chat.id));
    await initializeRunIdentity(db, { companyId, runId: run.id, issueId: chat.id, responsibleUserId: userId,
      messageIds: [message.id], cause: "issue_commented" });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), initial);
    const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId, agentId, runId: run.id };
    return { companyId, agentId, userId, root, permissions, chat, message, run, wake, actor, target: { companyId, id: agentId } };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const authorize = (f: Fixture) => authorizeInstructionCommit(db, f.actor, f.target);
  const expectDenied = async (f: Fixture) => {
    await expect(authorize(f)).rejects.toMatchObject({ status: 403 });
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe(initial);
  };

  it("persists the requested self-edit without relaxing the agent's trust or configuration permissions", async () => {
    const f = await seed();
    const service = agentInstructionRevisionService(db);
    const target = { companyId: f.companyId, agentId: f.agentId };
    const before = (await service.readCurrent(target, f.actor))!;
    const saved = await service.commit({ ...target, entryFile: "AGENTS.md", baseRevisionId: before.revision.id,
      content: "# Ralph\nFollow the owner's project conventions.\n", source: "api" }, f.actor);
    expect(saved.changed).toBe(true);
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe(saved.content);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent.permissions).toEqual(f.permissions);
    const actor = await resolveInstructionActor(db, f.actor);
    for (const action of ["agent_config:update", "secrets:read"] as const) {
      expect(await authorizationService(db).decide({ actor, action,
        resource: { type: "agent", companyId: f.companyId, agentId: f.agentId } })).toMatchObject({ allowed: false });
    }
  });

  it.each(["running", "succeeded", "failed", "timed_out"])("collects authorized private edits from a %s owner-chat run", async (status) => {
    const f = await seed();
    const copies = agentInstructionWorkingCopyService(db);
    const copy = (await copies.prepare({ companyId: f.companyId, agentId: f.agentId, runId: f.run.id, cwd: home, legacy: true }))!;
    await fs.writeFile(path.join(copy.localRoot, copy.entryFile), "The owner's requested edit");
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.run.id));
    expect((await copies.collectStopped({ companyId: f.companyId, runId: f.run.id }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe("The owner's requested edit");
  });

  it.each([false, true])("saves the current agent directory in owner chat (warm: %s)", async (warm) => {
    const f = await seed();
    const copies = agentInstructionWorkingCopyService(db);
    const copy = (await copies.prepare({ companyId: f.companyId, agentId: f.agentId, runId: f.run.id, cwd: home, warm }))!;
    await fs.writeFile(path.join(copy.localRoot, copy.entryFile), "Requested through owner chat");
    expect((await copies.collectStopped({ companyId: f.companyId, runId: f.run.id }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe("Requested through owner chat");
  });

  it.each([false, true])("surfaces the actual rejection when directory collection loses chat authority (warm: %s)", async (warm) => {
    const f = await seed();
    const copies = agentInstructionWorkingCopyService(db);
    const copy = (await copies.prepare({ companyId: f.companyId, agentId: f.agentId, runId: f.run.id, cwd: home, warm }))!;
    await fs.writeFile(path.join(copy.localRoot, copy.entryFile), "Must not be saved");
    await db.update(agentWakeupRequests).set({ requestedByActorType: "agent", requestedByActorId: f.agentId }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (warm) {
      expect((await copies.checkpointWarm({ companyId: f.companyId, runId: f.run.id }))?.errorMessage)
        .toContain("Self-edits require a direct message");
    }
    expect(await copies.collectStopped({ companyId: f.companyId, runId: f.run.id })).toMatchObject({
      state: "unavailable", errorMessage: expect.stringContaining("Self-edits require a direct message"),
    });
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe(initial);
  });

  it("does not carry owner-chat instruction authority into an outside task or its subtask", async () => {
    const f = await seed();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Outside work", assigneeAgentId: f.agentId }).returning();
    const [child] = await db.insert(issues).values({ companyId: f.companyId, title: "Subtask", parentId: task.id, assigneeAgentId: f.agentId }).returning();
    for (const issue of [task, child]) {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id } }).returning();
      await initializeRunIdentity(db, { companyId: f.companyId, runId: run.id, issueId: issue.id,
        responsibleUserId: f.userId, parentRunId: f.run.id, cause: "assignment" });
      await expect(authorizeInstructionCommit(db, { ...f.actor, runId: run.id }, f.target)).rejects.toMatchObject({ status: 403 });
    }
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe(initial);
  });

  it.each(["plugin", "connector", "slack board", "unknown channel", "wrong comment receipt", "missing client request", "agent", "missing receipt"])("rejects %s work attributed to the same owner", async (source) => {
    const f = await seed();
    if (source === "plugin") await db.update(agentWakeupRequests).set({ payload: { ...f.wake.payload,
      _paperclipWakeContext: { ...f.run.contextSnapshot, source: "plugin:inbox" } } }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (source === "connector") await db.update(agentWakeupRequests).set({ idempotencyKey: `chat-inbound:${randomUUID()}` }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (source === "slack board") await db.update(agentWakeupRequests).set({ source: "automation", triggerDetail: "system",
      idempotencyKey: `slack-board-comment:${randomUUID()}` }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (source === "unknown channel") await db.update(agentWakeupRequests).set({ idempotencyKey: null }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (source === "wrong comment receipt") await db.update(agentWakeupRequests).set({ idempotencyKey: `conversation-comment:${randomUUID()}` }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (source === "missing client request") await db.update(issueComments).set({ clientRequestId: null }).where(eq(issueComments.id, f.message.id));
    if (source === "agent") await db.update(agentWakeupRequests).set({ requestedByActorType: "agent", requestedByActorId: f.agentId }).where(eq(agentWakeupRequests.id, f.wake.id));
    if (source === "missing receipt") await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, f.wake.id));
    await expectDenied(f);
  });

  it("does not let a later external message borrow an earlier owner message's authority", async () => {
    const f = await seed();
    const [outside] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.chat.id,
      authorUserId: f.userId, body: "Imported outside instructions" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: f.companyId, runId: f.run.id,
      responsibleUserId: f.userId, messageId: outside.id, revision: 3, cause: "steering", correlationId: "external-message", status: "accepted" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, f.run.id));
    await expectDenied(f);
  });

  it("accepts a coalesced owner message only when it is the active instruction", async () => {
    const f = await seed();
    await db.update(agentWakeupRequests).set({ status: "coalesced", payload: { issueId: f.chat.id,
      _paperclipWakeContext: { source: "issue.comment", wakeCommentIds: [f.message.id] } } }).where(eq(agentWakeupRequests.id, f.wake.id));
    await expect(authorize(f)).resolves.toMatchObject({ agentId: f.agentId });
  });

  it("allows a fresh request after /new while rejecting messages before the reset boundary", async () => {
    const f = await seed();
    const [boundary] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.chat.id,
      authorUserId: f.userId, body: "/new", conversationSessionGeneration: 1,
      createdAt: new Date(f.message.createdAt.getTime() - 1_000) }).returning();
    await db.update(issues).set({ conversationSessionGeneration: 1, conversationBoundaryCommentId: boundary.id })
      .where(eq(issues.id, f.chat.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.run.contextSnapshot, conversationSessionGeneration: 1 } })
      .where(eq(heartbeatRuns.id, f.run.id));
    await expect(authorize(f)).resolves.toMatchObject({ agentId: f.agentId });
    await db.update(issueComments).set({ createdAt: new Date(boundary.createdAt.getTime() - 1_000) })
      .where(eq(issueComments.id, f.message.id));
    await expectDenied(f);
  });

  it.each(["cancelled", "queued", "reset", "deleted message", "reassigned", "different owner"])("revokes the exception after %s", async (change) => {
    const f = await seed();
    if (change === "cancelled" || change === "queued") await db.update(heartbeatRuns).set({ status: change }).where(eq(heartbeatRuns.id, f.run.id));
    if (change === "reset") await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.chat.id));
    if (change === "deleted message") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, f.message.id));
    if (change === "reassigned") await db.update(issues).set({ assigneeAgentId: null, conversationAgentId: null,
      conversationUserId: null, conversationState: null }).where(eq(issues.id, f.chat.id));
    if (change === "different owner") await db.update(issues).set({ conversationUserId: randomUUID() }).where(eq(issues.id, f.chat.id));
    await expectDenied(f);
  });

  it.each(["membership", "edit grant"])("rechecks the owner's %s when collecting edits", async (permission) => {
    const f = await seed();
    const copies = agentInstructionWorkingCopyService(db);
    const copy = (await copies.prepare({ companyId: f.companyId, agentId: f.agentId, runId: f.run.id, cwd: home, legacy: true }))!;
    await fs.writeFile(path.join(copy.localRoot, copy.entryFile), "Must remain a candidate");
    if (permission === "membership") await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, f.userId));
    else await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, f.userId));
    const result = await copies.collectStopped({ companyId: f.companyId, runId: f.run.id });
    expect(result).toMatchObject({ state: "conflict", candidateBase64: expect.any(String) });
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe(initial);
  });

  it("keeps peer instruction changes prohibited even with explicit grants", async () => {
    const f = await seed();
    const [peer] = await db.insert(agents).values({ companyId: f.companyId, name: "Peer", status: "active" }).returning();
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.agentId, permissionKey: "agents:configure" });
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [f.agentId, peer.id] } }).where(eq(principalPermissionGrants.principalId, f.userId));
    await expect(authorizeInstructionCommit(db, f.actor, { companyId: f.companyId, id: peer.id })).rejects.toMatchObject({ status: 403 });
  });

  it("continues the same request on a server-linked retry but cannot revive a cancelled request", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      invocationSource: "automation", status: "running", retryOfRunId: f.run.id,
      contextSnapshot: { issueId: f.chat.id, conversationSessionGeneration: 0 } }).returning();
    await initializeRunIdentity(db, { companyId: f.companyId, runId: retry.id, issueId: f.chat.id,
      responsibleUserId: f.userId, parentRunId: f.run.id, cause: "retry" });
    const actor = { ...f.actor, runId: retry.id };
    await expect(authorizeInstructionCommit(db, actor, f.target)).resolves.toMatchObject({ runId: retry.id });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(authorizeInstructionCommit(db, actor, f.target)).rejects.toMatchObject({ status: 403 });
  });

  it("does not lend a past owner request to an automatic continuation or a retry of external steering", async () => {
    const f = await seed();
    const [continuation] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      invocationSource: "automation", status: "running", contextSnapshot: f.run.contextSnapshot }).returning();
    await initializeRunIdentity(db, { companyId: f.companyId, runId: continuation.id, issueId: f.chat.id,
      responsibleUserId: f.userId, parentRunId: f.run.id, cause: "continuation" });
    await expect(authorizeInstructionCommit(db, { ...f.actor, runId: continuation.id }, f.target))
      .rejects.toMatchObject({ status: 403, details: { reason: "deny_low_trust_boundary" } });

    const [external] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.chat.id,
      authorUserId: f.userId, body: "Outside message" }).returning();
    const [identity] = await db.insert(runIdentityContexts).values({ companyId: f.companyId, runId: f.run.id,
      responsibleUserId: f.userId, messageId: external.id, revision: 3, cause: "steering", correlationId: "external" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: identity.id, status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      invocationSource: "automation", status: "running", retryOfRunId: f.run.id, contextSnapshot: f.run.contextSnapshot }).returning();
    await initializeRunIdentity(db, { companyId: f.companyId, runId: retry.id, issueId: f.chat.id,
      responsibleUserId: f.userId, parentRunId: f.run.id, cause: "retry" });
    await expect(authorizeInstructionCommit(db, { ...f.actor, runId: retry.id }, f.target))
      .rejects.toMatchObject({ status: 403, details: { reason: "deny_low_trust_boundary" } });
  });

  it("still enforces explicit protected-change restrictions inside owner chat", async () => {
    const f = await seed();
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent",
      principalId: f.agentId, permissionKey: "agents:suggest-changes" });
    await expect(authorize(f)).rejects.toMatchObject({ status: 403, details: { code: "reflection_coach_mutation_gate_required" } });
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, f.agentId));
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent",
      principalId: f.agentId, permissionKey: "agents:configure", scope: { agentIds: [randomUUID()] } });
    await expect(authorize(f)).rejects.toMatchObject({ status: 403 });
  });

  it("cannot use forged caller identity or a malformed trust boundary", async () => {
    const f = await seed();
    await expect(authorizeInstructionCommit(db, { ...f.actor, onBehalfOfUserId: randomUUID() }, f.target)).rejects.toMatchObject({ status: 403 });
    await db.update(agents).set({ permissions: { ...f.permissions, authorizationPolicy: {
      trustBoundary: { ...f.permissions.authorizationPolicy.trustBoundary, companyId: randomUUID() },
    } } }).where(eq(agents.id, f.agentId));
    await expectDenied(f);
  });
});
