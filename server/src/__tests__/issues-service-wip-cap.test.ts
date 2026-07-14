import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService WIP-cap (HELA-3909)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-wip-cap-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithAgent(options: { cap?: number } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      ...(options.cap !== undefined ? { wipCapInProgress: options.cap } : {}),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedInProgress(
    companyId: string,
    agentId: string,
    count: number,
    overrides: { originKind?: string } = {},
  ) {
    if (count <= 0) return [] as string[];
    const rows = Array.from({ length: count }, () => ({
      id: randomUUID(),
      companyId,
      title: "Occupied slot",
      status: "in_progress" as const,
      priority: "medium" as const,
      assigneeAgentId: agentId,
      ...(overrides.originKind ? { originKind: overrides.originKind } : {}),
    }));
    await db.insert(issues).values(rows);
    return rows.map((row) => row.id);
  }

  async function seedTodo(companyId: string, agentId: string, overrides: { originKind?: string } = {}) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued candidate",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      ...(overrides.originKind ? { originKind: overrides.originKind } : {}),
    });
    return issueId;
  }

  async function countInProgress(companyId: string) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(issues)
      .where(sql`${issues.companyId} = ${companyId} AND ${issues.status} = 'in_progress'`);
    return Number(row?.count ?? 0);
  }

  it("rejects the 10th checkout when 9 are already in_progress (default cap)", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    await seedInProgress(companyId, agentId, 9);
    const candidate = await seedTodo(companyId, agentId);

    await expect(svc.checkout(candidate, agentId, ["todo"], null)).rejects.toMatchObject({
      status: 409,
      message: "Company WIP cap reached",
      details: { cap: 9, currentInProgress: 9 },
    });

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, candidate))
      .then((rows) => rows[0]);
    // The candidate stays queued (unchanged) — the agent does not start.
    expect(row?.status).toBe("todo");
  });

  it("allows checkout when only 8 are in_progress (one free slot under cap 9)", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    await seedInProgress(companyId, agentId, 8);
    const candidate = await seedTodo(companyId, agentId);

    const result = await svc.checkout(candidate, agentId, ["todo"], null);
    expect(result?.status).toBe("in_progress");
    expect(await countInProgress(companyId)).toBe(9);
  });

  it("reads the cap from companies.wipCapInProgress rather than a hardcoded 9", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent({ cap: 3 });
    await seedInProgress(companyId, agentId, 3);
    const candidate = await seedTodo(companyId, agentId);

    await expect(svc.checkout(candidate, agentId, ["todo"], null)).rejects.toMatchObject({
      status: 409,
      details: { cap: 3, currentInProgress: 3 },
    });
  });

  it("serializes concurrent checkouts so exactly one wins the last free slot", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent({ cap: 9 });
    await seedInProgress(companyId, agentId, 8); // exactly one slot free
    const candidates = await Promise.all([
      seedTodo(companyId, agentId),
      seedTodo(companyId, agentId),
      seedTodo(companyId, agentId),
    ]);

    const results = await Promise.allSettled(
      candidates.map((id) => svc.checkout(id, agentId, ["todo"], null)),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ status: 409, message: "Company WIP cap reached" });
    }
    // Never breaches the cap.
    expect(await countInProgress(companyId)).toBe(9);
  });

  it("does not block exit transitions (done/blocked/cancelled) even at the cap", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent({ cap: 9 });
    const [doneId, blockedId, cancelledId, ...rest] = await seedInProgress(companyId, agentId, 9);
    expect(rest).toHaveLength(6);

    await expect(svc.update(doneId, { status: "done" })).resolves.toMatchObject({ status: "done" });
    await expect(svc.update(blockedId, { status: "blocked" })).resolves.toMatchObject({
      status: "blocked",
    });
    await expect(svc.update(cancelledId, { status: "cancelled" })).resolves.toMatchObject({
      status: "cancelled",
    });

    // Three slots freed → a queued issue can now be pulled in.
    const candidate = await seedTodo(companyId, agentId);
    const promoted = await svc.checkout(candidate, agentId, ["todo"], null);
    expect(promoted?.status).toBe("in_progress");
  });

  it("gates PATCH transitions into in_progress via update()", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent({ cap: 9 });
    await seedInProgress(companyId, agentId, 9);
    const candidate = await seedTodo(companyId, agentId);

    await expect(
      svc.update(candidate, { status: "in_progress", assigneeAgentId: agentId }),
    ).rejects.toMatchObject({ status: 409, message: "Company WIP cap reached" });
  });

  it("frees a slot when an issue leaves in_progress, admitting the next candidate", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent({ cap: 9 });
    const occupied = await seedInProgress(companyId, agentId, 9);
    const candidate = await seedTodo(companyId, agentId);

    // Full — rejected.
    await expect(svc.checkout(candidate, agentId, ["todo"], null)).rejects.toMatchObject({
      status: 409,
    });

    // Free one slot.
    await svc.update(occupied[0], { status: "done" });

    // Now admitted.
    const promoted = await svc.checkout(candidate, agentId, ["todo"], null);
    expect(promoted?.status).toBe("in_progress");
    expect(await countInProgress(companyId)).toBe(9);
  });

  it("does not count plugin-operation (service) issues toward the cap", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent({ cap: 9 });
    // 8 real in_progress + several plugin-operation issues that must not count.
    await seedInProgress(companyId, agentId, 8);
    await seedInProgress(companyId, agentId, 5, { originKind: "plugin:acme.tool:operation" });
    const candidate = await seedTodo(companyId, agentId);

    // Still one real slot free despite 13 total in_progress rows.
    const result = await svc.checkout(candidate, agentId, ["todo"], null);
    expect(result?.status).toBe("in_progress");
  });
});
