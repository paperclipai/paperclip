import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "../../packages/paperclip-runner/src/drivers/acpx/generated-profiles.js";
import { antigravityCandidateAdmissionForExecution, isAntigravityAdmittedExecution } from "./antigravity-admission.js";
import { ANTIGRAVITY_API_KEY_LINEUP, ANTIGRAVITY_GEMINI4_LINEUP, antigravityLineupProfileId } from "./antigravity-qualification-cases.js";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment, buildPaperclipServerEnvironment } from "./harness-env.js";
import { evaluateMatchers } from "./matchers.js";
import { observeActiveStopPending, readActiveStopCaller, readActiveStopSettlement, readDeniedPermissionSettlement } from "./native-active-stop-evidence.js";
import { assertProviderLossSettlement } from "./native-provider-loss-flow.js";
import { buildMatrixJobs, daytonaCandidateProviders, parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { readRestartRequest } from "./server-restart-request.js";

type Row = Record<string, any>;
const suiteId = "antigravity-qualification";
const cells = runnerMatrix.filter(cell => cell.suite.id === suiteId);
const companyId = "11111111-1111-4111-8111-111111111111";
const select = (...args: string[]) => selectRunnerExecutions(parseRunnerSelectors(args));

describe("Google Antigravity explicit Product qualification", () => {
  it("lists twelve journeys in local and Daytona without entering --all", () => {
    expect(cells).toHaveLength(24);
    expect(new Set(cells.map(cell => cell.environment.id))).toEqual(new Set(["local", "daytona"]));
    expect(new Set(cells.map(cell => cell.task.id))).toEqual(new Set([
      "message-marker", "plan-revise-accept", "ask-question", "structured-question-resume", "structured-question-restart-resume",
      "file-edit-validate", "warm-three-turn", "stop-new-resume", "continuity-restart", "pending-permission-stop", "permission-deny-stop", "pending-permission-provider-loss",
    ]));
    expect(select("--suite", suiteId)).toHaveLength(24);
    expect(select("--all").some(cell => cell.profile.qualificationCandidate === "antigravity")).toBe(false);
    expect(() => select("--profile", "runner-acpx-antigravity")).toThrow("zero executions");
    expect(runnerSuites.find(suite => suite.id === suiteId)?.definitionMetadata).toMatchObject({
      model: "gemini-3.8-flash-low", authentication: "gemini-api-key", scheduling: "explicit-only",
      qualification: QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus === "pending" ? "pending" : "qualified",
    });
  });

  it("reuses the shared lifecycle fixtures on per-turn Daytona leases", () => {
    const lifecycle = cells.filter(cell => cell.task.flow === "native_active_stop" || cell.task.flow === "native_provider_loss");
    expect(lifecycle.map(cell => cell.task.id).sort()).toEqual(["pending-permission-provider-loss", "pending-permission-provider-loss", "pending-permission-stop", "pending-permission-stop", "permission-deny-stop", "permission-deny-stop"]);
    const cursorLoss = runnerMatrix.find(cell => cell.suite.id === "native-provider-loss" && cell.environment.id === "local")!;
    expect(cells.find(cell => cell.task.id === "pending-permission-provider-loss")!.task.buildPrompt("n")).toBe(cursorLoss.task.buildPrompt("n"));
    for (const cell of lifecycle.filter(cell => cell.environment.id === "daytona")) expect(cell.environment.configurationKey).toBeUndefined();
    const warmDaytona = cells.find(cell => cell.environment.id === "daytona" && cell.task.id === "message-marker")!;
    expect(warmDaytona.environment).not.toBe(lifecycle.find(cell => cell.environment.id === "daytona")!.environment);
  });

  it("binds only the selected encrypted Gemini key on a per-turn native agent", () => {
    const ref = { type: "secret_ref" as const, secretId: "22222222-2222-4222-8222-222222222222", version: "latest" as const };
    for (const cell of cells) {
      expect(cell.suite.manualOnly).toBe(true);
      expect(cell.task.automaticRetryPolicy).toBe("single_attempt");
      expect(cell.requiredCredentials).toEqual(cell.environment.id === "local" ? ["GEMINI_API_KEY"] : ["GEMINI_API_KEY", "DAYTONA_API_KEY"]);
      expect(cell.profile).toMatchObject({ id: "runner-acpx-antigravity", qualificationCandidate: "antigravity", model: "gemini-3.8-flash-low", credential: "GEMINI_API_KEY" });
      expect(cell.profile.buildAgent({ executionId: cell.id, environmentId: "env", environmentFixtureId: cell.environment.id,
        workspacePath: "/workspace", secretRefs: { GEMINI_API_KEY: ref } })).toMatchObject({
        adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-low",
          lifecycleMode: "per_turn", timeoutSec: 120, env: { GEMINI_API_KEY: ref } },
      });
    }
  });

  it("admits CI matrix jobs for unattended cells but still refuses the attended journey", () => {
    const jobs = buildMatrixJobs(select("--suite", suiteId));
    expect(jobs).toHaveLength(24);
    expect(new Set(jobs.map(job => job.credentialName))).toEqual(new Set(["GEMINI_API_KEY"]));
    expect(jobs.filter(job => job.needsDaytona)).toHaveLength(12);
    expect(() => buildMatrixJobs(select("--suite", "antigravity-agent-journey"))).toThrow("Attended connection journeys");
  });

  it("asks CI for an Antigravity image and controller pack only for pending Daytona cells", () => {
    const pending = QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus === "pending";
    expect(daytonaCandidateProviders(select("--suite", suiteId))).toEqual(pending ? ["antigravity"] : []);
    expect(daytonaCandidateProviders(select("--suite", suiteId, "--environment", "local"))).toEqual([]);
    // Released providers live in the default pack and are never requested.
    expect(daytonaCandidateProviders(select("--id", "rolling-web-deployment.runner-acpx-kimi.daytona.recover-controller"))).toEqual([]);
  });

  it("keeps candidate authority out of the shared operator list and rejects unrelated suites", () => {
    const cell = cells[0]!;
    const ambient = { PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient", PAPERCLIP_ACPX_CANDIDATE_ADMISSION: "ambient" };
    const env = buildRunnerE2EProcessEnvironment(ambient, cells);
    expect(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    expect(env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION).toBeUndefined();
    for (const suite of [{ ...cell.suite, manualOnly: false }, { ...cell.suite, id: "extended-harnesses" }, { ...cell.suite, id: "kimi-qualification" }]) {
      expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, suite }])).toThrow("explicit provider qualification suite");
    }
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, profile: { ...cell.profile, id: "unrelated-profile" } }])).toThrow("explicit provider qualification suite");
    const chat = runnerMatrix.find(row => row.suite.id === "chat-features" && row.profile.qualificationCandidate === "antigravity")!;
    expect(isAntigravityAdmittedExecution(chat)).toBe(true);
    expect(isAntigravityAdmittedExecution({ ...chat, profile: { ...chat.profile, explicitOnly: undefined } })).toBe(false);
  });

  it("removes ambient Google credentials before starting the product server", () => {
    const source = { GEMINI_API_KEY: "selected", GOOGLE_API_KEY: "ambient", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json", GEMINI_HOME: "/login" };
    const server = buildPaperclipServerEnvironment(source);
    for (const name of Object.keys(source)) expect(server[name]).toBeUndefined();
  });
});

describe("Antigravity company-bound candidate grant", () => {
  const local = cells.find(cell => cell.environment.id === "local")!;
  const remote = cells.find(cell => cell.environment.id === "daytona")!;
  const pending = QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus === "pending";

  it.runIf(pending)("binds the disposable company, exact model, digests and darwin-arm64 target", () => {
    const now = Date.now();
    expect(antigravityCandidateAdmissionForExecution(local, companyId, now, { platform: "darwin", arch: "arm64" })).toMatchObject({
      schema: "paperclip.acpx-candidate-admission.v1", companyId, agent: "antigravity", model: "gemini-3.8-flash-low",
      profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest, platform: "darwin", architecture: "arm64", expiresAt: now + 3_600_000,
    });
    expect(() => antigravityCandidateAdmissionForExecution(local, "not-a-company")).toThrow("exact disposable company");
    expect(() => antigravityCandidateAdmissionForExecution({ ...local, suite: { ...local.suite, id: "extended-harnesses" } }, companyId)).toThrow("explicit Antigravity suite");
    expect(antigravityCandidateAdmissionForExecution({ ...local, profile: { ...local.profile, qualificationCandidate: "kimi" } }, companyId)).toBeUndefined();
  });

  it.runIf(pending)("stages a linux-x64 grant with the patched closure for a Daytona cell on any controller host", () => {
    const now = Date.now();
    for (const host of [{ platform: "darwin", arch: "arm64" }, { platform: "linux", arch: "x64" }] as const) {
      expect(antigravityCandidateAdmissionForExecution(remote, companyId, now, host)).toMatchObject({
        companyId, agent: "antigravity", model: "gemini-3.8-flash-low", platform: "linux", architecture: "x64",
        nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["linux-x64"].closureSha256}`, expiresAt: now + 3_600_000,
      });
    }
  });

  it.runIf(pending)("fails before provider spend on a target without an admitted closure", () => {
    expect(() => antigravityCandidateAdmissionForExecution(local, companyId, Date.now(), { platform: "win32", arch: "x64" })).toThrow(/no admitted runtime closure|does not match/i);
  });

  it.runIf(pending)("stages the grant only for a selected Antigravity cell and its model", async () => {
    const root = await mkdtemp(join(tmpdir(), "antigravity-restart-"));
    try {
      const path = join(root, "request.json"), grant = antigravityCandidateAdmissionForExecution(local, companyId, Date.now(), process)!;
      if (`${process.platform}-${process.arch}` !== "darwin-arm64") return;
      await writeFile(path, JSON.stringify({ requestId: "antigravity-startup", kimiCandidateAdmission: grant }));
      await expect(readRestartRequest(path, [local.id])).resolves.toMatchObject({ kimiCandidateAdmission: { agent: "antigravity", companyId } });
      await expect(readRestartRequest(path, [runnerMatrix.find(cell => cell.suite.id === "kimi-qualification")!.id])).rejects.toThrow("explicit Kimi or Antigravity");
      await writeFile(path, JSON.stringify({ requestId: "antigravity-startup", kimiCandidateAdmission: { ...grant, model: "gemini-3.1-pro-low" } }));
      await expect(readRestartRequest(path, [local.id])).rejects.toThrow("does not match the selected execution");
    } finally { await rm(root, { recursive: true, force: true }); }
    expect(remote.environment.expectedExecutionTarget.kind).toBe("remote");
  });

  it.runIf(!pending)("needs no grant once the profile is released", () => {
    expect(antigravityCandidateAdmissionForExecution(local, companyId)).toBeUndefined();
  });
});

describe("Antigravity model lineups", () => {
  it("parameterises one exact-model cell per API-key and Gemini 4 model", () => {
    for (const [suite, models] of [["antigravity-model-lineup", ANTIGRAVITY_API_KEY_LINEUP], ["antigravity-model-lineup-gemini4", ANTIGRAVITY_GEMINI4_LINEUP]] as const) {
      const lineup = runnerMatrix.filter(cell => cell.suite.id === suite);
      expect(lineup.map(cell => cell.profile.model)).toEqual(models);
      expect(lineup.every(cell => cell.environment.id === "local" && cell.task.id === "model-receipt" && cell.id === `${suite}.${antigravityLineupProfileId(cell.profile.model)}.local.model-receipt`)).toBe(true);
      expect(lineup.every(cell => cell.id.split(".").length === 4)).toBe(true);
      expect(select("--suite", suite)).toHaveLength(models.length);
      expect(lineup.every(isAntigravityAdmittedExecution)).toBe(true);
      expect(() => buildRunnerE2EProcessEnvironment({}, lineup)).not.toThrow();
      expect(buildMatrixJobs(lineup).every(job => job.credentialName === "GEMINI_API_KEY" && !job.needsDaytona)).toBe(true);
    }
    // Exactly what a 1.5.2 `gemini-api-key` session lists (live, prompt-free).
    expect(ANTIGRAVITY_API_KEY_LINEUP).toEqual([
      "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
      "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
      "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
      "gemini-3.5-flash-high", "gemini-3.5-flash-medium", "gemini-3.5-flash-low",
      "gemini-3.1-pro-high", "gemini-3.1-pro-low",
    ]);
    expect(ANTIGRAVITY_API_KEY_LINEUP).not.toContain("gemini-3.1-pro-extra_high");
    // Each Gemini 4 family keeps its own levels; none offers minimal.
    expect(ANTIGRAVITY_GEMINI4_LINEUP).toEqual([
      "gemini-4-carbon-medium", "gemini-4-carbon-high", "gemini-4-carbon-low",
      "gemini-4-neon-high", "gemini-4-neon-extra_high", "gemini-4-neon-medium", "gemini-4-neon-low",
      "gemini-4-hydrogen-high", "gemini-4-hydrogen-extra_high", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-low",
      "gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low",
    ]);
    expect(() => antigravityLineupProfileId("auto")).toThrow("Invalid Antigravity model ID");
  });

  it("requires the Runner's exact-model receipt, not merely a reply", async () => {
    const cell = runnerMatrix.find(row => row.suite.id === "antigravity-model-lineup-gemini4" && row.profile.model === "gemini-4-neon-high")!;
    const receiptMatchers = cell.task.buildMatchers("nonce", cell).filter(matcher => matcher.kind === "json_path");
    expect(receiptMatchers).toHaveLength(4);
    const run = (effectiveModel: string) => ({ runnerProfileJson: { nativeExecutionInput: { provider: { kind: "acpx", agent: "antigravity", model: "gemini-4-neon-high" } },
      sessionCheckpoint: { providerIdentity: { requestedModel: "gemini-4-neon-high", effectiveModel } } } });
    const grade = (value: Row) => evaluateMatchers(receiptMatchers, { message: "", json: { run: value } } as never);
    expect((await grade(run("gemini-4-neon-high"))).every(result => result.passed)).toBe(true);
    expect((await grade(run("gemini-4-neon-low"))).every(result => result.passed)).toBe(false);
    expect((await grade({})).some(result => result.passed)).toBe(false);
  });
});

describe("Antigravity opt-in profiles in shared eval suites", () => {
  it.each(["chat-features", "native-completion"])("%s keeps Antigravity behind an explicit profile selector", suite => {
    const all = select("--suite", suite);
    expect(all.some(cell => cell.profile.qualificationCandidate === "antigravity")).toBe(false);
    const opted = select("--suite", suite, "--profile", "runner-acpx-antigravity");
    expect(opted.length).toBeGreaterThan(0);
    expect(opted.every(cell => cell.profile.qualificationCandidate === "antigravity" && cell.profile.explicitOnly === true)).toBe(true);
    expect(() => buildRunnerE2EProcessEnvironment({}, opted.slice(0, 1))).not.toThrow();
  });
});

describe("Antigravity pending-permission lifecycle evidence", () => {
  const caller = readActiveStopCaller({ deploymentMode: "local_trusted" }, { session: { userId: "local-board", id: "paperclip:local_implicit:local-board" } });
  const cancellationRequestId = "11111111-2222-4333-8444-555555555555";
  function fixture() {
    const scope = { provider: "antigravity" as const, companyId: "company", issueId: "issue", runId: "run", target: "pc-denied/active-stop.txt" };
    const row = (eventType: string, payload: Row): Row => {
      const seq = events.length + 1;
      return { companyId: "company", runId: "run", seq, eventType, protocolSchemaVersion: 1,
        payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", eventType, runId: "run", turnId: "turn",
          normalizedSessionId: "session", sourceInstanceId: "runner", sourceSeq: seq, sourceEventId: `runner:run:${seq}`, emittedAt: "2026-11-22T00:00:00Z", payload } } };
    };
    const tool = (executionId: string, operation: string, target: string | null, status = "running") => ({ schema: "paperclip.tool.execution.v1", executionId, transport: "builtin", name: null, operation, target, status });
    const events: Row[] = [];
    const push = (eventType: string, payload: Row) => { events.push(row(eventType, payload)); };
    push("tool.execution.started", tool("read-1", "read", "README.md"));
    push("tool.execution.completed", tool("read-1", "read", "README.md", "completed"));
    push("tool.execution.started", tool("write-1", "edit", scope.target));
    push("runtime_request.created", { request: { schema: "paperclip.runtime_request.v2", type: "permission", requestKind: "permission_approval", status: "pending",
      requestId: "request", turnId: "turn", itemId: "item", prompt: `Edit ${scope.target}`, details: { toolCallId: "write-1" },
      choices: [{ key: "accept" }, { key: "decline" }], origin: { adapter: "acpx-runtime-sidecar", provider: "antigravity", method: "session/request_permission" } } });
    const run: Row = { id: "run", companyId: "company", nativeIssueId: "issue", runtimeMode: "native", status: "running", resultJson: {}, error: null };
    const issue: Row = { id: "issue", companyId: "company", status: "in_progress" };
    const observe = () => observeActiveStopPending({ events, run, issue, scope, caller, cancellationRequestId });
    return { scope, events, run, issue, push, tool, observe };
  }

  it("observes the exact pending native edit from canonical events alone", () => {
    const f = fixture();
    expect(f.observe()).toMatchObject({ requestId: "request", toolCallId: "write-1", turnId: "turn", normalizedSessionId: "session" });
  });

  it("rejects an extra mutation, a completed write, a foreign provider or a missing target", () => {
    const extra = fixture(); extra.events.splice(2, 0, ...[]); extra.push("tool.execution.started", extra.tool("write-2", "edit", "other.txt"));
    expect(() => extra.observe()).toThrow(/extra native operation/);
    const done = fixture(); done.push("tool.execution.completed", done.tool("write-1", "edit", done.scope.target, "completed"));
    expect(() => done.observe()).toThrow(/mutation lifecycle/);
    const foreign = fixture(); foreign.events[3]!.payload.prpEvent.payload.request.origin.provider = "cursor";
    expect(() => foreign.observe()).toThrow(/permission identity/);
    const elsewhere = fixture(); elsewhere.events[2]!.payload.prpEvent.payload.target = null; elsewhere.events[3]!.payload.prpEvent.payload.request.prompt = "Edit file";
    expect(() => elsewhere.observe()).toThrow(/mutation lifecycle/);
  });

  it("requires cancellation of the retained request for Stop and expiry for provider loss", () => {
    const stop = fixture(), pending = stop.observe(), dispatchMonotonicNs = (BigInt(pending.observedMonotonicNs) + 1n).toString();
    stop.push("runtime_request.cancelled", { requestId: "request", requestKind: "permission_approval", turnId: "turn", itemId: "item", reason: "turn_terminal" });
    stop.push("turn.cancelled", { status: "cancelled", error: null });
    expect(() => readActiveStopSettlement({ events: stop.events, run: stop.run, issue: stop.issue, pending, dispatchMonotonicNs })).toThrow(/acknowledgement/);
    stop.run.status = "cancelled";
    stop.run.resultJson = { startupCancellation: { cancellationRequestId, requestedBy: { type: "board", userId: "local-board" } }, nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", intentId: `native-cancellation:${cancellationRequestId}`, companyId: "company", runId: "run", issueId: "issue", scope: "run",
      dispatched: true, dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"], intentAuditId: "intent", acknowledgementAuditId: "ack" } };
    expect(readActiveStopSettlement({ events: stop.events, run: stop.run, issue: stop.issue, pending, dispatchMonotonicNs })).toMatchObject({ branch: "pending_permission_cancelled", replayAllowed: false });

    const loss = fixture(), lost = loss.observe();
    loss.push("runtime_request.expired", { requestId: "request", requestKind: "permission_approval", turnId: "turn", reason: "provider_process_lost", replayAllowed: false });
    loss.push("turn.failed", { error: { code: "provider_transport_lost" } });
    Object.assign(loss.run, { status: "failed", error: "Provider transport lost" }); loss.issue.status = "blocked";
    expect(assertProviderLossSettlement(loss.run, loss.issue, loss.events, lost)).toMatchObject({ requestClosure: "runtime_request.expired", replayAllowed: false });
    loss.push("tool.execution.completed", loss.tool("write-1", "edit", loss.scope.target, "completed"));
    expect(() => assertProviderLossSettlement(loss.run, loss.issue, loss.events, lost)).toThrow(/completed mutation/);
  });

  it("requires a delivered decline of the exact request, no completed mutation and the operator's Stop", () => {
    const acknowledged = (run: Row) => Object.assign(run, { status: "cancelled", resultJson: {
      startupCancellation: { cancellationRequestId, requestedBy: { type: "board", userId: "local-board" } }, nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", intentId: `native-cancellation:${cancellationRequestId}`, companyId: "company", runId: "run", issueId: "issue", scope: "run",
        dispatched: true, dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"], intentAuditId: "intent", acknowledgementAuditId: "ack" } } });
    const denied = () => {
      const f = fixture(), pending = f.observe();
      f.push("runtime_request.resolved", { requestId: "request", requestKind: "permission_approval", turnId: "turn", itemId: "item", action: "decline" });
      f.push("tool.execution.completed", f.tool("write-1", "edit", f.scope.target, "failed"));
      return { ...f, pending };
    };
    const stopped = denied();
    stopped.push("turn.cancelled", { status: "cancelled", error: null }); acknowledged(stopped.run);
    expect(readDeniedPermissionSettlement({ events: stopped.events, run: stopped.run, issue: stopped.issue, pending: stopped.pending, stopDispatched: true }))
      .toMatchObject({ branch: "denied_then_stopped", requestId: "request", replayAllowed: false });
    // A cancellation nobody asked for is not this journey.
    expect(() => readDeniedPermissionSettlement({ events: stopped.events, run: stopped.run, issue: stopped.issue, pending: stopped.pending, stopDispatched: false })).toThrow(/without the operator's Stop/);

    const finished = denied();
    finished.push("turn.completed", { status: "completed" }); finished.run.status = "succeeded";
    expect(readDeniedPermissionSettlement({ events: finished.events, run: finished.run, issue: finished.issue, pending: finished.pending, stopDispatched: false }))
      .toMatchObject({ branch: "denied_then_finished" });
    finished.issue.status = "done";
    expect(() => readDeniedPermissionSettlement({ events: finished.events, run: finished.run, issue: finished.issue, pending: finished.pending, stopDispatched: false })).toThrow(/claims completion/);

    const accepted = fixture(), acceptedPending = accepted.observe();
    accepted.push("runtime_request.resolved", { requestId: "request", requestKind: "permission_approval", turnId: "turn", itemId: "item", action: "accept" });
    accepted.push("turn.cancelled", { status: "cancelled", error: null }); acknowledged(accepted.run);
    expect(() => readDeniedPermissionSettlement({ events: accepted.events, run: accepted.run, issue: accepted.issue, pending: acceptedPending, stopDispatched: true })).toThrow(/denial was not delivered/);

    const cancelledOnly = fixture(), cancelledPending = cancelledOnly.observe();
    cancelledOnly.push("runtime_request.cancelled", { requestId: "request", requestKind: "permission_approval", turnId: "turn", itemId: "item", reason: "turn_terminal" });
    cancelledOnly.push("turn.cancelled", { status: "cancelled", error: null }); acknowledged(cancelledOnly.run);
    expect(() => readDeniedPermissionSettlement({ events: cancelledOnly.events, run: cancelledOnly.run, issue: cancelledOnly.issue, pending: cancelledPending, stopDispatched: true })).toThrow(/denial was not delivered/);

    const written = denied();
    written.events.pop(); written.push("tool.execution.completed", written.tool("write-1", "edit", written.scope.target, "completed"));
    written.push("turn.cancelled", { status: "cancelled", error: null }); acknowledged(written.run);
    expect(() => readDeniedPermissionSettlement({ events: written.events, run: written.run, issue: written.issue, pending: written.pending, stopDispatched: true })).toThrow();
  });
});
