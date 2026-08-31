import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Holder for the id of the agent whose per-agent tick should throw. Populated by
// each test before it calls tickTimers. Declared via vi.hoisted so it exists when
// the mock factory below (hoisted above the imports) captures it.
const mockState = vi.hoisted(() => ({ poisonAgentId: "" }));

// Simulate a single agent whose wake/tick throws — e.g. a heartbeat-enabled agent
// with a null defaultEnvironmentId, the exact shape that took down the fleet-wide
// scheduler. evaluateAgentInvokability is the first per-agent call inside the
// tickTimers loop, so throwing here reproduces "one agent aborts the whole tick".
// All other agents fall through to the real implementation.
vi.mock("../services/agent-invokability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-invokability.js")>();
  return {
    ...actual,
    evaluateAgentInvokability: (
      agent: Parameters<typeof actual.evaluateAgentInvokability>[0],
      companyAgents: Parameters<typeof actual.evaluateAgentInvokability>[1],
    ) => {
      if (agent && agent.id === mockState.poisonAgentId) {
        throw new Error(`simulated per-agent heartbeat tick failure for ${agent.id}`);
      }
      return actual.evaluateAgentInvokability(agent, companyAgents);
    },
  };
});

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat timer tick isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat timer tick per-agent isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-tick-isolation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockState.poisonAgentId = "";
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function insertActiveCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function insertHeartbeatAgent(
    companyId: string,
    name: string,
    // A very large interval keeps healthy agents in the loop's "checked" phase
    // without enqueuing a wake (and spawning a background run), so the test can
    // assert isolation deterministically without draining live executions.
    intervalSec: number,
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      // defaultEnvironmentId left null on purpose — this is the misconfiguration
      // that made the real "PR Gate Lead" agent's tick throw.
      defaultEnvironmentId: null,
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    return agentId;
  }

  it("isolates a throwing agent so the rest of the fleet still ticks", async () => {
    const companyId = await insertActiveCompany();

    // One poison agent whose per-agent tick throws, plus three healthy agents.
    const poisonAgentId = await insertHeartbeatAgent(companyId, "PR Gate Lead", 60);
    const healthyIds = [
      await insertHeartbeatAgent(companyId, "Healthy Agent A", 3_600_000),
      await insertHeartbeatAgent(companyId, "Healthy Agent B", 3_600_000),
      await insertHeartbeatAgent(companyId, "Healthy Agent C", 3_600_000),
    ];
    expect(healthyIds).toHaveLength(3);

    mockState.poisonAgentId = poisonAgentId;

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    // Before the fix the poison agent's uncaught throw propagates out of
    // tickTimers, rejecting the whole tick and starving every other agent. After
    // the fix tickTimers resolves and every healthy agent is still evaluated.
    const result = await heartbeat.tickTimers(new Date());

    // All three healthy agents were reached and counted despite the throwing
    // agent; none was enqueued because their interval has not elapsed.
    expect(result).toEqual({ checked: 3, enqueued: 0, skipped: 0 });
  });
});
