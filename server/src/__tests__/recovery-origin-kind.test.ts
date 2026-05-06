import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  issueRelations,
  activityLog,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  isAgentDeclarableOriginKind,
} from "../services/recovery/origins.js";
import { recoveryService } from "../services/recovery/service.ts";
import {
  RECOVERY_ORIGIN_KINDS,
} from "../services/recovery/origins.js";
import { AGENT_DECLARABLE_ORIGIN_KINDS } from "@paperclipai/shared";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("../middleware/logger.ts", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery-origin-kind tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("isAgentDeclarableOriginKind", () => {
  it("returns false for system kinds", () => {
    expect(isAgentDeclarableOriginKind(null)).toBe(false);
    expect(isAgentDeclarableOriginKind(RECOVERY_ORIGIN_KINDS.strandedIssueRecovery)).toBe(false);
    expect(isAgentDeclarableOriginKind(RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation)).toBe(false);
    expect(isAgentDeclarableOriginKind("manual")).toBe(false);
  });

  it("returns true for listed declarable kinds", () => {
    for (const kind of AGENT_DECLARABLE_ORIGIN_KINDS) {
      expect(isAgentDeclarableOriginKind(kind)).toBe(true);
    }
  });
});

describeEmbeddedPostgres("declarable origin kinds in recovery flows", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-origin-kind-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, managerId, coderId, issuePrefix };
  }

  it("silently cancels stranded assigned issues with declarable origin kind", async () => {
    const { companyId, coderId, issuePrefix } = await seedCompanyAndAgent();
    
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "failed",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: new Date(),
      processStartedAt: new Date(),
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: { issueId },
      logBytes: 0,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Transient intent issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "intent:test",
      executionRunId: runId,
    });

    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    
    const result = await recovery.reconcileStrandedAssignedIssues();
    
    // It should have scanned our issue
    expect(result.skipped).toBe(1);

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated?.status).toBe("cancelled");

    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(logs.length).toBeGreaterThan(0);
    const cancelLog = logs.find((l) => (l.details as any)?.source === "recovery.silent_cancel_declarable_origin");
    expect(cancelLog).toBeDefined();
    expect((cancelLog?.details as any)?.status).toBe("cancelled");
  });

  it("excludes declarable origin kinds from issue graph liveness findings", async () => {
    const { companyId, coderId, issuePrefix } = await seedCompanyAndAgent();
    
    const declarableIssueId = randomUUID();
    const normalIssueId = randomUUID();

    // Declarable issue
    await db.insert(issues).values({
      id: declarableIssueId,
      companyId,
      title: "Transient skill issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      originKind: "skill:test",
    });

    // Normal issue
    await db.insert(issues).values({
      id: normalIssueId,
      companyId,
      title: "Normal blocked issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
    });

    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const result = await recovery.buildIssueGraphLivenessAutoRecoveryPreview();
    
    // We don't really care about the auto recovery preview, but we do care about the findings query
    const dbFindings = await db.select().from(issues).where(eq(issues.companyId, companyId));
    
    // We expect `collectIssueGraphLivenessFindings` to not return declarableIssueId, 
    // so we can test it directly if exported, or via the `reconcileIssueGraphLiveness` or similar method
    // Wait, collectIssueGraphLivenessFindings is internal. Let's run reconcileIssueGraphLiveness
    const reconcileResult = await recovery.reconcileIssueGraphLiveness({ force: true, lookbackHours: 24 * 7 });
    
    // Since normal issue is blocked but doesn't have blockers in issueRelations, it should show up
    // as "blocked_by_unassigned_issue" or similar based on liveness classifier.
    
    // We just want to check that the declarable issue doesn't have liveness escalations created for it
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation)
      ));
      
    // Because normal issue is blocked without a blocker, it gets escalated
    const escalatedForNormal = recoveryIssues.find((i) => i.originFingerprint?.includes(normalIssueId));
    expect(escalatedForNormal).toBeDefined();

    const escalatedForDeclarable = recoveryIssues.find((i) => i.originFingerprint?.includes(declarableIssueId));
    expect(escalatedForDeclarable).toBeUndefined();
  });
});
