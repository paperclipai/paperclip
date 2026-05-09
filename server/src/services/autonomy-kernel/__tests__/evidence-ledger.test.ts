import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { autonomyEvidenceEntries, companies, createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { AutonomyEvidenceLedgerError, autonomyKernelService } from "../index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres autonomy evidence ledger tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("autonomy kernel evidence ledger", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;
  let svc!: ReturnType<typeof autonomyKernelService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("autonomy-kernel-evidence-ledger");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    svc = autonomyKernelService(db);
  });

  afterEach(async () => {
    await db.delete(autonomyEvidenceEntries);
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

  it("records normalized pending evidence from run/work product sources", async () => {
    const companyId = await seedCompany();

    const evidence = await svc.recordEvidence({
      companyId,
      type: "test_run",
      laneKey: "default",
      title: "Vitest autonomy kernel suite",
      summary: "Targeted tests passed.",
      uri: "file:///repo/server/src/services/autonomy-kernel/__tests__/evidence-ledger.test.ts",
      sourceType: "heartbeat_run_event",
      sourceId: "event-123",
      payload: {
        command: "pnpm --filter @paperclipai/server test -- autonomy-kernel",
        exitCode: 0,
      },
    });

    expect(evidence).toMatchObject({
      companyId,
      type: "test_run",
      status: "pending",
      verdict: "pending",
      laneKey: "default",
      sourceType: "heartbeat_run_event",
      sourceId: "event-123",
      title: "Vitest autonomy kernel suite",
    });

    const rows = await db.select().from(autonomyEvidenceEntries);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(evidence.id);
    expect(rows[0]?.payload).toMatchObject({ exitCode: 0 });
  });

  it("updates validation verdicts with company scoping", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const evidence = await svc.recordEvidence({
      companyId,
      type: "commit",
      title: "Implementation commit",
      sourceType: "external",
      sourceId: "commit:abc123",
      payload: { commitSha: "abc123" },
    });

    await expect(
      svc.validateEvidence({
        companyId: otherCompanyId,
        evidenceEntryId: evidence.id,
        verdict: "accepted",
        validatorName: "commit-exists",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" } satisfies Partial<AutonomyEvidenceLedgerError>);

    const accepted = await svc.validateEvidence({
      companyId,
      evidenceEntryId: evidence.id,
      verdict: "accepted",
      validatorName: "commit-exists",
      validatorVersion: "1.0.0",
      validatorMessage: "Commit exists in workspace.",
      validatorPayload: { checked: true },
    });

    expect(accepted.status).toBe("accepted");
    expect(accepted.verdict).toBe("accepted");
    expect(accepted.validatorName).toBe("commit-exists");
    expect(accepted.validatorMessage).toBe("Commit exists in workspace.");
    expect(accepted.validatedAt).toEqual(expect.any(String));
  });

  it("redacts sensitive payload fields before storing evidence", async () => {
    const companyId = await seedCompany();

    const evidence = await svc.recordEvidence({
      companyId,
      type: "external_api_check",
      title: "API health check",
      sourceType: "external",
      sourceId: "health-check-1",
      payload: {
        status: 200,
        headers: {
          authorization: "Bearer should-not-persist",
          nestedToken: "should-not-persist",
        },
        apiKey: "should-not-persist",
      },
    });

    expect(evidence.payload).toEqual({
      status: 200,
      headers: {
        authorization: "[REDACTED]",
        nestedToken: "[REDACTED]",
      },
      apiKey: "[REDACTED]",
    });

    const [row] = await db.select().from(autonomyEvidenceEntries);
    expect(row?.payload).toMatchObject({
      headers: { authorization: "[REDACTED]", nestedToken: "[REDACTED]" },
      apiKey: "[REDACTED]",
    });
  });

  it("rejects secret-looking source values instead of storing them", async () => {
    const companyId = await seedCompany();

    await expect(
      svc.recordEvidence({
        companyId,
        type: "run_log",
        title: "Unsafe source",
        sourceType: "external",
        sourceId: "sk-thisLooksLikeASecretValue1234567890",
      }),
    ).rejects.toMatchObject({ code: "SECRET_SOURCE_VALUE_REJECTED" } satisfies Partial<AutonomyEvidenceLedgerError>);

    expect(await db.select().from(autonomyEvidenceEntries)).toHaveLength(0);
  });

  it("records validator errors as rejected evidence verdicts", async () => {
    const companyId = await seedCompany();
    const evidence = await svc.recordEvidence({
      companyId,
      type: "build",
      title: "Production build",
    });

    const validatorError = await svc.validateEvidence({
      companyId,
      evidenceEntryId: evidence.id,
      verdict: "validator_error",
      validatorName: "build-log-validator",
      validatorMessage: "Build log artifact was unreadable.",
    });

    expect(validatorError.verdict).toBe("validator_error");
    expect(validatorError.status).toBe("rejected");
    expect(validatorError.validatorMessage).toBe("Build log artifact was unreadable.");
  });
});
