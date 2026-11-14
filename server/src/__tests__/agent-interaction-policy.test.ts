import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, issues, principalPermissionGrants,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { AGENT_INTERACTION_PERMISSION_KEYS, type AgentInteractionPermissionKey } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInteractionDenial, assertAgentInteraction, type AgentInteractionInput } from "../services/agent-interaction-policy.js";
import { authorizationService, authorizationDeniedDetails } from "../services/authorization.js";
import { withPluginInteractionOrigin } from "../services/plugin-interaction-context.js";

describe("agent interaction authorization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-interaction-policy-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "human", name: "Human", email: "human@example.com", createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), actorAgentId = randomUUID(), targetAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Interactions", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(agents).values([actorAgentId, targetAgentId].map((id, i) => ({
      id, companyId, name: `Agent ${i}`, status: "idle", adapterType: "process", permissions: {},
    })));
    await db.insert(companyMemberships).values([actorAgentId, targetAgentId].map(principalId => ({
      companyId, principalId, principalType: "agent", membershipRole: "member", status: "active",
    })));
    const [task, own, unassigned, human, conversation] = await db.insert(issues).values([
      { assigneeAgentId: targetAgentId }, { assigneeAgentId: actorAgentId }, {}, { assigneeUserId: "human" },
      { conversationAgentId: actorAgentId, conversationUserId: "human", assigneeAgentId: actorAgentId, conversationState: "active" as const },
    ].map((value, i) => ({ companyId, title: `Task ${i}`, status: "todo", ...value }))).returning();
    return { companyId, actorAgentId, targetAgentId, task: task!, own: own!, unassigned: unassigned!, human: human!, conversation: conversation! };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function set(agentId: string, key: AgentInteractionPermissionKey, value = false) {
    await db.update(agents).set({ permissions: { interactions: { [key]: value } } }).where(eq(agents.id, agentId));
  }
  const input = (f: Fixture, operation: AgentInteractionInput["operation"], more: Partial<AgentInteractionInput> = {}): AgentInteractionInput => ({
    companyId: f.companyId, actorAgentId: f.actorAgentId, operation, ...more,
  });

  const cases: Array<[AgentInteractionPermissionKey, "incoming" | "outgoing", AgentInteractionInput["operation"]]> = [
    ["canAssignTasksToAgents", "outgoing", "assign"], ["canReceiveAssignmentsFromAgents", "incoming", "assign"],
    ["canAssignTasksToHumans", "outgoing", "assign"], ["canMentionAgents", "outgoing", "mention"],
    ["canReceiveMentionsFromAgents", "incoming", "mention"], ["canCommentOnOtherTasks", "outgoing", "comment"],
    ["canReceiveCommentsFromAgents", "incoming", "comment"], ["canEditOtherTasks", "outgoing", "edit"],
    ["canReceiveTaskEditsFromAgents", "incoming", "edit"], ["canConfigureOtherAgents", "outgoing", "configure"],
    ["canReceiveConfigurationChangesFromAgents", "incoming", "configure"],
  ];
  it.each(cases)("%s independently restricts its operation and can be restored", async (key, direction, operation) => {
    const f = await seed();
    const action = input(f, operation, {
      ...(operation === "comment" || operation === "edit" ? { issueId: f.task.id } :
        key === "canAssignTasksToHumans" ? { assigneeUserId: "human" } : { targetAgentId: f.targetAgentId }),
    });
    expect(await agentInteractionDenial(db, action)).toBeNull();
    const policyAgentId = direction === "incoming" ? f.targetAgentId : f.actorAgentId;
    await set(policyAgentId, key);
    expect(await agentInteractionDenial(db, action)).toMatchObject({ permission: key, direction, policyAgentId });
    await expect(assertAgentInteraction(db, action)).rejects.toMatchObject({ status: 403, details: { code: "agent_interaction_denied", permission: key } });
    expect(await agentInteractionDenial(db, { ...action, actorAgentId: null })).toBeNull();
    if (operation !== "configure") expect(await agentInteractionDenial(db, input(f, "configure", { targetAgentId: f.targetAgentId }))).toBeNull();
    await set(policyAgentId, key, true);
    expect(await agentInteractionDenial(db, action)).toBeNull();
    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, policyAgentId));
    expect(await agentInteractionDenial(db, action)).toBeNull();
  });

  it("uses current ownership including conversations, never creator or manager relationships", async () => {
    const f = await seed();
    await db.update(agents).set({ reportsTo: f.actorAgentId }).where(eq(agents.id, f.targetAgentId));
    await db.update(issues).set({ createdByAgentId: f.actorAgentId, parentId: f.own.id }).where(eq(issues.id, f.task.id));
    for (const operation of ["comment", "edit"] as const) {
      await set(f.actorAgentId, operation === "comment" ? "canCommentOnOtherTasks" : "canEditOtherTasks");
      for (const task of [f.own, f.conversation]) expect(await agentInteractionDenial(db, input(f, operation, { issueId: task.id }))).toBeNull();
      for (const task of [f.task, f.unassigned, f.human]) expect(await agentInteractionDenial(db, input(f, operation, { issueId: task.id }))).not.toBeNull();
    }
    await db.update(issues).set({ assigneeAgentId: f.targetAgentId }).where(eq(issues.id, f.own.id));
    expect(await agentInteractionDenial(db, input(f, "edit", { issueId: f.own.id }))).not.toBeNull();
  });

  it("protects a source owner from self-claim/unassignment and parent edits independently of destination", async () => {
    const f = await seed();
    await set(f.targetAgentId, "canReceiveTaskEditsFromAgents");
    for (const destination of [{}, { targetAgentId: f.actorAgentId }, { assigneeUserId: "human" }]) {
      expect(await agentInteractionDenial(db, input(f, "assign", { issueId: f.task.id, ...destination })))
        .toMatchObject({ permission: "canReceiveTaskEditsFromAgents", operation: "edit" });
    }
    expect(await agentInteractionDenial(db, input(f, "assign", { parentIssueId: f.task.id, targetAgentId: f.actorAgentId })))
      .toMatchObject({ issueId: f.task.id, permission: "canReceiveTaskEditsFromAgents" });
    expect(await agentInteractionDenial(db, input(f, "assign", { targetAgentId: f.targetAgentId }))).toBeNull();
    expect(await agentInteractionDenial(db, input(f, "assign", { issueId: f.task.id, targetAgentId: f.targetAgentId, delivery: true }))).toBeNull();
  });

  it("checks every structured mention alongside the operation while allowing self and ordinary text", async () => {
    const f = await seed(), foreign = await seed();
    await set(f.targetAgentId, "canReceiveMentionsFromAgents");
    const action = input(f, "comment", { issueId: f.own.id });
    expect(await agentInteractionDenial(db, { ...action, texts: [`[@self](agent://${f.actorAgentId}) and [@target](agent://${f.targetAgentId})`] }))
      .toMatchObject({ operation: "mention", targetAgentId: f.targetAgentId });
    expect(await agentInteractionDenial(db, { ...action, texts: [`@Agent 1 [@self](agent://${f.actorAgentId}) [@foreign](agent://${foreign.targetAgentId}) [@unknown](agent://not-a-uuid)`] })).toBeNull();
    await set(f.actorAgentId, "canMentionAgents");
    expect(await agentInteractionDenial(db, { ...action, texts: [`[@self](agent://${f.actorAgentId})`] })).toBeNull();
  });

  it("enforces explicit denials after shared authorization, including CEO/grants and responsible-human attribution", async () => {
    const f = await seed();
    await db.update(agents).set({ role: "ceo", permissions: { canCreateAgents: true } }).where(eq(agents.id, f.actorAgentId));
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.actorAgentId, permissionKey: "tasks:assign" });
    const actor = { type: "agent" as const, agentId: f.actorAgentId, companyId: f.companyId };
    const resource = { type: "issue" as const, companyId: f.companyId, assigneeAgentId: f.targetAgentId };
    expect((await authorizationService(db).decide({ actor, action: "tasks:assign", resource })).allowed).toBe(true);
    await set(f.targetAgentId, "canReceiveAssignmentsFromAgents");
    const decision = await authorizationService(db).decide({ actor, action: "tasks:assign", resource });
    expect(decision).toMatchObject({ allowed: false, reason: "deny_agent_interaction" });
    expect(authorizationDeniedDetails(decision)).toMatchObject({ code: "agent_interaction_denied", permission: "canReceiveAssignmentsFromAgents", direction: "incoming" });
    await db.update(agents).set({ permissions: { trustPreset: "low_trust_review", interactions: { canAssignTasksToAgents: true },
      authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId: f.companyId, issueIds: [f.own.id] } } } }).where(eq(agents.id, f.actorAgentId));
    await set(f.targetAgentId, "canReceiveAssignmentsFromAgents", true);
    expect((await authorizationService(db).decide({ actor, action: "tasks:assign", resource })).allowed).toBe(false);
  });

  it("preserves sparse existing records and checks fresh policy even for a reused authorizer", async () => {
    const f = await seed();
    const auth = authorizationService(db);
    const query = { actor: { type: "agent" as const, agentId: f.actorAgentId, companyId: f.companyId }, action: "issue:comment" as const,
      resource: { type: "issue" as const, companyId: f.companyId, issueId: f.task.id, assigneeAgentId: f.targetAgentId, assigneeUserId: null, status: "todo" } };
    expect((await auth.decide(query)).allowed).toBe(true);
    expect((await db.select().from(agents).where(eq(agents.id, f.actorAgentId)))[0]?.permissions).toEqual({});
    await set(f.targetAgentId, "canReceiveCommentsFromAgents");
    expect((await auth.decide(query)).allowed).toBe(false);
    expect(cases.map(([key]) => key).sort()).toEqual([...AGENT_INTERACTION_PERMISSION_KEYS].sort());
  });

  it("serializes an authorized mutation with a concurrent human permission change", async () => {
    const f = await seed();
    let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const mutation = db.transaction(async tx => {
      await assertAgentInteraction(tx, input(f, "edit", { issueId: f.task.id, lock: true }));
      await tx.update(issues).set({ title: "Authorized before revocation" }).where(eq(issues.id, f.task.id));
      locked();
      await held;
    });
    await ready;
    try {
      await expect(db.transaction(async tx => {
        await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, f.targetAgentId)).for("update", { noWait: true });
      })).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      release();
      await mutation;
    }
    await set(f.targetAgentId, "canReceiveTaskEditsFromAgents");
    await expect(db.transaction(async tx => {
      await assertAgentInteraction(tx, input(f, "edit", { issueId: f.task.id, lock: true }));
      await tx.update(issues).set({ title: "Must not persist" }).where(eq(issues.id, f.task.id));
    })).rejects.toMatchObject({ status: 403 });
    expect((await db.select({ title: issues.title }).from(issues).where(eq(issues.id, f.task.id)))[0]?.title).toBe("Authorized before revocation");
  });

  it("uses trusted plugin origin even when a handler labels the operation human or another agent", async () => {
    const f = await seed();
    await set(f.targetAgentId, "canReceiveCommentsFromAgents");
    await withPluginInteractionOrigin({ companyId: f.companyId, agentId: f.actorAgentId }, async () => {
      for (const actorAgentId of [null, f.targetAgentId]) {
        expect(await agentInteractionDenial(db, input(f, "comment", { actorAgentId, issueId: f.task.id })))
          .toMatchObject({ permission: "canReceiveCommentsFromAgents", actorAgentId: f.actorAgentId });
      }
      const decision = await authorizationService(db).decide({
        actor: { type: "board", source: "local_implicit" }, action: "issue:comment",
        resource: { type: "issue", companyId: f.companyId, issueId: f.task.id },
      });
      expect(decision).toMatchObject({ allowed: false, code: "agent_interaction_denied" });
      await expect(agentInteractionDenial(db, input(f, "comment", { companyId: randomUUID() })))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  it("checks the original company's sender for an independently authorized cross-company import", async () => {
    const source = await seed(), destination = await seed();
    const action = input(destination, "assign", { actorAgentId: source.actorAgentId, targetAgentId: destination.targetAgentId });
    await expect(agentInteractionDenial(db, action)).rejects.toMatchObject({ status: 404 });
    const attributed = { ...action, actorCompanyId: source.companyId };
    expect(await agentInteractionDenial(db, attributed)).toBeNull();
    await set(source.actorAgentId, "canAssignTasksToAgents");
    expect(await agentInteractionDenial(db, attributed)).toMatchObject({ permission: "canAssignTasksToAgents", direction: "outgoing" });
    await set(source.actorAgentId, "canAssignTasksToAgents", true);
    await set(destination.targetAgentId, "canReceiveAssignmentsFromAgents");
    expect(await agentInteractionDenial(db, attributed)).toMatchObject({ permission: "canReceiveAssignmentsFromAgents", direction: "incoming" });
  });
});
