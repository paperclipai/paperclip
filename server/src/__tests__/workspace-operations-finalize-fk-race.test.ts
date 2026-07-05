import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, workspaceOperations } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recordOperationBestEffort, workspaceOperationService } from "../services/workspace-operations.ts";

// Regression coverage for #51: workspace_finalize inserting a
// workspace_operations row can race a deleted heartbeat_runs parent row
// (janitor/cleanup, agent/company deletion, replica failover). That FK
// violation must never propagate out of finalize bookkeeping and fail the
// whole heartbeat/run.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace-operations finalize FK race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workspace_finalize op-log FK race (#51)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-finalize-fk-race-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("baseline: recordOperation throws a FK violation when heartbeat_run_id points at a missing heartbeat_runs row", async () => {
    const companyId = await seedCompany();
    const service = workspaceOperationService(db);
    // No heartbeat_runs row was ever inserted for this id — simulates the
    // parent row having been deleted (janitor/cleanup race) before the
    // workspace_finalize op-log insert lands.
    const missingHeartbeatRunId = randomUUID();
    const recorder = service.createRecorder({ companyId, heartbeatRunId: missingHeartbeatRunId });

    let caughtError: unknown;
    await recorder
      .recordOperation({
        phase: "workspace_finalize",
        run: async () => ({ status: "succeeded" }),
      })
      .catch((error: unknown) => {
        caughtError = error;
      });

    expect(caughtError).toBeDefined();
    const causeMessage = String((caughtError as { cause?: unknown } | undefined)?.cause ?? caughtError);
    expect(causeMessage).toMatch(/heartbeat_run_id_heartbeat_runs_id_fk|foreign key/i);
  });

  it("guarded: recordOperationBestEffort swallows the same FK violation, reports it, and returns null instead of throwing", async () => {
    const companyId = await seedCompany();
    const service = workspaceOperationService(db);
    const missingHeartbeatRunId = randomUUID();
    const recorder = service.createRecorder({ companyId, heartbeatRunId: missingHeartbeatRunId });
    const onError = vi.fn();

    const result = await recordOperationBestEffort(
      recorder,
      {
        phase: "workspace_finalize",
        run: async () => ({ status: "succeeded" }),
      },
      onError,
    );

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    const reportedError = onError.mock.calls[0]?.[0] as { cause?: unknown } | undefined;
    const causeMessage = String(reportedError?.cause ?? reportedError);
    expect(causeMessage).toMatch(/heartbeat_run_id_heartbeat_runs_id_fk|foreign key/i);

    // No workspace_operations row landed for this bookkeeping attempt, and no
    // exception escaped — the caller's heartbeat/run continues unaffected.
    const rows = await db.select().from(workspaceOperations);
    expect(rows).toHaveLength(0);
  });
});
