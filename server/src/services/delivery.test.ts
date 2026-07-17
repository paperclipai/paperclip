import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  deliveryEvents,
  externalOperations,
  heartbeatRuns,
  issues,
  issueTreeHolds,
  issueWorkProducts,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import type { DeliveryEventV1, DeliveryFactoryProvenanceV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  deliveryService,
  buildFactoryDeliveryEvidenceExpectations,
  candidateShasMatch,
  evaluateDeliveryEvidenceGate,
  projectDeliverySnapshot,
} from "./delivery.js";
import type { ExternalOperationVerifier } from "./delivery-verifiers.js";
import { DEFAULT_FACTORY_POLICY_V1 } from "./ai-factory-policy.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const SHA = "5fa761a27c7d8cfc285057e6997b04b9831a07c4";
const FACTORY_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const GITHUB_WORKFLOW_PATH = ".github/workflows/ci.yml";
const GITHUB_WORKFLOW_BLOB_SHA = "1111111111111111111111111111111111111111";
const GITHUB_WORKFLOW_EVENT = "push";

function factoryProvenance(
  stageId: string,
  stageKey: string,
  stageRevision: number,
): DeliveryFactoryProvenanceV1 {
  return {
    version: 1,
    stageId,
    stageKey,
    stageRevision,
    stageActivatedAt: `2026-07-16T${String(stageRevision).padStart(2, "0")}:00:00.000Z`,
    participant: { type: "agent", agentId: FACTORY_AGENT_ID, userId: null },
  };
}

function event(overrides: Partial<DeliveryEventV1>): DeliveryEventV1 {
  return {
    version: 1,
    id: randomUUID(),
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    stage: "deployment",
    state: "unknown",
    candidateSha: SHA,
    environment: "production",
    provider: null,
    providerExternalId: null,
    providerUrl: null,
    sourceKind: "agent_submission",
    authority: "agent_claim",
    summary: null,
    metadata: null,
    sourceFingerprint: null,
    sourceWorkProductId: null,
    supersedesEventId: null,
    observedAt: new Date("2026-07-16T14:00:00.000Z"),
    createdByAgentId: null,
    createdByUserId: null,
    createdByRunId: null,
    createdAt: new Date("2026-07-16T14:00:00.000Z"),
    ...overrides,
  };
}

describe("projectDeliverySnapshot", () => {
  it("keeps verified deployment truth when a later agent claim contradicts it", () => {
    const verified = event({
      id: "00000000-0000-4000-8000-000000000001",
      state: "succeeded",
      provider: "cloudflare",
      providerExternalId: "2268dd54-02f6-4e86-b0cb-e93ae75b92ca",
      sourceKind: "provider_observation",
      authority: "provider_verified",
    });
    const falseClaim = event({
      id: "00000000-0000-4000-8000-000000000002",
      state: "failed",
      summary: "Nothing was deployed",
      observedAt: new Date("2026-07-16T15:00:00.000Z"),
      createdAt: new Date("2026-07-16T15:00:00.000Z"),
    });
    const snapshot = projectDeliverySnapshot(COMPANY_ID, ISSUE_ID, [verified, falseClaim]);

    expect(snapshot.stages.deployment).toMatchObject({
      state: "succeeded",
      authority: "provider_verified",
      eventId: verified.id,
    });
  });

  it("applies append-only corrections by superseding the older event", () => {
    const deployed = event({
      id: "00000000-0000-4000-8000-000000000003",
      state: "succeeded",
      sourceKind: "provider_observation",
      authority: "provider_verified",
    });
    const rollback = event({
      id: "00000000-0000-4000-8000-000000000004",
      state: "rolled_back",
      sourceKind: "provider_observation",
      authority: "provider_verified",
      supersedesEventId: deployed.id,
      observedAt: new Date("2026-07-16T16:00:00.000Z"),
      createdAt: new Date("2026-07-16T16:00:00.000Z"),
    });
    const snapshot = projectDeliverySnapshot(COMPANY_ID, ISSUE_ID, [deployed, rollback]);

    expect(snapshot.stages.deployment.state).toBe("rolled_back");
    expect(snapshot.supersededEventIds).toEqual([deployed.id]);
  });

  it("uses user authority for business acceptance without overwriting provider facts", () => {
    const providerAcceptance = event({
      id: "00000000-0000-4000-8000-000000000005",
      stage: "business_acceptance",
      state: "accepted",
      sourceKind: "provider_observation",
      authority: "provider_verified",
    });
    const userRejection = event({
      id: "00000000-0000-4000-8000-000000000006",
      stage: "business_acceptance",
      state: "rejected",
      sourceKind: "user_submission",
      authority: "user_asserted",
    });
    const snapshot = projectDeliverySnapshot(COMPANY_ID, ISSUE_ID, [providerAcceptance, userRejection]);

    expect(snapshot.stages.business_acceptance).toMatchObject({
      state: "rejected",
      authority: "user_asserted",
    });
  });

  it("anchors factory candidate identity to implementation instead of a later provider observation", () => {
    const implementationStageId = randomUUID();
    const deploymentStageId = randomUUID();
    const implementation = event({
      stage: "implementation",
      state: "succeeded",
      metadata: { paperclipFactory: factoryProvenance(implementationStageId, "implementation", 1) },
    });
    const wrongProviderCandidate = event({
      candidateSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      state: "succeeded",
      sourceKind: "provider_observation",
      authority: "provider_verified",
      metadata: { paperclipFactory: factoryProvenance(deploymentStageId, "deployment", 4) },
    });

    const snapshot = projectDeliverySnapshot(COMPANY_ID, ISSUE_ID, [implementation, wrongProviderCandidate]);

    expect(snapshot.candidateSha).toBe(SHA);
    expect(snapshot.stages.deployment).toMatchObject({
      eventId: wrongProviderCandidate.id,
      state: "succeeded",
      stale: true,
    });
  });
});

describe("evaluateDeliveryEvidenceGate", () => {
  it("requires an event-backed current observation and honors provider authority gates", () => {
    const providerEvent = event({
      state: "succeeded",
      sourceKind: "provider_observation",
      authority: "provider_verified",
    });
    const snapshot = projectDeliverySnapshot(COMPANY_ID, ISSUE_ID, [providerEvent]);
    expect(evaluateDeliveryEvidenceGate(
      snapshot,
      "delivery:deployment:succeeded:provider_verified",
    )).toMatchObject({ satisfied: true });
    expect(evaluateDeliveryEvidenceGate(
      snapshot,
      "delivery:deployment:succeeded:user_asserted",
    )).toMatchObject({ satisfied: false, reason: "authority_provider_verified" });
    expect(evaluateDeliveryEvidenceGate(
      snapshot,
      "delivery:smoke:succeeded",
    )).toMatchObject({ satisfied: false, reason: "missing_event" });
  });

  it("does not accept legacy unverified evidence as a stage gate", () => {
    const legacy = event({
      state: "succeeded",
      sourceKind: "legacy_backfill",
      authority: "legacy_unverified",
    });
    const snapshot = projectDeliverySnapshot(COMPANY_ID, ISSUE_ID, [legacy]);
    expect(evaluateDeliveryEvidenceGate(
      snapshot,
      "delivery:deployment:succeeded",
    )).toMatchObject({ satisfied: false, reason: "unverified_authority" });
  });

  it("does not pass a provider gate when the provider observed a different candidate", () => {
    const expectedCandidate = event({
      stage: "implementation",
      state: "succeeded",
      sourceKind: "agent_submission",
      authority: "agent_claim",
    });
    const mismatchedDeployment = event({
      state: "succeeded",
      candidateSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceKind: "provider_observation",
      authority: "provider_verified",
      metadata: { candidateMismatch: true, expectedCandidateSha: SHA },
    });
    const snapshot = projectDeliverySnapshot(COMPANY_ID, ISSUE_ID, [expectedCandidate, mismatchedDeployment]);
    expect(snapshot.candidateSha).toBe(SHA);
    expect(snapshot.stages.deployment.stale).toBe(true);
    expect(snapshot.stages.deployment.state).toBe("succeeded");
    expect(evaluateDeliveryEvidenceGate(
      snapshot,
      "delivery:deployment:succeeded:provider_verified",
    )).toMatchObject({ satisfied: false, reason: "stale_event" });
  });

  it("rejects green evidence without an implementation candidate anchor", () => {
    const provider = event({
      state: "succeeded",
      candidateSha: null,
      sourceKind: "provider_observation",
      authority: "provider_verified",
      metadata: { paperclipFactory: factoryProvenance(randomUUID(), "deployment", 3) },
    });
    const snapshot = projectDeliverySnapshot(COMPANY_ID, ISSUE_ID, [provider]);

    expect(snapshot.candidateSha).toBeNull();
    expect(evaluateDeliveryEvidenceGate(
      snapshot,
      "delivery:deployment:succeeded:provider_verified",
    )).toMatchObject({ satisfied: false, reason: "missing_candidate_anchor" });
  });

  it("normalizes full SHA identity without accepting ambiguous prefixes or null lineage", () => {
    expect(candidateShasMatch(SHA.toUpperCase(), SHA)).toBe(true);
    expect(candidateShasMatch(SHA.slice(0, 12).toUpperCase(), SHA)).toBe(false);
    expect(candidateShasMatch(null, SHA)).toBe(false);
  });

  it("rejects old-revision provider green after rewind while retaining same-revision provider authority", () => {
    const implementationStageId = randomUUID();
    const deploymentStageId = randomUUID();
    const implementation = event({
      stage: "implementation",
      state: "succeeded",
      metadata: { paperclipFactory: factoryProvenance(implementationStageId, "implementation", 1) },
    });
    const oldProviderGreen = event({
      state: "succeeded",
      sourceKind: "provider_observation",
      authority: "provider_verified",
      metadata: { paperclipFactory: factoryProvenance(deploymentStageId, "deployment", 4) },
      observedAt: new Date("2026-07-16T18:00:00.000Z"),
      createdAt: new Date("2026-07-16T18:00:00.000Z"),
    });
    const snapshot = projectDeliverySnapshot(COMPANY_ID, ISSUE_ID, [implementation, oldProviderGreen]);
    const participant = factoryProvenance(deploymentStageId, "deployment", 6).participant;

    expect(evaluateDeliveryEvidenceGate(
      snapshot,
      "delivery:deployment:succeeded:provider_verified",
      { candidateSha: SHA, stageId: deploymentStageId, stageRevision: 6, participant },
    )).toMatchObject({ satisfied: false, reason: "factory_stage_revision_mismatch" });

    const sameRevisionGreen = event({
      state: "succeeded",
      sourceKind: "provider_observation",
      authority: "provider_verified",
      metadata: { paperclipFactory: factoryProvenance(deploymentStageId, "deployment", 6) },
      observedAt: new Date("2026-07-16T17:00:00.000Z"),
      createdAt: new Date("2026-07-16T17:00:00.000Z"),
    });
    const controllerFailure = event({
      state: "failed",
      sourceKind: "paperclip_action",
      authority: "paperclip_verified",
      metadata: {
        paperclipFactory: factoryProvenance(deploymentStageId, "deployment", 6),
        controllerOutcome: "exhausted",
      },
    });
    const currentSnapshot = projectDeliverySnapshot(
      COMPANY_ID,
      ISSUE_ID,
      [implementation, sameRevisionGreen, oldProviderGreen, controllerFailure],
    );
    expect(currentSnapshot.stages.deployment.eventId).toBe(sameRevisionGreen.id);
    expect(evaluateDeliveryEvidenceGate(
      currentSnapshot,
      "delivery:deployment:succeeded:provider_verified",
      { candidateSha: SHA, stageId: deploymentStageId, stageRevision: 6, participant },
    )).toMatchObject({ satisfied: true, reason: null });
  });

  it("binds repeated factory gates to the first producer stage", () => {
    const implementationStageId = randomUUID();
    const qaStageId = randomUUID();
    const reviewStageId = randomUUID();
    const expectations = buildFactoryDeliveryEvidenceExpectations({
      candidateSha: SHA,
      policy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: implementationStageId,
            key: "implementation",
            type: "work",
            approvalsNeeded: 1,
            evidenceGates: ["delivery:implementation:succeeded"],
            participants: [{ id: randomUUID(), type: "agent", agentId: FACTORY_AGENT_ID }],
          },
          {
            id: qaStageId,
            key: "independent_qa",
            type: "verification",
            approvalsNeeded: 1,
            evidenceGates: ["delivery:functional_qa:succeeded"],
            participants: [{ id: randomUUID(), type: "agent", agentId: FACTORY_AGENT_ID }],
          },
          {
            id: reviewStageId,
            key: "technical_acceptance",
            type: "review",
            approvalsNeeded: 1,
            evidenceGates: ["delivery:functional_qa:succeeded"],
            participants: [{ id: randomUUID(), type: "agent", agentId: FACTORY_AGENT_ID }],
          },
        ],
      },
      state: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 2,
        currentStageType: "review",
        stageRevision: 3,
        currentStageActivatedAt: "2026-07-16T03:00:00.000Z",
        completedStageRevisions: { [implementationStageId]: 1, [qaStageId]: 2 },
        currentParticipant: { type: "agent", agentId: FACTORY_AGENT_ID },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [implementationStageId, qaStageId],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    expect(expectations.implementation).toMatchObject({ stageId: implementationStageId, stageRevision: 1 });
    expect(expectations.functional_qa).toMatchObject({ stageId: qaStageId, stageRevision: 2 });
    expect(expectations.functional_qa?.stageId).not.toBe(reviewStageId);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("deliveryService ledger", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: COMPANY_ID, name: "Delivery Co", issuePrefix: "DEL" });
    await db.insert(projects).values({
      id: DEFAULT_PROJECT_ID,
      companyId: COMPANY_ID,
      name: "Delivery Project",
      env: {
        CLOUDFLARE_ACCOUNT_ID: "account-1",
        CLOUDFLARE_PAGES_PROJECT_NAME: "paperclip",
      },
    });
    await db.insert(issues).values({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      projectId: DEFAULT_PROJECT_ID,
      title: "Ship it",
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("derives agent authority server-side and prevents ledger mutation", async () => {
    const delivery = deliveryService(db);
    const result = await delivery.appendAgentClaim(
      COMPANY_ID,
      ISSUE_ID,
      { stage: "deployment", state: "succeeded", provider: "cloudflare", candidateSha: SHA },
      { actorType: "agent" },
    );

    expect(result.event).toMatchObject({
      authority: "agent_claim",
      sourceKind: "agent_submission",
    });
    const updateError = await db
      .update(deliveryEvents)
      .set({ authority: "provider_verified" })
      .where(eq(deliveryEvents.id, result.event.id))
      .then(() => null, (error: unknown) => error as { cause?: { message?: string } });
    const deleteError = await db
      .delete(deliveryEvents)
      .where(eq(deliveryEvents.id, result.event.id))
      .then(() => null, (error: unknown) => error as { cause?: { message?: string } });
    expect(updateError?.cause?.message).toMatch(/append-only/);
    expect(deleteError?.cause?.message).toMatch(/append-only/);
  });

  it("rejects delivery mutations under an active cancel hold", async () => {
    const [hold] = await db.insert(issueTreeHolds).values({
      companyId: COMPANY_ID,
      rootIssueId: ISSUE_ID,
      mode: "cancel",
      status: "active",
      reason: "Board cancelled the delivery tree",
      createdByActorType: "user",
      createdByUserId: "board-user",
    }).returning({ id: issueTreeHolds.id });
    try {
      await expect(deliveryService(db).appendAgentClaim(
        COMPANY_ID,
        ISSUE_ID,
        { stage: "implementation", state: "succeeded", candidateSha: SHA },
        { actorType: "agent" },
      )).rejects.toMatchObject({
        status: 409,
        details: expect.objectContaining({ code: "issue_tree_cancelled" }),
      });
    } finally {
      if (hold) await db.delete(issueTreeHolds).where(eq(issueTreeHolds.id, hold.id));
    }
  });

  it("enforces exact source-authority pairs and one correction branch in the database", async () => {
    const invalidPairError = await db.insert(deliveryEvents).values({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      stage: "implementation",
      state: "succeeded",
      candidateSha: SHA,
      sourceKind: "agent_submission",
      authority: "provider_verified",
    }).then(() => null, (error: unknown) => error as { cause?: { message?: string } });
    expect(invalidPairError?.cause?.message).toMatch(/delivery_events_source_authority_pair_check/);

    const delivery = deliveryService(db);
    const provider = await delivery.appendProviderObservation(COMPANY_ID, ISSUE_ID, {
      stage: "deployment",
      state: "succeeded",
      candidateSha: SHA,
      observedAt: new Date(),
      sourceFingerprint: `provider:${randomUUID()}`,
    });
    await expect(delivery.appendAgentClaim(
      COMPANY_ID,
      ISSUE_ID,
      {
        stage: "deployment",
        state: "failed",
        candidateSha: SHA,
        supersedesEventId: provider.event.id,
      },
      { actorType: "agent" },
    )).rejects.toThrow(/Lower-authority evidence/);
    await expect(delivery.appendUserAssertion(
      COMPANY_ID,
      ISSUE_ID,
      {
        stage: "smoke",
        state: "failed",
        candidateSha: SHA,
        supersedesEventId: provider.event.id,
      },
      { actorType: "user", userId: "board-user" },
    )).rejects.toThrow(/same stage/);

    const base = await delivery.appendAgentClaim(
      COMPANY_ID,
      ISSUE_ID,
      { stage: "functional_qa", state: "succeeded", candidateSha: SHA },
      { actorType: "agent" },
    );
    await delivery.appendUserAssertion(
      COMPANY_ID,
      ISSUE_ID,
      {
        stage: "functional_qa",
        state: "failed",
        candidateSha: SHA,
        supersedesEventId: base.event.id,
      },
      { actorType: "user", userId: "board-user" },
    );
    await expect(delivery.appendUserAssertion(
      COMPANY_ID,
      ISSUE_ID,
      {
        stage: "functional_qa",
        state: "failed",
        candidateSha: SHA,
        supersedesEventId: base.event.id,
      },
      { actorType: "user", userId: "second-board-user" },
    )).rejects.toMatchObject({ details: expect.objectContaining({ code: "delivery_correction_fork" }) });
  });

  it("allows owner cascades while still rejecting direct delivery-event deletion", async () => {
    const issueCascadeId = randomUUID();
    await db.insert(issues).values({ id: issueCascadeId, companyId: COMPANY_ID, title: "Cascade issue" });
    await db.insert(deliveryEvents).values({
      companyId: COMPANY_ID,
      issueId: issueCascadeId,
      stage: "implementation",
      state: "succeeded",
      candidateSha: SHA,
      sourceKind: "agent_submission",
      authority: "agent_claim",
    });
    await db.delete(issues).where(eq(issues.id, issueCascadeId));
    expect(await db.select().from(deliveryEvents).where(eq(deliveryEvents.issueId, issueCascadeId))).toHaveLength(0);

    const companyCascadeId = randomUUID();
    await db.insert(companies).values({ id: companyCascadeId, name: "Cascade Company", issuePrefix: "CAS" });
    // The two FKs are independent at the database layer. Use an existing issue
    // so this deletion exercises delivery_events.company_id's cascade directly
    // instead of being blocked by issues.company_id's intentionally restrictive FK.
    await db.insert(deliveryEvents).values({
      companyId: companyCascadeId,
      issueId: ISSUE_ID,
      stage: "implementation",
      state: "succeeded",
      candidateSha: SHA,
      sourceKind: "agent_submission",
      authority: "agent_claim",
    });
    await db.delete(companies).where(eq(companies.id, companyCascadeId));
    expect(await db.select().from(deliveryEvents).where(eq(deliveryEvents.companyId, companyCascadeId))).toHaveLength(0);
  });

  it("uses the frozen factory recovery schedule as the operation polling clock", async () => {
    const factoryIssueId = randomUUID();
    const implementationStageId = randomUUID();
    const deploymentStageId = randomUUID();
    const liveQaStageId = randomUUID();
    const runId = randomUUID();
    const activatedAt = new Date().toISOString();
    await db.insert(agents).values({
      id: FACTORY_AGENT_ID,
      companyId: COMPANY_ID,
      name: "Factory Deployer",
      role: "devops",
      status: "active",
    }).onConflictDoNothing();
    await db.insert(issues).values({
      id: factoryIssueId,
      companyId: COMPANY_ID,
      projectId: DEFAULT_PROJECT_ID,
      title: "Factory release",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: implementationStageId,
            key: "implementation",
            type: "work",
            approvalsNeeded: 1,
            evidenceGates: ["delivery:implementation:succeeded"],
            participants: [{ id: randomUUID(), type: "agent", agentId: FACTORY_AGENT_ID }],
          },
          {
            id: deploymentStageId,
            key: "deployment",
            type: "deployment",
            approvalsNeeded: 1,
            evidenceGates: ["delivery:deployment:succeeded:provider_verified"],
            participants: [{ id: randomUUID(), type: "agent", agentId: FACTORY_AGENT_ID }],
          },
          {
            id: liveQaStageId,
            key: "live_qa",
            type: "verification",
            approvalsNeeded: 1,
            evidenceGates: [
              "delivery:deployment:succeeded:provider_verified",
              "delivery:smoke:succeeded",
            ],
            participants: [{ id: randomUUID(), type: "agent", agentId: FACTORY_AGENT_ID }],
          },
        ],
        factory: {
          schemaVersion: 1,
          laneKind: "execution",
          topologyMode: "same_issue_only",
          controlIssueId: randomUUID(),
          coordinator: { type: "agent", agentId: FACTORY_AGENT_ID },
          policyKey: "paperclipai/paperclip/paperclip-ai-factory",
          policyVersion: "1",
          policyHash: "factory-policy-hash",
          maxExecutionLanes: 1,
          production: true,
          policySnapshot: DEFAULT_FACTORY_POLICY_V1,
        },
      },
      executionState: {
        status: "pending",
        currentStageId: deploymentStageId,
        currentStageIndex: 1,
        currentStageType: "deployment",
        stageRevision: 2,
        currentStageActivatedAt: activatedAt,
        completedStageRevisions: { [implementationStageId]: 1 },
        currentParticipant: { type: "agent", agentId: FACTORY_AGENT_ID },
        returnAssignee: { type: "agent", agentId: FACTORY_AGENT_ID },
        reviewRequest: null,
        completedStageIds: [implementationStageId],
        lastDecisionId: null,
        lastDecisionOutcome: "approved",
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: COMPANY_ID,
      agentId: FACTORY_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: factoryIssueId },
    });
    await db.insert(deliveryEvents).values({
      companyId: COMPANY_ID,
      issueId: factoryIssueId,
      stage: "implementation",
      state: "succeeded",
      candidateSha: SHA,
      sourceKind: "agent_submission",
      authority: "agent_claim",
      metadata: {
        paperclipFactory: factoryProvenance(implementationStageId, "implementation", 1),
      },
    });
    const provenance: DeliveryFactoryProvenanceV1 = {
      version: 1,
      stageId: deploymentStageId,
      stageKey: "deployment",
      stageRevision: 2,
      stageActivatedAt: activatedAt,
      participant: { type: "agent", agentId: FACTORY_AGENT_ID, userId: null },
    };
    const delivery = deliveryService(db);
    const created = await delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId: `factory-deploy-${randomUUID()}`,
        candidateSha: SHA,
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      { actorType: "agent", agentId: FACTORY_AGENT_ID, runId },
      provenance,
    );

    expect(created.operation.nextCheckAt!.getTime() - created.operation.createdAt.getTime()).toBe(2 * 60_000);
    expect(created.operation.environment).toBe("production");
    expect(created.operation.metadata).toMatchObject({
      paperclipController: {
        attemptCount: 0,
        maxAttempts: 3,
        attemptMinutes: [2, 10, 30],
        scheduleStartedAt: created.operation.createdAt.toISOString(),
        scheduleIndex: 0,
      },
    });
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId: `factory-second-${randomUUID()}`,
        candidateSha: SHA,
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      { actorType: "agent", agentId: FACTORY_AGENT_ID, runId },
      provenance,
    )).rejects.toMatchObject({
      details: expect.objectContaining({ code: "factory_external_operation_already_registered" }),
    });
    await expect(delivery.updateExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      created.operation.id,
      { nextCheckAt: new Date(created.operation.createdAt.getTime() + 10 * 60_000) },
    )).rejects.toMatchObject({ details: expect.objectContaining({ code: "factory_operation_schedule_frozen" }) });
    await expect(delivery.updateExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      created.operation.id,
      { candidateSha: SHA },
    )).rejects.toMatchObject({ details: expect.objectContaining({ code: "external_operation_identity_frozen" }) });
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId: `factory-preview-${randomUUID()}`,
        candidateSha: SHA,
        environment: "preview",
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      { actorType: "agent", agentId: FACTORY_AGENT_ID, runId },
      provenance,
    )).rejects.toMatchObject({
      details: expect.objectContaining({ code: "factory_production_environment_required" }),
    });
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId: `factory-deploy-${randomUUID()}`,
        candidateSha: SHA,
        environment: "production",
        timeoutAt: new Date(Date.now() + 5 * 60_000),
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      { actorType: "agent", agentId: FACTORY_AGENT_ID, runId },
      provenance,
    )).rejects.toThrow(/server-owned/);

    const retrospectiveVerifier: ExternalOperationVerifier = {
      provider: "cloudflare",
      kind: "cloudflare_pages_deployment",
      async verify() {
        return {
          provider: "cloudflare",
          externalId: created.operation.externalId,
          operationState: "succeeded",
          eventState: "succeeded",
          candidateSha: SHA,
          environment: "production",
          url: "https://paperclip.pages.dev",
          startedAt: new Date(new Date(activatedAt).getTime() - 1_000),
          observedAt: new Date(Date.now() + 1_000),
          summary: "Deployment started before authorization",
          metadata: { status: "success", accountId: "account-1", projectName: "paperclip" },
        };
      },
    };
    const retrospectiveDelivery = deliveryService(db, {
      verifiers: new Map([["cloudflare:cloudflare_pages_deployment", retrospectiveVerifier]]),
      resolveCredential: async () => ({ credential: "test-only" }),
    });
    await expect(retrospectiveDelivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      created.operation.id,
      { actorType: "agent", agentId: FACTORY_AGENT_ID, runId },
    )).rejects.toMatchObject({
      details: expect.objectContaining({ code: "provider_operation_predates_authorization" }),
    });

    await db.insert(deliveryEvents).values({
      companyId: COMPANY_ID,
      issueId: factoryIssueId,
      stage: "deployment",
      state: "succeeded",
      candidateSha: SHA,
      environment: "production",
      provider: "cloudflare",
      providerExternalId: created.operation.externalId,
      providerUrl: "https://paperclip.pages.dev",
      sourceKind: "provider_observation",
      authority: "provider_verified",
      metadata: { paperclipFactory: provenance },
    });
    const liveQaActivatedAt = new Date().toISOString();
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: liveQaStageId,
        currentStageIndex: 2,
        currentStageType: "verification",
        stageRevision: 3,
        currentStageActivatedAt: liveQaActivatedAt,
        completedStageRevisions: { [implementationStageId]: 1, [deploymentStageId]: 2 },
        currentParticipant: { type: "agent", agentId: FACTORY_AGENT_ID },
        returnAssignee: { type: "agent", agentId: FACTORY_AGENT_ID },
        reviewRequest: null,
        completedStageIds: [implementationStageId, deploymentStageId],
        lastDecisionId: null,
        lastDecisionOutcome: "approved",
      },
    }).where(eq(issues.id, factoryIssueId));
    const smoke = await delivery.appendAgentClaim(
      COMPANY_ID,
      factoryIssueId,
      {
        stage: "smoke",
        state: "succeeded",
        candidateSha: SHA,
        environment: "preview",
        provider: "spoofed-provider",
        providerExternalId: "spoofed-operation",
        providerUrl: "https://preview.example.test",
      },
      { actorType: "agent", agentId: FACTORY_AGENT_ID, runId },
      {
        version: 1,
        stageId: liveQaStageId,
        stageKey: "live_qa",
        stageRevision: 3,
        stageActivatedAt: liveQaActivatedAt,
        participant: { type: "agent", agentId: FACTORY_AGENT_ID, userId: null },
      },
    );
    expect(smoke.event).toMatchObject({
      environment: "production",
      provider: "cloudflare",
      providerExternalId: created.operation.externalId,
      providerUrl: "https://paperclip.pages.dev",
      metadata: expect.objectContaining({
        verifiedDeploymentTarget: expect.objectContaining({
          environment: "production",
          externalId: created.operation.externalId,
          url: "https://paperclip.pages.dev",
        }),
      }),
    });
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: implementationStageId,
        currentStageIndex: 0,
        currentStageType: "work",
        stageRevision: 3,
        currentStageActivatedAt: new Date().toISOString(),
        completedStageRevisions: {},
        currentParticipant: { type: "agent", agentId: FACTORY_AGENT_ID },
        returnAssignee: { type: "agent", agentId: FACTORY_AGENT_ID },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: "changes_requested",
      },
    }).where(eq(issues.id, factoryIssueId));
    const rewound = await delivery.getSnapshot(COMPANY_ID, factoryIssueId);
    expect(rewound.stages.deployment).toMatchObject({ state: "succeeded", stale: true });
  });

  it("retries failed factory CI through one append-only canonical lineage", async () => {
    const candidateA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const candidateMismatchExpected = "cccccccccccccccccccccccccccccccccccccccc";
    const candidateMismatchObserved = "dddddddddddddddddddddddddddddddddddddddd";
    const candidateB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const projectId = randomUUID();
    const factoryIssueId = randomUUID();
    const implementationStageId = randomUUID();
    const deploymentStageId = randomUUID();
    const runId = randomUUID();
    const activatedAt = new Date().toISOString();
    const ciAExternalId = `ci-a-${randomUUID()}`;
    const ciMismatchExternalId = `ci-mismatch-${randomUUID()}`;
    const ciAttestationMismatchExternalId = `ci-attestation-mismatch-${randomUUID()}`;
    const ciBExternalId = `ci-b-${randomUUID()}`;
    const deploymentMismatchExternalId = `deploy-preview-${randomUUID()}`;
    const deploymentBExternalId = `deploy-production-${randomUUID()}`;
    const verifierCalls = new Map<string, number>();
    const verifier: ExternalOperationVerifier = {
      provider: "github",
      kind: "github_actions_workflow_run",
      async verify({ operation }) {
        verifierCalls.set(operation.externalId, (verifierCalls.get(operation.externalId) ?? 0) + 1);
        const succeeded = operation.externalId !== ciAExternalId;
        const candidateSha = operation.externalId === ciAExternalId
          ? candidateA
          : operation.externalId === ciMismatchExternalId
            ? candidateMismatchObserved
            : candidateB;
        return {
          provider: "github",
          externalId: operation.externalId,
          operationState: succeeded ? "succeeded" : "failed",
          eventState: succeeded ? "succeeded" : "failed",
          candidateSha,
          environment: null,
          url: `https://github.com/paperclipai/paperclip/actions/runs/${operation.externalId}`,
          startedAt: new Date(),
          observedAt: new Date(),
          summary: succeeded ? "Candidate B CI passed" : "Candidate A CI failed",
          metadata: {
            repositoryFullName: "paperclipai/paperclip",
            workflowId: 42,
            workflowPath: GITHUB_WORKFLOW_PATH,
            workflowBlobSha: operation.externalId === ciAttestationMismatchExternalId
              ? "2222222222222222222222222222222222222222"
              : GITHUB_WORKFLOW_BLOB_SHA,
            workflowEvent: GITHUB_WORKFLOW_EVENT,
            workflowBlobHeadSha: candidateSha,
          },
        };
      },
    };
    const deploymentVerifier: ExternalOperationVerifier = {
      provider: "cloudflare",
      kind: "cloudflare_pages_deployment",
      async verify({ operation }) {
        verifierCalls.set(operation.externalId, (verifierCalls.get(operation.externalId) ?? 0) + 1);
        const production = operation.externalId === deploymentBExternalId;
        return {
          provider: "cloudflare",
          externalId: operation.externalId,
          operationState: "succeeded",
          eventState: "succeeded",
          candidateSha: candidateB,
          environment: production ? "production" : "preview",
          url: production ? "https://paperclip.pages.dev" : "https://preview.paperclip.pages.dev",
          startedAt: new Date(),
          observedAt: new Date(),
          summary: production ? "Production deployment passed" : "Provider returned preview",
          metadata: { status: "success", accountId: "account-1", projectName: "paperclip" },
        };
      },
    };
    const delivery = deliveryService(db, {
      verifiers: new Map([
        ["github:github_actions_workflow_run", verifier],
        ["cloudflare:cloudflare_pages_deployment", deploymentVerifier],
      ]),
      resolveCredential: async () => ({ credential: "test-only" }),
    });

    await db.insert(agents).values({
      id: FACTORY_AGENT_ID,
      companyId: COMPANY_ID,
      name: "Factory Builder",
      role: "engineer",
      status: "active",
    }).onConflictDoNothing();
    await db.insert(projects).values({
      id: projectId,
      companyId: COMPANY_ID,
      name: "Factory CI Project",
      env: {
        GITHUB_ACTIONS_WORKFLOW_ID: "42",
        GITHUB_ACTIONS_WORKFLOW_PATH: GITHUB_WORKFLOW_PATH,
        GITHUB_ACTIONS_WORKFLOW_BLOB_SHA: GITHUB_WORKFLOW_BLOB_SHA,
        GITHUB_ACTIONS_EVENT: GITHUB_WORKFLOW_EVENT,
        CLOUDFLARE_ACCOUNT_ID: "account-1",
        CLOUDFLARE_PAGES_PROJECT_NAME: "paperclip",
      },
    });
    await db.insert(projectWorkspaces).values({
      companyId: COMPANY_ID,
      projectId,
      name: "Primary",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: factoryIssueId,
      companyId: COMPANY_ID,
      projectId,
      title: "Retry factory CI",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: implementationStageId,
            key: "implementation",
            type: "work",
            approvalsNeeded: 1,
            evidenceGates: [
              "delivery:implementation:succeeded",
              "delivery:ci:succeeded:provider_verified",
            ],
            participants: [{ id: randomUUID(), type: "agent", agentId: FACTORY_AGENT_ID }],
          },
          {
            id: deploymentStageId,
            key: "deployment",
            type: "deployment",
            approvalsNeeded: 1,
            evidenceGates: ["delivery:deployment:succeeded:provider_verified"],
            participants: [{ id: randomUUID(), type: "agent", agentId: FACTORY_AGENT_ID }],
          },
        ],
        factory: {
          schemaVersion: 1,
          laneKind: "execution",
          topologyMode: "same_issue_only",
          controlIssueId: randomUUID(),
          coordinator: { type: "agent", agentId: FACTORY_AGENT_ID },
          policyKey: "paperclipai/paperclip/paperclip-ai-factory",
          policyVersion: "1",
          policyHash: "factory-policy-hash",
          maxExecutionLanes: 1,
          production: true,
          policySnapshot: DEFAULT_FACTORY_POLICY_V1,
        },
      },
      executionState: {
        status: "pending",
        currentStageId: implementationStageId,
        currentStageIndex: 0,
        currentStageType: "work",
        stageRevision: 1,
        currentStageActivatedAt: activatedAt,
        completedStageRevisions: {},
        currentParticipant: { type: "agent", agentId: FACTORY_AGENT_ID },
        returnAssignee: { type: "agent", agentId: FACTORY_AGENT_ID },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: COMPANY_ID,
      agentId: FACTORY_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: factoryIssueId },
    });
    const provenance: DeliveryFactoryProvenanceV1 = {
      version: 1,
      stageId: implementationStageId,
      stageKey: "implementation",
      stageRevision: 1,
      stageActivatedAt: activatedAt,
      participant: { type: "agent", agentId: FACTORY_AGENT_ID, userId: null },
    };
    const actor = { actorType: "agent" as const, agentId: FACTORY_AGENT_ID, runId };

    await delivery.appendAgentClaim(
      COMPANY_ID,
      factoryIssueId,
      { stage: "implementation", state: "succeeded", candidateSha: candidateA },
      actor,
      provenance,
    );
    const ciA = await delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "github_actions_workflow_run",
        provider: "github",
        stage: "ci",
        externalId: ciAExternalId,
        candidateSha: candidateA,
        metadata: { owner: "paperclipai", repo: "paperclip" },
      },
      actor,
      provenance,
    );
    const duplicateA = await delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "github_actions_workflow_run",
        provider: "github",
        stage: "ci",
        externalId: ciAExternalId,
        candidateSha: candidateA,
        metadata: { owner: "paperclipai", repo: "paperclip" },
      },
      actor,
      provenance,
    );
    expect(duplicateA).toMatchObject({ created: false, operation: { id: ciA.operation.id } });
    const failedA = await delivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      ciA.operation.id,
      actor,
    );
    expect(failedA.operation).toMatchObject({ state: "failed", terminalAt: expect.any(Date) });

    await delivery.appendAgentClaim(
      COMPANY_ID,
      factoryIssueId,
      { stage: "implementation", state: "succeeded", candidateSha: candidateMismatchExpected },
      actor,
      provenance,
    );
    const ciMismatch = await delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "github_actions_workflow_run",
        provider: "github",
        stage: "ci",
        externalId: ciMismatchExternalId,
        candidateSha: candidateMismatchExpected,
        metadata: { owner: "paperclipai", repo: "paperclip" },
      },
      actor,
      provenance,
    );
    expect(ciMismatch.operation.supersedesOperationId).toBe(ciA.operation.id);
    const mismatchedCi = await delivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      ciMismatch.operation.id,
      actor,
    );
    expect(mismatchedCi).toMatchObject({
      candidateMismatch: true,
      operation: { state: "succeeded", verificationStatus: "mismatch", terminalAt: expect.any(Date) },
    });

    await delivery.appendAgentClaim(
      COMPANY_ID,
      factoryIssueId,
      { stage: "implementation", state: "succeeded", candidateSha: candidateB },
      actor,
      provenance,
    );
    const ciAttestationMismatch = await delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "github_actions_workflow_run",
        provider: "github",
        stage: "ci",
        externalId: ciAttestationMismatchExternalId,
        candidateSha: candidateB,
        metadata: { owner: "paperclipai", repo: "paperclip" },
      },
      actor,
      provenance,
    );
    expect(ciAttestationMismatch.operation.supersedesOperationId).toBe(ciMismatch.operation.id);
    await expect(delivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      ciAttestationMismatch.operation.id,
      actor,
    )).rejects.toThrow(/workflow blob does not match/);
    expect(await delivery.getExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      ciAttestationMismatch.operation.id,
    )).toMatchObject({
      state: "failed",
      verificationStatus: "mismatch",
      terminalAt: expect.any(Date),
      nextCheckAt: null,
      metadata: {
        providerAttestationMismatch: expect.objectContaining({ code: "github_workflow_blob_mismatch" }),
      },
    });
    expect((await delivery.listEvents(COMPANY_ID, factoryIssueId)).some(
      (entry) => entry.providerExternalId === ciAttestationMismatchExternalId,
    )).toBe(false);
    const beforeCiBRegistration = await delivery.getSnapshot(COMPANY_ID, factoryIssueId);
    const ciB = await delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "github_actions_workflow_run",
        provider: "github",
        stage: "ci",
        externalId: ciBExternalId,
        candidateSha: candidateB,
        metadata: { owner: "paperclipai", repo: "paperclip" },
      },
      actor,
      provenance,
    );
    expect(ciB.operation).toMatchObject({
      supersedesOperationId: ciAttestationMismatch.operation.id,
      state: "unknown",
      candidateSha: candidateB,
    });
    const pendingRetrySnapshot = await delivery.getSnapshot(COMPANY_ID, factoryIssueId);
    expect(pendingRetrySnapshot).toMatchObject({
      candidateSha: candidateB,
      stages: { ci: { state: "unknown", eventId: null } },
    });
    expect(pendingRetrySnapshot.revision).not.toBe(beforeCiBRegistration.revision);
    expect(pendingRetrySnapshot.supersededEventIds).toContain(failedA.event.id);
    expect(pendingRetrySnapshot.supersededEventIds).toContain(mismatchedCi.event.id);

    await delivery.verifyExternalOperation(COMPANY_ID, factoryIssueId, ciB.operation.id, actor);
    const passedSnapshot = await delivery.getSnapshot(COMPANY_ID, factoryIssueId);
    expect(passedSnapshot.stages.ci).toMatchObject({
      state: "succeeded",
      stale: false,
      candidateSha: candidateB,
      providerExternalId: ciBExternalId,
    });
    expect(evaluateDeliveryEvidenceGate(
      passedSnapshot,
      "delivery:ci:succeeded:provider_verified",
      {
        candidateSha: candidateB,
        stageId: implementationStageId,
        stageRevision: 1,
        participant: provenance.participant,
      },
    )).toMatchObject({ satisfied: true, reason: null });

    await expect(delivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      ciA.operation.id,
      actor,
    )).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "factory_external_operation_superseded",
        successorOperationId: ciMismatch.operation.id,
      }),
    });
    await expect(delivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      ciMismatch.operation.id,
      actor,
    )).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "factory_external_operation_superseded",
        successorOperationId: ciAttestationMismatch.operation.id,
      }),
    });
    await expect(delivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      ciAttestationMismatch.operation.id,
      actor,
    )).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "factory_external_operation_superseded",
        successorOperationId: ciB.operation.id,
      }),
    });
    expect(verifierCalls.get(ciAExternalId)).toBe(1);
    expect(verifierCalls.get(ciMismatchExternalId)).toBe(1);
    expect(verifierCalls.get(ciBExternalId)).toBe(1);

    const deploymentActivatedAt = new Date().toISOString();
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: deploymentStageId,
        currentStageIndex: 1,
        currentStageType: "deployment",
        stageRevision: 2,
        currentStageActivatedAt: deploymentActivatedAt,
        completedStageRevisions: { [implementationStageId]: 1 },
        currentParticipant: { type: "agent", agentId: FACTORY_AGENT_ID },
        returnAssignee: { type: "agent", agentId: FACTORY_AGENT_ID },
        reviewRequest: null,
        completedStageIds: [implementationStageId],
        lastDecisionId: null,
        lastDecisionOutcome: "approved",
      },
    }).where(eq(issues.id, factoryIssueId));
    const deploymentProvenance: DeliveryFactoryProvenanceV1 = {
      ...provenance,
      stageId: deploymentStageId,
      stageKey: "deployment",
      stageRevision: 2,
      stageActivatedAt: deploymentActivatedAt,
    };
    const deploymentMismatch = await delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId: deploymentMismatchExternalId,
        candidateSha: candidateB,
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      actor,
      deploymentProvenance,
    );
    const mismatchedEnvironment = await delivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      deploymentMismatch.operation.id,
      actor,
    );
    expect(mismatchedEnvironment).toMatchObject({
      environmentMismatch: true,
      operation: {
        state: "succeeded",
        verificationStatus: "mismatch",
        terminalAt: expect.any(Date),
      },
    });
    const deploymentB = await delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId: deploymentBExternalId,
        candidateSha: candidateB,
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      actor,
      deploymentProvenance,
    );
    expect(deploymentB.operation).toMatchObject({
      supersedesOperationId: deploymentMismatch.operation.id,
      environment: "production",
    });
    const pendingDeploymentSnapshot = await delivery.getSnapshot(COMPANY_ID, factoryIssueId);
    expect(pendingDeploymentSnapshot.stages.deployment).toMatchObject({ state: "unknown", eventId: null });
    expect(pendingDeploymentSnapshot.supersededEventIds).toContain(mismatchedEnvironment.event.id);

    await delivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      deploymentB.operation.id,
      actor,
    );
    const deployedSnapshot = await delivery.getSnapshot(COMPANY_ID, factoryIssueId);
    expect(deployedSnapshot.stages.deployment).toMatchObject({
      state: "succeeded",
      stale: false,
      candidateSha: candidateB,
      environment: "production",
      providerExternalId: deploymentBExternalId,
    });
    await expect(delivery.verifyExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      deploymentMismatch.operation.id,
      actor,
    )).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "factory_external_operation_superseded",
        successorOperationId: deploymentB.operation.id,
      }),
    });
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      factoryIssueId,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId: `deploy-after-success-${randomUUID()}`,
        candidateSha: candidateB,
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      actor,
      deploymentProvenance,
    )).rejects.toMatchObject({
      details: expect.objectContaining({ code: "factory_external_operation_already_registered" }),
    });
    expect(verifierCalls.get(deploymentMismatchExternalId)).toBe(1);
    expect(verifierCalls.get(deploymentBExternalId)).toBe(1);
    expect(verifierCalls.get(ciAttestationMismatchExternalId)).toBe(1);
    expect(verifierCalls.get(ciBExternalId)).toBe(1);
  });

  it("fails closed unless a GitHub operation matches the project's parsed primary repository", async () => {
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: COMPANY_ID, name: "GitHub project" });
    await db.insert(issues).values({ id: issueId, companyId: COMPANY_ID, projectId, title: "GitHub build" });
    const delivery = deliveryService(db);
    const input = {
      kind: "github_actions_workflow_run" as const,
      provider: "github",
      stage: "ci" as const,
      externalId: `github-run-${randomUUID()}`,
      candidateSha: SHA,
      metadata: { owner: "paperclipai", repo: "paperclip" },
    };
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      issueId,
      input,
      { actorType: "agent" },
    )).rejects.toThrow(/parseable repository/);
    await db.insert(projectWorkspaces).values({
      companyId: COMPANY_ID,
      projectId,
      name: "Primary",
      repoUrl: "https://github.com/another/repository.git",
      isPrimary: true,
    });
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      issueId,
      input,
      { actorType: "agent" },
    )).rejects.toThrow(/must match/);
    await db.update(projectWorkspaces)
      .set({ repoUrl: "https://github.com/paperclipai/paperclip.git" })
      .where(eq(projectWorkspaces.projectId, projectId));
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      issueId,
      input,
      { actorType: "agent" },
    )).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "github_ci_workflow_not_configured" }),
    });
    await db.update(projects)
      .set({ env: { GITHUB_ACTIONS_WORKFLOW_ID: "42" } })
      .where(eq(projects.id, projectId));
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      issueId,
      input,
      { actorType: "agent" },
    )).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "github_ci_attestation_not_configured" }),
    });
    await db.update(projects)
      .set({
        env: {
          GITHUB_ACTIONS_WORKFLOW_ID: "42",
          GITHUB_ACTIONS_WORKFLOW_PATH: GITHUB_WORKFLOW_PATH,
          GITHUB_ACTIONS_WORKFLOW_BLOB_SHA: GITHUB_WORKFLOW_BLOB_SHA,
          GITHUB_ACTIONS_EVENT: "workflow_dispatch",
        },
      })
      .where(eq(projects.id, projectId));
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      issueId,
      input,
      { actorType: "agent" },
    )).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "github_ci_attestation_invalid",
        field: "GITHUB_ACTIONS_EVENT",
      }),
    });
    await db.update(projects)
      .set({
        env: {
          GITHUB_ACTIONS_WORKFLOW_ID: "42",
          GITHUB_ACTIONS_WORKFLOW_PATH: GITHUB_WORKFLOW_PATH,
          GITHUB_ACTIONS_WORKFLOW_BLOB_SHA: GITHUB_WORKFLOW_BLOB_SHA,
          GITHUB_ACTIONS_EVENT: GITHUB_WORKFLOW_EVENT,
        },
      })
      .where(eq(projects.id, projectId));
    await expect(delivery.createExternalOperation(
      COMPANY_ID,
      issueId,
      { ...input, metadata: { ...input.metadata, workflowId: 99 } },
      { actorType: "agent" },
    )).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "github_ci_workflow_mismatch" }),
    });
    const created = await delivery.createExternalOperation(
      COMPANY_ID,
      issueId,
      input,
      { actorType: "agent" },
    );
    expect(created.operation.metadata).toMatchObject({
      githubRepositoryHost: "github.com",
      githubRepositoryFullName: "paperclipai/paperclip",
      workflowId: "42",
      githubWorkflowPath: GITHUB_WORKFLOW_PATH,
      githubWorkflowBlobSha: GITHUB_WORKFLOW_BLOB_SHA,
      githubWorkflowEvent: GITHUB_WORKFLOW_EVENT,
    });

    let attestation = {
      workflowPath: ".github/workflows/docs.yml",
      workflowBlobSha: GITHUB_WORKFLOW_BLOB_SHA,
      workflowEvent: GITHUB_WORKFLOW_EVENT,
    };
    const unrelatedWorkflowVerifier: ExternalOperationVerifier = {
      provider: "github",
      kind: "github_actions_workflow_run",
      async verify() {
        return {
          provider: "github",
          externalId: input.externalId,
          operationState: "succeeded",
          eventState: "succeeded",
          candidateSha: SHA,
          environment: null,
          url: `https://github.com/paperclipai/paperclip/actions/runs/${input.externalId}`,
          observedAt: new Date(),
          summary: "An unrelated docs workflow was green",
          metadata: {
            repositoryFullName: "paperclipai/paperclip",
            workflowId: 42,
            ...attestation,
            workflowBlobHeadSha: SHA,
          },
        };
      },
    };
    const verifyingDelivery = deliveryService(db, {
      verifiers: new Map([["github:github_actions_workflow_run", unrelatedWorkflowVerifier]]),
      resolveCredential: async () => ({ credential: "test-only" }),
    });
    for (const mismatch of [
      {
        attestation: {
          workflowPath: ".github/workflows/docs.yml",
          workflowBlobSha: GITHUB_WORKFLOW_BLOB_SHA,
          workflowEvent: GITHUB_WORKFLOW_EVENT,
        },
        message: /workflow path does not match/,
      },
      {
        attestation: {
          workflowPath: GITHUB_WORKFLOW_PATH,
          workflowBlobSha: GITHUB_WORKFLOW_BLOB_SHA,
          workflowEvent: "workflow_dispatch",
        },
        message: /event does not match/,
      },
      {
        attestation: {
          workflowPath: GITHUB_WORKFLOW_PATH,
          workflowBlobSha: "2222222222222222222222222222222222222222",
          workflowEvent: GITHUB_WORKFLOW_EVENT,
        },
        message: /workflow blob does not match/,
      },
    ]) {
      attestation = mismatch.attestation;
      await expect(verifyingDelivery.verifyExternalOperation(
        COMPANY_ID,
        issueId,
        created.operation.id,
        { actorType: "agent" },
      )).rejects.toThrow(mismatch.message);
      expect((await verifyingDelivery.getSnapshot(COMPANY_ID, issueId)).stages.ci.eventId).toBeNull();
    }

    attestation = {
      workflowPath: GITHUB_WORKFLOW_PATH,
      workflowBlobSha: GITHUB_WORKFLOW_BLOB_SHA,
      workflowEvent: GITHUB_WORKFLOW_EVENT,
    };
    const verified = await verifyingDelivery.verifyExternalOperation(
      COMPANY_ID,
      issueId,
      created.operation.id,
      { actorType: "agent" },
    );
    expect(verified).toMatchObject({
      candidateMismatch: false,
      operation: { state: "succeeded", verificationStatus: "verified" },
      event: { authority: "provider_verified", stage: "ci", state: "succeeded" },
    });
    expect((await verifyingDelivery.getSnapshot(COMPANY_ID, issueId)).stages.ci).toMatchObject({
      state: "succeeded",
      authority: "provider_verified",
      candidateSha: SHA,
    });
  });

  it("rejects inconsistent provider state tuples before they can create green evidence", async () => {
    const externalId = `invalid-tuple-${randomUUID()}`;
    const verifier: ExternalOperationVerifier = {
      provider: "cloudflare",
      kind: "cloudflare_pages_deployment",
      async verify() {
        return {
          provider: "cloudflare",
          externalId,
          operationState: "running",
          eventState: "succeeded",
          candidateSha: SHA,
          environment: "production",
          url: "https://paperclip.pages.dev",
          observedAt: new Date(Date.now() + 1_000),
          summary: "Impossible green running state",
          metadata: { status: "building", accountId: "account-1", projectName: "paperclip" },
        };
      },
    };
    const delivery = deliveryService(db, {
      verifiers: new Map([["cloudflare:cloudflare_pages_deployment", verifier]]),
      resolveCredential: async () => ({ credential: "test-only" }),
    });
    const created = await delivery.createExternalOperation(
      COMPANY_ID,
      ISSUE_ID,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId,
        candidateSha: SHA,
        environment: "production",
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      { actorType: "agent" },
    );

    await expect(delivery.verifyExternalOperation(
      COMPANY_ID,
      ISSUE_ID,
      created.operation.id,
      { actorType: "agent" },
    )).rejects.toMatchObject({ details: expect.objectContaining({ code: "provider_state_tuple_invalid" }) });
    expect(await db.select().from(deliveryEvents).where(eq(deliveryEvents.providerExternalId, externalId))).toHaveLength(0);
  });

  it("re-arms an exhausted factory controller from fresh nonterminal provider evidence", async () => {
    const externalId = `rearm-${randomUUID()}`;
    const verifier: ExternalOperationVerifier = {
      provider: "cloudflare",
      kind: "cloudflare_pages_deployment",
      async verify() {
        return {
          provider: "cloudflare",
          externalId,
          operationState: "running",
          eventState: "pending",
          candidateSha: SHA,
          environment: "production",
          url: "https://paperclip.pages.dev",
          observedAt: new Date(Date.now() + 1_000),
          summary: "Fresh provider progress",
          metadata: { status: "building", accountId: "account-1", projectName: "paperclip" },
        };
      },
    };
    const delivery = deliveryService(db, {
      verifiers: new Map([["cloudflare:cloudflare_pages_deployment", verifier]]),
      resolveCredential: async () => ({ credential: "test-only" }),
    });
    const created = await delivery.createExternalOperation(
      COMPANY_ID,
      ISSUE_ID,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId,
        candidateSha: SHA,
        environment: "production",
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      { actorType: "agent" },
    );
    await db.update(externalOperations).set({
      nextCheckAt: null,
      timeoutAt: new Date(Date.now() + 60 * 60_000),
      verificationStatus: "error",
      metadata: {
        ...(created.operation.metadata ?? {}),
        paperclipController: {
          attemptCount: 3,
          maxAttempts: 3,
          attemptMinutes: [2, 10, 30],
          evidenceFingerprint: "old-provider-evidence",
          status: "exhausted",
        },
      },
    }).where(eq(externalOperations.id, created.operation.id));

    const verified = await delivery.verifyExternalOperation(
      COMPANY_ID,
      ISSUE_ID,
      created.operation.id,
      { actorType: "agent" },
    );
    expect(verified.operation).toMatchObject({ state: "running", verificationStatus: "verified" });
    expect(verified.operation.nextCheckAt!.getTime() - verified.operation.lastVerifiedAt!.getTime()).toBe(2 * 60_000);
    expect(verified.operation.metadata).toMatchObject({
      paperclipController: { attemptCount: 0, scheduleIndex: 0, status: "waiting" },
    });
  });

  it("commits provider operation state and its ledger event atomically", async () => {
    const externalId = `atomic-${randomUUID()}`;
    const verifier: ExternalOperationVerifier = {
      provider: "cloudflare",
      kind: "cloudflare_pages_deployment",
      async verify() {
        return {
          provider: "cloudflare",
          externalId,
          operationState: "succeeded",
          eventState: "succeeded",
          candidateSha: SHA,
          environment: "production",
          url: "https://paperclip.pages.dev",
          observedAt: new Date(Date.now() + 1_000),
          summary: "Provider success",
          metadata: { status: "success", accountId: "account-1", projectName: "paperclip" },
        };
      },
    };
    const delivery = deliveryService(db, {
      verifiers: new Map([["cloudflare:cloudflare_pages_deployment", verifier]]),
      resolveCredential: async () => ({ credential: "test-only" }),
    });
    const created = await delivery.createExternalOperation(
      COMPANY_ID,
      ISSUE_ID,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId,
        candidateSha: SHA,
        environment: "production",
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      { actorType: "agent" },
    );
    await db.execute(sql`
      CREATE FUNCTION delivery_test_reject_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'test delivery append failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER delivery_test_reject_insert
      BEFORE INSERT ON delivery_events
      FOR EACH ROW EXECUTE FUNCTION delivery_test_reject_insert()
    `);
    try {
      await expect(delivery.verifyExternalOperation(
        COMPANY_ID,
        ISSUE_ID,
        created.operation.id,
        { actorType: "agent" },
      )).rejects.toBeTruthy();
      const persisted = await delivery.getExternalOperation(COMPANY_ID, ISSUE_ID, created.operation.id);
      expect(persisted).toMatchObject({ state: "unknown", verificationStatus: "unverified", lastVerifiedAt: null });
      expect(await db.select().from(deliveryEvents).where(eq(deliveryEvents.providerExternalId, externalId))).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS delivery_test_reject_insert ON delivery_events`);
      await db.execute(sql`DROP FUNCTION IF EXISTS delivery_test_reject_insert()`);
    }
  });

  it("backfills legacy work products as unverified and remains idempotent", async () => {
    const [product] = await db.insert(issueWorkProducts).values({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      type: "runtime_service",
      provider: "cloudflare",
      externalId: "legacy-deploy-1",
      title: "Legacy deployment",
      url: "https://legacy.pages.dev",
      status: "active",
    }).returning();
    const delivery = deliveryService(db);
    const first = await delivery.backfillLegacyWorkProducts(COMPANY_ID, ISSUE_ID, [product!.id]);
    const second = await delivery.backfillLegacyWorkProducts(COMPANY_ID, ISSUE_ID, [product!.id]);

    expect(first.appended).toHaveLength(1);
    expect(first.appended[0]).toMatchObject({
      authority: "legacy_unverified",
      sourceKind: "legacy_backfill",
      sourceWorkProductId: product!.id,
    });
    expect(second.appended).toHaveLength(0);
    await db.delete(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
    const persistedEvent = await db
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.id, first.appended[0]!.id))
      .then((rows) => rows[0]);
    expect(persistedEvent?.sourceWorkProductId).toBeNull();
  });

  it("records provider truth without accepting the agent's expected candidate as verification", async () => {
    const observedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const observedAt = new Date(Date.now() + 1_000);
    const verifier: ExternalOperationVerifier = {
      provider: "cloudflare",
      kind: "cloudflare_pages_deployment",
      async verify() {
        return {
          provider: "cloudflare",
          externalId: "2268dd54-02f6-4e86-b0cb-e93ae75b92ca",
          operationState: "succeeded",
          eventState: "succeeded",
          candidateSha: observedSha,
          environment: "production",
          url: "https://paperclip.pages.dev",
          observedAt,
          summary: "Provider says the run succeeded",
          metadata: { status: "success", accountId: "account-1", projectName: "paperclip" },
        };
      },
    };
    const delivery = deliveryService(db, {
      verifiers: new Map([["cloudflare:cloudflare_pages_deployment", verifier]]),
      resolveCredential: async () => ({ credential: "test-only" }),
    });
    const created = await delivery.createExternalOperation(
      COMPANY_ID,
      ISSUE_ID,
      {
        kind: "cloudflare_pages_deployment",
        provider: "cloudflare",
        stage: "deployment",
        externalId: "2268dd54-02f6-4e86-b0cb-e93ae75b92ca",
        candidateSha: SHA,
        environment: "production",
        metadata: { accountId: "account-1", projectName: "paperclip" },
      },
      { actorType: "agent" },
    );
    const verified = await delivery.verifyExternalOperation(
      COMPANY_ID,
      ISSUE_ID,
      created.operation.id,
      { actorType: "agent" },
    );
    const repeated = await delivery.verifyExternalOperation(
      COMPANY_ID,
      ISSUE_ID,
      created.operation.id,
      { actorType: "agent" },
    );

    expect(verified).toMatchObject({
      candidateMismatch: true,
      eventCreated: true,
      operation: { verificationStatus: "mismatch", state: "succeeded" },
      event: {
        authority: "provider_verified",
        sourceKind: "provider_observation",
        candidateSha: observedSha,
      },
    });
    expect(repeated.eventCreated).toBe(false);
  });
});
