import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveCreatedByRunId } from "../services/run-id.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-id FK helper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regression coverage for the shared run-id resolver (TON-2666). Every
// createdByRunId column carries an FK to heartbeat_runs, so a stale/foreign or
// malformed run-id must be demoted to NULL rather than surfacing as a raw FK
// 500 / 22P02 at insert time. addComment, document-annotations comment inserts,
// and routines revision inserts all funnel through resolveCreatedByRunId, so
// proving the resolver also proves every call site.
describeEmbeddedPostgres("resolveCreatedByRunId hardening", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runid-helper-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RunId Helper Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Run Owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    return { companyId, runId };
  }

  it("returns NULL for a null/undefined run-id without touching the database", async () => {
    expect(await resolveCreatedByRunId(db, null)).toBeNull();
    expect(await resolveCreatedByRunId(db, undefined)).toBeNull();
  });

  it("demotes an unknown (but well-formed) run-id to NULL instead of throwing FK 500", async () => {
    const ghostRunId = randomUUID(); // valid UUID, no matching heartbeat_runs row
    expect(await resolveCreatedByRunId(db, ghostRunId)).toBeNull();
  });

  it("demotes a malformed (non-UUID) run-id to NULL instead of throwing 22P02", async () => {
    expect(await resolveCreatedByRunId(db, "not-a-uuid")).toBeNull();
  });

  it("preserves a valid existing run-id unchanged", async () => {
    const { runId } = await seedRun();
    expect(await resolveCreatedByRunId(db, runId)).toBe(runId);
  });

  it("resolves correctly inside a transaction executor", async () => {
    const { runId } = await seedRun();
    const ghostRunId = randomUUID();
    await db.transaction(async (tx) => {
      expect(await resolveCreatedByRunId(tx, runId)).toBe(runId);
      expect(await resolveCreatedByRunId(tx, ghostRunId)).toBeNull();
    });
  });
});
