import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  deliveryRepairAttempts,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  readExecutableRepairIntent,
} from "../services/recovery/executable-repair-intent.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres delivery repair-intent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const REASON = "review_blocking_findings";

describeEmbeddedPostgres("delivery repair intent is fenced by the persisted candidate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-repair-intent-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(deliveryRepairAttempts);
    await db.delete(deliveryUnitIssues);
    await db.delete(deliveryUnits);
    await db.delete(deliveryRepositories);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: {
    unitStatus?: string;
    unitGeneration?: number;
    unitHeadSha?: string | null;
    unitPaused?: boolean;
    attemptGeneration?: number;
    attemptHeadSha?: string | null;
    attemptStatus?: string;
    attemptCount?: number;
    ownedByOtherAgent?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const repositoryId = randomUUID();
    const unitId = randomUUID();
    const otherAgentId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Delivery project" });
    for (const [id, name] of [[agentId, "Owner"], [otherAgentId, "Other"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Delivery repair issue",
      description: "Fixture issue for repair intent.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "responsible-user",
      identifier: `T-${issueId.slice(0, 6)}`,
    });
    await db.insert(deliveryRepositories).values({
      id: repositoryId,
      companyId,
      provider: "github",
      host: "github.com",
      owner: "example",
      name: `repo-${repositoryId.slice(0, 8)}`,
    });
    await db.insert(deliveryUnits).values({
      id: unitId,
      companyId,
      projectId,
      repositoryId,
      primaryIssueId: issueId,
      targetBranch: "main",
      sourceBranch: `delivery/${issueId}`,
      status: input.unitStatus ?? "blocked",
      headSha: input.unitHeadSha === undefined ? HEAD_A : input.unitHeadSha,
      candidateGeneration: input.unitGeneration ?? 2,
      ownerAgentId: input.ownedByOtherAgent ? otherAgentId : agentId,
      ...(input.unitPaused ? { pausedAt: now } : {}),
    });
    await db.insert(deliveryUnitIssues).values({
      companyId,
      unitId,
      issueId,
      role: "primary",
    });
    const attempt = input.attemptCount ?? 1;
    await db.insert(deliveryRepairAttempts).values({
      companyId,
      unitId,
      reasonCode: REASON,
      attempt,
      status: input.attemptStatus ?? "dispatched",
      candidateGeneration: input.attemptGeneration ?? 2,
      headSha: input.attemptHeadSha === undefined ? HEAD_A : input.attemptHeadSha,
      ownerAgentId: agentId,
    });
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    const carrier = {
      unitId,
      candidateGeneration: input.attemptGeneration ?? 2,
      headSha: HEAD_A,
      reasonCode: REASON,
      attempt,
    };
    return { companyId, agentId, otherAgentId, issueId, unitId, issue, carrier };
  }

  function intentInput(seedResult: Awaited<ReturnType<typeof seed>>, context: Record<string, unknown>, agentId?: string) {
    return {
      companyId: seedResult.companyId,
      issueId: seedResult.issueId,
      agentId: agentId ?? seedResult.agentId,
      issue: seedResult.issue,
      context,
    };
  }

  it("accepts a declared intent whose attempt row still matches its generation and head", async () => {
    const seeded = await seed();
    await expect(
      readExecutableRepairIntent(db, intentInput(seeded, { deliveryRepair: seeded.carrier })),
    ).resolves.toEqual({
      kind: "delivery_repair",
      unitId: seeded.unitId,
      candidateGeneration: 2,
      headSha: HEAD_A,
      reasonCode: REASON,
      attempt: 1,
      declared: true,
    });
  });

  it("rejects a declared intent when the attempt row is from an older generation of the same head", async () => {
    // A -> B -> A: the unit is back at generation 2 / head A, but the attempt
    // that woke this run was dispatched for generation 1.
    const seeded = await seed({ attemptGeneration: 1 });
    await expect(
      readExecutableRepairIntent(db, intentInput(seeded, { deliveryRepair: seeded.carrier })),
    ).resolves.toBeNull();
  });

  it("rejects a declared intent when the attempt row was dispatched for another head", async () => {
    const seeded = await seed({ attemptHeadSha: HEAD_B });
    await expect(
      readExecutableRepairIntent(db, intentInput(seeded, { deliveryRepair: seeded.carrier })),
    ).resolves.toBeNull();
  });

  it("derives the intent from rows when the wake lost the carrier", async () => {
    const seeded = await seed();
    await expect(
      readExecutableRepairIntent(db, intentInput(seeded, {})),
    ).resolves.toMatchObject({
      kind: "delivery_repair",
      unitId: seeded.unitId,
      candidateGeneration: 2,
      declared: false,
    });
  });

  it("rejects a stale row-derived attempt whose generation moved on", async () => {
    const seeded = await seed({ attemptGeneration: 1 });
    await expect(readExecutableRepairIntent(db, intentInput(seeded, {}))).resolves.toBeNull();
  });

  it("rejects a stale row-derived attempt whose head moved on", async () => {
    const seeded = await seed({ attemptHeadSha: HEAD_B });
    await expect(readExecutableRepairIntent(db, intentInput(seeded, {}))).resolves.toBeNull();
  });

  it("rejects a present but malformed carrier instead of falling back to the rows", async () => {
    const seeded = await seed();
    for (const malformed of [
      { unitId: seeded.unitId, reasonCode: REASON },
      { ...seeded.carrier, candidateGeneration: 0 },
      { ...seeded.carrier, headSha: "not-a-sha" },
      { ...seeded.carrier, attempt: "abc" },
      true,
      "delivery_repair_requested",
    ]) {
      await expect(
        readExecutableRepairIntent(db, intentInput(seeded, { deliveryRepair: malformed })),
        JSON.stringify(malformed),
      ).resolves.toBeNull();
    }
    // The same run without a carrier is still a valid row-derived intent, so the
    // rejection above is the carrier's, not a broken fixture.
    await expect(readExecutableRepairIntent(db, intentInput(seeded, {}))).resolves.not.toBeNull();
  });

  it("rejects a declared intent when the unit no longer matches", async () => {
    const reassigned = await seed();
    await expect(
      readExecutableRepairIntent(db, intentInput(reassigned, { deliveryRepair: reassigned.carrier }, reassigned.otherAgentId)),
    ).resolves.toBeNull();

    const movedHead = await seed({ unitHeadSha: HEAD_B });
    await expect(
      readExecutableRepairIntent(db, intentInput(movedHead, { deliveryRepair: movedHead.carrier })),
    ).resolves.toBeNull();

    const nextGeneration = await seed({ unitGeneration: 3 });
    await expect(
      readExecutableRepairIntent(db, intentInput(nextGeneration, { deliveryRepair: nextGeneration.carrier })),
    ).resolves.toBeNull();
  });

  it("rejects terminal, paused and no-longer-actionable repairs", async () => {
    for (const terminal of ["merged", "cancelled", "closed_unmerged"] as const) {
      const seeded = await seed({ unitStatus: terminal });
      await expect(
        readExecutableRepairIntent(db, intentInput(seeded, { deliveryRepair: seeded.carrier })),
        terminal,
      ).resolves.toBeNull();
      await expect(readExecutableRepairIntent(db, intentInput(seeded, {})), terminal).resolves.toBeNull();
    }

    const paused = await seed({ unitPaused: true });
    await expect(
      readExecutableRepairIntent(db, intentInput(paused, { deliveryRepair: paused.carrier })),
    ).resolves.toBeNull();

    for (const status of ["resolved", "exhausted"] as const) {
      const settled = await seed({ attemptStatus: status });
      await expect(
        readExecutableRepairIntent(db, intentInput(settled, { deliveryRepair: settled.carrier })),
        status,
      ).resolves.toBeNull();
      await expect(readExecutableRepairIntent(db, intentInput(settled, {})), status).resolves.toBeNull();
    }
  });

  it("rejects a repair owned by another agent and a terminal issue", async () => {
    const otherOwner = await seed({ ownedByOtherAgent: true });
    await expect(
      readExecutableRepairIntent(db, intentInput(otherOwner, { deliveryRepair: otherOwner.carrier })),
    ).resolves.toBeNull();

    const terminalIssue = await seed();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, terminalIssue.issueId));
    const reloaded = await db
      .select()
      .from(issues)
      .where(eq(issues.id, terminalIssue.issueId))
      .then((rows) => rows[0]!);
    await expect(
      readExecutableRepairIntent(db, {
        companyId: terminalIssue.companyId,
        issueId: terminalIssue.issueId,
        agentId: terminalIssue.agentId,
        issue: reloaded,
        context: { deliveryRepair: terminalIssue.carrier },
      }),
    ).resolves.toBeNull();
  });

  it("finds the newest actionable attempt only for the current candidate", async () => {
    const seeded = await seed({ attemptCount: 1 });
    await db.insert(deliveryRepairAttempts).values({
      companyId: seeded.companyId,
      unitId: seeded.unitId,
      reasonCode: "checks_failing",
      attempt: 2,
      status: "dispatched",
      candidateGeneration: 2,
      headSha: HEAD_A,
      ownerAgentId: seeded.agentId,
    });
    await expect(readExecutableRepairIntent(db, intentInput(seeded, {}))).resolves.toMatchObject({
      reasonCode: "checks_failing",
      attempt: 2,
      declared: false,
    });
  });
});
