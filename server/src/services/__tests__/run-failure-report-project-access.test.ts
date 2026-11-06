import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());

vi.mock("../../sentry.js", () => ({
  captureRunFailure: mockCaptureRunFailure,
}));

import { reportRunFailure } from "../run-failure-report.js";
import { PROJECT_ACCESS_DENIED } from "../project-access-denial.js";

const testDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = testDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reportRunFailure low-trust project denials", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let inheritedEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    if (testDatabaseUrl) {
      await applyPendingMigrations(testDatabaseUrl);
      db = createDb(testDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-failure-project-access-");
      db = createDb(tempDb.connectionString);
    }
  }, 20_000);

  beforeEach(async () => {
    // Keep redaction inputs independent of the developer/CI environment.
    inheritedEnv = process.env;
    process.env = Object.fromEntries(
      ["PATH", "HOME", "USER", "USERNAME", "LOGNAME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"]
        .flatMap((key) => inheritedEnv[key] === undefined ? [] : [[key, inheritedEnv[key]]]),
    );
    process.env.PAPERCLIP_SENTRY_RUN_FAILURES = "unexpected";
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "OpenCodeCoder",
      role: "engineer",
      status: "active",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    process.env = inheritedEnv;
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (testDatabaseUrl) await closeRegisteredClients(testDatabaseUrl);
    await tempDb?.cleanup();
  });

  // Matches the setup failure run-completion records for ProjectAccessDeniedError.
  function projectAccessDeniedRun(
    overrides: Partial<typeof heartbeatRuns.$inferSelect> = {},
  ): typeof heartbeatRuns.$inferSelect {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      error: "Project is outside this low-trust boundary.",
      errorCode: PROJECT_ACCESS_DENIED,
      executionStage: "preparing",
      nativeIssueId: randomUUID(),
      contextSnapshot: null,
      resultJson: {
        projectAccessDenied: { projectId: randomUUID() },
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
      ...overrides,
    } as unknown as typeof heartbeatRuns.$inferSelect;
  }

  it("keeps a low-trust project denial before dispatch on the task", async () => {
    await reportRunFailure(db, projectAccessDeniedRun(), { phase: "setup" });
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });

  it.each([
    { status: "timed_out" }, { errorCode: "setup_failed" }, { executionStage: "executing" }, { exitCode: 1 }, { signal: "SIGTERM" },
    { resultJson: { projectAccessDenied: { projectId: randomUUID() } } },
    { resultJson: { projectAccessDenied: { projectId: randomUUID() }, executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } },
    { resultJson: { projectAccessDenied: {}, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } },
  ])("reports project denial markers without an exact pre-dispatch outcome: %j", async (overrides) => {
    await reportRunFailure(db, projectAccessDeniedRun(overrides), { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "execute"] as const)("reports project denial markers outside the setup report: %s", async (phase) => {
    await reportRunFailure(db, projectAccessDeniedRun(), { phase });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it("reports project denials when every run failure is reported", async () => {
    vi.stubEnv("PAPERCLIP_SENTRY_RUN_FAILURES", "all");
    await reportRunFailure(db, projectAccessDeniedRun(), { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });
});
