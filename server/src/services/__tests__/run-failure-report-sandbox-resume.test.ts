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

import { environmentResumeErrorData, JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { reportRunFailure } from "../run-failure-report.js";
import { REUSABLE_SANDBOX_RESUME_FAILED_CODE, ReusableSandboxResumeError } from "../reusable-sandbox-resume-error.js";

const testDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = testDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reportRunFailure sandbox resume provider outages", () => {
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
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-failure-sandbox-resume-");
      db = createDb(tempDb.connectionString);
    }
  }, 20_000);

  beforeEach(async () => {
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
      name: "SandboxBot",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
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

  // The sandbox provider answered the saved-sandbox resume with a gateway
  // page. The plugin worker sends only the closed status across JSON-RPC.
  const providerOutage = () => new ReusableSandboxResumeError({ provider: "daytona", providerLeaseId: "lease-1",
    cause: new JsonRpcCallError({ code: -32002, message: "<html><head><title>502 Bad Gateway</title></head></html>",
      data: environmentResumeErrorData({ status: 502 }) }) });

  function resumeFailureRun(
    overrides: Partial<typeof heartbeatRuns.$inferSelect> = {},
  ): typeof heartbeatRuns.$inferSelect {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      error: "Reusable sandbox lease could not be resumed",
      errorCode: REUSABLE_SANDBOX_RESUME_FAILED_CODE,
      runtimeMode: "legacy",
      executionStage: "preparing",
      nativeIssueId: null,
      contextSnapshot: null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      ...overrides,
    } as unknown as typeof heartbeatRuns.$inferSelect;
  }

  it("keeps a provider outage local until its retry decision, and after a scheduled retry", async () => {
    const run = resumeFailureRun();
    const error = providerOutage();
    await reportRunFailure(db, run, { phase: "setup", error, sandboxResumeRetry: "pending" });
    await reportRunFailure(db, run, { phase: "setup", error, sandboxResumeRetry: "scheduled" });
    // The setup path reports once more with its decision, so a pending write stays local in every mode.
    vi.stubEnv("PAPERCLIP_SENTRY_RUN_FAILURES", "all");
    await reportRunFailure(db, run, { phase: "setup", error, sandboxResumeRetry: "pending" });
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });

  it.each([
    ["no retry was scheduled", {}, "not_scheduled", "unexpected"],
    ["the decision is unknown", {}, undefined, "unexpected"],
    ["every run failure is reported", {}, "scheduled", "all"],
    ["the run failed for another reason", { errorCode: "setup_failed" }, "scheduled", "unexpected"],
  ] as const)("reports a sandbox resume provider outage when %s", async (_label, overrides, sandboxResumeRetry, mode) => {
    vi.stubEnv("PAPERCLIP_SENTRY_RUN_FAILURES", mode);
    const run = resumeFailureRun(overrides);
    await reportRunFailure(db, run, { phase: "setup", error: providerOutage(), ...(sandboxResumeRetry ? { sandboxResumeRetry } : {}) });
    expect(mockCaptureRunFailure).toHaveBeenCalledOnce();
    expect(mockCaptureRunFailure.mock.calls[0]![0]).toMatchObject({ errorCode: run.errorCode, runStatus: "failed" });
  });
});
