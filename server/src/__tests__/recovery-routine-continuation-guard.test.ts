import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activeRoutineContinuationWhere } from "../services/recovery/successful-run-handoff.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine-continuation guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// TWX-1228: a routine's continuation path binds to an issue either as its parent
// tracker OR as a live routine-execution instance. Both must be recognized so the
// disposition resolver / stranded-recovery sweep leave them alone instead of nagging
// them into `blocked` (which then triggers CEO recovery).
describeEmbeddedPostgres("activeRoutineContinuationWhere", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-continuation-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function matches(issue: {
    companyId: string;
    id: string;
    originKind: string | null;
    originId: string | null;
  }) {
    const rows = await db
      .select({ id: routines.id })
      .from(routines)
      .where(
        activeRoutineContinuationWhere({
          companyId: issue.companyId,
          issueId: issue.id,
          originKind: issue.originKind,
          originId: issue.originId,
        }),
      )
      .limit(1);
    return rows.length > 0;
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const trackerId = randomUUID();
    const routineId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Ops", status: "in_progress" });
    await db.insert(issues).values({
      id: trackerId,
      companyId,
      projectId,
      title: "Routine tracker",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(routines).values({
      id: routineId,
      companyId,
      projectId,
      parentIssueId: trackerId,
      title: "Daily ops routine",
      assigneeAgentId: agentId,
      status: "active",
    });

    async function makeIssue(input: { originKind?: string; originId?: string | null }) {
      const id = randomUUID();
      await db.insert(issues).values({
        id,
        companyId,
        projectId,
        title: "Issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: input.originKind ?? "manual",
        originId: input.originId ?? null,
      });
      return id;
    }

    return { companyId, routineId, trackerId, makeIssue };
  }

  it("matches the routine's parent tracker issue", async () => {
    const { companyId, trackerId } = await seed();
    expect(await matches({ companyId, id: trackerId, originKind: "manual", originId: null })).toBe(true);
  });

  it("matches a live routine-execution instance bound by originId", async () => {
    const { companyId, routineId, makeIssue } = await seed();
    const execIssueId = await makeIssue({ originKind: "routine_execution", originId: routineId });
    expect(
      await matches({ companyId, id: execIssueId, originKind: "routine_execution", originId: routineId }),
    ).toBe(true);
  });

  it("does not match a manual issue unrelated to any routine", async () => {
    const { companyId, makeIssue } = await seed();
    const manualId = await makeIssue({});
    expect(await matches({ companyId, id: manualId, originKind: "manual", originId: null })).toBe(false);
  });

  it("does not match a routine-execution issue whose routine is not active", async () => {
    const { companyId, routineId, makeIssue } = await seed();
    await db.update(routines).set({ status: "paused" }).where(eq(routines.id, routineId));
    const execIssueId = await makeIssue({ originKind: "routine_execution", originId: routineId });
    expect(
      await matches({ companyId, id: execIssueId, originKind: "routine_execution", originId: routineId }),
    ).toBe(false);
  });
});
