import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, autonomyIncidents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { autonomyKernelService, AutonomyIncidentError } from "../index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres autonomy incident tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("autonomy kernel incident service", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;
  let svc!: ReturnType<typeof autonomyKernelService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("autonomy-kernel-incidents");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    svc = autonomyKernelService(db);
  });

  afterEach(async () => {
    await db.delete(autonomyIncidents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(id = randomUUID()) {
    await db.insert(companies).values({
      id,
      name: `Company ${id.slice(0, 8)}`,
      status: "active",
      issuePrefix: id.slice(0, 8).toUpperCase(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  it("creates durable open incident rows with critical lane-stop semantics", async () => {
    const companyId = await seedCompany();

    const incident = await svc.createIncident({
      companyId,
      type: "RUN_FAILED_NO_EVIDENCE",
      severity: "critical",
      laneKey: "default",
      title: "Run failed without evidence",
      message: "The agent exited cleanly but produced no accepted evidence.",
      remediation: "Inspect the run and assign concrete follow-up work.",
      sourceType: "heartbeat_run",
      sourceId: "run-output-check",
      metadata: { terminalClassification: "failed_no_evidence" },
    });

    expect(incident).toMatchObject({
      companyId,
      type: "RUN_FAILED_NO_EVIDENCE",
      severity: "critical",
      status: "open",
      laneKey: "default",
      sourceType: "heartbeat_run",
      sourceId: "run-output-check",
      stopsLane: true,
    });

    const rows = await db.select().from(autonomyIncidents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(incident.id);
    expect(rows[0]?.stopsLane).toBe(true);
  });

  it("creates incidents idempotently by company, type, and source when configured", async () => {
    const companyId = await seedCompany();

    const first = await svc.createIncident({
      companyId,
      type: "VALIDATOR_FAILED",
      severity: "error",
      title: "Validator failed",
      message: "Validator returned an error.",
      sourceType: "kernel",
      sourceId: "validator:commit-exists",
      idempotent: true,
    });

    const second = await svc.createIncident({
      companyId,
      type: "VALIDATOR_FAILED",
      severity: "critical",
      title: "Different title should not duplicate unresolved incident",
      message: "Still the same source/type/company.",
      sourceType: "kernel",
      sourceId: "validator:commit-exists",
      idempotent: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.severity).toBe("error");
    expect(await db.select().from(autonomyIncidents)).toHaveLength(1);
  });

  it("resolves incidents durably and keeps resolution company-scoped", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const incident = await svc.createIncident({
      companyId,
      type: "LANE_STOPPED",
      severity: "warning",
      laneKey: "default",
      title: "Lane stopped",
      message: "Lane was stopped by policy.",
      stopsLane: true,
    });

    await expect(
      svc.resolveIncident({
        companyId: otherCompanyId,
        incidentId: incident.id,
        resolvedByUserId: "user-1",
      }),
    ).rejects.toMatchObject({ code: "INCIDENT_NOT_FOUND" } satisfies Partial<AutonomyIncidentError>);

    const resolved = await svc.resolveIncident({
      companyId,
      incidentId: incident.id,
      resolvedByUserId: "user-1",
      resolutionNote: "Operator verified recovery.",
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedByUserId).toBe("user-1");
    expect(resolved.resolvedAt).toEqual(expect.any(String));
    expect(resolved.resolutionNote).toBe("Operator verified recovery.");

    const [row] = await db.select().from(autonomyIncidents);
    expect(row?.status).toBe("resolved");
    expect(row?.resolvedByUserId).toBe("user-1");
  });
});
