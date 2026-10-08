import { randomUUID } from "node:crypto";
import os from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
const mockRedactCurrentUserText = vi.hoisted(() => vi.fn());
const mockResolveSecret = vi.hoisted(() => vi.fn());

vi.mock("../../secrets/provider-registry.js", () => ({
  getSecretProvider: () => ({ resolveVersion: mockResolveSecret }),
}));

vi.mock("../../sentry.js", () => ({
  captureRunFailure: mockCaptureRunFailure,
}));
// Wrap the real function instead of a fake, so tests can assert the actual
// redacted output while still spying on the call. A fake output would hide
// whether the composed redaction in run-failure-report.ts is correct.
vi.mock("../../log-redaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../log-redaction.js")>();
  mockRedactCurrentUserText.mockImplementation(actual.redactCurrentUserText);
  return { ...actual, redactCurrentUserText: mockRedactCurrentUserText };
});

import { reportRunFailure, waitForPendingRunFailureReports } from "../run-failure-report.js";
import { REDACTED_EVENT_VALUE } from "../../redaction.js";

const testDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = testDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reportRunFailure", () => {
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
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-failure-report-");
      db = createDb(tempDb.connectionString);
    }
  }, 20_000);

  beforeEach(() => {
    // Unknown host values intentionally count as secrets, including short values
    // such as "1". Keep these fixtures independent of the developer/CI environment
    // and add secret values explicitly in the tests that exercise redaction.
    inheritedEnv = process.env;
    process.env = Object.fromEntries(
      ["PATH", "HOME", "USER", "USERNAME", "LOGNAME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"]
        .flatMap((key) => inheritedEnv[key] === undefined ? [] : [[key, inheritedEnv[key]]]),
    );
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

  async function seedCompanyAndAgent(agentOverrides: Partial<typeof agents.$inferInsert> = {}) {
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
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...agentOverrides,
    });
    return { companyId, agentId };
  }

  function buildRun(
    overrides: Partial<typeof heartbeatRuns.$inferSelect> = {},
  ): typeof heartbeatRuns.$inferSelect {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      error: "the provider process exited with code 1",
      errorCode: "process_lost",
      nativeIssueId: randomUUID(),
      contextSnapshot: null,
      ...overrides,
    } as unknown as typeof heartbeatRuns.$inferSelect;
  }

  const gitConnection = { schemaVersion: 1, provider: "git", operation: "clone", reason: "authentication_failed" };
  const hermesConnection = { schemaVersion: 1, provider: "hermes_gateway", operation: "create_run", reason: "connection_refused" };

  function gitConnectionRun(overrides: Partial<typeof heartbeatRuns.$inferSelect> = {}) {
    return buildRun({
      errorCode: "setup_failed", executionStage: "preparing", exitCode: null, signal: null,
      resultJson: { connectionFailure: gitConnection,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      ...overrides,
    });
  }

  function hermesConnectionRun(overrides: Partial<typeof heartbeatRuns.$inferSelect> = {}) {
    return buildRun({
      errorCode: "hermes_gateway_connect_failed", executionStage: "executing", exitCode: 1, signal: null,
      resultJson: { connectionFailure: hermesConnection }, ...overrides,
    });
  }

  it("keeps a proven Git clone failure and its persisted task error unchanged", async () => {
    await seedCompanyAndAgent();
    const input = gitConnectionRun();
    const [run] = await db.insert(heartbeatRuns).values(input).returning();
    const before = structuredClone(run);
    await reportRunFailure(db, run!, { phase: "setup" });
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    expect(run).toEqual(before);
    expect(await db.select().from(heartbeatRuns)).toEqual([before]);
  });

  it("keeps an all-external Git materialization aggregate local even across different external causes", async () => {
    await seedCompanyAndAgent();
    const run = gitConnectionRun({ errorCode: "workspace_validation_failed" });
    run.resultJson!.workspaceValidation = { reason: "git_worktree_base_materialization_failed", materializationFailures: [
      { connectionFailure: gitConnection },
      { connectionFailure: { ...gitConnection, reason: "repository_unavailable" } },
    ] };
    const before = structuredClone(run);
    await reportRunFailure(db, run, { phase: "setup" });
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    expect(run).toEqual(before);
  });

  it.each([
    { status: "timed_out" }, { executionStage: "executing" }, { executionStage: null },
    { errorCode: "adapter_failed" }, { exitCode: 1 }, { exitCode: 0 }, { signal: "SIGTERM" },
    { resultJson: {} },
    { resultJson: { connectionFailure: { ...gitConnection, schemaVersion: 2 }, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } },
    { resultJson: { connectionFailure: hermesConnection, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } },
  ])("reports a Git marker without its matching setup outcome: %j", async (overrides) => {
    await seedCompanyAndAgent();
    await reportRunFailure(db, gitConnectionRun(overrides), { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledOnce();
  });

  it.each([undefined, "execute"] as const)("reports Git failures outside setup: %s", async (phase) => {
    await seedCompanyAndAgent();
    await reportRunFailure(db, gitConnectionRun(), { phase });
    expect(mockCaptureRunFailure).toHaveBeenCalledOnce();
  });

  it.each([undefined, { kind: "bootstrap" }, { kind: "bootstrap", providerWorkStarted: true },
    { kind: "runtime", providerWorkStarted: false }])("reports Git failures without unstarted bootstrap proof: %j", async (recovery) => {
    await seedCompanyAndAgent();
    const run = gitConnectionRun();
    run.resultJson!.executionRecovery = recovery;
    await reportRunFailure(db, run, { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledOnce();
  });

  it.each([
    [], [null], [{ connectionFailure: gitConnection }, {}],
    [{ connectionFailure: gitConnection }, { connectionFailure: hermesConnection }],
    [{ connectionFailure: gitConnection }, { connectionFailure: { ...gitConnection, reason: "unknown" } }],
    [{ connectionFailure: { ...gitConnection, reason: "repository_unavailable" } }],
  ].map((failures) => ({ failures })))("reports mixed, malformed, or inconsistent Git materialization evidence: %j", async ({ failures }) => {
    await seedCompanyAndAgent();
    const run = gitConnectionRun({ errorCode: "workspace_validation_failed" });
    run.resultJson!.workspaceValidation = { reason: "git_worktree_base_materialization_failed", materializationFailures: failures };
    await reportRunFailure(db, run, { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledOnce();
  });

  it.each([
    { reason: "git_worktree_base_materialization_failed", materializationFailures: [{ connectionFailure: gitConnection }] },
    { reason: "git_worktree_not_reusable" },
  ])("does not use setup_failed to bypass separate workspace validation evidence: %j", async (validation) => {
    await seedCompanyAndAgent();
    const run = gitConnectionRun();
    run.resultJson!.workspaceValidation = validation;
    await reportRunFailure(db, run, { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledOnce();
  });

  it.each([
    ["configuration", "endpoint_missing", "hermes_gateway_api_base_url_missing"],
    ["configuration", "endpoint_invalid", "hermes_gateway_api_base_url_invalid"],
    ["configuration", "insecure_transport", "hermes_gateway_plain_http_remote_denied"],
    ["configuration", "credentials_missing", "hermes_gateway_api_key_missing"],
    ["create_run", "authentication_failed", "hermes_gateway_auth_failed"],
    ["create_run", "endpoint_not_found", "hermes_gateway_runs_unsupported"],
    ["create_run", "rate_limited", "hermes_gateway_rate_limited"],
    ["create_run", "remote_unavailable", "hermes_gateway_upstream_error"],
    ...["connection_refused", "dns_failure", "network_unreachable", "connection_reset", "connection_timeout", "tls_failure"]
      .flatMap((reason) => ["hermes_gateway_connect_failed", "hermes_gateway_protocol_error"].map((code) => ["create_run", reason, code])),
  ])("keeps the matching Hermes %s/%s task error local", async (operation, reason, errorCode) => {
    await seedCompanyAndAgent({ adapterType: "hermes_gateway" });
    const run = hermesConnectionRun({ errorCode, resultJson: { connectionFailure: { ...hermesConnection, operation, reason } } });
    const before = structuredClone(run);
    await reportRunFailure(db, run, { phase: "execute" });
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    expect(run).toEqual(before);
  });

  it.each([undefined, { kind: "bootstrap", providerWorkStarted: true }, { kind: "runtime", providerWorkStarted: true }])(
    "does not infer remote nonacceptance from a classified Hermes connection failure: %j", async (recovery) => {
      await seedCompanyAndAgent({ adapterType: "hermes_gateway" });
      const input = hermesConnectionRun();
      input.resultJson!.executionRecovery = recovery;
      const [run] = await db.insert(heartbeatRuns).values(input).returning();
      const before = structuredClone(run);
      await reportRunFailure(db, run!);
      expect(mockCaptureRunFailure).not.toHaveBeenCalled();
      expect(await db.select().from(heartbeatRuns)).toEqual([before]);
    },
  );

  it.each([
    { status: "timed_out" }, { status: "cancelled", startedAt: new Date(0) },
    { exitCode: 0 }, { exitCode: null }, { signal: "SIGTERM" },
    { errorCode: "hermes_gateway_timeout" }, { errorCode: "hermes_gateway_run_failed" },
    { errorCode: "hermes_gateway_auth_failed" },
    { resultJson: {} },
    { resultJson: { connectionFailure: { ...hermesConnection, reason: "unknown" } } },
    { resultJson: { connectionFailure: { ...hermesConnection, privateUrl: "https://private.example.test" } } },
    { resultJson: { connectionFailure: gitConnection } },
    { resultJson: { connectionFailure: { ...hermesConnection, operation: "configuration", reason: "credentials_missing" } } },
  ])("reports an unproven or mismatched Hermes outcome: %j", async (overrides) => {
    await seedCompanyAndAgent({ adapterType: "hermes_gateway" });
    const run = hermesConnectionRun(overrides);
    const before = structuredClone(run);
    await reportRunFailure(db, run, { phase: "execute" });
    expect(mockCaptureRunFailure).toHaveBeenCalledOnce();
    expect(run).toEqual(before);
  });

  it("keeps setup errors reportable even when they carry a matching Hermes marker", async () => {
    await seedCompanyAndAgent({ adapterType: "hermes_gateway" });
    await reportRunFailure(db, hermesConnectionRun(), { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledOnce();
  });

  it.each(["codex_local", "hermes_local"])("requires the actual database adapter, not a Hermes marker on %s", async (adapterType) => {
    await seedCompanyAndAgent({ adapterType });
    const run = hermesConnectionRun({ contextSnapshot: { adapterType: "hermes_gateway" } });
    await reportRunFailure(db, run);
    expect(mockCaptureRunFailure).toHaveBeenCalledWith(expect.objectContaining({ agentAdapter: adapterType }));
  });

  it.each(["missing", "other_company"])("does not suppress Hermes when its database agent is %s", async (kind) => {
    await seedCompanyAndAgent({ adapterType: "hermes_gateway" });
    const run = hermesConnectionRun(kind === "missing" ? { agentId: randomUUID() } : { companyId: randomUUID() });
    await reportRunFailure(db, run);
    expect(mockCaptureRunFailure).toHaveBeenCalledWith(expect.objectContaining({ agentAdapter: "unknown" }));
  });

  function missingSecretRun(overrides: Partial<typeof heartbeatRuns.$inferSelect> = {}) {
    return buildRun({
      errorCode: "configuration_incomplete",
      executionStage: "preparing",
      resultJson: {
        configurationIncomplete: {
          reason: "secret_binding_missing",
          missingBindings: [{ bindingType: "user_secret_ref", errorCode: "user_secret_missing" }],
        },
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
      ...overrides,
    });
  }

  it.each([
    { bindingType: "secret_ref" },
    { bindingType: "secret_ref", errorCode: "binding_missing" },
    ...["binding_missing", "responsible_user_missing", "user_secret_missing", "secret_inactive", "user_secret_definition_inactive"]
      .map((errorCode) => ({ bindingType: "user_secret_ref", errorCode })),
  ])("keeps the known pre-dispatch secret blocker local: %j", async (binding) => {
    await seedCompanyAndAgent();
    const run = missingSecretRun();
    (run.resultJson!.configurationIncomplete as Record<string, unknown>).missingBindings = [binding];
    const saved = structuredClone(run);

    await reportRunFailure(db, run, { phase: "setup" });

    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    expect(run).toEqual(saved);
  });

  it.each([
    {},
    { reason: "secret_binding_missing", missingBindings: [] },
    { reason: "secret_binding_missing", missingBindings: [null] },
    { reason: "secret_binding_missing", missingBindings: [{ errorCode: "user_secret_missing" }] },
    { reason: "secret_binding_missing", missingBindings: [{ bindingType: "user_secret_ref", errorCode: "provider_error" }] },
    { reason: "secret_binding_missing", missingBindings: [{ bindingType: "user_secret_ref", errorCode: "user_secret_definition_missing" }] },
    { reason: "secret_binding_missing", missingBindings: [{ bindingType: "user_secret_ref", errorCode: "new_unknown_reason" }] },
    { reason: "secret_binding_missing", missingBindings: [
      { bindingType: "user_secret_ref", errorCode: "user_secret_missing" },
      { bindingType: "secret_ref", errorCode: "provider_error" },
    ] },
    { reason: "ai_connection_unavailable" },
  ])("reports ambiguous, unknown, and provider failures: %j", async (configurationIncomplete) => {
    await seedCompanyAndAgent();
    const run = missingSecretRun();
    run.resultJson!.configurationIncomplete = configurationIncomplete;

    await reportRunFailure(db, run, { phase: "setup" });

    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "timed_out" },
    { errorCode: "setup_failed" },
    { errorCode: "workspace_validation_failed" },
    { errorCode: "adapter_failed" },
    { executionStage: "executing" },
    { executionStage: null },
    { exitCode: 1 },
    { exitCode: 0 },
    { signal: "SIGTERM" },
  ])("reports missing-secret text without a proven pre-dispatch outcome: %j", async (overrides) => {
    await seedCompanyAndAgent();

    await reportRunFailure(db, missingSecretRun(overrides), { phase: "setup" });

    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, { kind: "bootstrap" }, { kind: "bootstrap", providerWorkStarted: true }])(
    "reports missing-secret failures without explicit bootstrap proof: %j", async (executionRecovery) => {
      await seedCompanyAndAgent();
      const run = missingSecretRun();
      run.resultJson!.executionRecovery = executionRecovery;

      await reportRunFailure(db, run, { phase: "setup" });

      expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, "execute"] as const)("reports configuration failures outside setup: %s", async (phase) => {
    await seedCompanyAndAgent();

    await reportRunFailure(db, missingSecretRun(), { phase });

    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it("captures once for the status failed", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed" });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  function localPathConfigurationRun(overrides: Partial<typeof heartbeatRuns.$inferSelect> = {}) {
    return buildRun({
      errorCode: "workspace_validation_failed",
      executionStage: "preparing",
      resultJson: {
        workspaceValidation: {
          reason: "git_worktree_base_not_git_checkout",
          configurationReason: "local_path_requires_git_checkout",
          resolvedWorkspaceSource: "project_primary",
          workspaceStrategyType: "git_worktree",
          requestedExecutionWorkspaceMode: "isolated_workspace",
        },
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
      ...overrides,
    });
  }

  it.each(["isolated_workspace", "operator_branch"])("keeps proven local-path policy conflicts actionable locally: %s", async (mode) => {
    await seedCompanyAndAgent();
    const run = localPathConfigurationRun();
    (run.resultJson!.workspaceValidation as Record<string, unknown>).requestedExecutionWorkspaceMode = mode;
    const before = structuredClone(run);

    await reportRunFailure(db, run, { phase: "setup" });

    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    expect(run).toEqual(before);
  });

  it.each([
    { configurationReason: undefined },
    { configurationReason: "unknown_reason" },
    { reason: "git_worktree_base_materialization_failed" },
    { reason: "git_worktree_not_reusable" },
    { reason: "inherited_workspace_reuse_unavailable" },
    { resolvedWorkspaceSource: "agent_home" },
    { workspaceStrategyType: "project_primary" },
    { requestedExecutionWorkspaceMode: "agent_default" },
  ])("reports unproven and other workspace failures: %j", async (validation) => {
    await seedCompanyAndAgent();
    const run = localPathConfigurationRun();
    Object.assign(run.resultJson!.workspaceValidation as object, validation);
    await reportRunFailure(db, run, { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "timed_out" }, { errorCode: "setup_failed" }, { executionStage: "executing" },
    { exitCode: 1 }, { signal: "SIGTERM" }, { resultJson: {} },
    { resultJson: { workspaceValidation: { reason: "git_worktree_base_not_git_checkout", configurationReason: "local_path_requires_git_checkout" } } },
  ])("reports workspace failures without an exact pre-dispatch outcome: %j", async (overrides) => {
    await seedCompanyAndAgent();
    await reportRunFailure(db, localPathConfigurationRun(overrides), { phase: "setup" });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "execute"] as const)("reports local-path markers outside the setup report: %s", async (phase) => {
    await seedCompanyAndAgent();
    await reportRunFailure(db, localPathConfigurationRun(), { phase });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, { kind: "bootstrap" }, { kind: "bootstrap", providerWorkStarted: true }])(
    "reports local-path markers without affirmative unstarted-provider evidence: %j", async (executionRecovery) => {
      await seedCompanyAndAgent();
      const run = localPathConfigurationRun();
      run.resultJson!.executionRecovery = executionRecovery;
      await reportRunFailure(db, run, { phase: "setup" });
      expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
    },
  );

  it("captures once for the status timed_out", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "timed_out" });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ runStatus: "timed_out" }),
    );
  });

  it("forwards stored exit evidence even when the adapter error is generic", async () => {
    await seedCompanyAndAgent();
    for (const processExit of [
      { exitCode: 1, signal: null },
      { exitCode: null, signal: "SIGTERM" },
      { exitCode: null, signal: null },
    ]) {
      mockCaptureRunFailure.mockClear();
      await reportRunFailure(db, buildRun({
        error: "Adapter failed",
        errorCode: "adapter_failed",
        ...processExit,
        stdoutExcerpt: "private-output",
        stderrExcerpt: "private-error-output",
        resultJson: { private: "adapter-result" },
      }));

      expect(mockCaptureRunFailure).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: "Adapter failed",
        errorCode: "adapter_failed",
        ...processExit,
      }));
      const captured = mockCaptureRunFailure.mock.calls[0][0];
      expect(captured).not.toHaveProperty("stdoutExcerpt");
      expect(captured).not.toHaveProperty("stderrExcerpt");
      expect(captured).not.toHaveProperty("resultJson");
    }
  });

  it("reports selected provider diagnostics and the original cause without copying arbitrary payloads", async () => {
    await seedCompanyAndAgent();
    const cause = Object.assign(new Error("provider unreachable"), {
      code: "ECONNRESET", requestId: "request-123", status: 503,
      response: { body: "private-response" },
    });
    const error = new Error("adapter threw", { cause });
    const run = buildRun({
      runtimeMode: "legacy",
      executionStage: "execute",
      error: "adapter threw",
      stderrExcerpt: "private-stderr",
      stdoutExcerpt: "private-stdout",
      contextSnapshot: { prompt: "private-prompt" },
      resultJson: {
        terminalSessionFailure: { category: "service", title: "Provider unavailable", details: "request-123 failed", raw: "private-provider-raw" },
        timeoutFired: false, summary: "private-summary", env: { SECRET: "private-env" },
      },
    });
    await reportRunFailure(db, run, { error, phase: "execute", adapterErrorMeta: { phase: "turn", retryable: true, response: "private-adapter-response" } });
    const captured = mockCaptureRunFailure.mock.calls[0][0];
    expect(captured.diagnostics).toMatchObject({
      execution: { runtimeMode: "legacy", executionStage: "execute", failurePhase: "execute", timeoutFired: false },
      adapter: { phase: "turn", retryable: true },
      provider: { category: "service", title: "Provider unavailable", details: "request-123 failed" },
      exceptions: [{ message: "adapter threw" }, { message: "provider unreachable", code: "ECONNRESET", status: 503, requestId: "request-123" }],
    });
    expect(captured.diagnostics.exceptions[0].stack).toContain("run-failure-report.test.ts");
    // Match the sensitive fixture values, not a legitimate checkout name in the stack.
    for (const value of ["private-response", "private-stderr", "private-stdout", "private-prompt", "private-provider-raw", "private-summary", "private-env", "private-adapter-response"]) {
      expect(JSON.stringify(captured)).not.toContain(value);
    }
    expect(error.cause).toBe(cause);
  });

  it.each([false, true])("redacts registered run secrets and fails closed when resolution fails: %s", async (fails) => {
    await seedCompanyAndAgent();
    const secret = "opaque-registered-value";
    const run = buildRun({
      error: `connection failed: ${secret}`,
      contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "fixture", material: { encrypted: "fixture" } }] },
      resultJson: { terminalSessionFailure: { category: "service", details: `upstream rejected ${secret}` } },
    });
    await db.insert(heartbeatRuns).values(run);
    if (fails) mockResolveSecret.mockRejectedValueOnce(new Error("fixture resolution failed"));
    else mockResolveSecret.mockResolvedValueOnce(secret);

    await expect(reportRunFailure(db, run, {
      error: new Error(`failed ${secret}`, { cause: new Error(`cause ${secret}`) }),
      adapterErrorMeta: { causeMessage: `adapter ${secret}` },
    })).resolves.toBeUndefined();
    expect(mockResolveSecret).toHaveBeenCalledTimes(1);
    if (fails) {
      expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    } else {
      expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
      const captured = mockCaptureRunFailure.mock.calls[0][0];
      expect(JSON.stringify(captured)).not.toContain(secret);
      expect(captured.diagnostics.provider.details).toContain(REDACTED_EVENT_VALUE);
      expect(captured.diagnostics.exceptions[1].message).toContain(REDACTED_EVENT_VALUE);
    }
  });

  it("redacts runtime and host environment secret values even without a persisted registry", async () => {
    await seedCompanyAndAgent();
    const runtimeSecret = "opaque-runtime-value";
    const hostSecret = "opaque-host-value";
    vi.stubEnv("FIXTURE_CUSTOM_VALUE", hostSecret);
    const text = `connection failed: ${runtimeSecret} ${hostSecret}`;
    const run = buildRun({ error: text, contextSnapshot: null,
      resultJson: { terminalSessionFailure: { details: text } },
    });
    await reportRunFailure(db, run, {
      error: new Error(text, { cause: new Error(text) }),
      adapterErrorMeta: { causeMessage: text, stackPreview: text },
      secretValues: [runtimeSecret],
    });
    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
    const captured = mockCaptureRunFailure.mock.calls[0][0];
    expect(JSON.stringify(captured)).not.toContain(runtimeSecret);
    expect(JSON.stringify(captured)).not.toContain(hostSecret);
    expect(captured.diagnostics.exceptions).toHaveLength(2);
    expect(captured).not.toHaveProperty("secretValues");
  });

  it("still redacts short values from unknown host settings", async () => {
    await seedCompanyAndAgent();
    vi.stubEnv("FIXTURE_CUSTOM_VALUE", "1");

    await reportRunFailure(db, buildRun());

    expect(mockCaptureRunFailure.mock.calls[0][0].errorMessage)
      .toBe(`the provider process exited with code ${REDACTED_EVENT_VALUE}`);
  });

  it("captures nothing for succeeded, cancelled, and interrupted", async () => {
    await seedCompanyAndAgent();
    for (const status of ["succeeded", "cancelled", "interrupted"] as const) {
      const run = buildRun({ status });
      await reportRunFailure(db, run);
    }

    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });
  it.each(["provider", "unknown"])("reports an unexpected started cancellation from %s", async source => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "cancelled", startedAt: new Date(0), finishedAt: new Date(1000),
      resultJson: { cancellation: { source, expected: false, initiator: { type: "provider", id: "private-actor" },
        reason: "private-reason", recordedAt: new Date(1000).toISOString() } } });
    await reportRunFailure(db, run);
    expect(mockCaptureRunFailure).toHaveBeenCalledOnce();
    expect(mockCaptureRunFailure.mock.calls[0][0]).toMatchObject({ runStatus: "cancelled",
      diagnostics: { execution: { cancellationSource: source, cancellationExpected: false } } });
    expect(JSON.stringify(mockCaptureRunFailure.mock.calls)).not.toMatch(/private-actor|private-reason/);
  });
  it("does not report an operator's Stop as a failure", async () => {
    await seedCompanyAndAgent();
    await reportRunFailure(db, buildRun({ status: "cancelled", startedAt: new Date(0), resultJson: {
      cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "board" },
        reason: "Stop", recordedAt: new Date().toISOString() },
    } }));
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });

  it("sends agents.adapterType from the loaded agent row", async () => {
    await seedCompanyAndAgent({ adapterType: "claude_managed" });
    const run = buildRun({ status: "failed" });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ agentAdapter: "claude_managed" }),
    );
  });

  it("sends the adapter value unknown when the agent row is absent", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed", agentId: randomUUID() });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ agentAdapter: "unknown" }),
    );
  });

  it("calls redactCurrentUserText on the error message before it composes the credential redactor", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed", error: "raw message" });

    await reportRunFailure(db, run);

    expect(mockRedactCurrentUserText).toHaveBeenCalledWith("raw message");
  });

  it("removes an Authorization: Bearer credential from the error message", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      error: "the adapter request failed: Authorization: Bearer live-secret-token-value",
    });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain("live-secret-token-value");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("removes an API-key form from the error message", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      error: `adapter payload: {"apiKey":"json-secret-value"}`,
    });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain("json-secret-value");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("removes a JSON Web Token form from the error message", async () => {
    await seedCompanyAndAgent();
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const run = buildRun({ status: "failed", error: `session token: ${jwt}` });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain(jwt);
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("removes a password value from the error message", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      error: `login failed: password="hunter2-super-secret"`,
    });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain("hunter2-super-secret");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("removes a database connection string from the error message", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      error: `connect failed: connectionString: "postgres://appuser:s3cr3t-pass@db.internal:5432/paperclip"`,
    });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain("s3cr3t-pass");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("still masks the current user's home path in the error message", async () => {
    await seedCompanyAndAgent();
    const homeDir = os.homedir();
    const rawError = `read failed at ${homeDir}/workspace/report.log`;
    const run = buildRun({ status: "failed", error: rawError });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    // Environment-value redaction can fully mask the username before the
    // current-user redactor applies its partial mask. Both remove the home path.
    expect(errorMessage).toContain("workspace/report.log");
    expect(errorMessage).not.toContain(homeDir);
  });

  const MAX_ERROR_MESSAGE_LENGTH = 4096;

  it("truncates an error message that is longer than the bound", async () => {
    await seedCompanyAndAgent();
    const longError = "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 500);
    const run = buildRun({ status: "failed", error: longError });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(errorMessage).toBe("x".repeat(MAX_ERROR_MESSAGE_LENGTH - 12) + "\n[truncated]");
  });

  it("preserves a short error message with known public host settings", async () => {
    vi.stubEnv("PAPERCLIP_DB_BACKUP_ENABLED", "false");
    vi.stubEnv("PAPERCLIP_DB_BACKUP_RETENTION_DAYS", "1");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    await seedCompanyAndAgent();
    const shortError = "the provider process exited with code 1";
    const run = buildRun({ status: "failed", error: shortError });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).toBe(shortError);
  });

  const MAX_ERROR_CODE_LENGTH = 200;

  it("sends a normal error code such as adapter_failed to Sentry unchanged", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed", errorCode: "adapter_failed" });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "adapter_failed" }),
    );
  });

  it("redacts an error code that holds a credential form", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      errorCode: "Authorization: Bearer live-secret-token-value",
    });

    await reportRunFailure(db, run);

    const { errorCode } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorCode).not.toContain("live-secret-token-value");
    expect(errorCode).toContain(REDACTED_EVENT_VALUE);
  });

  it("truncates an error code that is longer than 200 characters", async () => {
    await seedCompanyAndAgent();
    const longErrorCode = "y".repeat(MAX_ERROR_CODE_LENGTH + 50);
    const run = buildRun({ status: "failed", errorCode: longErrorCode });

    await reportRunFailure(db, run);

    const { errorCode } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorCode).toHaveLength(MAX_ERROR_CODE_LENGTH);
    expect(errorCode).toBe("y".repeat(MAX_ERROR_CODE_LENGTH - 12) + "\n[truncated]");
  });

  it("sends errorCode null unchanged when the run holds no error code", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed", errorCode: null });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: null }),
    );
  });

  it("reads the task id from nativeIssueId, falling back to contextSnapshot.issueId", async () => {
    await seedCompanyAndAgent();
    const nativeIssueId = randomUUID();
    const runWithNativeIssueId = buildRun({
      status: "failed",
      nativeIssueId,
      contextSnapshot: { issueId: randomUUID() },
    });

    await reportRunFailure(db, runWithNativeIssueId);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: nativeIssueId }),
    );

    mockCaptureRunFailure.mockClear();
    const contextIssueId = randomUUID();
    const runWithContextIssueId = buildRun({
      status: "failed",
      nativeIssueId: null,
      contextSnapshot: { issueId: contextIssueId },
    });

    await reportRunFailure(db, runWithContextIssueId);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: contextIssueId }),
    );
  });

  it("does not throw when the database read fails", async () => {
    const throwingDb = {
      select: () => {
        throw new Error("connection reset");
      },
    } as unknown as Db;
    const run = buildRun({ status: "failed", agentId: randomUUID() });

    await expect(reportRunFailure(throwingDb, run)).resolves.toBeUndefined();
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });

  describe("waitForPendingRunFailureReports", () => {
    function deferredAgentRows() {
      let resolve!: (rows: Array<{ adapterType: string }>) => void;
      const promise = new Promise<Array<{ adapterType: string }>>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    function fakeDb(agentRowsPromise: Promise<Array<{ adapterType: string }>>): Db {
      return {
        select: () => ({
          from: () => ({
            where: () => agentRowsPromise,
          }),
        }),
      } as unknown as Db;
    }

    it("resolves at once when no report is in flight", async () => {
      await expect(waitForPendingRunFailureReports()).resolves.toBeUndefined();
    });

    it("waits for an unawaited report's database read and Sentry capture before it resolves", async () => {
      const agentRows = deferredAgentRows();
      const run = buildRun({ status: "failed", agentId: randomUUID() });

      // Do not await the report — this models the fire-and-forget
      // `void reportRunFailure(db, run)` call every caller uses.
      void reportRunFailure(fakeDb(agentRows.promise), run);

      const drain = waitForPendingRunFailureReports(1_000);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockCaptureRunFailure).not.toHaveBeenCalled();

      agentRows.resolve([{ adapterType: "claude_managed" }]);
      await drain;

      expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
    });

    it("gives up after the bound and does not throw when a report never settles", async () => {
      const run = buildRun({ status: "failed", agentId: randomUUID() });
      void reportRunFailure(fakeDb(new Promise(() => undefined)), run);

      await expect(waitForPendingRunFailureReports(20)).resolves.toBeUndefined();
      expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    });
  });
});
