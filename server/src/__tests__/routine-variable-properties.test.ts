import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, routineRuns, routines } from "@paperclipai/db";
import { routineService } from "../services/routines.ts";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ROUTINES_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("routine variable object property names", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-variable-properties-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Routine variables",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
  }, 20_000);

  afterAll(async () => {
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await db.delete(routineRuns).where(eq(routineRuns.companyId, companyId));
    await db.delete(routines).where(eq(routines.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    await tempDb?.cleanup();
  });

  it.each(["constructor", "toString", "hasOwnProperty"])(
    "resolves supplied values and defaults for %s",
    async (name) => {
      const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
      const routine = await svc.create(companyId, {
        projectId: null, goalId: null, parentIssueId: null,
        title: `Review {{${name}}}`, description: null, assigneeAgentId: agentId,
        priority: "medium", status: "active", concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
        variables: [{ name, label: null, type: "select", defaultValue: "default", required: true, options: ["supplied", "default"] }],
      }, {});

      for (const [variables, expected] of [
        [{ [name]: "supplied" }, "supplied"],
        [{}, "default"],
        [{ [name]: undefined }, "default"],
      ] as const) {
        const run = await svc.runRoutine(routine.id, { source: "manual", variables });
        const [issue] = await db.select({ title: issues.title }).from(issues).where(eq(issues.id, run.linkedIssueId!));
        expect(issue?.title).toBe(`Review ${expected}`);
        expect(run.triggerPayload).toEqual({ variables: { [name]: expected } });
      }
    },
  );
});
