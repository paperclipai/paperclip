import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import type { PluginCapability } from "@paperclipai/shared";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { heartbeatService, resolveLedgerScopeForRun } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin agent session attribution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PLUGIN_KEY = "paperclip.gateway";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("plugin agent session sends: user and project attribution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const disposers: Array<() => void> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-session-attribution-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk")
      || message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(costEvents);
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(projectAccessMembers);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seed a company with an owner (the company-default responsible user), an
   * agent, and a running run that holds the agent's single concurrency slot so
   * a session wake is queued without the heartbeat going on to execute it.
   */
  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: {},
    });
    return { companyId, agentId, ownerUserId };
  }

  async function addMember(
    companyId: string,
    overrides: { status?: string; membershipRole?: string } = {},
  ) {
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: overrides.status ?? "active",
      membershipRole: overrides.membershipRole ?? "operator",
    });
    return userId;
  }

  async function addProject(companyId: string, overrides: Partial<typeof projects.$inferInsert> = {}) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Launch",
      status: "in_progress",
      ...overrides,
    });
    return projectId;
  }

  async function grantProjectAccess(
    companyId: string,
    projectId: string,
    subjectType: "agent" | "user",
    subjectId: string,
  ) {
    await db.insert(projectAccessMembers).values({ companyId, projectId, subjectType, subjectId });
  }

  function pluginHost(
    capabilities: PluginCapability[] = ["agent.sessions.create", "agent.sessions.send"],
    pluginKey = PLUGIN_KEY,
  ) {
    const services = buildHostServices(
      db,
      `${pluginKey}-record-id`,
      pluginKey,
      createEventBusStub(),
      undefined,
      { heartbeatRuntimeEnv: {} },
    );
    disposers.push(() => services.dispose());
    const handlers = createHostClientHandlers({ pluginId: pluginKey, capabilities, services });
    return {
      async createSession(companyId: string, agentId: string) {
        return handlers["agents.sessions.create"](
          { agentId, companyId },
          { invocationScope: { companyId } },
        );
      },
      async send(params: {
        sessionId: string;
        companyId: string;
        prompt?: string;
        actorUserId?: string;
        projectId?: string;
      }) {
        return handlers["agents.sessions.sendMessage"](
          { prompt: "hello", ...params },
          { invocationScope: { companyId: params.companyId } },
        );
      },
    };
  }

  async function runAndWakeup(runId: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [wakeupRequest] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, runId));
    return { run: run!, wakeupRequest: wakeupRequest! };
  }

  function sessionWakeActivity() {
    return db.select().from(activityLog).where(eq(activityLog.action, "agent.session_wakeup_requested"));
  }

  it("attributes the run and its cost scope to the verified user and the project", async () => {
    const { companyId, agentId } = await seedCompany();
    const actorUserId = await addMember(companyId);
    const projectId = await addProject(companyId);
    const host = pluginHost(["agent.sessions.create", "agent.sessions.send", "agent.sessions.send_human_attributed"]);
    const session = await host.createSession(companyId, agentId);

    const { runId } = await host.send({ sessionId: session.sessionId, companyId, actorUserId, projectId });

    // Cost events carry no user column: they link to the run through
    // heartbeatRunId, and the run's responsibleUserId is who the cost lands
    // on. The ledger scope is what the run's cost events are written with.
    const { run } = await runAndWakeup(runId);
    expect(run.responsibleUserId).toBe(actorUserId);
    await expect(resolveLedgerScopeForRun(db, companyId, run)).resolves.toEqual({
      issueId: null,
      projectId,
      billingCode: null,
    });
  });

  it("writes a plugin activity entry naming the user, agent, session, run and project", async () => {
    const { companyId, agentId } = await seedCompany();
    const actorUserId = await addMember(companyId);
    const projectId = await addProject(companyId);
    const host = pluginHost(["agent.sessions.create", "agent.sessions.send", "agent.sessions.send_human_attributed"]);
    const session = await host.createSession(companyId, agentId);

    const { runId } = await host.send({ sessionId: session.sessionId, companyId, actorUserId, projectId });

    const entries = await sessionWakeActivity();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      companyId,
      actorType: "plugin",
      actorId: `${PLUGIN_KEY}-record-id`,
      entityType: "agent",
      entityId: agentId,
      details: expect.objectContaining({
        agentId,
        sessionId: session.sessionId,
        runId,
        projectId,
        sourcePluginKey: PLUGIN_KEY,
        initiatingActorType: "user",
        initiatingActorId: actorUserId,
        initiatingUserId: actorUserId,
      }),
    });
  });

  it("writes a plugin activity entry with the project and no initiating user for a project-only send", async () => {
    const { companyId, agentId } = await seedCompany();
    const projectId = await addProject(companyId);
    const host = pluginHost();
    const session = await host.createSession(companyId, agentId);

    const { runId } = await host.send({ sessionId: session.sessionId, companyId, projectId });

    const entries = await sessionWakeActivity();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toMatchObject({
      agentId,
      sessionId: session.sessionId,
      runId,
      projectId,
      initiatingActorType: null,
      initiatingUserId: null,
    });
  });

  it("refuses a send that names another company while the session belongs to this one", async () => {
    const { companyId, agentId } = await seedCompany();
    const other = await seedCompany();
    const otherCompanyUserId = await addMember(other.companyId);
    const host = pluginHost(["agent.sessions.create", "agent.sessions.send", "agent.sessions.send_human_attributed"]);
    const session = await host.createSession(companyId, agentId);

    await expect(host.send({ sessionId: session.sessionId, companyId: other.companyId, actorUserId: otherCompanyUserId }))
      .rejects.toThrow(`Session not found: ${session.sessionId}`);
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
    await expect(sessionWakeActivity()).resolves.toHaveLength(0);
  });

  it("records a verified actorUserId as the wake's requesting and responsible user", async () => {
    const { companyId, agentId } = await seedCompany();
    const actorUserId = await addMember(companyId);
    const host = pluginHost(["agent.sessions.create", "agent.sessions.send", "agent.sessions.send_human_attributed"]);
    const session = await host.createSession(companyId, agentId);

    const { runId } = await host.send({ sessionId: session.sessionId, companyId, actorUserId });

    const { run, wakeupRequest } = await runAndWakeup(runId);
    expect(wakeupRequest).toMatchObject({ requestedByActorType: "user", requestedByActorId: actorUserId });
    expect(run).toMatchObject({ agentId, companyId, status: "queued", responsibleUserId: actorUserId });
  });

  it("refuses actorUserId when the plugin lacks agent.sessions.send_human_attributed", async () => {
    const { companyId, agentId } = await seedCompany();
    const actorUserId = await addMember(companyId);
    const host = pluginHost(["agent.sessions.create", "agent.sessions.send"]);
    const session = await host.createSession(companyId, agentId);

    await expect(host.send({ sessionId: session.sessionId, companyId, actorUserId }))
      .rejects.toThrow("agent.sessions.send_human_attributed");
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
  });

  it.each([
    ["a user who is not a company member", null, "is not an active human member of this company"],
    ["an inactive (suspended) member", { status: "suspended" }, "is not an active human member of this company"],
    ["a viewer-role (read-only) member", { membershipRole: "viewer" }, "viewer (read-only) access"],
  ] as const)("refuses actorUserId for %s", async (_label, membership, message) => {
    const { companyId, agentId } = await seedCompany();
    const actorUserId = membership ? await addMember(companyId, membership) : randomUUID();
    const host = pluginHost(["agent.sessions.create", "agent.sessions.send", "agent.sessions.send_human_attributed"]);
    const session = await host.createSession(companyId, agentId);

    await expect(host.send({ sessionId: session.sessionId, companyId, actorUserId })).rejects.toThrow(message);
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
  });

  it("refuses an active member of a different company", async () => {
    const { companyId, agentId } = await seedCompany();
    const other = await seedCompany();
    const otherCompanyUserId = await addMember(other.companyId);
    const host = pluginHost(["agent.sessions.create", "agent.sessions.send", "agent.sessions.send_human_attributed"]);
    const session = await host.createSession(companyId, agentId);

    await expect(host.send({ sessionId: session.sessionId, companyId, actorUserId: otherCompanyUserId }))
      .rejects.toThrow("is not an active human member of this company");
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
  });

  // The run context's projectId is the same field an issue-in-project wake
  // carries; at execution the heartbeat binds the project's workspace,
  // execution-workspace policy and env from it. Executing the run here would
  // need real adapter and workspace realization, so this asserts the binding
  // input rather than the realized workspace.
  it("puts a same-company projectId into the run context that binds the project's workspace and cost scope", async () => {
    const { companyId, agentId } = await seedCompany();
    const projectId = await addProject(companyId);
    // projectId needs only agent.sessions.send.
    const host = pluginHost();
    const session = await host.createSession(companyId, agentId);

    const { runId } = await host.send({ sessionId: session.sessionId, companyId, projectId });

    const { run } = await runAndWakeup(runId);
    expect(run.contextSnapshot).toMatchObject({ projectId });
    await expect(resolveLedgerScopeForRun(db, companyId, run)).resolves.toMatchObject({
      issueId: null,
      projectId,
    });
  });

  it("applies the project budget gate to a send scoped to a budget-paused project", async () => {
    const { companyId, agentId } = await seedCompany();
    const projectId = await addProject(companyId, { pausedAt: new Date(), pauseReason: "budget" });
    const host = pluginHost();
    const session = await host.createSession(companyId, agentId);

    // Only the project is paused, so this block can come only from the project
    // scope. With no policy behind the budget pause, the budget service reports
    // it as needing a policy or an explicit operator resume.
    await expect(host.send({ sessionId: session.sessionId, companyId, projectId }))
      .rejects.toThrow("Budget pause requires a policy or an explicit operator resume.");
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "queued"))).resolves.toHaveLength(0);
  });

  it.each([
    ["belongs to another company", "other-company"],
    ["does not exist", "missing"],
  ] as const)("refuses a projectId that %s", async (_label, kind) => {
    const { companyId, agentId } = await seedCompany();
    const other = await seedCompany();
    const projectId = kind === "other-company" ? await addProject(other.companyId) : randomUUID();
    const host = pluginHost();
    const session = await host.createSession(companyId, agentId);

    await expect(host.send({ sessionId: session.sessionId, companyId, projectId })).rejects.toThrow("Project not found");
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
  });

  // A private project admits only its access members. A project-scoped send
  // binds the project's workspace to the run and streams the run's output
  // back to the plugin, so the session agent must be an access member and,
  // when the send is attributed, so must the user — the same intersection the
  // host applies to an agent acting on behalf of a user.
  describe("private projects", () => {
    const attributedCapabilities: PluginCapability[] = [
      "agent.sessions.create",
      "agent.sessions.send",
      "agent.sessions.send_human_attributed",
    ];

    it("allows a send when the session agent is an access member", async () => {
      const { companyId, agentId } = await seedCompany();
      const projectId = await addProject(companyId, { visibility: "private" });
      await grantProjectAccess(companyId, projectId, "agent", agentId);
      const host = pluginHost();
      const session = await host.createSession(companyId, agentId);

      const { runId } = await host.send({ sessionId: session.sessionId, companyId, projectId });

      const { run } = await runAndWakeup(runId);
      expect(run.contextSnapshot).toMatchObject({ projectId });
    });

    it("allows an attributed send when both the agent and the user are access members", async () => {
      const { companyId, agentId } = await seedCompany();
      const actorUserId = await addMember(companyId);
      const projectId = await addProject(companyId, { visibility: "private" });
      await grantProjectAccess(companyId, projectId, "agent", agentId);
      await grantProjectAccess(companyId, projectId, "user", actorUserId);
      const host = pluginHost(attributedCapabilities);
      const session = await host.createSession(companyId, agentId);

      const { runId } = await host.send({ sessionId: session.sessionId, companyId, actorUserId, projectId });

      const { run } = await runAndWakeup(runId);
      expect(run).toMatchObject({ responsibleUserId: actorUserId, contextSnapshot: expect.objectContaining({ projectId }) });
    });

    it("refuses a send when the session agent is not an access member", async () => {
      const { companyId, agentId } = await seedCompany();
      const actorUserId = await addMember(companyId);
      const projectId = await addProject(companyId, { visibility: "private" });
      // The user's access does not stand in for the agent's.
      await grantProjectAccess(companyId, projectId, "user", actorUserId);
      const host = pluginHost(attributedCapabilities);
      const session = await host.createSession(companyId, agentId);

      await expect(host.send({ sessionId: session.sessionId, companyId, projectId }))
        .rejects.toThrow("Project not found");
      await expect(host.send({ sessionId: session.sessionId, companyId, actorUserId, projectId }))
        .rejects.toThrow("Project not found");
      await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
      await expect(sessionWakeActivity()).resolves.toHaveLength(0);
    });

    it("refuses an attributed send when the user is not an access member", async () => {
      const { companyId, agentId } = await seedCompany();
      const actorUserId = await addMember(companyId);
      const projectId = await addProject(companyId, { visibility: "private" });
      await grantProjectAccess(companyId, projectId, "agent", agentId);
      const host = pluginHost(attributedCapabilities);
      const session = await host.createSession(companyId, agentId);

      await expect(host.send({ sessionId: session.sessionId, companyId, actorUserId, projectId }))
        .rejects.toThrow("Project not found");
      await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
      await expect(sessionWakeActivity()).resolves.toHaveLength(0);
    });

    it("leaves an open project without access members unaffected", async () => {
      const { companyId, agentId } = await seedCompany();
      const actorUserId = await addMember(companyId);
      const projectId = await addProject(companyId, { visibility: "open" });
      const host = pluginHost(attributedCapabilities);
      const session = await host.createSession(companyId, agentId);

      const { runId } = await host.send({ sessionId: session.sessionId, companyId, actorUserId, projectId });

      const { run } = await runAndWakeup(runId);
      expect(run.contextSnapshot).toMatchObject({ projectId });
    });
  });

  it("still refuses another plugin's session when attribution fields are passed", async () => {
    const { companyId, agentId } = await seedCompany();
    const actorUserId = await addMember(companyId);
    const projectId = await addProject(companyId);
    const owner = pluginHost(["agent.sessions.create", "agent.sessions.send"], "paperclip.other-plugin");
    const session = await owner.createSession(companyId, agentId);
    const intruder = pluginHost(["agent.sessions.create", "agent.sessions.send", "agent.sessions.send_human_attributed"]);

    await expect(intruder.send({ sessionId: session.sessionId, companyId, actorUserId, projectId }))
      .rejects.toThrow(`Session not found: ${session.sessionId}`);
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);
  });

  it("keeps the plugin as requester and the company default as responsible user when both fields are left out", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const host = pluginHost();
    const session = await host.createSession(companyId, agentId);

    const { runId } = await host.send({ sessionId: session.sessionId, companyId });

    const { run, wakeupRequest } = await runAndWakeup(runId);
    expect(wakeupRequest).toMatchObject({
      requestedByActorType: "system",
      requestedByActorId: `${PLUGIN_KEY}-record-id`,
    });
    expect(run).toMatchObject({ status: "queued", responsibleUserId: ownerUserId });
    expect(run.contextSnapshot).not.toHaveProperty("projectId");
    await expect(resolveLedgerScopeForRun(db, companyId, run)).resolves.toMatchObject({ projectId: null });
    await expect(sessionWakeActivity()).resolves.toHaveLength(0);
  });
});
