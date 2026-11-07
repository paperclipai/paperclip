import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatRunState } from "./run-state.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("persisted run completion comment selection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-comment-selection-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("retains system notices while selecting only a same-company task reply", async () => {
    const [company] = await db.insert(companies).values({ name: "Notice selection", issuePrefix: "NSL" }).returning();
    const [otherCompany] = await db.insert(companies).values({ name: "Other company", issuePrefix: "OTH" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Agent", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Reply Hi", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, status: "running" }).returning();
    const [notice] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id,
      authorAgentId: agent.id, createdByRunId: run.id, body: "## Workspace Ready",
      presentation: { kind: "system_notice", tone: "info", title: "Workspace ready", density: "compact", detailsDefaultOpen: false },
    }).returning();
    const dependencies = {
      ...createHeartbeatRunState(db), ...createHeartbeatRunPreparation(db),
      issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
      recovery: { escalateStrandedAssignedIssue: vi.fn() },
      companySkills: { completeTestRunForIssue: vi.fn() },
      budgets: { getInvocationBlock: vi.fn(async () => null) },
      treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
      enqueueWakeup: vi.fn(), getCurrentUserRedactionOptions: vi.fn(async () => ({ enabled: false })),
      getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
      emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
    } satisfies HeartbeatLifecycleDependencies;
    const lifecycle = createHeartbeatLifecycle(db, dependencies);
    expect(await lifecycle.findRunIssueComment(run.id, company.id, issue.id, {})).toBeNull();
    const [reply] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id,
      authorAgentId: agent.id, createdByRunId: run.id, body: "Hi",
    }).returning();
    expect(await lifecycle.findRunIssueComment(run.id, company.id, issue.id, {})).toMatchObject({ id: reply.id, body: "Hi" });
    expect(await lifecycle.findRunIssueComment(run.id, otherCompany.id, issue.id, {})).toBeNull();
    expect(await db.select().from(issueComments)).toEqual(expect.arrayContaining([expect.objectContaining({ id: notice.id }), expect.objectContaining({ id: reply.id })]));
  });
});
