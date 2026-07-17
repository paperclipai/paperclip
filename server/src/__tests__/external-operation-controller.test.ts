import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  deliveryEvents,
  externalOperations,
  heartbeatRuns,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  EXTERNAL_OPERATION_CONTROLLER_BASE_RECHECK_MS,
  heartbeatService,
} from "../services/heartbeat.js";
import { deliveryService } from "../services/delivery.js";
import type { ExternalOperationVerifier } from "../services/delivery-verifiers.js";

const CANDIDATE_SHA = "5fa761a27c7d8cfc285057e6997b04b9831a07c4";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external-operation controller tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("external operation controller", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-operation-controller-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `EO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "External Operation Controller Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Delivery Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Verify deployment",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function insertOperation(input: {
    companyId: string;
    issueId: string;
    nextCheckAt: Date;
    timeoutAt?: Date | null;
    maxAttempts?: number;
    attemptCount?: number;
    attemptMinutes?: number[];
    evidenceFingerprint?: string | null;
    scheduleIndex?: number;
    scheduleStartedAt?: Date;
    createdAt?: Date;
    candidateSha?: string | null;
    stage?: string;
    provider?: string;
  }) {
    const id = randomUUID();
    await db.insert(externalOperations).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "custom",
      provider: input.provider ?? "test-provider-without-verifier",
      stage: input.stage ?? "deployment",
      externalId: `deployment-${id}`,
      candidateSha: input.candidateSha ?? null,
      environment: "production",
      nextCheckAt: input.nextCheckAt,
      timeoutAt: input.timeoutAt ?? null,
      metadata: {
        paperclipController: {
          ...(input.attemptCount === undefined ? {} : { attemptCount: input.attemptCount }),
          ...(input.attemptMinutes === undefined ? {} : { attemptMinutes: input.attemptMinutes }),
          ...(input.evidenceFingerprint === undefined
            ? {}
            : { evidenceFingerprint: input.evidenceFingerprint }),
          ...(input.scheduleIndex === undefined ? {} : { scheduleIndex: input.scheduleIndex }),
          ...(input.scheduleStartedAt === undefined
            ? {}
            : { scheduleStartedAt: input.scheduleStartedAt.toISOString() }),
          maxAttempts: input.maxAttempts ?? 10,
        },
      },
      ...(input.createdAt === undefined
        ? {}
        : { createdAt: input.createdAt, updatedAt: input.createdAt }),
    });
    return id;
  }

  async function seedGreenDelivery(input: {
    companyId: string;
    issueId: string;
    provider?: string;
    stage?: string;
    authority?: "provider_verified" | "agent_claim";
  }) {
    const id = randomUUID();
    await db.insert(deliveryEvents).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      stage: input.stage ?? "deployment",
      state: "succeeded",
      candidateSha: CANDIDATE_SHA,
      environment: "production",
      provider: input.provider ?? "test-provider-without-verifier",
      providerExternalId: `green-${id}`,
      sourceKind: input.authority === "agent_claim" ? "agent_submission" : "provider_observation",
      authority: input.authority ?? "provider_verified",
      summary: "Provider previously reported success",
      sourceFingerprint: `test-green:${id}`,
    });
    return id;
  }

  it("claims a due operation only once across concurrent controller passes", async () => {
    const seeded = await seedIssue();
    const now = new Date("2026-07-17T01:00:00.000Z");
    const operationId = await insertOperation({
      ...seeded,
      nextCheckAt: new Date(now.getTime() - 1_000),
      maxAttempts: 1,
      candidateSha: CANDIDATE_SHA,
    });
    await seedGreenDelivery({ ...seeded, authority: "agent_claim" });
    const heartbeat = heartbeatService(db);

    const passes = await Promise.all([
      heartbeat.reconcileDueExternalOperations({ now }),
      heartbeat.reconcileDueExternalOperations({ now }),
    ]);

    expect(passes.reduce((sum, pass) => sum + pass.claimed, 0)).toBe(1);
    expect(passes.reduce((sum, pass) => sum + pass.failed, 0)).toBe(1);
    const operation = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(operation.nextCheckAt).toBeNull();
    expect(operation.state).toBe("failed");
    expect(operation.terminalAt?.toISOString()).toBe(now.toISOString());
    expect(operation.verificationStatus).toBe("error");
    expect(operation.lastVerificationError).toContain("No provider verifier");
    expect(operation.metadata).toMatchObject({
      paperclipController: {
        attemptCount: 1,
        maxAttempts: 1,
        status: "exhausted",
      },
    });
    const snapshot = await deliveryService(db).getSnapshot(seeded.companyId, seeded.issueId);
    expect(snapshot.stages.deployment).toMatchObject({
      state: "unknown",
      authority: "paperclip_verified",
      candidateSha: CANDIDATE_SHA,
    });
    const correction = await db
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.id, snapshot.stages.deployment.eventId!))
      .then((rows) => rows[0]!);
    expect(correction).toMatchObject({
      stage: "deployment",
      candidateSha: CANDIDATE_SHA,
      supersedesEventId: null,
      metadata: expect.objectContaining({
        operationId,
        paperclipController: expect.objectContaining({
          outcome: "exhausted",
          verificationError: expect.stringContaining("No provider verifier"),
        }),
      }),
    });
  });

  it("does not let an expired verifier claim overwrite a newer controller owner", async () => {
    const seeded = await seedIssue();
    const now = new Date(Date.now() - 60_000);
    const operationId = await insertOperation({
      ...seeded,
      createdAt: new Date(now.getTime() - 60_000),
      nextCheckAt: new Date(now.getTime() - 1_000),
      timeoutAt: new Date(now.getTime() + 60 * 60_000),
      maxAttempts: 3,
      candidateSha: CANDIDATE_SHA,
      provider: "slow-provider",
    });
    let markVerifierStarted!: () => void;
    const verifierStarted = new Promise<void>((resolve) => {
      markVerifierStarted = resolve;
    });
    let releaseVerifier!: () => void;
    const verifierRelease = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const verifier: ExternalOperationVerifier = {
      provider: "slow-provider",
      kind: "custom",
      async verify({ operation }) {
        markVerifierStarted();
        await verifierRelease;
        return {
          provider: operation.provider,
          externalId: operation.externalId,
          operationState: "running",
          eventState: "pending",
          candidateSha: operation.candidateSha,
          environment: operation.environment,
          url: operation.url,
          observedAt: now,
          summary: "Slow provider returned after its controller lease was replaced",
          metadata: { providerState: "running" },
        };
      },
    };
    const heartbeat = heartbeatService(db, {
      externalOperationVerifiers: new Map([["slow-provider:custom", verifier]]),
      externalOperationCredentialResolver: async () => ({ credential: "test-only" }),
    });

    const passPromise = heartbeat.reconcileDueExternalOperations({ now });
    await verifierStarted;
    const claimed = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    const claimedMetadata = claimed.metadata ?? {};
    const claimedController = claimedMetadata.paperclipController as Record<string, unknown>;
    const newerNextCheckAt = new Date(now.getTime() + 10 * 60_000);
    await db
      .update(externalOperations)
      .set({
        nextCheckAt: newerNextCheckAt,
        metadata: {
          ...claimedMetadata,
          paperclipController: {
            ...claimedController,
            claimToken: "newer-controller-owner",
            status: "verifying",
          },
        },
        updatedAt: new Date(now.getTime() + 1),
      })
      .where(eq(externalOperations.id, operationId));
    releaseVerifier();

    const result = await passPromise;
    expect(result).toMatchObject({ claimed: 1, failed: 1, skipped: 1, exhausted: 0 });
    const operation = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(operation.nextCheckAt?.toISOString()).toBe(newerNextCheckAt.toISOString());
    expect(operation.metadata).toMatchObject({
      paperclipController: {
        claimToken: "newer-controller-owner",
        attemptCount: 0,
        status: "verifying",
      },
    });
    const corrections = await db
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.issueId, seeded.issueId));
    expect(corrections.some((event) => event.authority === "paperclip_verified")).toBe(false);
  });

  it("backs off after a verification error and stops at the configured attempt bound", async () => {
    const seeded = await seedIssue();
    const now = new Date("2026-07-17T02:00:00.000Z");
    const operationId = await insertOperation({
      ...seeded,
      nextCheckAt: new Date(now.getTime() - 1_000),
      maxAttempts: 2,
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileDueExternalOperations({ now });
    expect(first).toMatchObject({ claimed: 1, failed: 1, rescheduled: 1, exhausted: 0 });
    const afterFirst = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(afterFirst.nextCheckAt?.getTime()).toBe(
      now.getTime() + EXTERNAL_OPERATION_CONTROLLER_BASE_RECHECK_MS,
    );

    const second = await heartbeat.reconcileDueExternalOperations({
      now: new Date(afterFirst.nextCheckAt!.getTime() + 1),
    });
    expect(second).toMatchObject({ claimed: 1, failed: 1, rescheduled: 0, exhausted: 1 });
    const afterSecond = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(afterSecond.nextCheckAt).toBeNull();
    expect(afterSecond.state).toBe("failed");
    expect(afterSecond.terminalAt).not.toBeNull();
    expect(afterSecond.metadata).toMatchObject({
      paperclipController: { attemptCount: 2, maxAttempts: 2, status: "exhausted" },
    });
  });

  it("runs every server-stamped factory poll at its absolute operation-age offset", async () => {
    const seeded = await seedIssue();
    const createdAt = new Date("2026-07-17T02:30:00.000Z");
    const firstAttemptAt = new Date(createdAt.getTime() + 2 * 60_000);
    const secondAttemptAt = new Date(createdAt.getTime() + 10 * 60_000);
    const thirdAttemptAt = new Date(createdAt.getTime() + 30 * 60_000);
    const operationId = await insertOperation({
      ...seeded,
      createdAt,
      nextCheckAt: firstAttemptAt,
      timeoutAt: new Date(createdAt.getTime() + 2 * 60 * 60_000),
      maxAttempts: 3,
      attemptMinutes: [2, 10, 30],
    });
    const heartbeat = heartbeatService(db);

    const early = await heartbeat.reconcileDueExternalOperations({
      now: new Date(firstAttemptAt.getTime() - 1),
    });
    expect(early).toMatchObject({ inspected: 0, claimed: 0 });

    const first = await heartbeat.reconcileDueExternalOperations({ now: firstAttemptAt });
    expect(first).toMatchObject({ claimed: 1, failed: 1, rescheduled: 1, exhausted: 0 });
    const afterFirst = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(afterFirst.lastVerifiedAt?.toISOString()).toBe(firstAttemptAt.toISOString());
    expect(afterFirst.nextCheckAt?.toISOString()).toBe(secondAttemptAt.toISOString());

    const second = await heartbeat.reconcileDueExternalOperations({ now: secondAttemptAt });
    expect(second).toMatchObject({ claimed: 1, failed: 1, rescheduled: 1, exhausted: 0 });
    const afterSecond = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(afterSecond.lastVerifiedAt?.toISOString()).toBe(secondAttemptAt.toISOString());
    expect(afterSecond.nextCheckAt?.toISOString()).toBe(thirdAttemptAt.toISOString());
    expect(afterSecond.metadata).toMatchObject({
      paperclipController: {
        attemptCount: 2,
        maxAttempts: 3,
        attemptMinutes: [2, 10, 30],
      },
    });

    const third = await heartbeat.reconcileDueExternalOperations({ now: thirdAttemptAt });
    expect(third).toMatchObject({ claimed: 1, failed: 1, rescheduled: 0, exhausted: 1 });
    const afterThird = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(afterThird.lastVerifiedAt?.toISOString()).toBe(thirdAttemptAt.toISOString());
    expect(afterThird.nextCheckAt).toBeNull();
    expect(afterThird.state).toBe("failed");
    expect(afterThird.terminalAt?.toISOString()).toBe(thirdAttemptAt.toISOString());
    expect(afterThird.metadata).toMatchObject({
      paperclipController: {
        attemptCount: 3,
        maxAttempts: 3,
        attemptMinutes: [2, 10, 30],
        status: "exhausted",
      },
    });
  });

  it("terminalizes a due operation when its explicit timeout has elapsed", async () => {
    const seeded = await seedIssue();
    const now = new Date("2026-07-17T03:00:00.000Z");
    const operationId = await insertOperation({
      ...seeded,
      nextCheckAt: new Date(now.getTime() - 2_000),
      timeoutAt: new Date(now.getTime() - 1_000),
      candidateSha: CANDIDATE_SHA,
    });
    const greenEventId = await seedGreenDelivery(seeded);

    const result = await heartbeatService(db).reconcileDueExternalOperations({ now });

    expect(result).toMatchObject({ claimed: 0, terminal: 1, timedOut: 1, failed: 0 });
    const operation = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(operation).toMatchObject({
      state: "timed_out",
      verificationStatus: "error",
      nextCheckAt: null,
    });
    expect(operation.terminalAt?.toISOString()).toBe(now.toISOString());
    const snapshot = await deliveryService(db).getSnapshot(seeded.companyId, seeded.issueId);
    expect(snapshot.stages.deployment).toMatchObject({
      state: "succeeded",
      authority: "provider_verified",
      candidateSha: CANDIDATE_SHA,
      eventId: greenEventId,
    });
    const correction = await db
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.authority, "paperclip_verified"))
      .then((rows) => rows.find((row) => row.issueId === seeded.issueId)!);
    expect(correction).toMatchObject({
      state: "unknown",
      supersedesEventId: null,
      metadata: expect.objectContaining({
        operationId,
        paperclipController: expect.objectContaining({
          outcome: "timed_out",
          stage: "deployment",
          candidateSha: CANDIDATE_SHA,
        }),
      }),
    });
  });

  it("keeps a healthy unchanged running provider live after every recovery offset is consumed", async () => {
    const seeded = await seedIssue();
    const createdAt = new Date(Date.now() - 40 * 60_000);
    const providerObservedAt = new Date(createdAt.getTime() + 60_000);
    const firstAttemptAt = new Date(createdAt.getTime() + 2 * 60_000);
    const secondAttemptAt = new Date(createdAt.getTime() + 10 * 60_000);
    const thirdAttemptAt = new Date(createdAt.getTime() + 30 * 60_000);
    const operationId = await insertOperation({
      ...seeded,
      createdAt,
      nextCheckAt: firstAttemptAt,
      timeoutAt: new Date(createdAt.getTime() + 3 * 60 * 60_000),
      maxAttempts: 1,
      attemptMinutes: [2, 10, 30],
      scheduleIndex: 0,
      scheduleStartedAt: createdAt,
      candidateSha: CANDIDATE_SHA,
      provider: "nonterminal-provider",
    });
    const verifier: ExternalOperationVerifier = {
      provider: "nonterminal-provider",
      kind: "custom",
      async verify({ operation }) {
        return {
          provider: operation.provider,
          externalId: operation.externalId,
          operationState: "running",
          eventState: "pending",
          candidateSha: operation.candidateSha,
          environment: operation.environment,
          url: operation.url,
          observedAt: providerObservedAt,
          summary: "Provider still reports a nonterminal operation",
          metadata: { providerState: "running" },
        };
      },
    };
    const heartbeat = heartbeatService(db, {
      externalOperationVerifiers: new Map([["nonterminal-provider:custom", verifier]]),
      externalOperationCredentialResolver: async () => ({ credential: "test-only" }),
    });

    const first = await heartbeat.reconcileDueExternalOperations({ now: firstAttemptAt });
    expect(first).toMatchObject({ claimed: 1, verified: 1, exhausted: 0, rescheduled: 1, failed: 0 });
    const second = await heartbeat.reconcileDueExternalOperations({ now: secondAttemptAt });
    expect(second).toMatchObject({ claimed: 1, verified: 1, exhausted: 0, rescheduled: 1, failed: 0 });
    const third = await heartbeat.reconcileDueExternalOperations({ now: thirdAttemptAt });
    expect(third).toMatchObject({ claimed: 1, verified: 1, exhausted: 0, rescheduled: 1, failed: 0 });
    const operation = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(operation.verificationStatus).toBe("verified");
    expect(operation.nextCheckAt?.toISOString()).toBe(
      new Date(thirdAttemptAt.getTime() + 30 * 60_000).toISOString(),
    );
    expect(operation.metadata).toMatchObject({
      paperclipController: {
        attemptCount: 0,
        maxAttempts: 1,
        pollCount: 3,
        scheduleIndex: 3,
        status: "waiting",
      },
    });
    const snapshot = await deliveryService(db).getSnapshot(seeded.companyId, seeded.issueId);
    expect(snapshot.stages.deployment).toMatchObject({
      state: "pending",
      authority: "provider_verified",
      candidateSha: CANDIDATE_SHA,
      provider: "nonterminal-provider",
    });
    const events = await db
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.issueId, seeded.issueId));
    expect(events.filter((event) => event.authority === "provider_verified")).toHaveLength(1);
    expect(events.some((event) => event.authority === "paperclip_verified")).toBe(false);
  });

  it("resets the per-fingerprint failure budget and schedule when provider evidence advances", async () => {
    const seeded = await seedIssue();
    const createdAt = new Date(Date.now() - 40 * 60_000);
    const now = new Date(createdAt.getTime() + 30 * 60_000);
    const operationId = await insertOperation({
      ...seeded,
      createdAt,
      nextCheckAt: now,
      timeoutAt: new Date(createdAt.getTime() + 3 * 60 * 60_000),
      maxAttempts: 3,
      attemptCount: 2,
      attemptMinutes: [2, 10, 30],
      evidenceFingerprint: "old-provider-evidence",
      scheduleIndex: 2,
      scheduleStartedAt: createdAt,
      candidateSha: CANDIDATE_SHA,
      provider: "advancing-provider",
    });
    const verifier: ExternalOperationVerifier = {
      provider: "advancing-provider",
      kind: "custom",
      async verify({ operation }) {
        return {
          provider: operation.provider,
          externalId: operation.externalId,
          operationState: "running",
          eventState: "pending",
          candidateSha: operation.candidateSha,
          environment: operation.environment,
          url: operation.url,
          observedAt: new Date(now.getTime() - 60_000),
          summary: "Provider emitted newer running evidence",
          metadata: { providerState: "running", providerRevision: 2 },
        };
      },
    };
    const heartbeat = heartbeatService(db, {
      externalOperationVerifiers: new Map([["advancing-provider:custom", verifier]]),
      externalOperationCredentialResolver: async () => ({ credential: "test-only" }),
    });

    const result = await heartbeat.reconcileDueExternalOperations({ now });

    expect(result).toMatchObject({ claimed: 1, verified: 1, exhausted: 0, rescheduled: 1, failed: 0 });
    const operation = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    const providerEvent = await db
      .select()
      .from(deliveryEvents)
      .where(eq(deliveryEvents.issueId, seeded.issueId))
      .then((rows) => rows.find((event) => event.authority === "provider_verified")!);
    expect(operation.nextCheckAt?.toISOString()).toBe(
      new Date(now.getTime() + 2 * 60_000).toISOString(),
    );
    expect(operation.metadata).toMatchObject({
      paperclipController: {
        attemptCount: 0,
        maxAttempts: 3,
        evidenceFingerprint: providerEvent.sourceFingerprint,
        evidenceFingerprintEventId: providerEvent.id,
        scheduleIndex: 0,
        scheduleStartedAt: now.toISOString(),
        status: "waiting",
      },
    });
  });

  it("does not claim or advance a due operation under a formal pause hold", async () => {
    const seeded = await seedIssue();
    const now = new Date("2026-07-17T03:45:00.000Z");
    const operationId = await insertOperation({
      ...seeded,
      nextCheckAt: new Date(now.getTime() - 1_000),
      timeoutAt: new Date(now.getTime() + 30 * 60_000),
      maxAttempts: 1,
    });
    await db.insert(issueTreeHolds).values({
      companyId: seeded.companyId,
      rootIssueId: seeded.issueId,
      mode: "pause",
      status: "active",
      reason: "Board decision pending",
      createdByActorType: "user",
      createdByUserId: "board-user",
    });

    const result = await heartbeatService(db).reconcileDueExternalOperations({ now });

    expect(result).toMatchObject({
      inspected: 1,
      claimed: 0,
      held: 1,
      verified: 0,
      terminal: 0,
      skipped: 1,
    });
    const operation = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(operation.nextCheckAt?.toISOString()).toBe(new Date(now.getTime() - 1_000).toISOString());
    expect(operation.verificationStatus).toBe("unverified");
    expect(operation.metadata).toMatchObject({
      paperclipController: { maxAttempts: 1 },
    });
    expect(await db.select().from(deliveryEvents)).toHaveLength(0);
  });

  it("does not claim or advance a due operation under a formal cancel hold", async () => {
    const seeded = await seedIssue();
    const now = new Date("2026-07-17T03:47:00.000Z");
    const operationId = await insertOperation({
      ...seeded,
      nextCheckAt: new Date(now.getTime() - 1_000),
      timeoutAt: new Date(now.getTime() + 30 * 60_000),
      maxAttempts: 1,
    });
    await db.insert(issueTreeHolds).values({
      companyId: seeded.companyId,
      rootIssueId: seeded.issueId,
      mode: "cancel",
      status: "active",
      reason: "Board cancelled this delivery tree",
      createdByActorType: "user",
      createdByUserId: "board-user",
    });

    const result = await heartbeatService(db).reconcileDueExternalOperations({ now });

    expect(result).toMatchObject({
      inspected: 1,
      claimed: 0,
      held: 1,
      verified: 0,
      terminal: 0,
      skipped: 1,
    });
    const operation = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(operation.nextCheckAt?.toISOString()).toBe(new Date(now.getTime() - 1_000).toISOString());
    expect(operation.verificationStatus).toBe("unverified");
    expect(operation.metadata).toMatchObject({
      paperclipController: { maxAttempts: 1 },
    });
    expect(await db.select().from(deliveryEvents)).toHaveLength(0);
  });

  it("serializes a controller claim behind concurrent explicit-hold creation", async () => {
    const seeded = await seedIssue();
    const now = new Date("2026-07-17T03:50:00.000Z");
    const originalNextCheckAt = new Date(now.getTime() - 1_000);
    const operationId = await insertOperation({
      ...seeded,
      nextCheckAt: originalNextCheckAt,
      timeoutAt: new Date(now.getTime() + 30 * 60_000),
      maxAttempts: 1,
    });
    let markHoldLockAcquired!: () => void;
    const holdLockAcquired = new Promise<void>((resolve) => {
      markHoldLockAcquired = resolve;
    });
    let releaseHoldCommit!: () => void;
    const holdCommitRelease = new Promise<void>((resolve) => {
      releaseHoldCommit = resolve;
    });
    const holdCreation = db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${`${seeded.companyId}:${seeded.issueId}:delivery`}, 0)
      )`);
      markHoldLockAcquired();
      await holdCommitRelease;
      await tx.insert(issueTreeHolds).values({
        companyId: seeded.companyId,
        rootIssueId: seeded.issueId,
        mode: "pause",
        status: "active",
        reason: "Concurrent board hold",
        createdByActorType: "user",
        createdByUserId: "board-user",
      });
    });
    await holdLockAcquired;

    let controllerResolved = false;
    const controllerPass = heartbeatService(db)
      .reconcileDueExternalOperations({ now })
      .then((result) => {
        controllerResolved = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controllerResolved).toBe(false);
    releaseHoldCommit();
    await holdCreation;

    const result = await controllerPass;
    expect(result).toMatchObject({ inspected: 1, claimed: 0, held: 1, skipped: 1 });
    const operation = await db
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .then((rows) => rows[0]!);
    expect(operation.nextCheckAt?.toISOString()).toBe(originalNextCheckAt.toISOString());
    expect(operation.metadata).toMatchObject({
      paperclipController: { maxAttempts: 1 },
    });
  });

  it("treats a scheduled external operation as a live waiting path", async () => {
    const seeded = await seedIssue();
    const now = new Date();
    await insertOperation({
      ...seeded,
      nextCheckAt: new Date(now.getTime() + 5 * 60_000),
      timeoutAt: new Date(now.getTime() + 30 * 60_000),
    });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({
      skipped: 1,
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      externalOperationController: { inspected: 0 },
    });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("suppresses issue-graph escalation while a bounded external check is scheduled", async () => {
    const seeded = await seedIssue();
    const now = new Date();
    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: now })
      .where(eq(issues.id, seeded.issueId));
    await insertOperation({
      ...seeded,
      nextCheckAt: new Date(now.getTime() + 5 * 60_000),
      timeoutAt: new Date(now.getTime() + 30 * 60_000),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness({ force: true });

    expect(result).toMatchObject({
      findings: 1,
      escalationsCreated: 0,
      boardEscalationsCreated: 0,
      skippedPendingExternalOperation: 1,
      skipped: 1,
    });
    const escalations = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "harness_liveness_escalation"));
    expect(escalations).toHaveLength(0);
  });

  it.each([
    {
      label: "an unbounded timeout",
      operation: (now: Date) => ({
        nextCheckAt: new Date(now.getTime() + 5 * 60_000),
        timeoutAt: null,
      }),
    },
    {
      label: "an exhausted attempt budget",
      operation: (now: Date) => ({
        nextCheckAt: new Date(now.getTime() + 5 * 60_000),
        timeoutAt: new Date(now.getTime() + 30 * 60_000),
        attemptCount: 3,
        maxAttempts: 3,
      }),
    },
    {
      label: "a next check beyond its timeout",
      operation: (now: Date) => ({
        nextCheckAt: new Date(now.getTime() + 31 * 60_000),
        timeoutAt: new Date(now.getTime() + 30 * 60_000),
      }),
    },
  ])("does not let $label mask issue-graph recovery", async ({ operation }) => {
    const seeded = await seedIssue();
    const now = new Date();
    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: now })
      .where(eq(issues.id, seeded.issueId));
    await insertOperation({ ...seeded, ...operation(now) });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness({ force: true });

    expect(result).toMatchObject({
      findings: 1,
      escalationsCreated: 0,
      boardEscalationsCreated: 1,
      skippedPendingExternalOperation: 0,
    });
  });
});
