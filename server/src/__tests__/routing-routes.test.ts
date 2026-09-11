import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionProfiles,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  routeDecisions,
  routePoolClaims,
  routeRules,
} from "@paperclipai/db";
import type { TaskFacts } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { routingRoutes } from "../routes/routing.js";
import { routingService, type RoutingWakeup } from "../services/routing/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type WakeCall = { agentId: string; opts: Parameters<RoutingWakeup>[1] };

describeEmbeddedPostgres("task attempt routing routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const wakes: WakeCall[] = [];
  let rejectWakes = false;

  /** Fake scheduler seam: records the wake and persists a queued run the way enqueueWakeup does. */
  const enqueueWakeup: RoutingWakeup = async (agentId, opts) => {
    wakes.push({ agentId, opts });
    if (rejectWakes) return null;
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    return db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId,
        status: "queued",
        invocationSource: "on_demand",
        contextSnapshot: opts.contextSnapshot ?? {},
      })
      .returning()
      .then((rows) => rows[0]!);
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routing-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    wakes.length = 0;
    rejectWakes = false;
    await db.delete(routePoolClaims);
    await db.delete(routeDecisions);
    await db.delete(routeRules);
    await db.delete(executionProfiles);
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRelations);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      Object.assign(req, { actor });
      next();
    });
    testApp.use("/api", routingRoutes(db, { enqueueWakeup }));
    testApp.use(errorHandler);
    return testApp;
  }

  function boardActor(companyId: string, userId = "board-user") {
    return { type: "board", source: "local_implicit", userId, companyIds: [companyId], isInstanceAdmin: false };
  }

  function memberBoardActor(companyId: string, userId = "member-user") {
    return { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false, memberships: [{ companyId, status: "active", membershipRole: "admin" }] };
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", source: "agent_key", companyId, agentId, keyId: null, keyScope: { kind: "standard" }, runId: null };
  }

  async function seedAgent(companyId: string, name: string, model: string) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: { model }, runtimeConfig: {}, permissions: {} });
    return id;
  }

  async function seedProfile(companyId: string, input: { name: string; family: "anthropic" | "openai" | "meta"; agentId: string; model: string; effort?: string; roles: string[]; max?: number; enabled?: boolean }) {
    const row = await db
      .insert(executionProfiles)
      .values({ companyId, name: input.name, providerFamily: input.family, agentId: input.agentId, model: input.model, effort: input.effort ?? "low", roleCapabilities: input.roles, maxConcurrentAttempts: input.max ?? 1, enabled: input.enabled ?? true })
      .returning()
      .then((rows) => rows[0]!);
    return row.id;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Routing Co", issuePrefix: `R${companyId.slice(0, 3).toUpperCase()}` });
    const fable51Agent = await seedAgent(companyId, "Fable 5.1", "claude-fable-5-1");
    const fable5Agent = await seedAgent(companyId, "Fable 5", "claude-fable-5");
    const astraAgent = await seedAgent(companyId, "Astra", "gpt-6-astra");
    const solAgent = await seedAgent(companyId, "Sol", "gpt-5.6-sol");
    const fable51 = await seedProfile(companyId, { name: "fable-5-1", family: "anthropic", agentId: fable51Agent, model: "claude-fable-5-1", roles: ["worker", "advisor", "reviewer", "rescuer"], max: 2 });
    const fable5 = await seedProfile(companyId, { name: "fable-5", family: "anthropic", agentId: fable5Agent, model: "claude-fable-5", roles: ["worker", "reviewer", "rescuer"], max: 3 });
    const astra = await seedProfile(companyId, { name: "astra", family: "openai", agentId: astraAgent, model: "gpt-6-astra", roles: ["worker", "reviewer", "rescuer"], max: 1 });
    const sol = await seedProfile(companyId, { name: "sol", family: "openai", agentId: solAgent, model: "gpt-5.6-sol", effort: "high", roles: ["advisor", "reviewer"], max: 1 });
    const bindings = { longFeatureOwnerProfileId: fable51, fastBugWorkerProfileId: fable5, invariantSpecialistProfileId: astra, advisorReviewerProfileId: sol };
    return { companyId, agents: { fable51Agent, fable5Agent, astraAgent, solAgent }, profiles: { fable51, fable5, astra, sol }, bindings };
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, identifier: `RT-${id.slice(0, 4)}`, title: "Ship the widget", status: "todo", ...overrides });
    return id;
  }

  const featureFacts: TaskFacts = { taskClass: "feature_standard", riskFlags: [], affectedLayers: ["server", "ui"], reproductionKnown: true, acceptanceDefined: true, architecturalDecisionOpen: false, consequential: true };

  async function seedDefaults(companyId: string, bindings: Record<string, string>) {
    const res = await request(app(boardActor(companyId))).post(`/api/companies/${companyId}/route-rules/defaults`).send(bindings);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  describe("execution profiles and rules", () => {
    it("keeps profiles company-scoped and model-consistent, and fences updates by version", async () => {
      const a = await seedCompany();
      const otherCompany = randomUUID();
      await db.insert(companies).values({ id: otherCompany, name: "Other", issuePrefix: "OTH" });
      const foreignAgent = await seedAgent(otherCompany, "Foreign", "gpt-6-astra");
      const board = request(app(boardActor(a.companyId)));

      const crossCompany = await board.post(`/api/companies/${a.companyId}/execution-profiles`).send({ name: "foreign", providerFamily: "openai", agentId: foreignAgent, model: "gpt-6-astra", effort: "low", roleCapabilities: ["worker"] });
      expect(crossCompany.status).toBe(422);
      expect(crossCompany.body.details.code).toBe("agent_company_mismatch");

      const drift = await board.post(`/api/companies/${a.companyId}/execution-profiles`).send({ name: "mislabelled", providerFamily: "openai", agentId: a.agents.astraAgent, model: "gpt-5.6-sol", effort: "low", roleCapabilities: ["worker"] });
      expect(drift.status).toBe(422);
      expect(drift.body.details.code).toBe("execution_profile_model_mismatch");

      const agentCreate = await request(app(agentActor(a.companyId, a.agents.astraAgent))).post(`/api/companies/${a.companyId}/execution-profiles`).send({ name: "self", providerFamily: "openai", agentId: a.agents.astraAgent, model: "gpt-6-astra", effort: "low", roleCapabilities: ["worker"] });
      expect(agentCreate.status).toBe(403);

      const foreignRead = await request(app(memberBoardActor(otherCompany))).get(`/api/companies/${a.companyId}/execution-profiles`);
      expect(foreignRead.status).toBe(403);

      const stale = await board.patch(`/api/execution-profiles/${a.profiles.astra}`).send({ expectedVersion: 7, enabled: false });
      expect(stale.status).toBe(409);
      expect(stale.body.details.code).toBe("version_conflict");
      const ok = await board.patch(`/api/execution-profiles/${a.profiles.astra}`).send({ expectedVersion: 1, enabled: false });
      expect(ok.status).toBe(200);
      expect(ok.body.version).toBe(2);
      expect(ok.body.enabled).toBe(false);

      const foreignPatch = await request(app(memberBoardActor(otherCompany))).patch(`/api/execution-profiles/${a.profiles.astra}`).send({ expectedVersion: 2, enabled: true });
      expect(foreignPatch.status).toBe(403);
    });

    it("rejects same-family or self reviewers on rule writes and seeds the matrix from explicit bindings", async () => {
      const a = await seedCompany();
      const board = request(app(boardActor(a.companyId)));
      const sameFamily = await board.put(`/api/companies/${a.companyId}/route-rules`).send({
        taskClass: "feature_standard", workerProfileId: a.profiles.fable51, advisorProfileId: null, advisorMode: "none",
        reviewerProfileId: a.profiles.fable5, reviewerFallbackProfileId: null, reviewRequirement: "always", reviewerFallbackPolicy: "fail_closed",
        rescueProfileId: a.profiles.astra, maxAttempts: 2, maxWallClockMinutes: 120, maxCostCents: null,
      });
      expect(sameFamily.status).toBe(422);
      expect(sameFamily.body.details.code).toBe("reviewer-family-conflict");

      const seeded = await seedDefaults(a.companyId, a.bindings);
      expect(seeded.rules.map((rule: { taskClass: string }) => rule.taskClass).sort()).toEqual(
        ["bug_fast", "bug_invariant", "feature_critical", "feature_standard", "migration", "security_recovery"],
      );
      expect(seeded.unresolvedTaskClasses).toEqual(["mechanical"]);
      const migration = seeded.rules.find((rule: { taskClass: string }) => rule.taskClass === "migration");
      expect(migration.reviewerFallbackPolicy).toBe("fail_closed");
      expect(migration.reviewerProfileId).toBe(a.profiles.astra);

      // Seeding again never overwrites operator-tuned rules.
      const tuned = await board.put(`/api/companies/${a.companyId}/route-rules`).send({ ...migration, expectedVersion: migration.version, maxAttempts: 5, id: undefined, companyId: undefined, version: undefined, createdAt: undefined, updatedAt: undefined });
      expect(tuned.status).toBe(200);
      const reseeded = await seedDefaults(a.companyId, a.bindings);
      expect(reseeded.rules.find((rule: { taskClass: string }) => rule.taskClass === "migration").maxAttempts).toBe(5);
    });
  });

  describe("route decisions", () => {
    it("creates an immutable routed decision, preserves it across ordinary retries, and audits it", async () => {
      const a = await seedCompany();
      await seedDefaults(a.companyId, a.bindings);
      const issueId = await seedIssue(a.companyId);
      const agent = request(app(agentActor(a.companyId, a.agents.fable5Agent)));

      const first = await agent.post(`/api/issues/${issueId}/routing/route`).send({ facts: featureFacts });
      expect(first.status).toBe(201);
      expect(first.body.state).toBe("routed");
      expect(first.body.revision).toBe(1);
      expect(first.body.worker.profileId).toBe(a.profiles.fable51);
      expect(first.body.worker.providerFamily).toBe("anthropic");
      expect(first.body.reviewer.providerFamily).toBe("openai");
      expect(first.body.policyVersion).toBe("routing-policy/v1");

      const retry = await agent.post(`/api/issues/${issueId}/routing/route`).send({ facts: { ...featureFacts, taskClass: "bug_fast" } });
      expect(retry.status).toBe(200);
      expect(retry.body.id).toBe(first.body.id);

      const rows = await db.select().from(routeDecisions).where(eq(routeDecisions.issueId, issueId));
      expect(rows).toHaveLength(1);
      const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "route_decision.created")));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details).toMatchObject({ decisionId: first.body.id, workerProviderFamily: "anthropic", reviewerProviderFamily: "openai" });
      expect(JSON.stringify(audit[0]!.details)).not.toContain("adapterConfig");

      const foreign = await request(app(memberBoardActor(randomUUID()))).get(`/api/issues/${issueId}/routing`);
      expect(foreign.status).toBe(403);
    });

    it("persists typed refusals for invalid facts instead of a cheap default", async () => {
      const a = await seedCompany();
      await seedDefaults(a.companyId, a.bindings);
      const issueId = await seedIssue(a.companyId);
      const res = await request(app(boardActor(a.companyId))).post(`/api/issues/${issueId}/routing/route`).send({ facts: { ...featureFacts, taskClass: "mechanical", acceptanceDefined: false } });
      expect(res.status).toBe(201);
      expect(res.body.state).toBe("classification-required");
      expect(res.body.worker).toBeNull();
      const dispatch = await request(app(boardActor(a.companyId))).post(`/api/issues/${issueId}/routing/dispatch`);
      expect(dispatch.status).toBe(409);
      expect(dispatch.body.details.code).toBe("classification-required");
    });

    it("dispatches through the scheduler seam with the decision in run context and refuses a second live attempt", async () => {
      const a = await seedCompany();
      await seedDefaults(a.companyId, a.bindings);
      const issueId = await seedIssue(a.companyId);
      const board = request(app(boardActor(a.companyId)));
      await board.post(`/api/issues/${issueId}/routing/route`).send({ facts: featureFacts });

      const denied = await request(app(agentActor(a.companyId, a.agents.fable5Agent))).post(`/api/issues/${issueId}/routing/dispatch`);
      expect(denied.status).toBe(403);

      const res = await board.post(`/api/issues/${issueId}/routing/dispatch`);
      expect(res.status).toBe(200);
      expect(res.body.dispatched).toBe(true);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.agentId).toBe(a.agents.fable51Agent);
      expect(wakes[0]!.opts.contextSnapshot).toMatchObject({ issueId, routeDecisionId: res.body.decision.id, executionProfileId: a.profiles.fable51, routeRole: "worker" });
      expect(wakes[0]!.opts.issueStateGuard?.assigneeAgentId).toBe(a.agents.fable51Agent);

      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.assigneeAgentId).toBe(a.agents.fable51Agent);
      const claims = await db.select().from(routePoolClaims).where(and(eq(routePoolClaims.issueId, issueId), isNull(routePoolClaims.releasedAt)));
      expect(claims).toHaveLength(1);
      expect(claims[0]!.runId).toBe(res.body.runId);
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, res.body.runId));
      expect(events.map((event) => event.eventType)).toEqual(["route.decision"]);
      expect(events[0]!.payload).toMatchObject({ decisionId: res.body.decision.id, role: "worker" });

      await db.update(issues).set({ executionRunId: res.body.runId }).where(eq(issues.id, issueId));
      const again = await board.post(`/api/issues/${issueId}/routing/dispatch`);
      expect(again.status).toBe(409);
      expect(again.body.details.code).toBe("attempt_active");

      // A profile edit after routing cannot silently change what runs.
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, res.body.runId));
      await db.update(agents).set({ adapterConfig: { model: "claude-opus-5" } }).where(eq(agents.id, a.agents.fable51Agent));
      const drifted = await board.post(`/api/issues/${issueId}/routing/dispatch`);
      expect(drifted.status).toBe(409);
      expect(drifted.body.details.code).toBe("execution_profile_model_drift");
    });

    it("releases the slot and records the refusal when the scheduler rejects the wake", async () => {
      const a = await seedCompany();
      await seedDefaults(a.companyId, a.bindings);
      const issueId = await seedIssue(a.companyId);
      const board = request(app(boardActor(a.companyId)));
      await board.post(`/api/issues/${issueId}/routing/route`).send({ facts: featureFacts });
      rejectWakes = true;
      const res = await board.post(`/api/issues/${issueId}/routing/dispatch`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ dispatched: false, reason: "wake_rejected" });
      const active = await db.select().from(routePoolClaims).where(isNull(routePoolClaims.releasedAt));
      expect(active).toHaveLength(0);
    });

    it("never double-dispatches one worker slot under concurrent claims", async () => {
      const a = await seedCompany();
      await seedDefaults(a.companyId, a.bindings);
      const svc = routingService(db, { enqueueWakeup });
      const issueA = await seedIssue(a.companyId);
      const issueB = await seedIssue(a.companyId);
      const issueC = await seedIssue(a.companyId);
      const decisionA = await db.insert(routeDecisions).values(decisionRow(a.companyId, issueA, a)).returning().then((rows) => rows[0]!);
      const decisionB = await db.insert(routeDecisions).values(decisionRow(a.companyId, issueB, a)).returning().then((rows) => rows[0]!);
      const decisionC = await db.insert(routeDecisions).values(decisionRow(a.companyId, issueC, a)).returning().then((rows) => rows[0]!);
      const results = await Promise.allSettled([
        svc.claimSlot({ companyId: a.companyId, profileId: a.profiles.astra, decisionId: decisionA.id, issueId: issueA, role: "worker" }),
        svc.claimSlot({ companyId: a.companyId, profileId: a.profiles.astra, decisionId: decisionB.id, issueId: issueB, role: "worker" }),
        svc.claimSlot({ companyId: a.companyId, profileId: a.profiles.astra, decisionId: decisionC.id, issueId: issueC, role: "worker" }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(2);
      for (const failure of rejected) expect(failure.reason.details.code).toBe("pool_capacity_exhausted");
      const active = await db.select().from(routePoolClaims).where(and(eq(routePoolClaims.profileId, a.profiles.astra), isNull(routePoolClaims.releasedAt)));
      expect(active).toHaveLength(1);
    });
  });

  function decisionRow(companyId: string, issueId: string, a: Awaited<ReturnType<typeof seedCompany>>) {
    return {
      companyId, issueId, revision: 1, revisionKind: "initial", policyVersion: "routing-policy/v1", taskClass: "bug_invariant", effectiveTaskClass: "bug_invariant", state: "routed",
      workerProfileId: a.profiles.astra, workerAgentId: a.agents.astraAgent, workerProviderFamily: "openai", workerModel: "gpt-6-astra", workerEffort: "low",
      maxAttempts: 2, maxWallClockMinutes: 120, createdByType: "system",
    } as const;
  }

  describe("override, rescue, and review", () => {
    it("fences overrides by expected revision, rejects invariant violations, and retains lineage", async () => {
      const a = await seedCompany();
      await seedDefaults(a.companyId, a.bindings);
      const issueId = await seedIssue(a.companyId);
      const board = request(app(boardActor(a.companyId)));
      const initial = (await board.post(`/api/issues/${issueId}/routing/route`).send({ facts: featureFacts })).body;

      const agentOverride = await request(app(agentActor(a.companyId, a.agents.fable5Agent))).post(`/api/issues/${issueId}/routing/override`).send({ expectedRevision: 1, reviewerProfileId: a.profiles.sol, note: "agent" });
      expect(agentOverride.status).toBe(403);

      const stale = await board.post(`/api/issues/${issueId}/routing/override`).send({ expectedRevision: 3, reviewerProfileId: a.profiles.sol, note: "stale" });
      expect(stale.status).toBe(409);
      expect(stale.body.details).toMatchObject({ code: "route_revision_conflict", currentRevision: 1 });

      const sameFamily = await board.post(`/api/issues/${issueId}/routing/override`).send({ expectedRevision: 1, reviewerProfileId: a.profiles.fable5, note: "same family" });
      expect(sameFamily.status).toBe(422);
      expect(sameFamily.body.details.code).toBe("reviewer-family-conflict");

      const waiver = await board.post(`/api/issues/${issueId}/routing/override`).send({ expectedRevision: 1, requireCrossFamilyReview: false, note: "waive" });
      expect(waiver.status).toBe(201);
      expect(waiver.body.requireCrossFamilyReview).toBe(true);

      const ok = await board.post(`/api/issues/${issueId}/routing/override`).send({ expectedRevision: 2, reviewerProfileId: a.profiles.sol, note: "prefer Sol; token Bearer abcdef0123456789abcdef" });
      expect(ok.status).toBe(201);
      expect(ok.body.revision).toBe(3);
      expect(ok.body.revisionKind).toBe("override");
      expect(ok.body.supersedesDecisionId).toBe(waiver.body.id);
      expect(ok.body.reviewer.profileId).toBe(a.profiles.sol);
      expect(ok.body.note).not.toContain("abcdef0123456789abcdef");

      const routing = (await board.get(`/api/issues/${issueId}/routing`)).body;
      expect(routing.current.id).toBe(ok.body.id);
      expect(routing.history.map((decision: { revision: number }) => decision.revision)).toEqual([3, 2, 1]);
      expect(routing.history[2].id).toBe(initial.id);
      const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "route_decision.overridden")));
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit.map((row) => row.details))).not.toContain("abcdef0123456789abcdef");
    });

    it("rescues with an opposite-family worker, recomputes the reviewer, and then requires a human", async () => {
      const a = await seedCompany();
      await seedDefaults(a.companyId, a.bindings);
      const issueId = await seedIssue(a.companyId);
      const board = request(app(boardActor(a.companyId)));
      await board.post(`/api/issues/${issueId}/routing/route`).send({ facts: featureFacts });
      const dispatched = await board.post(`/api/issues/${issueId}/routing/dispatch`);
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, dispatched.body.runId));

      const rescue = await board.post(`/api/issues/${issueId}/routing/rescue`).send({ reason: "repeated-failure-fingerprint" });
      expect(rescue.status).toBe(201);
      expect(rescue.body.decision.revisionKind).toBe("rescue");
      expect(rescue.body.decision.worker.providerFamily).toBe("openai");
      expect(rescue.body.decision.worker.agentId).toBe(a.agents.astraAgent);
      expect(rescue.body.decision.reviewer.providerFamily).toBe("anthropic");
      expect(rescue.body.decision.reviewer.agentId).not.toBe(a.agents.fable51Agent);
      expect(rescue.body.dispatch.dispatched).toBe(true);
      expect(wakes.at(-1)!.agentId).toBe(a.agents.astraAgent);
      expect(wakes.at(-1)!.opts.contextSnapshot).toMatchObject({ routeRole: "rescuer" });
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.assigneeAgentId).toBe(a.agents.astraAgent);
      expect(issue.status).not.toBe("done");

      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, rescue.body.dispatch.runId));
      const second = await board.post(`/api/issues/${issueId}/routing/rescue`).send({ reason: "dirty-terminal-attempt" });
      expect(second.status).toBe(201);
      expect(second.body.decision.state).toBe("escalation-required");
      expect(second.body.dispatch).toBeNull();
      const parked = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(parked.status).toBe("blocked");
      expect(parked.unblockDescriptor).toMatchObject({ owner: "board" });
    });

    it("creates one independent opposite-family review task and blocks the parent on it", async () => {
      const a = await seedCompany();
      await seedDefaults(a.companyId, a.bindings);
      const issueId = await seedIssue(a.companyId, { status: "in_review", assigneeAgentId: a.agents.fable51Agent });
      const board = request(app(boardActor(a.companyId)));
      await board.post(`/api/issues/${issueId}/routing/route`).send({ facts: featureFacts });

      const res = await request(app(agentActor(a.companyId, a.agents.fable51Agent))).post(`/api/issues/${issueId}/routing/review-request`);
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("requested");
      expect(res.body.reviewer.agentId).toBe(a.agents.astraAgent);
      const review = await db.select().from(issues).where(eq(issues.id, res.body.reviewIssueId)).then((rows) => rows[0]!);
      expect(review.originKind).toBe("route_review");
      expect(review.parentId).toBe(issueId);
      expect(review.assigneeAgentId).toBe(a.agents.astraAgent);
      expect(review.description).toContain("Do not comment on, edit, or change the status of the parent task");
      const blocker = await db.select().from(issueRelations).where(eq(issueRelations.issueId, review.id));
      expect(blocker.some((relation) => relation.relatedIssueId === issueId && relation.type === "blocks")).toBe(true);
      expect(wakes.at(-1)!.agentId).toBe(a.agents.astraAgent);
      expect(wakes.at(-1)!.opts.contextSnapshot).toMatchObject({ routeRole: "reviewer", reviewedIssueId: issueId });

      const again = await board.post(`/api/issues/${issueId}/routing/review-request`);
      expect(again.body).toMatchObject({ state: "requested", reviewIssueId: review.id, created: false });
      const parent = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(parent.status).toBe("in_review");
    });

    it("fails closed on high-risk work when no opposite-family reviewer is available", async () => {
      const a = await seedCompany();
      await seedDefaults(a.companyId, a.bindings);
      const issueId = await seedIssue(a.companyId, { status: "in_review", assigneeAgentId: a.agents.fable51Agent });
      const board = request(app(boardActor(a.companyId)));
      const routed = await board.post(`/api/issues/${issueId}/routing/route`).send({ facts: { ...featureFacts, taskClass: "migration", riskFlags: ["persistence"], affectedLayers: ["db", "shared", "server"] } });
      expect(routed.body.reviewer.agentId).toBe(a.agents.astraAgent);
      expect(routed.body.reviewerFallback).toBeNull();

      await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, a.agents.astraAgent));
      const res = await board.post(`/api/issues/${issueId}/routing/review-request`);
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("reviewer-unavailable");
      expect(res.body.blocked).toBe(true);
      const parent = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(parent.status).toBe("blocked");
      expect(parent.unblockDescriptor).toMatchObject({ owner: "board" });
      const reviews = await db.select().from(issues).where(eq(issues.originKind, "route_review"));
      expect(reviews).toHaveLength(0);
      // The worker's own family is never substituted, and the worker never reviews itself.
      const decisions = await db.select().from(routeDecisions).where(eq(routeDecisions.issueId, issueId));
      expect(decisions.every((row) => row.reviewerAgentId !== row.workerAgentId)).toBe(true);
    });
  });
});
