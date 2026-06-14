import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDb,
  companies,
  agents,
  heartbeatRuns,
  budgetPolicies,
  budgetIncidents,
  approvals,
  activityLog,
  instanceSettings,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { agentInstructionsService } from "../services/agent-instructions.ts";
import { instructionReadinessService } from "../services/instruction-readiness.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const instructions = agentInstructionsService();

// agent-shape good enough for deriveBundleState (reads adapterConfig) and
// resolveManagedInstructionsRoot (reads id + companyId). No DB needed.
function fakeAgent(adapterConfig: Record<string, unknown>) {
  return { id: randomUUID(), companyId: randomUUID(), adapterConfig } as never;
}

describe("W1 instruction-readiness — isManagedBundleEmpty probe", () => {
  const tempDirs: string[] = [];
  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("flags a managed bundle with no root as empty", async () => {
    const result = await instructions.isManagedBundleEmpty(
      fakeAgent({ instructionsBundleMode: "managed" }),
    );
    expect(result).toEqual({ empty: true, mode: "managed" });
  });

  it("does not flag a managed bundle that has instruction files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-readiness-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "AGENTS.md"), "# you are an agent", "utf8");

    const result = await instructions.isManagedBundleEmpty(
      fakeAgent({ instructionsBundleMode: "managed", instructionsRootPath: dir }),
    );
    expect(result).toEqual({ empty: false, mode: "managed" });
  });

  it("flags a managed bundle whose root exists but is empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-readiness-empty-"));
    tempDirs.push(dir);

    const result = await instructions.isManagedBundleEmpty(
      fakeAgent({ instructionsBundleMode: "managed", instructionsRootPath: dir }),
    );
    expect(result).toEqual({ empty: true, mode: "managed" });
  });

  it("never flags an external-mode bundle", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-readiness-ext-"));
    tempDirs.push(dir);
    const result = await instructions.isManagedBundleEmpty(
      fakeAgent({ instructionsBundleMode: "external", instructionsRootPath: dir }),
    );
    expect(result.empty).toBe(false);
    expect(result.mode).toBe("external");
  });

  it("does not flag a managed bundle that has a legacy prompt template", async () => {
    const result = await instructions.isManagedBundleEmpty(
      fakeAgent({ instructionsBundleMode: "managed", promptTemplate: "you are an agent" }),
    );
    expect(result).toEqual({ empty: false, mode: "managed" });
  });
});

describe("W1 instruction-readiness — evaluate", () => {
  const svc = instructionReadinessService({} as never);

  it("returns a fault for an empty bundle", () => {
    const fault = svc.evaluate(true);
    expect(fault).not.toBeNull();
    expect(fault!.reason).toBe("instructions_empty");
  });

  it("returns null for a non-empty bundle", () => {
    expect(svc.evaluate(false)).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("W1 instruction-readiness — trip side effects", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-readiness-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      status: "active",
    });
    return { companyId, agentId };
  }

  it("pauses the agent + opens an incident + spawns no run", async () => {
    const { companyId, agentId } = await seed();
    const svc = instructionReadinessService(db);

    const fault = svc.evaluate(true);
    expect(fault).not.toBeNull();
    await svc.trip(companyId, agentId, fault!);

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r) => r[0]!);
    expect(agent.status).toBe("paused");
    expect(agent.pauseReason).toBe("budget");

    const incident = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.scopeId, agentId))
      .then((r) => r[0] ?? null);
    expect(incident).not.toBeNull();
    expect(incident!.status).toBe("open");

    const approval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, companyId))
      .then((r) => r[0] ?? null);
    expect(approval).not.toBeNull();
    expect(approval!.type).toBe("budget_override_required");
    const payload = approval!.payload as Record<string, unknown>;
    expect(payload.reason).toBe("instructions_empty");
    expect(payload.instructionsEmpty).toBe(true);

    // The whole point of the gate: an empty-bundle agent consumes no run.
    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(0);
  });
});
