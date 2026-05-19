import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  projects,
  routineRuns,
  routines,
  routineTriggers,
  standupParticipants,
  standupPolicies,
  standupSessions,
} from "@paperclipai/db";
import {
  PAPERCLIP_SESSION_SCHEMA_VERSION,
  type PaperclipSessionActor,
  type PaperclipSessionDocument,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { routineService } from "../services/routines.js";
import { sessionService } from "../services/sessions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres session integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Paperclip session service integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const freshSourceCollectedAt = new Date().toISOString();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sessions-integration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueDocuments);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const managerAgentId = randomUUID();
    const participantAgentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "CAR",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerAgentId,
        companyId,
        name: "COO",
        role: "coo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: participantAgentId,
        companyId,
        name: "CRO",
        role: "cro",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "CAR operations",
      status: "in_progress",
    });

    const issueSvc = issueService(db);
    const sessionIssue = await issueSvc.create(companyId, {
      projectId,
      title: "CAR EOD session",
      description: "Inspect the day and force owner-bound follow-up.",
      status: "todo",
      priority: "high",
      assigneeAgentId: managerAgentId,
      originKind: "session_manual",
      originId: "car-eod",
    });

    return { companyId, managerAgentId, participantAgentId, projectId, sessionIssue };
  }

  function serviceActor(agentId: string, runId: string = randomUUID()): PaperclipSessionActor {
    return {
      actorType: "service",
      actorId: "test-session-service",
      agentId,
      runId,
    };
  }

  function boardActor(): PaperclipSessionActor {
    return {
      actorType: "board",
      actorId: "local-board",
      agentId: null,
      userId: "local-board",
      runId: null,
    };
  }

  function makeSession(input: {
    companyId: string;
    issueId: string;
    participantAgentId: string;
    actor: PaperclipSessionActor;
    sessionType?: PaperclipSessionDocument["sessionType"];
    state?: PaperclipSessionDocument["state"];
    stateRevision?: number;
    beforeState?: PaperclipSessionDocument["state"] | null;
    source?: PaperclipSessionDocument["source"];
  }): PaperclipSessionDocument {
    const state = input.state ?? "open";
    const now = freshSourceCollectedAt;
    return {
      schemaVersion: PAPERCLIP_SESSION_SCHEMA_VERSION,
      policyKey: "car-leadership-sessions",
      policyVersion: "2026-05-18",
      companyId: input.companyId,
      issueId: input.issueId,
      sessionType: input.sessionType ?? "eod",
      state,
      stateRevision: input.stateRevision ?? 0,
      idempotencyKey: `session:${input.issueId}:${input.stateRevision ?? 0}`,
      objective: "Turn one material CAR finding into an owner-bound next action.",
      source: {
        triggerClass: "eod_material_finding",
        source: "test",
        collectedAt: now,
        snapshot: { issueIdentifier: "CAR-1095" },
        ...input.source,
      },
      participants: [
        {
          role: "CRO",
          agentId: input.participantAgentId,
          issueId: null,
          status: "pending",
        },
      ],
      receipts: [],
      taskRoutes: [],
      reviews: [],
      eodFindings: [],
      health: [],
      lastTransition: {
        transitionId: randomUUID(),
        transition: input.stateRevision ? "challenge" : "create",
        actor: input.actor,
        beforeState: input.beforeState ?? null,
        afterState: state,
        at: now,
      },
    };
  }

  async function createOpenSession(
    fixture: Awaited<ReturnType<typeof seedFixture>>,
    overrides: Pick<Parameters<typeof makeSession>[0], "source"> = {},
  ) {
    const actor = boardActor();
    const svc = sessionService(db);
    return svc.transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: null,
      expectedState: null,
      transition: "create",
      nextState: makeSession({
        companyId: fixture.companyId,
        issueId: fixture.sessionIssue.id,
        participantAgentId: fixture.participantAgentId,
        actor,
        ...overrides,
      }),
      actor,
      idempotencyKey: `session:${fixture.sessionIssue.id}:0`,
    });
  }

  async function addMaterialFinding(
    fixture: Awaited<ReturnType<typeof seedFixture>>,
    created: Awaited<ReturnType<ReturnType<typeof sessionService>["transition"]>>,
    findingId = "CAR-1095",
  ) {
    const actor = boardActor();
    const next: PaperclipSessionDocument = JSON.parse(JSON.stringify(created.session));
    next.state = "reviewing";
    next.stateRevision += 1;
    next.idempotencyKey = `finding:${findingId}`;
    next.lastTransition = {
      transitionId: randomUUID(),
      transition: "challenge",
      actor,
      beforeState: created.session.state,
      afterState: "reviewing",
      at: "2026-05-18T19:05:00.000Z",
    };
    next.eodFindings = [
      {
        findingId,
        summary: "CAR paper work has no owner-bound next action.",
        disposition: "task",
        ownerRole: "CRO",
        reason: "material paper-work finding requires direct ownership",
      },
    ];
    return sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: created.session.state,
      transition: "challenge",
      nextState: next,
      actor,
      idempotencyKey: next.idempotencyKey,
    });
  }

  it("creates participant-visible assigned obligations and exposes them in inspect", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);

    expect(created.session.participants[0]?.issueId).toBeTruthy();
    expect(created.participantIssues).toHaveLength(1);
    expect(created.participantIssues[0]?.assigneeAgentId).toBe(fixture.participantAgentId);

    const obligation = await db
      .select()
      .from(issues)
      .where(eq(issues.id, created.session.participants[0]!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(obligation?.originKind).toBe("session_participant_obligation");
    expect(obligation?.parentId).toBe(fixture.sessionIssue.id);
  });

  it("replays idempotent session transitions without writing a new revision", async () => {
    const fixture = await seedFixture();
    const actor = boardActor();
    const svc = sessionService(db);
    const input = {
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: null,
      expectedState: null,
      transition: "create" as const,
      nextState: makeSession({
        companyId: fixture.companyId,
        issueId: fixture.sessionIssue.id,
        participantAgentId: fixture.participantAgentId,
        actor,
      }),
      actor,
      idempotencyKey: `session:${fixture.sessionIssue.id}:0`,
    };

    const created = await svc.transition(input);
    const replayed = await svc.transition(input);

    expect(replayed.replayed).toBe(true);
    expect(replayed.document.latestRevisionId).toBe(created.document.latestRevisionId);
    expect(replayed.session.stateRevision).toBe(created.session.stateRevision);

    const nextWaiting = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      state: "waiting_response",
      stateRevision: 1,
      beforeState: "open",
    });
    nextWaiting.idempotencyKey = "request-response";
    nextWaiting.lastTransition.transition = "request_response";

    await expect(svc.transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: randomUUID(),
      expectedState: "open",
      transition: "request_response",
      nextState: nextWaiting,
      actor,
      idempotencyKey: nextWaiting.idempotencyKey,
    })).rejects.toMatchObject({ status: 409 });

    await expect(svc.transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "completed",
      transition: "request_response",
      nextState: nextWaiting,
      actor,
      idempotencyKey: nextWaiting.idempotencyKey,
    })).rejects.toMatchObject({ status: 409 });

    await expect(svc.transition({
      ...input,
      actor: { ...actor, actorId: "other-board", userId: "other-board" },
    })).rejects.toMatchObject({ status: 409 });

    await expect(svc.transition({
      ...input,
      nextState: { ...input.nextState, objective: "Forge a different objective under the same idempotency key." },
    })).rejects.toMatchObject({ status: 409 });
  });

  it("updates participant response state through the server-owned session document", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);
    const responseActor: PaperclipSessionActor = {
      actorType: "agent",
      actorId: fixture.participantAgentId,
      agentId: fixture.participantAgentId,
      runId: randomUUID(),
    };

    const responded = await sessionService(db).respond({
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      expectedRevisionId: created.document.latestRevisionId!,
      response: { responseId: "cro-response-1", proof: "reviewed CAR-1095" },
      actor: responseActor,
    });

    expect(responded.session.state).toBe("reviewing");
    expect(responded.session.participants[0]?.status).toBe("responded");
    expect(responded.session.participants[0]?.responseId).toBe("cro-response-1");
  });

  it("rejects review decisions without qualified challenge and EOD duplicate dispositions", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);
    const actor = boardActor();
    const passiveReview = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      sessionType: "review",
      state: "accepted",
      stateRevision: 1,
      beforeState: "open",
    });
    passiveReview.idempotencyKey = "passive-review";
    passiveReview.lastTransition.transition = "accept";
    passiveReview.reviews = [{ domain: "research", disposition: "accepted", downstreamOwnerRole: "CRO" }];

    await expect(sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "open",
      transition: "accept",
      nextState: passiveReview,
      actor,
      idempotencyKey: "passive-review",
    })).rejects.toMatchObject({ status: 422 });

    const sourceRefresh = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      state: "reviewing",
      stateRevision: 1,
      beforeState: "open",
    });
    sourceRefresh.idempotencyKey = "source-refresh";
    sourceRefresh.source = { ...created.session.source, freshnessSeconds: 0 };
    sourceRefresh.eodFindings = [{
      findingId: "CAR-1095",
      summary: "Try to refresh source freshness during the decision transition.",
      disposition: "task",
      ownerRole: "CRO",
      reason: "source freshness cannot be rewritten by the decision request",
    }];

    await expect(sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "open",
      transition: "challenge",
      nextState: sourceRefresh,
      actor,
      idempotencyKey: "source-refresh",
    })).rejects.toMatchObject({ status: 409 });

    const staleFixture = await seedFixture();
    const staleCreated = await createOpenSession(staleFixture, { source: { freshnessSeconds: 172_800 } });
    const staleReview = makeSession({
      companyId: staleFixture.companyId,
      issueId: staleFixture.sessionIssue.id,
      participantAgentId: staleFixture.participantAgentId,
      actor,
      sessionType: "review",
      state: "accepted",
      stateRevision: 1,
      beforeState: "open",
      source: staleCreated.session.source,
    });
    staleReview.idempotencyKey = "stale-review";
    staleReview.lastTransition.transition = "accept";
    staleReview.reviews = [{
      domain: "research",
      challenge: "Qualified challenge exists, but the source freshness is stale.",
      disposition: "accepted",
      downstreamOwnerRole: "CRO",
    }];

    await expect(sessionService(db).transition({
      issueId: staleFixture.sessionIssue.id,
      expectedRevisionId: staleCreated.document.latestRevisionId,
      expectedState: "open",
      transition: "accept",
      nextState: staleReview,
      actor,
      idempotencyKey: "stale-review",
    })).rejects.toMatchObject({ status: 422 });

    const staleCollectedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const staleCollectedAtFixture = await seedFixture();
    const staleCollectedAtCreated = await createOpenSession(staleCollectedAtFixture, {
      source: { collectedAt: staleCollectedAt, freshnessSeconds: 0 },
    });
    const staleCollectedAtReview = makeSession({
      companyId: staleCollectedAtFixture.companyId,
      issueId: staleCollectedAtFixture.sessionIssue.id,
      participantAgentId: staleCollectedAtFixture.participantAgentId,
      actor,
      sessionType: "review",
      state: "accepted",
      stateRevision: 1,
      beforeState: "open",
      source: staleCollectedAtCreated.session.source,
    });
    staleCollectedAtReview.idempotencyKey = "stale-collected-at-review";
    staleCollectedAtReview.lastTransition.transition = "accept";
    staleCollectedAtReview.reviews = [{
      domain: "research",
      challenge: "Qualified challenge exists, but collectedAt proves the source is stale.",
      disposition: "accepted",
      downstreamOwnerRole: "CRO",
    }];

    await expect(sessionService(db).transition({
      issueId: staleCollectedAtFixture.sessionIssue.id,
      expectedRevisionId: staleCollectedAtCreated.document.latestRevisionId,
      expectedState: "open",
      transition: "accept",
      nextState: staleCollectedAtReview,
      actor,
      idempotencyKey: "stale-collected-at-review",
    })).rejects.toMatchObject({ status: 422 });

    const missingReviewOwner = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      sessionType: "review",
      state: "accepted",
      stateRevision: 1,
      beforeState: "open",
    });
    missingReviewOwner.idempotencyKey = "missing-review-owner";
    missingReviewOwner.lastTransition.transition = "accept";
    missingReviewOwner.reviews = [{
      domain: "research",
      challenge: "Qualified challenge exists, but no one owns the accepted result.",
      disposition: "accepted",
    }];

    await expect(sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "open",
      transition: "accept",
      nextState: missingReviewOwner,
      actor,
      idempotencyKey: "missing-review-owner",
    })).rejects.toMatchObject({ status: 422 });

    const summaryOnlyEod = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      state: "accepted",
      stateRevision: 1,
      beforeState: "open",
    });
    summaryOnlyEod.idempotencyKey = "summary-only-eod";
    summaryOnlyEod.lastTransition.transition = "accept";

    await expect(sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "open",
      transition: "accept",
      nextState: summaryOnlyEod,
      actor,
      idempotencyKey: "summary-only-eod",
    })).rejects.toMatchObject({ status: 422 });

    const acceptedRiskWithoutReason = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      state: "accepted",
      stateRevision: 1,
      beforeState: "open",
    });
    acceptedRiskWithoutReason.idempotencyKey = "accepted-risk-no-reason";
    acceptedRiskWithoutReason.lastTransition.transition = "accept";
    acceptedRiskWithoutReason.eodFindings = [{
      findingId: "CAR-1096",
      summary: "Known risk was accepted without an explanation.",
      disposition: "accepted_risk",
      reason: "",
    }];

    await expect(sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "open",
      transition: "accept",
      nextState: acceptedRiskWithoutReason,
      actor,
      idempotencyKey: "accepted-risk-no-reason",
    })).rejects.toMatchObject({ status: 422 });

    const missingOwnerAction = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      state: "accepted",
      stateRevision: 1,
      beforeState: "open",
    });
    missingOwnerAction.idempotencyKey = "missing-owner-action";
    missingOwnerAction.lastTransition.transition = "accept";
    missingOwnerAction.eodFindings = [{
      findingId: "CAR-1097",
      summary: "Material paper work needs a task.",
      disposition: "task",
      ownerRole: "CRO",
      reason: "Material finding needs owner-bound action.",
    }];

    await expect(sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "open",
      transition: "accept",
      nextState: missingOwnerAction,
      actor,
      idempotencyKey: "missing-owner-action",
    })).rejects.toMatchObject({ status: 422 });

    const duplicateEod = makeSession({
      companyId: fixture.companyId,
      issueId: fixture.sessionIssue.id,
      participantAgentId: fixture.participantAgentId,
      actor,
      state: "reviewing",
      stateRevision: 1,
      beforeState: "open",
    });
    duplicateEod.idempotencyKey = "duplicate-eod";
    duplicateEod.lastTransition.transition = "challenge";
    duplicateEod.eodFindings = [
      { findingId: "CAR-1095", summary: "halted", disposition: "task", ownerRole: "CRO", reason: "needs owner" },
      { findingId: "CAR-1095", summary: "halted again", disposition: "no_op", reason: "duplicate" },
    ];

    await expect(sessionService(db).transition({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: created.document.latestRevisionId,
      expectedState: "open",
      transition: "challenge",
      nextState: duplicateEod,
      actor,
      idempotencyKey: "duplicate-eod",
    })).rejects.toMatchObject({ status: 422 });
  });

  it("records service task routes and failed revoked-router receipts without broad mutation", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);
    const withFinding = await addMaterialFinding(fixture, created);
    await routineService(db, {
      heartbeat: {
        wakeup: async () => null,
      },
    }).create(fixture.companyId, {
      projectId: fixture.projectId,
      title: "CAR linked EOD route authority",
      assigneeAgentId: fixture.managerAgentId,
      linkedSessionPolicy: {
        policyKey: "car-leadership-sessions",
        policyVersion: "2026-05-18",
        sessionType: "eod",
        objective: "Turn the day review into owner-bound work.",
        participants: [{ role: "CRO", agentId: fixture.participantAgentId }],
      },
    }, {});
    const validServiceRunId = randomUUID();
    const timedOutServiceRunId = randomUUID();
    const revokedServiceRunId = randomUUID();
    const wrongCompanyId = randomUUID();
    const wrongCompanyAgentId = randomUUID();
    const wrongCompanyServiceRunId = randomUUID();
    const wrongPolicyServiceRunId = randomUUID();
    const wrongSessionTypeServiceRunId = randomUUID();
    const killSwitchServiceRunId = randomUUID();
    await db.insert(companies).values({
      id: wrongCompanyId,
      name: "Other company",
      issuePrefix: `O${wrongCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: wrongCompanyAgentId,
      companyId: wrongCompanyId,
      name: "Other router",
      role: "router",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: validServiceRunId,
        companyId: fixture.companyId,
        agentId: fixture.managerAgentId,
        invocationSource: "routine_session",
        status: "completed",
        contextSnapshot: {
          policyKey: "car-leadership-sessions",
          allowedSessionTypes: ["eod"],
          routerRevoked: false,
        },
      },
      {
        id: timedOutServiceRunId,
        companyId: fixture.companyId,
        agentId: fixture.managerAgentId,
        invocationSource: "routine_session",
        status: "timed_out",
        contextSnapshot: {
          policyKey: "car-leadership-sessions",
          allowedSessionTypes: ["eod"],
        },
      },
      {
        id: revokedServiceRunId,
        companyId: fixture.companyId,
        agentId: fixture.managerAgentId,
        invocationSource: "routine_session",
        status: "completed",
        contextSnapshot: {
          policyKey: "car-leadership-sessions",
          allowedSessionTypes: ["eod"],
          routerRevoked: true,
        },
      },
      {
        id: wrongCompanyServiceRunId,
        companyId: wrongCompanyId,
        agentId: wrongCompanyAgentId,
        invocationSource: "routine_session",
        status: "completed",
        contextSnapshot: {
          policyKey: "car-leadership-sessions",
          allowedSessionTypes: ["eod"],
        },
      },
      {
        id: wrongPolicyServiceRunId,
        companyId: fixture.companyId,
        agentId: fixture.managerAgentId,
        invocationSource: "routine_session",
        status: "completed",
        contextSnapshot: {
          policyKey: "other-policy",
          allowedSessionTypes: ["eod"],
        },
      },
      {
        id: wrongSessionTypeServiceRunId,
        companyId: fixture.companyId,
        agentId: fixture.managerAgentId,
        invocationSource: "routine_session",
        status: "completed",
        contextSnapshot: {
          policyKey: "car-leadership-sessions",
          allowedSessionTypes: ["review"],
        },
      },
      {
        id: killSwitchServiceRunId,
        companyId: fixture.companyId,
        agentId: fixture.managerAgentId,
        invocationSource: "routine_session",
        status: "completed",
        contextSnapshot: {
          policyKey: "car-leadership-sessions",
          allowedSessionTypes: ["eod"],
          routerKillSwitch: true,
        },
      },
    ]);

    const direct = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: withFinding.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate CAR-1095",
      description: "Create the next paper-work action for CAR-1095.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      actor: boardActor(),
    });
    expect(direct.route.authorityPath).toBe("direct");
    expect(direct.route.createdIssueId).toBeTruthy();
    expect(
      direct.session.eodFindings.find((finding) => finding.findingId === "CAR-1095")?.taskRouteId,
    ).toBe(direct.route.routeId);

    const fallback = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: direct.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate CAR-1095 through fallback",
      description: "Create the next paper-work action through the participant role fallback.",
      priority: "high",
      actor: boardActor(),
    });
    expect(fallback.route.authorityPath).toBe("multi_actor_fallback");
    expect(fallback.route.createdIssueId).toBeTruthy();

    const routed = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: fallback.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate CAR-1095 through service",
      description: "Create the next paper-work action for CAR-1095 through service authority.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: validServiceRunId,
      actor: serviceActor(fixture.managerAgentId, validServiceRunId),
    });
    expect(routed.route.authorityPath).toBe("service");
    expect(routed.route.createdIssueId).toBeTruthy();

    await expect(sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: routed.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Try service run with wrong actor",
      description: "Create the next paper-work action with an actor who does not own the service run.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: validServiceRunId,
      actor: serviceActor(fixture.participantAgentId, validServiceRunId),
    })).rejects.toMatchObject({ status: 403 });

    await expect(sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: routed.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Try arbitrary assignment",
      description: "Create a task for a non-participant assignee.",
      priority: "high",
      assigneeAgentId: fixture.managerAgentId,
      actor: boardActor(),
    })).rejects.toMatchObject({ status: 403 });

    await expect(sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: routed.document.latestRevisionId!,
      sourceFindingId: "invented-finding",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Try invented source",
      description: "Create work without a material session finding.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      actor: boardActor(),
    })).rejects.toMatchObject({ status: 403 });

    await expect(sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: routed.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Service route without a service run",
      description: "A service actor must not route work without service-run authority.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      actor: serviceActor(fixture.managerAgentId),
    })).rejects.toMatchObject({ status: 403 });

    for (const blockedDescription of [
      "Grant permission to mutate another agent.",
      "Move live capital after this review.",
      "Create work in an unrelated project.",
    ]) {
      await expect(sessionService(db).routeTask({
        issueId: fixture.sessionIssue.id,
        expectedRevisionId: routed.document.latestRevisionId!,
        sourceFindingId: "CAR-1095",
        intendedOwnerRole: "CRO",
        targetRole: "CRO",
        title: blockedDescription,
        description: blockedDescription,
        priority: "high",
        assigneeAgentId: fixture.participantAgentId,
        actor: boardActor(),
      })).rejects.toMatchObject({ status: 403 });
    }

    const unavailableRunId = randomUUID();
    const unavailable = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: routed.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate missing-router case",
      description: "Create the next paper-work action after router lookup fails.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: unavailableRunId,
      allowDirectFallback: true,
      actor: serviceActor(fixture.managerAgentId, unavailableRunId),
    });
    expect(unavailable.route.authorityPath).toBe("failed_router");
    expect(unavailable.route.blockedReason).toBe("service_run_not_found");
    expect(unavailable.route.createdIssueId).toBeNull();

    const stale = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: unavailable.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate timed-out-router case",
      description: "Create the next paper-work action after router authority timed out.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: timedOutServiceRunId,
      allowDirectFallback: true,
      actor: serviceActor(fixture.managerAgentId, timedOutServiceRunId),
    });
    expect(stale.route.authorityPath).toBe("failed_router");
    expect(stale.route.blockedReason).toBe("service_run_not_active");
    expect(stale.route.createdIssueId).toBeNull();

    const wrongCompany = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: stale.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate wrong-company router case",
      description: "Create work after a router run from another company is presented.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: wrongCompanyServiceRunId,
      allowDirectFallback: true,
      actor: serviceActor(wrongCompanyAgentId, wrongCompanyServiceRunId),
    });
    expect(wrongCompany.route.authorityPath).toBe("failed_router");
    expect(wrongCompany.route.blockedReason).toBe("service_run_company_mismatch");
    expect(wrongCompany.route.createdIssueId).toBeNull();

    const wrongPolicy = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: wrongCompany.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate wrong-policy router case",
      description: "Create work after a router run scoped to another policy is presented.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: wrongPolicyServiceRunId,
      allowDirectFallback: true,
      actor: serviceActor(fixture.managerAgentId, wrongPolicyServiceRunId),
    });
    expect(wrongPolicy.route.authorityPath).toBe("failed_router");
    expect(wrongPolicy.route.blockedReason).toBe("service_run_policy_mismatch");
    expect(wrongPolicy.route.createdIssueId).toBeNull();

    const wrongSessionType = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: wrongPolicy.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate wrong-session-type router case",
      description: "Create work after a router run scoped to a different session type is presented.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: wrongSessionTypeServiceRunId,
      allowDirectFallback: true,
      actor: serviceActor(fixture.managerAgentId, wrongSessionTypeServiceRunId),
    });
    expect(wrongSessionType.route.authorityPath).toBe("failed_router");
    expect(wrongSessionType.route.blockedReason).toBe("service_run_session_type_mismatch");
    expect(wrongSessionType.route.createdIssueId).toBeNull();

    const killSwitch = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: wrongSessionType.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate kill-switch router case",
      description: "Create work after the router kill switch is active.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: killSwitchServiceRunId,
      allowDirectFallback: true,
      actor: serviceActor(fixture.managerAgentId, killSwitchServiceRunId),
    });
    expect(killSwitch.route.authorityPath).toBe("failed_router");
    expect(killSwitch.route.routerRevoked).toBe(true);
    expect(killSwitch.route.blockedReason).toBe("service_run_router_revoked");
    expect(killSwitch.route.createdIssueId).toBeNull();

    const failed = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: killSwitch.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Investigate revoked-router case",
      description: "Create the next paper-work action after revocation.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: revokedServiceRunId,
      allowDirectFallback: true,
      actor: serviceActor(fixture.managerAgentId, revokedServiceRunId),
    });
    expect(failed.route.authorityPath).toBe("failed_router");
    expect(failed.route.routerRevoked).toBe(true);
    expect(failed.route.createdIssueId).toBeNull();

    const rollback = await sessionService(db).rollbackDisable({
      companyId: fixture.companyId,
      policyKey: "car-leadership-sessions",
      sessionType: "eod",
      triggerClass: "eod_material_finding",
      expectedNoNewSessionProof: "no linked routines remain active",
      actor: boardActor(),
    });
    expect(rollback.disabledRoutineIds).toHaveLength(1);
    expect(rollback.revokedServiceRunIds).toContain(validServiceRunId);

    const afterRollback = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: failed.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Try after rollback",
      description: "Create work after the router has been disabled.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: validServiceRunId,
      allowDirectFallback: true,
      actor: serviceActor(fixture.managerAgentId, validServiceRunId),
    });
    expect(afterRollback.route.authorityPath).toBe("failed_router");
    expect(afterRollback.route.createdIssueId).toBeNull();
    expect(afterRollback.route.blockedReason).toBe("service_run_router_revoked");
    const inspected = await sessionService(db).inspect({ issueId: fixture.sessionIssue.id });
    expect(inspected.taskRoutes.map((route) => route.routeId)).toEqual(expect.arrayContaining([
      direct.route.routeId,
      fallback.route.routeId,
      routed.route.routeId,
      unavailable.route.routeId,
      stale.route.routeId,
      wrongCompany.route.routeId,
      wrongPolicy.route.routeId,
      wrongSessionType.route.routeId,
      killSwitch.route.routeId,
      failed.route.routeId,
      afterRollback.route.routeId,
    ]));
    const failedRoutes = inspected.taskRoutes.filter((route) => route.authorityPath === "failed_router");
    expect(failedRoutes.map((route) => route.blockedReason)).toEqual(expect.arrayContaining([
      "service_run_not_found",
      "service_run_not_active",
      "service_run_company_mismatch",
      "service_run_policy_mismatch",
      "service_run_session_type_mismatch",
      "service_run_router_revoked",
    ]));
    expect(failedRoutes.every((route) => route.createdIssueId === null)).toBe(true);
  });

  it("keeps linked session routines on the session path and preserves normal routine dispatch", async () => {
    const fixture = await seedFixture();
    const svc = routineService(db, {
      heartbeat: {
        wakeup: async () => null,
      },
    });
    const normal = await svc.create(fixture.companyId, {
      projectId: fixture.projectId,
      title: "Normal routine",
      assigneeAgentId: fixture.managerAgentId,
    }, {});
    const linked = await svc.create(fixture.companyId, {
      projectId: fixture.projectId,
      title: "CAR linked EOD",
      assigneeAgentId: fixture.managerAgentId,
      linkedSessionPolicy: {
        policyKey: "car-leadership-sessions",
        policyVersion: "2026-05-18",
        sessionType: "eod",
        objective: "Turn the day review into owner-bound work.",
        participants: [{ role: "CRO", agentId: fixture.participantAgentId }],
      },
    }, {});

    const normalRun = await svc.runRoutine(normal.id, { source: "manual" });
    const linkedRun = await svc.runRoutine(linked.id, { source: "manual", idempotencyKey: "linked-eod-1" });

    expect(normalRun.status).toBe("issue_created");
    expect(linkedRun.status).toBe("issue_created");
    const normalIssue = await db.select().from(issues).where(eq(issues.id, normalRun.linkedIssueId!)).then((rows) => rows[0]);
    const linkedIssue = await db.select().from(issues).where(eq(issues.id, linkedRun.linkedIssueId!)).then((rows) => rows[0]);
    expect(normalIssue?.originKind).toBe("routine_execution");
    expect(linkedIssue?.originKind).toBe("session_routine");

    const inspection = await sessionService(db).inspect({ issueId: linkedRun.linkedIssueId! });
    expect(inspection.session.policyKey).toBe("car-leadership-sessions");
    expect(inspection.participantIssues).toHaveLength(1);

    const scheduledLinked = await svc.create(fixture.companyId, {
      projectId: fixture.projectId,
      title: "CAR linked scheduled EOD",
      assigneeAgentId: fixture.managerAgentId,
      linkedSessionPolicy: {
        policyKey: "car-leadership-sessions",
        policyVersion: "2026-05-18",
        sessionType: "eod",
        objective: "Turn the scheduled day review into owner-bound work.",
        participants: [{ role: "CRO", agentId: fixture.participantAgentId }],
      },
    }, {});
    const { trigger } = await svc.createTrigger(scheduledLinked.id, {
      kind: "schedule",
      label: "EOD",
      cronExpression: "0 22 * * 1-5",
      timezone: "America/Chicago",
    }, {});
    const scheduledFor = new Date("2026-05-18T22:00:00.000Z");
    await db
      .update(routineTriggers)
      .set({ nextRunAt: scheduledFor })
      .where(eq(routineTriggers.id, trigger.id));

    const ticked = await svc.tickScheduledTriggers(new Date("2026-05-18T22:05:00.000Z"));

    expect(ticked.triggered).toBe(1);
    const [scheduledRun] = await svc.listRuns(scheduledLinked.id);
    expect(scheduledRun?.source).toBe("schedule");
    expect(scheduledRun?.status).toBe("issue_created");
    const scheduledInspection = await sessionService(db).inspect({ issueId: scheduledRun!.linkedIssueId! });
    expect(scheduledInspection.session.source.source).toBe("paperclip-routine");
    expect(scheduledInspection.session.source.snapshot).toMatchObject({
      routineId: scheduledLinked.id,
      routineRunId: scheduledRun?.id,
      triggerId: trigger.id,
      triggerSource: "schedule",
    });
  });

  it("provides redacted receipt, rollback-disable, and full R5 trigger framework proof", async () => {
    const fixture = await seedFixture();
    const created = await createOpenSession(fixture);
    const withFinding = await addMaterialFinding(fixture, created);
    const actor = boardActor();
    const redacted = await sessionService(db).redactReceipt({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: withFinding.document.latestRevisionId!,
      actor,
      redaction: {
        auditId: "audit-car-1095",
        managerReceipt: { finding: "CAR-1095", sensitive: "manager-only" },
        participantReceipt: { finding: "CAR-1095", sensitive: "[redacted]" },
        redactedFields: ["sensitive"],
      },
    });
    expect(redacted.receipts.map((receipt) => receipt.visibility).sort()).toEqual([
      "manager_audit",
      "participant_redacted",
    ]);
    const participantReceipt = redacted.receipts.find((receipt) => receipt.visibility === "participant_redacted");
    const managerReceipt = redacted.receipts.find((receipt) => receipt.visibility === "manager_audit");
    expect(participantReceipt?.issueId).toBe(created.participantIssues[0]?.id);
    expect(participantReceipt?.documentId).toBeTruthy();
    expect(managerReceipt?.issueId).toBeNull();
    expect(managerReceipt?.documentId).toBeTruthy();
    const receiptDocumentLinks = await db
      .select({
        issueId: issueDocuments.issueId,
        documentId: issueDocuments.documentId,
        body: documents.latestBody,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(issueDocuments.companyId, fixture.companyId));
    expect(receiptDocumentLinks.some((row) => row.documentId === managerReceipt?.documentId)).toBe(false);
    const participantDocument = receiptDocumentLinks.find((row) => row.documentId === participantReceipt?.documentId);
    expect(participantDocument?.issueId).toBe(participantReceipt?.issueId);
    expect(participantDocument?.body).toContain("[redacted]");
    expect(participantDocument?.body).not.toContain("manager-only");
    const [managerDocument] = await db
      .select({ body: documents.latestBody })
      .from(documents)
      .where(eq(documents.id, managerReceipt!.documentId!));
    expect(managerDocument?.body).toContain("manager-only");
    const missingRouterRunId = randomUUID();
    const failedRoute = await sessionService(db).routeTask({
      issueId: fixture.sessionIssue.id,
      expectedRevisionId: redacted.document.latestRevisionId!,
      sourceFindingId: "CAR-1095",
      intendedOwnerRole: "CRO",
      targetRole: "CRO",
      title: "Route proof after missing router",
      description: "Create a failed-router receipt for R5 detector proof.",
      priority: "high",
      assigneeAgentId: fixture.participantAgentId,
      serviceRunId: missingRouterRunId,
      allowDirectFallback: true,
      actor: serviceActor(fixture.managerAgentId, missingRouterRunId),
    });
    expect(failedRoute.route.authorityPath).toBe("failed_router");
    expect(failedRoute.route.blockedReason).toBe("service_run_not_found");

    const rollback = await sessionService(db).rollbackDisable({
      companyId: fixture.companyId,
      policyKey: "car-leadership-sessions",
      sessionType: "eod",
      triggerClass: "eod_material_finding",
      expectedNoNewSessionProof: "no linked routines remain active",
      actor,
    });
    expect(rollback.futureTriggersDisabled).toBe(true);
    expect(rollback.preservedHistory).toBe(true);

    const standupPolicyId = randomUUID();
    const standupSessionId = randomUUID();
    await db.insert(standupPolicies).values({
      id: standupPolicyId,
      companyId: fixture.companyId,
      policyKey: "daily-leadership-standup",
      title: "Daily leadership standup",
      scheduleCron: "0 14 * * 1-5",
      recoveryByLocalTime: "08:45",
      responseDueLocalTime: "09:15",
      escalationDueLocalTime: "09:45",
      participantAgentIds: [fixture.participantAgentId],
    });
    await db.insert(standupSessions).values({
      id: standupSessionId,
      companyId: fixture.companyId,
      policyId: standupPolicyId,
      localDate: "2026-05-18",
      policyVersion: 1,
      timezone: "UTC",
      status: "waiting_response",
      triggerSource: "manual",
      idempotencyKey: "standup-2026-05-18",
      responseDueAt: new Date("2026-05-18T14:15:00.000Z"),
      escalationDueAt: new Date("2026-05-18T14:45:00.000Z"),
    });
    await db.insert(standupParticipants).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      sessionId: standupSessionId,
      agentId: fixture.participantAgentId,
      roleKey: "CRO",
      responseStatus: "pending",
      responseDueAt: new Date("2026-05-18T14:15:00.000Z"),
      escalationDueAt: new Date("2026-05-18T14:45:00.000Z"),
    });
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "service",
      actorId: "strategy-evaluator",
      action: "strategy.super_pass",
      entityType: "strategy",
      entityId: "strategy-1095",
      details: { eventType: "super_pass", strategy_id: "strategy-1095", score: 3, expected_return: 0.02 },
    });
    const staleIssue = await issueService(db).create(fixture.companyId, {
      projectId: fixture.projectId,
      title: "Directive follow-up has gone stale",
      description: "A normal CAR paper-work issue that should be picked up by the full-work-halt detector.",
      status: "blocked",
      priority: "high",
      assigneeAgentId: fixture.managerAgentId,
      originKind: "manual",
      originId: "stale-directive",
    });
    await db
      .update(issues)
      .set({ updatedAt: new Date("2026-05-18T13:00:00.000Z") })
      .where(eq(issues.id, staleIssue.id));
    await db.insert(issueComments).values([
      {
        companyId: fixture.companyId,
        issueId: staleIssue.id,
        authorAgentId: fixture.managerAgentId,
        body: "directive: follow up on the CAR blocker",
        createdAt: new Date("2026-05-18T13:30:00.000Z"),
      },
      {
        companyId: fixture.companyId,
        issueId: staleIssue.id,
        authorAgentId: fixture.managerAgentId,
        body: "directive: this remains unanswered",
        createdAt: new Date("2026-05-18T13:45:00.000Z"),
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      agentId: fixture.managerAgentId,
      invocationSource: "generator",
      status: "completed",
      contextSnapshot: {
        generatorState: "idle",
        runtimeLane: "paper",
      },
      updatedAt: new Date("2026-05-18T13:50:00.000Z"),
    });
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "service",
      actorId: "runtime-monitor",
      action: "runtime.error",
      entityType: "runtime",
      entityId: "paperclip-runtime",
      details: { status: "failed", runtime_surface: "paperclip", failure_signature: "session-router" },
      createdAt: new Date("2026-05-18T15:00:00.000Z"),
    });
    const reviewIssue = await issueService(db).create(fixture.companyId, {
      projectId: fixture.projectId,
      title: "CAR stalled review session",
      description: "A review session that should be detected as stalled.",
      status: "todo",
      priority: "high",
      assigneeAgentId: fixture.managerAgentId,
      originKind: "session_manual",
      originId: "stalled-review",
    });
    const reviewOpen = await sessionService(db).transition({
      issueId: reviewIssue.id,
      expectedRevisionId: null,
      expectedState: null,
      transition: "create",
      nextState: makeSession({
        companyId: fixture.companyId,
        issueId: reviewIssue.id,
        participantAgentId: fixture.participantAgentId,
        actor,
        sessionType: "review",
      }),
      actor,
      idempotencyKey: `session:${reviewIssue.id}:0`,
    });
    const stalledReview: PaperclipSessionDocument = JSON.parse(JSON.stringify(reviewOpen.session));
    stalledReview.state = "reviewing";
    stalledReview.stateRevision += 1;
    stalledReview.idempotencyKey = "stalled-review";
    stalledReview.reviews = [{ domain: "research", disposition: "accepted" }];
    stalledReview.lastTransition = {
      transitionId: randomUUID(),
      transition: "challenge",
      actor,
      beforeState: "open",
      afterState: "reviewing",
      at: "2026-05-18T15:05:00.000Z",
    };
    await sessionService(db).transition({
      issueId: reviewIssue.id,
      expectedRevisionId: reviewOpen.document.latestRevisionId,
      expectedState: "open",
      transition: "challenge",
      nextState: stalledReview,
      actor,
      idempotencyKey: stalledReview.idempotencyKey,
    });

    const framework = sessionService(db).listAdHocTriggerFramework();
    const expectedTriggerClasses = [
      "standup_nonresponse",
      "repeated_unanswered_directive",
      "full_paper_work_halt",
      "generator_nonproductive_state",
      "failed_or_stalled_review",
      "runtime_risk",
      "material_super_pass_event",
      "eod_material_finding",
      "permission_or_task_router_blocker",
    ];
    expect(framework).toHaveLength(9);
    expect(framework.map((entry) => entry.triggerClass)).toContain("permission_or_task_router_blocker");
    const detected = await sessionService(db).detectAdHocTriggers({
      companyId: fixture.companyId,
      policyKey: "car-leadership-sessions",
      now: new Date("2026-05-18T15:30:00.000Z"),
    });
    expect(detected.detectorsRun).toEqual(expectedTriggerClasses);
    expect([...new Set(detected.candidates.map((candidate) => candidate.triggerClass))].sort()).toEqual(
      [...expectedTriggerClasses].sort(),
    );
    for (const triggerClass of expectedTriggerClasses) {
      expect(detected.sourceCounts[triggerClass]).toBeGreaterThan(0);
      const candidate = detected.candidates.find((row) => row.triggerClass === triggerClass);
      expect(candidate?.dedupeKey).toBeTruthy();
      expect(candidate?.correctionTarget).toBeTruthy();
      expect(candidate?.reopenTarget).toBeTruthy();
      expect(candidate?.ownerRole).toBeTruthy();
    }
    expect(detected.candidates.find((candidate) => candidate.triggerClass === "eod_material_finding")?.action).toBe("route_task");
    expect(
      detected.candidates.find((candidate) => candidate.triggerClass === "permission_or_task_router_blocker")?.action,
    ).toBe("route_task");
    const evaluated = sessionService(db).evaluateAdHocTrigger({
      triggerClass: "generator_nonproductive_state",
      severityInputs: { severityScore: 3 },
      dedupeKey: "generator:idle",
      openSessionCount: 0,
      openTaskCount: 0,
    });
    expect(evaluated.severity).toBe("high");
    expect(evaluated.overloadDecision).toBe("open_session_allowed");
  });
});
