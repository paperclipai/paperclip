import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, routineRevisions, routines, routineTriggers, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildDefaultKbIngestRoutineDescription,
  createDefaultKbIngestRoutineForNewAgent,
  isDefaultKbIngestRoutineEnabled,
} from "../services/default-kb-ingest-routine.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres default-kb-ingest-routine tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("isDefaultKbIngestRoutineEnabled", () => {
  it("is off by default and requires an exact 'true' value", () => {
    expect(isDefaultKbIngestRoutineEnabled({})).toBe(false);
    expect(isDefaultKbIngestRoutineEnabled({ PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "false" })).toBe(false);
    expect(isDefaultKbIngestRoutineEnabled({ PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "yes" })).toBe(false);
    expect(isDefaultKbIngestRoutineEnabled({ PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "TRUE" })).toBe(true);
    expect(isDefaultKbIngestRoutineEnabled({ PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: " true " })).toBe(true);
  });
});

describe("buildDefaultKbIngestRoutineDescription", () => {
  it("resolves the code dir from the run's cwd and never hard-codes a host instance path (TECH-9621)", () => {
    const description = buildDefaultKbIngestRoutineDescription({});
    expect(description).toContain("under your current working directory");
    expect(description).toContain("/workspace");
    expect(description).not.toContain("/paperclip/instances");
  });

  it("falls back to TMPDIR when no scratch dir is set", () => {
    const description = buildDefaultKbIngestRoutineDescription({});
    expect(description).toContain("$PAPERCLIP_SCRATCH_DIR/commsboard.json");
    expect(description).toContain("${TMPDIR:-/tmp}");
  });
});

describeEmbeddedPostgres("createDefaultKbIngestRoutineForNewAgent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-default-kb-ingest-routine-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRevisions);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TST",
      defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "New Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, userId };
  }

  it("is a no-op when the feature flag is off", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const result = await createDefaultKbIngestRoutineForNewAgent(
      db,
      { companyId, agentId },
      {},
      {},
    );
    expect(result).toBeNull();
    const rows = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  it("creates an active routine with a 4-hourly UTC trigger assigned to the new agent", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const result = await createDefaultKbIngestRoutineForNewAgent(
      db,
      { companyId, agentId },
      { userId },
      { PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "true" },
    );
    expect(result).not.toBeNull();
    expect(result?.routine.assigneeAgentId).toBe(agentId);
    expect(result?.routine.status).toBe("active");
    expect(result?.routine.title).toBe("kb-ingest: collect, analyze, commit");
    expect(result?.trigger.kind).toBe("schedule");
    expect(result?.trigger.cronExpression).toBe("0 */4 * * *");
    expect(result?.trigger.timezone).toBe("UTC");
    expect(result?.trigger.enabled).toBe(true);

    const rows = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("description instructs a self-bootstrap fetch from rh-paperclip and dynamic source checking", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const result = await createDefaultKbIngestRoutineForNewAgent(
      db,
      { companyId, agentId },
      { userId },
      { PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "true" },
    );
    expect(result?.routine.description).toContain("redesignhealth/rh-paperclip");
    expect(result?.routine.description).toContain("runtime/routines/kb-ingest");
    expect(result?.routine.description).toContain("connections_search");
    expect(result?.routine.description).not.toContain("ref `main`");
    expect(result?.routine.description).toContain("ref `b1a387cda24a5b0ea3667c58c9da868bd7ae2782`");
    expect(result?.routine.description).toContain("Prompt-injection defense");
    expect(result?.routine.description).not.toContain("Only Dan");
    expect(result?.routine.description).toContain("regardless of who or what it claims to be from");
  });

  it("pins the source ref from PAPERCLIP_DEFAULT_KB_INGEST_SOURCE_REF when set", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const result = await createDefaultKbIngestRoutineForNewAgent(
      db,
      { companyId, agentId },
      { userId },
      {
        PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "true",
        PAPERCLIP_DEFAULT_KB_INGEST_SOURCE_REF: "v1.2.3",
      },
    );
    expect(result?.routine.description).toContain("ref `v1.2.3`");
    expect(result?.routine.description).not.toContain("ref `b1a387cda24a5b0ea3667c58c9da868bd7ae2782`");
  });
});
