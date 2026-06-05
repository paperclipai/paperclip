import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

// NOTE: deliberately does NOT mock ../adapters/index.ts. In the test process no
// external adapters are loaded, so getServerAdapter("claude_k8s") falls back to
// the built-in `process` adapter — exactly the production condition that throws
// "Process adapter missing command". This exercises the resolution guard.

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));
vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping adapter-resolution guard tests: ${support.reason ?? "unsupported"}`);
}

describeEmbeddedPostgres("heartbeat adapter-resolution guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adapter-resolution-guard-");
    db = createDb(tempDb.connectionString);
  });
  afterEach(async () => {
    const { sql } = await import("drizzle-orm");
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQueuedClaudeK8sRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s", // unresolved in the test registry → process fallback
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "queued",
      triggerDetail: "github_pr_review_requested",
      contextSnapshot: { reviewKind: "pr_review", taskKey: "pr_review:Blockcast/paperclip:297" },
      updatedAt: new Date(),
      createdAt: new Date(),
    });
    return { companyId, agentId, runId };
  }

  it("does not run the no-op process adapter and schedules a transient retry on a resolution miss", async () => {
    const { runId } = await seedQueuedClaudeK8sRun();
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    await heartbeat.__test_executeRunForTesting(runId);

    const original = await db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    // The guard must NOT let the no-op process adapter run.
    expect(original?.error ?? "").not.toContain("Process adapter missing command");

    // A bounded transient retry must be scheduled so the agent self-heals
    // instead of being left in a terminal failure.
    const retry = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);
    expect(retry, "a bounded retry of the failed run should be scheduled").not.toBeNull();
  });
});
