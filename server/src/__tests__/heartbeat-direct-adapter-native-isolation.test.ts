import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping direct-adapter native-isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("direct adapter native-runner isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const execute = vi.fn<ServerAdapterModule["execute"]>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-direct-adapter-isolation-");
    db = createDb(tempDb.connectionString);
    const directCodexAdapter: ServerAdapterModule = {
      type: "codex_local",
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({
        adapterType: "codex_local",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    };
    registerServerAdapter(directCodexAdapter);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "native_run_finalizations",
        "status_decisions",
        "work_assessments",
        "native_run_results",
        "completion_contracts",
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    unregisterServerAdapter("codex_local");
    await tempDb?.cleanup();
  });

  it("executes flag-off codex_local once without creating native records", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const directProofJson = '{"schema":"direct-proof.v1","value":"byte-stable"}';
    execute.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "codex",
      model: "test-codex",
      summary: "Direct adapter summary.",
      resultJson: { directProofJson },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Direct compatibility",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Direct Codex",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);

    expect(execute).toHaveBeenCalledOnce();
    expect(finished).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      signal: null,
      runtimeMode: "legacy",
      nativePhase: null,
    });
    const persistedResult = finished?.resultJson as Record<string, unknown> | null;
    expect(persistedResult?.directProofJson).toBe(directProofJson);

    const nativeRows = await Promise.all([
      db.select().from(completionContracts),
      db.select().from(nativeRunResults),
      db.select().from(workAssessments),
      db.select().from(statusDecisions),
      db.select().from(nativeRunFinalizations),
    ]);
    expect(nativeRows.every((rows) => rows.length === 0)).toBe(true);
  });
});
