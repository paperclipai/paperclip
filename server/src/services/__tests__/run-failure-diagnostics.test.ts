import { captureEnvironmentAcquisitionDiagnostic } from "../environment-acquisition-diagnostics.js";
import { describe, expect, it } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import { collectRunFailureDiagnostics, collectRunFailureSecretValues, redactRunFailureSecretValues, sanitizeRunFailureDiagnostics, sanitizeRunFailureText } from "../run-failure-diagnostics.js";

type Run = typeof heartbeatRuns.$inferSelect;
const run = (overrides: Partial<Run> = {}) => ({ resultJson: null, ...overrides }) as Run;
const collect = (error: unknown) => collectRunFailureDiagnostics(run(), { error });

describe("run failure diagnostics", () => {
  it("reports only private acquisition observations for the exact failed setup run", () => {
    const scope = { companyId: "company-fixture", environmentId: "environment-fixture", runId: "run-fixture" };
    const diagnostic = { phase: "workspace", elapsedMs: 100, budgetMs: 2_000 } as const;
    const error = Object.freeze(new Error("Acquisition failed"));
    const properties = Object.getOwnPropertyDescriptors(error);
    captureEnvironmentAcquisitionDiagnostic(error, scope, diagnostic);
    const fixture = run({ id: scope.runId, companyId: scope.companyId, errorCode: "setup_failed" });
    const collectSetup = (failure: unknown, record = fixture) => collectRunFailureDiagnostics(record, { error: failure, phase: "setup" }).execution;
    expect(collectSetup(new Error("Cleanup confirmed", { cause: error }))).toMatchObject({
      environmentAcquisitionPhase: "workspace", environmentAcquisitionElapsedMs: 100, environmentAcquisitionBudgetMs: 2_000,
    });
    expect(collectSetup(error, run({ ...fixture, id: "another-run" }))).not.toHaveProperty("environmentAcquisitionPhase");
    expect(collectSetup(error, run({ ...fixture, companyId: "another-company" }))).not.toHaveProperty("environmentAcquisitionPhase");
    expect(collectSetup(error, run({ ...fixture, errorCode: "adapter_failed" }))).not.toHaveProperty("environmentAcquisitionPhase");
    expect(collectRunFailureDiagnostics(fixture, { error, phase: "execute" }).execution).not.toHaveProperty("environmentAcquisitionPhase");
    expect(Object.getOwnPropertyDescriptors(error)).toEqual(properties);
    captureEnvironmentAcquisitionDiagnostic(error, scope, null);
    expect(collectSetup(error)).not.toHaveProperty("environmentAcquisitionPhase");
  });

  it("ignores forged acquisition fields and persisted JSON without private producer evidence", () => {
    const acquisitionDiagnostic = { phase: "shell", elapsedMs: 2_000, budgetMs: 2_000 };
    const error = Object.assign(new Error("Acquisition failed"), { acquisitionDiagnostic,
      data: { schema: "paperclip/environment-creation-cleanup/v1", acquisitionDiagnostic },
    });
    expect(collectRunFailureDiagnostics(run({ errorCode: "setup_failed", resultJson: { acquisitionDiagnostic,
      environmentAcquisitionPhase: "shell", environmentAcquisitionElapsedMs: 2_000,
    } }), { error, phase: "setup" }).execution).toEqual({ failurePhase: "setup" });
  });

  it("exports only bounded workspace base-ref observations without treating them as proof", () => {
    const resultJson = { configurationIncomplete: { reason: "workspace_base_ref_unresolved",
      requestedRef: "private-ref", fetchError: "private-stderr", baseRefDiagnostic: {
        schemaVersion: 1, remoteLookup: "resolved", authLookup: "failed", fetch: "failed", fetchExitCode: 128,
        fetchFailureKind: "authentication_failed", refResolution: "failed", refExitCode: 128,
        repoUrl: "https://private.example.invalid", stderr: "private-token", credential: "private-credential",
      } } };
    const execution = collectRunFailureDiagnostics(run({ errorCode: "configuration_incomplete", resultJson }), {}).execution;
    expect(execution).toEqual({ workspaceBaseRefRemoteLookup: "resolved", workspaceBaseRefAuthLookup: "failed",
      workspaceBaseRefFetch: "failed", workspaceBaseRefFetchExitCode: 128, workspaceBaseRefFetchFailureKind: "authentication_failed",
      workspaceBaseRefRefResolution: "failed", workspaceBaseRefRefExitCode: 128 });
    expect(JSON.stringify(execution)).not.toContain("private");
    expect(collectRunFailureDiagnostics(run({ errorCode: "setup_failed", resultJson }), {}).execution).toEqual({});
    expect(collectRunFailureDiagnostics(run({ errorCode: "configuration_incomplete", resultJson: {
      configurationIncomplete: { ...resultJson.configurationIncomplete, reason: "other" },
    } }), {}).execution).toEqual({});
  });

  it.each([null, -1, 256, Infinity, NaN, 1.5, "private-value", {}])("omits invalid base-ref process codes (%j)", code => {
    const execution = collectRunFailureDiagnostics(run({ errorCode: "configuration_incomplete", resultJson: {
      configurationIncomplete: { reason: "workspace_base_ref_unresolved", baseRefDiagnostic: {
        schemaVersion: 1, remoteLookup: "resolved", authLookup: "not_requested", fetch: "failed", fetchExitCode: code,
        refResolution: "failed", refExitCode: code, fetchFailureKind: "private-value",
      } },
    } }), {}).execution;
    expect(execution).not.toHaveProperty("workspaceBaseRefFetchExitCode");
    expect(execution).not.toHaveProperty("workspaceBaseRefRefExitCode");
    expect(execution).not.toHaveProperty("workspaceBaseRefFetchFailureKind");
  });

  it("rejects forged or unknown base-ref shapes without reading accessor payloads", () => {
    const base = { schemaVersion: 1, remoteLookup: "resolved", authLookup: "not_requested", fetch: "failed" };
    let reads = 0;
    const accessor = Object.defineProperty({}, "schemaVersion", { get() { reads++; throw new Error("private-accessor"); } });
    for (const baseRefDiagnostic of [null, {}, [], accessor, Object.create(base), { ...base, schemaVersion: 2 },
      { ...base, remoteLookup: "private-url" }, { ...base, authLookup: "private-token" }, { ...base, fetch: "private-command" }]) {
      expect(collectRunFailureDiagnostics(run({ errorCode: "configuration_incomplete", resultJson: {
        configurationIncomplete: { reason: "workspace_base_ref_unresolved", baseRefDiagnostic },
      } }), {}).execution).toEqual({});
    }
    expect(reads).toBe(0);
  });

  it("exports only fixed workspace validation codes and bounded inspection evidence", () => {
    const resultJson = { workspaceValidation: { reason: "git_worktree_not_reusable", reasonCode: "git_inspection_failed",
      worktreePath: "/private/path", executionWorkspaceId: "private-id", repository: "private-url", message: "private-message",
      inspectionDiagnostic: { command: "worktree_list", failure: "nonzero_exit", exitCode: 128, stderr: "private-token" } } };
    const execution = collectRunFailureDiagnostics(run({ errorCode: "workspace_validation_failed", resultJson }), {}).execution;
    expect(execution).toEqual({ workspaceValidationReason: "git_worktree_not_reusable", workspaceValidationReasonCode: "git_inspection_failed",
      workspaceValidationInspectionCommand: "worktree_list", workspaceValidationInspectionFailure: "nonzero_exit", workspaceValidationInspectionExitCode: 128 });
    expect(JSON.stringify(execution)).not.toContain("private");
    expect(collectRunFailureDiagnostics(run({ errorCode: "adapter_failed", resultJson }), {}).execution).toEqual({});
  });

  it.each(["missing_worktree", "not_a_git_checkout", "not_registered", "wrong_repository_root", "branch_mismatch"])(
    "exports %s without attaching unrelated probe evidence", reasonCode => {
      expect(collectRunFailureDiagnostics(run({ errorCode: "workspace_validation_failed", resultJson: { workspaceValidation: {
        reason: "git_worktree_not_reusable", reasonCode, inspectionDiagnostic: { command: "worktree_list", failure: "nonzero_exit", exitCode: 128 },
      } } }), {}).execution).toEqual({ workspaceValidationReason: "git_worktree_not_reusable", workspaceValidationReasonCode: reasonCode });
    },
  );

  it.each([null, -1, 0, 256, Infinity, NaN, 1.5, "private", {}])("omits invalid Git inspection exit codes (%j)", exitCode => {
    const execution = collectRunFailureDiagnostics(run({ errorCode: "workspace_validation_failed", resultJson: { workspaceValidation: {
      reason: "git_worktree_not_reusable", reasonCode: "git_inspection_failed",
      inspectionDiagnostic: { command: "worktree_list", failure: "nonzero_exit", exitCode },
    } } }), {}).execution;
    expect(execution).not.toHaveProperty("workspaceValidationInspectionExitCode");
    expect(JSON.stringify(execution)).not.toContain("private");
  });

  it("omits unknown validation values and contains hostile diagnostic getters", () => {
    const inspect = (workspaceValidation: unknown) => collectRunFailureDiagnostics(run({ errorCode: "workspace_validation_failed", resultJson: { workspaceValidation } }), {}).execution;
    expect(inspect({ reason: "private" })).toEqual({});
    expect(inspect({ reason: "git_worktree_not_reusable", reasonCode: "private" })).toEqual({ workspaceValidationReason: "git_worktree_not_reusable" });
    const base = { reason: "git_worktree_not_reusable", reasonCode: "git_inspection_failed" };
    for (const inspectionDiagnostic of [null, {}, { command: "private", failure: "nonzero_exit" }, { command: "worktree_list", failure: "private" },
      Object.defineProperty({}, "command", { get() { throw new Error("private"); } })]) {
      expect(inspect({ ...base, inspectionDiagnostic })).toEqual({ workspaceValidationReason: base.reason, workspaceValidationReasonCode: base.reasonCode });
    }
    const error = Object.defineProperty({ command: "worktree_list", failure: "spawn_failed" }, "errorCode", { get() { throw new Error("private"); } });
    expect(inspect({ ...base, inspectionDiagnostic: error })).toMatchObject({ workspaceValidationInspectionErrorCode: "unknown" });
    expect(inspect({ ...base, inspectionDiagnostic: { command: "worktree_list", failure: "spawn_failed", errorCode: "EACCES", exitCode: 128 } })).toMatchObject({ workspaceValidationInspectionErrorCode: "EACCES" });
  });

  it.each(["source_scope_mismatch", "explicit_project_workspace_conflict", "source_path_unproven",
    "source_registration_unproven", "source_repository_mismatch", "source_repository_unavailable"])(
    "exports only the fixed retained-source reason %s", reasonCode => {
      const workspaceValidation = { reason: "persisted_workspace_source_conflict", reasonCode,
        executionWorkspaceId: "private-id", repoUrl: "private-url", cwd: "/private-path", message: "private-message" };
      expect(collectRunFailureDiagnostics(run({ errorCode: "workspace_validation_failed", resultJson: { workspaceValidation } }), {}).execution)
        .toEqual({ workspaceValidationReason: "persisted_workspace_source_conflict", workspaceValidationReasonCode: reasonCode });
      expect(collectRunFailureDiagnostics(run({ errorCode: "adapter_failed", resultJson: { workspaceValidation } }), {}).execution).toEqual({});
    },
  );

  it("omits arbitrary retained-source reason strings and hostile getters", () => {
    for (const reasonCode of ["private-url", Object.defineProperty({}, "value", { get() { throw new Error("private"); } })]) {
      expect(collectRunFailureDiagnostics(run({ errorCode: "workspace_validation_failed", resultJson: { workspaceValidation: {
        reason: "persisted_workspace_source_conflict", reasonCode,
      } } }), {}).execution).toEqual({ workspaceValidationReason: "persisted_workspace_source_conflict" });
    }
    const workspaceValidation = Object.defineProperty({ reason: "persisted_workspace_source_conflict" }, "reasonCode", {
      get() { throw new Error("private"); },
    });
    expect(collectRunFailureDiagnostics(run({ errorCode: "workspace_validation_failed", resultJson: { workspaceValidation } }), {}).execution)
      .toEqual({ workspaceValidationReason: "persisted_workspace_source_conflict" });
  });

  it("exports bounded orphan evidence only for a process-loss failure", () => {
    const processLossDiagnostic = { pidRecorded: false, groupRecorded: false, localCheck: "no_identifiers",
      retryEligible: false, runPredatesObserver: true, observerUptimeMs: 30_000, lastOutputAgeMs: 120_000,
      pid: 123, path: "/private-path", prompt: "private-prompt" };
    const resultJson = { processLossDiagnostic };
    expect(collectRunFailureDiagnostics(run({ errorCode: "process_lost", resultJson }), {}).execution).toEqual({
      processLossPidRecorded: false, processLossGroupRecorded: false, processLossLocalCheck: "no_identifiers",
      processLossRetryEligible: false, processLossRunPredatesObserver: true,
      processLossObserverUptimeMs: 30_000, processLossLastOutputAgeMs: 120_000,
    });
    expect(collectRunFailureDiagnostics(run({ errorCode: "adapter_failed", resultJson }), {}).execution).toEqual({});
  });

  it("exports only the closed native model/auth rejection vocabulary", () => {
    const diagnostic = { provider: "codex", category: "model_auth_incompatible", status: 400, authMode: "chatgpt" };
    const result = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics(run({ resultJson: {
      nativeProviderFailure: { ...diagnostic, model: "private-model", response: "private-provider-response", prompt: "private-prompt" },
    } }), {}));
    expect(result.provider).toEqual(diagnostic);
    expect(JSON.stringify(result)).not.toContain("private");
    for (const value of [null, [], { ...diagnostic, category: "private-category" },
      Object.defineProperty({}, "provider", { get() { throw new Error("private"); } })]) {
      expect(collectRunFailureDiagnostics(run({ resultJson: { nativeProviderFailure: value } }), {}).provider).toEqual({});
    }
  });

  it("selects bounded lock-owner evidence from a caught timeout cause", () => {
    const error = new Error("outer", { cause: Object.assign(new Error("lock timeout"), {
      code: "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT",
      workspaceRestoreLock: { operation: "agent_directory_release", ownerState: "alive", ownerSameProcess: true,
        ownerPredatesProcess: true, knownLocalHolder: false, ownerAgeMs: 120_000, waitMs: 30_001,
        ownerPid: 123, path: "/sentinel-lock-path", owner: { payload: "sentinel-owner-payload" } },
    }) });
    const result = sanitizeRunFailureDiagnostics(collect(error));
    expect(result.execution).toEqual({ restoreLockOperation: "agent_directory_release", restoreLockOwnerState: "alive", restoreLockOwnerSameProcess: true,
      restoreLockOwnerPredatesProcess: true, restoreLockKnownLocalHolder: false,
      restoreLockOwnerAgeMs: 120_000, restoreLockWaitMs: 30_001 });
    expect(JSON.stringify(result)).not.toContain("sentinel-");
    expect(result.execution).not.toHaveProperty("ownerPid");
  });

  it.each([null, -1, Infinity, NaN, 1.5, 604_800_001, "private", {}])("omits invalid lock diagnostic values (%j)", value => {
    const error = Object.assign(new Error("lock timeout"), { code: "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT",
      workspaceRestoreLock: { operation: value, ownerState: value, ownerAgeMs: value, waitMs: value,
        ownerSameProcess: value, ownerPredatesProcess: value, knownLocalHolder: value } });
    expect(collect(error).execution).toEqual({});
  });

  it("does not attach lock evidence to unrelated errors or invoke hostile getters", () => {
    expect(collect({ code: "OTHER", workspaceRestoreLock: { ownerState: "alive" } }).execution).toEqual({});
    const error = { code: "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT",
      workspaceRestoreLock: Object.defineProperty({}, "ownerState", { get() { throw new Error("private"); } }) };
    expect(collect(error).execution).toEqual({});
  });

  it.each(["restore_permission_denied", "restore_lock_timeout", "restore_unsafe_archive", "restore_failed"])(
    "includes the saved %s classification without copying workspace paths or results", (code) => {
      const result = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics(run({ resultJson: {
        workspaceRestoreFailure: code, workspaceRestorePath: "/private/workspace",
        executionBeforeRestore: { errorMessage: "private provider response" },
      } }), {}));
      expect(result.execution).toEqual({ workspaceRestoreFailure: code });
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it.each([null, false, 1, "private arbitrary code", { error: "private" }])(
    "omits unknown workspace restore classifications (%j)", (value) => {
      const result = collectRunFailureDiagnostics(run({ resultJson: { workspaceRestoreFailure: value } }), {});
      expect(result.execution).not.toHaveProperty("workspaceRestoreFailure");
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it("copies only classified restore diagnostics from the saved result", () => {
    const result = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics(run({ resultJson: {
      workspaceRestoreFailure: "restore_failed",
      workspaceRestoreDiagnostic: {
        phase: "workspace", step: "git_integration", errorCode: "unknown", httpStatus: 503, exitCode: 1,
        gitCommand: "merge_tree", gitFailureKind: "merge_conflict",
        message: "private command failed", path: "/private/workspace", stdout: "private file contents",
        cause: { code: "EIO", message: "private nested cause" },
      },
    } }), {}));
    expect(result.execution).toEqual({
      workspaceRestoreFailure: "restore_failed", workspaceRestorePhase: "workspace",
      workspaceRestoreStep: "git_integration", workspaceRestoreErrorCode: "unknown",
      workspaceRestoreHttpStatus: 503, workspaceRestoreExitCode: 1,
      workspaceRestoreGitCommand: "merge_tree", workspaceRestoreGitFailureKind: "merge_conflict",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.exceptions).toEqual([]);
  });

  it.each([
    { phase: "asset", step: "git_integration", gitCommand: "merge_tree", gitFailureKind: "merge_conflict" },
    { phase: "workspace", step: "git_import", gitCommand: "merge_tree", gitFailureKind: "merge_conflict" },
    { phase: "workspace", step: "git_integration", gitCommand: "private-command", gitFailureKind: "private-output" },
  ])("omits unrelated or unrecognized persisted Git labels (%j)", (diagnostic) => {
    const result = collectRunFailureDiagnostics(run({ resultJson: {
      workspaceRestoreFailure: "restore_failed", workspaceRestoreDiagnostic: diagnostic,
    } }), {});
    expect(result.execution).not.toHaveProperty("workspaceRestoreGitCommand");
    expect(result.execution).not.toHaveProperty("workspaceRestoreGitFailureKind");
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("requires a known restore failure before reading its diagnostic", () => {
    const diagnostic = { phase: "workspace", step: "git_import", errorCode: "EIO", exitCode: 1 };
    for (const code of [undefined, null, "private unknown classification"]) {
      const result = collectRunFailureDiagnostics(run({ resultJson: {
        workspaceRestoreFailure: code, workspaceRestoreDiagnostic: diagnostic,
      } }), {});
      expect(result.execution).toEqual({});
    }
    const resultJson = Object.defineProperty({}, "workspaceRestoreDiagnostic", {
      get() { throw new Error("must not read unrelated diagnostic"); },
    });
    expect(collectRunFailureDiagnostics(run({ resultJson }), {}).execution).toEqual({});
  });

  it.each([null, false, 1, "private payload", [], { phase: "private phase", errorCode: "EIO" }])(
    "omits malformed workspace restore diagnostics (%j)", (value) => {
      const result = collectRunFailureDiagnostics(run({ resultJson: {
        workspaceRestoreFailure: "restore_failed", workspaceRestoreDiagnostic: value,
      } }), {});
      expect(result.execution).toEqual({ workspaceRestoreFailure: "restore_failed" });
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it.each([null, -1, Infinity, NaN, 1.5, 600, "private status", {}])(
    "omits invalid restore status and exit values (%j)", (value) => {
      const result = collectRunFailureDiagnostics(run({ resultJson: {
        workspaceRestoreFailure: "restore_failed",
        workspaceRestoreDiagnostic: {
          phase: "asset", step: "private step", errorCode: "private code", httpStatus: value, exitCode: value,
        },
      } }), {});
      expect(result.execution).toEqual({
        workspaceRestoreFailure: "restore_failed", workspaceRestorePhase: "asset", workspaceRestoreErrorCode: "unknown",
      });
    },
  );

  it("does not walk restore causes or expose errors from diagnostic getters", () => {
    const diagnostic = Object.defineProperties({ phase: "workspace", errorCode: "EIO" }, {
      step: { get() { throw new Error("private getter"); } },
      httpStatus: { get() { throw new Error("private getter"); } },
      exitCode: { get() { throw new Error("private getter"); } },
      cause: { get() { throw new Error("must not walk cause"); } },
    });
    const result = collectRunFailureDiagnostics(run({ resultJson: {
      workspaceRestoreFailure: "restore_failed", workspaceRestoreDiagnostic: diagnostic,
    } }), {});
    expect(result.execution).toEqual({
      workspaceRestoreFailure: "restore_failed", workspaceRestorePhase: "workspace", workspaceRestoreErrorCode: "EIO",
    });
    expect(result.exceptions).toEqual([]);
  });

  it("includes only bounded ACP activity fields, not tool names, identities, or output", () => {
    const result = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics(run({ resultJson: {
      acpLastEventAgeMs: 14_000_000, acpObservedEventCount: 9, acpPendingToolCount: 2,
      acpToolInventoryComplete: false, acpToolNames: ["private command"], lastEvent: "private output",
    } }), {}));
    expect(result.execution).toEqual({
      acpLastEventAgeMs: 14_000_000, acpObservedEventCount: 9, acpPendingToolCount: 2,
      acpToolInventoryComplete: false,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([null, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, "private", {}])(
    "omits invalid ACP activity fields (%j)", (value) => {
      const result = collectRunFailureDiagnostics(run({ resultJson: {
        acpLastEventAgeMs: value, acpObservedEventCount: value, acpPendingToolCount: value,
        acpToolInventoryComplete: value,
      } }), {});
      expect(result.execution).toEqual({});
    },
  );

  it("selects declared environment secrets under opaque names and common credential keys", () => {
    expect(collectRunFailureSecretValues({
      CUSTOM_BINDING: "bound-opaque-value", ACCESS_TOKEN: "plain-opaque-value", REGION: "us-east-1", EMPTY_KEY: "",
    }, ["CUSTOM_BINDING"])).toEqual(["bound-opaque-value", "plain-opaque-value", "us-east-1"]);
    expect(collectRunFailureSecretValues({ PATH: "/usr/bin", CUSTOM_BINDING: "opaque" }, [], true)).toEqual(["opaque"]);
    expect(collectRunFailureSecretValues({ PATH: "secret-override" }, ["PATH"], true)).toEqual(["secret-override"]);
  });

  it("redacts encoded credentials and URL passwords without expanding replacement markers", () => {
    const secret = 'opaque/"credential';
    const values = collectRunFailureSecretValues({ DATABASE_URL: `postgres://user:${encodeURIComponent(secret)}@example/db` });
    const result = redactRunFailureSecretValues({ text: `${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret)}`, status: 503 }, [...values, "REDACTED"]);
    expect(result.text).not.toContain("opaque");
    expect(result.status).toBe(503);
    expect(result.text).not.toContain("***[REDACTED]");
  });

  it("preserves known boolean and numeric settings without exempting unknown or declared secrets", () => {
    const env = { PAPERCLIP_DB_BACKUP_ENABLED: "false", PAPERCLIP_DB_BACKUP_RETENTION_DAYS: "1" };
    expect(collectRunFailureSecretValues(env, [], true)).toEqual([]);
    expect(collectRunFailureSecretValues(env, ["PAPERCLIP_DB_BACKUP_ENABLED"], true)).toEqual(["false"]);
    expect(collectRunFailureSecretValues({ CUSTOM_BINDING: "1" }, [], true)).toEqual(["1"]);
    expect(collectRunFailureSecretValues({ PAPERCLIP_DB_BACKUP_ENABLED: "opaque" }, [], true)).toEqual(["opaque"]);
  });
  it("preserves generic exceptions, numeric codes and nested network causes", () => {
    const root = Object.assign(new Error("network failed"), { code: "ECONNRESET", statusCode: 502, request_id: "req-123" });
    const outer = Object.assign(new TypeError("adapter failed", { cause: root }), { code: -32000 });
    const result = sanitizeRunFailureDiagnostics(collect(outer));
    expect(result.exceptions).toMatchObject([
      { name: "TypeError", message: "adapter failed", code: "-32000" },
      { name: "Error", message: "network failed", code: "ECONNRESET", status: 502, requestId: "req-123" },
    ]);
    expect(result.exceptions[0].stack).toContain("run-failure-diagnostics.test.ts");
  });

  it("bounds cyclic, deep, and string causes without inspecting arbitrary error objects", () => {
    const cyclic = new Error("cycle"); cyclic.cause = cyclic;
    expect(collect(cyclic)).toMatchObject({ exceptions: [{ message: "cycle" }], truncatedFields: ["exceptions.cycle"] });
    let error = new Error("leaf");
    for (let i = 0; i < 10; i++) error = new Error(`level-${i}`, { cause: error });
    expect(collect(error).exceptions).toHaveLength(4);
    expect(collect(error).truncatedFields).toContain("exceptions.depth");
    expect(collect(new Error("outer", { cause: "string cause" })).exceptions).toHaveLength(2);
    const getter = Object.defineProperty({ message: "valid message" }, "response", { get: () => { throw new Error("must not read"); } });
    expect(collect(getter).exceptions).toEqual([{ message: "valid message" }]);
    expect(collect({ arbitrary: "private payload" }).exceptions).toEqual([]);
    expect(collect(Object.defineProperty({}, "message", { get: () => { throw new Error("bad getter"); } })).exceptions).toEqual([]);
  });

  it("redacts credential forms before truncation in all diagnostic text", () => {
    const failure = collectRunFailureDiagnostics(run({ resultJson: {
      terminalSessionFailure: { category: "service", title: 'password="secret-password"', details: 'Authorization: Bearer secret-bearer' },
    } }), { error: Object.assign(new Error('apiKey="secret-api-key"'), { cause: new Error('token="secret-token"') }), adapterErrorMeta: { causeMessage: 'password="secret-password"' } });
    const result = sanitizeRunFailureDiagnostics(failure);
    expect(JSON.stringify(result)).not.toContain("secret-");
    expect(sanitizeRunFailureText('x'.repeat(90) + ' password="secret-at-cut-boundary"', 110)).not.toContain("secret-at");
    expect(sanitizeRunFailureText('pass\x1b[31mword="secret-colored"', 200)).not.toContain("secret-colored");
  });

  it("reports truncation, preserves UTF-16 pairs, and keeps the total payload bounded", () => {
    const huge = "😀".repeat(100_000);
    let error = Object.assign(new Error(huge), { stack: huge });
    for (let i = 0; i < 5; i++) error = Object.assign(new Error(huge, { cause: error }), { stack: huge });
    const result = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics(run({ resultJson: {
      terminalSessionFailure: { category: "service", title: huge, details: huge, truncatedFields: ["details", "private-field"] },
    } }), { error }));
    expect(String(result.provider.title).length).toBeLessThanOrEqual(4096);
    expect(String(result.provider.details).length).toBeLessThanOrEqual(12288);
    expect(JSON.stringify(result)).not.toMatch(/[\ud800-\udfff]/u);
    expect(result.truncatedFields).toContain("provider.details");
    expect(result.truncatedFields).toContain("exceptions.0.stack");
    expect(result.truncatedFields).not.toContain("provider.private-field");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(150_000);
  });

  it("keeps scalar native and legacy execution evidence and rejects non-finite durations", () => {
    const result = collectRunFailureDiagnostics(run({
      runtimeMode: "native", nativePhase: "turn", driverKind: "codex", driverVersion: "1.2.3",
      startedAt: new Date(1000), finishedAt: new Date(8500),
      resultJson: { stopReason: "failed", timeoutFired: true, effectiveTimeoutSec: 60, errorFamily: "transient_upstream", summary: "private prose" },
    }), { phase: "execute" });
    expect(result.execution).toMatchObject({ runtimeMode: "native", nativePhase: "turn", driverKind: "codex", driverVersion: "1.2.3", durationMs: 7500, timeoutFired: true, effectiveTimeoutSec: 60, errorFamily: "transient_upstream" });
    expect(JSON.stringify(result)).not.toContain("private prose");
    expect(collectRunFailureDiagnostics(run({ startedAt: new Date(NaN), finishedAt: new Date() }), {}).execution).not.toHaveProperty("durationMs");
  });
});


it("revalidates persisted transfer evidence and excludes arbitrary nested payloads", () => {
  for (const known of [true, false]) {
    const result = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics(run({ resultJson: {
      workspaceRestoreFailure: "restore_failed", workspaceRestoreDiagnostic: {
        phase: "workspace", step: "workspace_transfer", errorCode: "unknown",
        transferStep: known ? "archive_create" : "private-command",
        transferFailureKind: known ? "command_failed" : "private-output", rpcCode: known ? -32003 : -12345,
        command: "private-command", cause: { message: "private-nested-message" },
      },
    } }), {}));
    expect(result.execution.workspaceRestoreTransferStep).toBe(known ? "archive_create" : undefined);
    expect(result.execution.workspaceRestoreTransferFailureKind).toBe(known ? "command_failed" : undefined);
    expect(result.execution.workspaceRestoreRpcCode).toBe(known ? -32003 : undefined);
    expect(JSON.stringify(result)).not.toContain("private-");
  }
});

it("does not project transfer fields into an unrelated restore step", () => {
  const result = collectRunFailureDiagnostics(run({ resultJson: {
    workspaceRestoreFailure: "restore_failed", workspaceRestoreDiagnostic: {
      phase: "workspace", step: "git_import", errorCode: "unknown",
      transferStep: "archive_create", transferFailureKind: "command_failed", rpcCode: -32003,
    },
  } }), {});
  expect(result.execution).not.toHaveProperty("workspaceRestoreTransferStep");
  expect(result.execution).not.toHaveProperty("workspaceRestoreTransferFailureKind");
  expect(result.execution).not.toHaveProperty("workspaceRestoreRpcCode");
});
