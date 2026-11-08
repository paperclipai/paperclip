import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  instanceUserRoles,
  userDelegates,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { userDelegateActorMiddleware } from "../middleware/user-delegate.js";
import { attentionRoutes } from "../routes/attention.js";
import { assertBoard } from "../routes/authz.js";
import { userDelegateRoutes } from "../routes/user-delegates.js";
import { accessService } from "../services/access.js";
import { authorizationService } from "../services/authorization.js";
import { matchUserDelegateAction } from "../services/user-delegates.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("user delegate action allowlist", () => {
  it.each([
    ["POST", "/api/issues/DAY-1/interactions/abc/respond", "interaction.resolve"],
    ["POST", "/api/issues/DAY-1/interactions/abc/accept", "interaction.resolve"],
    ["POST", "/api/decisions/abc/decide", "decision.decide"],
    ["PATCH", "/api/routines/abc", "routine.update"],
    ["POST", "/api/routines/abc/run", "routine.run"],
    ["PATCH", "/api/routine-triggers/abc", "routine.trigger_update"],
    ["POST", "/api/agents/abc/wakeup", "agent.wake"],
    ["POST", "/api/agents/abc/heartbeat/invoke", "agent.wake"],
    ["POST", "/api/agents/abc/resume", "agent.pause_resume"],
    ["POST", "/api/tool-profiles/abc/new-tools/review", "tools.review_new"],
    ["POST", "/api/companies/c/tools/policies/reorder", "tools.policy_create"],
    ["POST", "/api/companies/c/tools/policies/p/duplicate", "tools.policy_create"],
    ["POST", "/api/issues/DAY-1/stalled-review-decision", "stalled.review_decision"],
    ["POST", "/api/issues/DAY-1/recovery-actions/resolve", "recovery.resolve"],
    ["POST", "/api/issues/DAY-1/recovery-actions/recover-workspace", "recovery.workspace"],
    ["POST", "/api/issues/DAY-1/retry", "task.retry"],
    ["POST", "/api/heartbeat-runs/abc/watchdog-decisions", "watchdog.decide"],
    ["GET", "/api/companies/c/attention", "inbox.read"],
    ["GET", "/api/companies/c/inbox/mine/", "inbox.read"],
  ])("allows %s %s", (method, path, key) => {
    expect(matchUserDelegateAction(method, path)?.key).toBe(key);
  });

  it.each([
    ["POST", "/api/approvals/abc/approve"],
    ["POST", "/api/companies/c/secrets"],
    ["POST", "/api/routine-triggers/abc/rotate-secret"],
    ["POST", "/api/agents/abc/terminate"],
    ["DELETE", "/api/agents/abc"],
    ["POST", "/api/agents/abc/keys"],
    ["PATCH", "/api/agents/abc/permissions"],
    ["POST", "/api/issues/DAY-1/recovery-actions/reconstruct-workspace"],
    ["POST", "/api/issues/DAY-1/admin/force-release"],
    ["PUT", "/api/companies/c/users/me/delegate"],
    ["DELETE", "/api/companies/c/users/me/delegate"],
    ["GET", "/api/companies/c/attention/history"],
    ["GET", "/api/companies/c/me/user-secrets"],
    ["POST", "/api/companies/c/attention"],
    ["POST", "/api/agents/abc/wakeup/extra"],
  ])("refuses %s %s", (method, path) => {
    expect(matchUserDelegateAction(method, path)).toBeNull();
  });

  it("allows only adding a Composio account, not renaming or removing one", () => {
    const path = "/api/tool-connections/abc/composio/apps/gmail/accounts";
    expect(matchUserDelegateAction("POST", path, { action: "add" })?.key).toBe("composio.account_add");
    expect(matchUserDelegateAction("POST", path, { action: "rename", accountId: "a", alias: "x" })).toBeNull();
    expect(matchUserDelegateAction("POST", path, { action: "remove", accountId: "a" })).toBeNull();
    expect(matchUserDelegateAction("POST", path)).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("user delegates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const runIds = new Map<string, string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-user-delegates-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(userDelegates);
    await db.delete(instanceUserRoles);
    await db.delete(heartbeatRuns);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Mirrors the production order: actor, delegate middleware, then the API router behind the CSRF guard. */
  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = structuredClone(actor);
      next();
    });
    app.use(userDelegateActorMiddleware(db));
    const api = Router();
    api.use(boardMutationGuard());
    api.post("/agents/:id/wakeup", (req, res) => {
      assertBoard(req);
      res.json({ actor: req.actor, query: req.query });
    });
    api.use(attentionRoutes(db));
    api.use(userDelegateRoutes(db));
    app.use("/api", api);
    app.use(errorHandler);
    return app;
  }

  async function seed(options: { membershipRole?: string } = {}) {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const delegateAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: `Delegates ${companyId}`,
      issuePrefix: `UD${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(authUsers).values({
      id: userId, name: "Person", email: `${userId}@example.com`, emailVerified: true, createdAt: now, updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: options.membershipRole ?? "owner",
    });
    await db.insert(agents).values([delegateAgentId, otherAgentId].map((id, index) => ({
      id, companyId, name: index === 0 ? "Chief of staff" : "Other", role: "general",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    // The delegate acts inside a real run; activity rows reference it.
    for (const agentId of [delegateAgentId, otherAgentId]) {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId }).returning();
      runIds.set(agentId, run!.id);
    }
    return { companyId, userId, delegateAgentId, otherAgentId };
  }

  function personActor(companyId: string, userId: string): Express.Request["actor"] {
    return {
      type: "board", source: "board_key", userId, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false,
    };
  }

  function agentActor(companyId: string, agentId: string, extra: Partial<Express.Request["actor"]> = {}): Express.Request["actor"] {
    return {
      type: "agent", source: "agent_jwt", agentId, companyId, runId: runIds.get(agentId), keyScope: { kind: "standard" }, ...extra,
    };
  }

  async function nameDelegate(companyId: string, userId: string, agentId: string) {
    const res = await request(appFor(personActor(companyId, userId)))
      .put(`/api/companies/${companyId}/users/me/delegate`).send({ agentId });
    expect(res.status).toBe(200);
    return res.body.delegate as { id: string };
  }

  async function actedRows(companyId: string) {
    return db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "user_delegate.acted")));
  }

  it("keeps a board-only route closed to an agent that is not a delegate", async () => {
    const { companyId, userId, delegateAgentId } = await seed();
    const app = appFor(agentActor(companyId, delegateAgentId));

    const plain = await request(app).get(`/api/companies/${companyId}/attention`);
    expect(plain.status).toBe(403);
    expect(plain.body.error).toBe("Board access required");

    const marked = await request(app).get(`/api/companies/${companyId}/attention`)
      .set("X-Paperclip-Delegate-For", userId).set("X-Paperclip-Delegate-Reason", "Triage Leia's inbox");
    expect(marked.status).toBe(403);
    expect(marked.body.details?.code).toBe("user_delegate_not_authorized");
    expect(await actedRows(companyId)).toHaveLength(0);
  });

  it("lets the named delegate act as the person and logs the delegate, person and reason first", async () => {
    const { companyId, userId, delegateAgentId } = await seed();
    const delegation = await nameDelegate(companyId, userId, delegateAgentId);
    const actor = agentActor(companyId, delegateAgentId);
    const app = appFor(actor);

    const feed = await request(app).get(`/api/companies/${companyId}/attention`)
      .set("X-Paperclip-Delegate-For", userId).set("X-Paperclip-Delegate-Reason", "Triage the inbox");
    expect(feed.status).toBe(200);

    const wake = await request(app).post(`/api/agents/${randomUUID()}/wakeup`)
      .query({ delegateFor: userId, delegateReason: "Start the stall check", keep: "1" }).send({});
    expect(wake.status).toBe(200);
    // Routes that validate their query never see the delegate parameters.
    expect(wake.body.query).toEqual({ keep: "1" });
    expect(wake.body.actor).toMatchObject({
      type: "board",
      source: "delegate",
      userId,
      runId: actor.runId,
      companyIds: [companyId],
      isInstanceAdmin: false,
      ignoreInstanceAdmin: true,
      delegate: { delegationId: delegation.id, agentId: delegateAgentId, runId: actor.runId, reason: "Start the stall check", action: "agent.wake" },
    });

    const rows = await actedRows(companyId);
    expect(rows).toHaveLength(2);
    const wakeRow = rows.find((row) => (row.details as Record<string, unknown>).delegateAction === "agent.wake")!;
    expect(wakeRow).toMatchObject({
      actorType: "agent",
      actorId: delegateAgentId,
      agentId: delegateAgentId,
      runId: actor.runId,
      responsibleUserId: userId,
      entityType: "user_delegate",
      entityId: delegation.id,
    });
    expect(wakeRow.details).toMatchObject({ onBehalfOfUserId: userId, delegateAgentId, reason: "Start the stall check", method: "POST" });

    const mine = await request(app).get(`/api/companies/${companyId}/user-delegations/mine`);
    expect(mine.status).toBe(200);
    expect(mine.body.delegations).toEqual([expect.objectContaining({ id: delegation.id, userId })]);
  });

  it("never gives the delegate instance-admin rights, even when the person has them", async () => {
    const { companyId, userId, delegateAgentId } = await seed();
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    await nameDelegate(companyId, userId, delegateAgentId);
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: `Other ${otherCompanyId}`,
      issuePrefix: `UO${otherCompanyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });

    const wake = await request(appFor(agentActor(companyId, delegateAgentId)))
      .post(`/api/agents/${randomUUID()}/wakeup`)
      .set("X-Paperclip-Delegate-For", userId).set("X-Paperclip-Delegate-Reason", "Check admin scope").send({});
    expect(wake.status).toBe(200);
    const delegateActor = wake.body.actor as Express.Request["actor"];

    const request_ = { action: "agents:create" as const, resource: { type: "company" as const, companyId: otherCompanyId } };
    const asDelegate = await authorizationService(db).decide({ actor: delegateActor, ...request_ });
    expect(asDelegate.allowed).toBe(false);
    expect(asDelegate.reason).not.toBe("allow_instance_admin");
    // Control: the same person signed in directly is an instance admin.
    const asPerson = await authorizationService(db).decide({ actor: { type: "board", userId, source: "session" }, ...request_ });
    expect(asPerson).toMatchObject({ allowed: true, reason: "allow_instance_admin" });

    // Permission checks that rebuild the actor from a user ID (routines, tool
    // rules) must keep the delegate's instance-admin exclusion too.
    const access = accessService(db);
    expect(await access.canUser(otherCompanyId, userId, "tasks:assign", { ignoreInstanceAdmin: true })).toBe(false);
    expect(await access.canUser(otherCompanyId, userId, "tasks:assign")).toBe(true);
  });

  it("requires a reason, an allowlisted action, the named agent and an unrestricted credential", async () => {
    const { companyId, userId, delegateAgentId, otherAgentId } = await seed();
    await nameDelegate(companyId, userId, delegateAgentId);
    const wakePath = `/api/agents/${randomUUID()}/wakeup`;

    const noReason = await request(appFor(agentActor(companyId, delegateAgentId)))
      .post(wakePath).set("X-Paperclip-Delegate-For", userId).send({});
    expect(noReason.status).toBe(400);
    expect(noReason.body.details?.code).toBe("user_delegate_reason_required");

    const notAllowed = await request(appFor(agentActor(companyId, delegateAgentId)))
      .put(`/api/companies/${companyId}/users/me/delegate`)
      .set("X-Paperclip-Delegate-For", userId).set("X-Paperclip-Delegate-Reason", "Swap myself out")
      .send({ agentId: otherAgentId });
    expect(notAllowed.status).toBe(403);
    expect(notAllowed.body.details?.code).toBe("user_delegate_action_not_allowed");

    const otherAgent = await request(appFor(agentActor(companyId, otherAgentId)))
      .post(wakePath).set("X-Paperclip-Delegate-For", userId).set("X-Paperclip-Delegate-Reason", "Try").send({});
    expect(otherAgent.status).toBe(403);
    expect(otherAgent.body.details?.code).toBe("user_delegate_not_authorized");

    const scoped = await request(appFor(agentActor(companyId, delegateAgentId, { keyScope: { kind: "skill_test", issueId: randomUUID() } })))
      .post(wakePath).set("X-Paperclip-Delegate-For", userId).set("X-Paperclip-Delegate-Reason", "Try").send({});
    expect(scoped.status).toBe(403);
    expect(scoped.body.details?.code).toBe("user_delegate_credential_restricted");

    const board = await request(appFor(personActor(companyId, userId)))
      .post(wakePath).set("X-Paperclip-Delegate-For", userId).set("X-Paperclip-Delegate-Reason", "Try").send({});
    expect(board.status).toBe(403);
    expect(board.body.details?.code).toBe("user_delegate_actor_not_agent");

    expect(await actedRows(companyId)).toHaveLength(0);
  });

  it("stops at once when the person turns the delegate off or can no longer act", async () => {
    const { companyId, userId, delegateAgentId } = await seed();
    await nameDelegate(companyId, userId, delegateAgentId);
    const wake = () => request(appFor(agentActor(companyId, delegateAgentId)))
      .post(`/api/agents/${randomUUID()}/wakeup`)
      .set("X-Paperclip-Delegate-For", userId).set("X-Paperclip-Delegate-Reason", "Wake").send({});
    expect((await wake()).status).toBe(200);

    await db.update(companyMemberships).set({ membershipRole: "viewer" })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
    const asViewer = await wake();
    expect(asViewer.status).toBe(403);
    expect(asViewer.body.details?.code).toBe("user_delegate_user_unavailable");
    await db.update(companyMemberships).set({ membershipRole: "owner" })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));

    const off = await request(appFor(personActor(companyId, userId))).delete(`/api/companies/${companyId}/users/me/delegate`);
    expect(off.status).toBe(200);
    expect(off.body.delegate).toBeNull();
    const afterOff = await wake();
    expect(afterOff.status).toBe(403);
    expect(afterOff.body.details?.code).toBe("user_delegate_not_authorized");

    const changes = await db.select({ action: activityLog.action, actorId: activityLog.actorId }).from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "user_delegate")));
    expect(changes.map((row) => row.action).sort()).toEqual(["user_delegate.acted", "user_delegate.revoked", "user_delegate.set"]);
    expect(changes.find((row) => row.action === "user_delegate.revoked")?.actorId).toBe(userId);
  });

  it("keeps one active delegate per person and refuses unavailable agents", async () => {
    const { companyId, userId, delegateAgentId, otherAgentId } = await seed();
    await nameDelegate(companyId, userId, delegateAgentId);
    await nameDelegate(companyId, userId, otherAgentId);

    const active = await db.select().from(userDelegates)
      .where(and(eq(userDelegates.companyId, companyId), eq(userDelegates.status, "active")));
    expect(active.map((row) => row.delegateAgentId)).toEqual([otherAgentId]);

    const current = await request(appFor(personActor(companyId, userId))).get(`/api/companies/${companyId}/users/me/delegate`);
    expect(current.body.delegate).toMatchObject({ delegateAgentId: otherAgentId });
    expect(current.body.actions.length).toBeGreaterThan(0);

    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, delegateAgentId));
    const terminated = await request(appFor(personActor(companyId, userId)))
      .put(`/api/companies/${companyId}/users/me/delegate`).send({ agentId: delegateAgentId });
    expect(terminated.status).toBe(422);

    const foreign = await request(appFor(personActor(companyId, userId)))
      .put(`/api/companies/${companyId}/users/me/delegate`).send({ agentId: randomUUID() });
    expect(foreign.status).toBe(404);
  });
});
