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

const testDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = testDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const limitFailure = {
  schema: "paperclip.provider-failure.v1",
  provider: "anthropic",
  phase: "turn",
  category: "quota_exhausted",
  message: "ACP agent reported a terminal limit failure.\nYou've hit your weekly limit · resets Nov 10, 3pm (UTC)",
  retryability: "requires_action",
};

describeEmbeddedPostgres("reportRunFailure native provider usage limits", () => {
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
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-failure-native-usage-limit-");
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
      name: "Runner",
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

  /** The persisted shape of a native ACP turn that hit an exhausted provider allowance. */
  function nativeUsageLimitRun(
    overrides: Partial<typeof heartbeatRuns.$inferSelect> = {},
  ): typeof heartbeatRuns.$inferSelect {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      error: "ACP agent reported a terminal limit failure.",
      errorCode: "native_provider_usage_limit",
      runtimeMode: "native",
      nativePhase: "terminal_failure",
      nativeIssueId: randomUUID(),
      exitCode: null,
      signal: null,
      contextSnapshot: null,
      resultJson: { providerFailure: limitFailure },
      ...overrides,
    } as unknown as typeof heartbeatRuns.$inferSelect;
  }

  it.each(["quota_exhausted", "rate_limit"])("keeps a native %s usage limit on the task", async (category) => {
    const run = nativeUsageLimitRun({ resultJson: { providerFailure: { ...limitFailure, category } } });
    const before = structuredClone(run);
    for (const phase of [undefined, "execute"] as const) await reportRunFailure(db, run, { phase });
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    expect(run).toEqual(before);
  });

  it("keeps a native rate limit that refused the session start on the task", async () => {
    // The persisted shape of staging PAPERCLIP-BACKEND-8Z once it ends as a usage-limit hold.
    await reportRunFailure(db, nativeUsageLimitRun({
      error: "PRP command session.open failed: failed to start ACPX provider: ACPX sidecar command session.open was rejected (retryable=false, classification=provider_rate_limit)",
      resultJson: { providerFailure: { ...limitFailure, phase: "startup", category: "rate_limit", retryability: "unknown",
        httpStatus: 429, message: "API error: 429 This request would exceed your account's rate limit. Please try again later" } },
    }));
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });

  it("keeps a startup rate limit on the task when an earlier attempt of the run saved another failure", async () => {
    // A same-run startup retry keeps the first attempt's providerFailure (here an
    // overload); the limit that ended the run is saved as providerLimitStartup.
    const startupLimit = { ...limitFailure, phase: "startup", category: "rate_limit", retryability: "unknown", httpStatus: 429,
      message: "API error: 429 This request would exceed your account's rate limit. Please try again later" };
    await reportRunFailure(db, nativeUsageLimitRun({ resultJson: {
      providerFailure: { ...limitFailure, phase: "startup", category: "overloaded", retryability: "transient", httpStatus: 529 },
      providerLimitStartup: { failure: startupLimit, observedAt: new Date().toISOString() },
    } }));
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    // Without that saved limit the overload alone is still reported.
    await reportRunFailure(db, nativeUsageLimitRun({ resultJson: {
      providerFailure: { ...limitFailure, phase: "startup", category: "overloaded", retryability: "transient", httpStatus: 529 },
    } }));
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "timed_out" }, { signal: "SIGTERM" }, { runtimeMode: "legacy" },
    { errorCode: "native_provider_terminal_failed" }, { errorCode: "native_session_retry_exhausted" },
    { resultJson: {} }, { resultJson: null },
    { resultJson: { providerFailure: { ...limitFailure, category: "unknown", retryability: "unknown" } } },
    { resultJson: { providerFailure: { category: "quota_exhausted" } } },
  ])("reports a native usage limit outcome without typed limit evidence: %j", async (overrides) => {
    await reportRunFailure(db, nativeUsageLimitRun(overrides), { phase: "execute" });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it("reports a native usage limit during setup", async () => {
    await reportRunFailure(db, nativeUsageLimitRun(), { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it("reports native usage limits when every run failure is reported", async () => {
    vi.stubEnv("PAPERCLIP_SENTRY_RUN_FAILURES", "all");
    await reportRunFailure(db, nativeUsageLimitRun(), { phase: "execute" });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });
});
