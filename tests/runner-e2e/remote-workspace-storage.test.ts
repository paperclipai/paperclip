import { describe, expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { controllerOutageForExecution } from "./controller-outage.js";
import { retainedControllerFollowupTransport } from "./retained-controller-continuation.js";
import { assertIsolatedServerEnvironment, buildPaperclipServerEnvironment } from "./harness-env.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { gradeRemoteWorkspaceStorage, readRemoteWorkspaceStorageCheckpoint, remoteWorkspaceProofDigest, remoteWorkspaceStorageServerEnvironment,
  REMOTE_WORKSPACE_STORAGE_SUITE, type RemoteWorkspaceStorageEvidence } from "./remote-workspace-storage.js";

const executionId = "remote-workspace-storage.runner-codex.daytona.recover-controller";
const execution = () => runnerMatrix.find(row => row.id === executionId)!;
const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

function goodEvidence(): RemoteWorkspaceStorageEvidence {
  const point = { workspaceId: id("1"), snapshotId: id("2"), runId: id("3"), runSnapshotId: id("2"),
    runSaveState: "saved", authoritySchema: "paperclip.remote-workspace.v1", authorityDirty: false,
    authorityWriter: null, providerType: "cloud_sandbox", proofSha256: "a".repeat(64), fileSource: "live" };
  return { initial: point, final: { ...point, runId: id("4"), snapshotId: id("5"), runSnapshotId: id("5") },
    browserReadPhases: ["before-restart", "after-restart"],
    upgradeReadiness: { version: 1, activeRuns: 1, recoverableRuns: 1, truncated: false } };
}

function checkpointApi() {
  const context = { companyId: id("6"), agentId: id("7"), issueId: id("8"), environmentId: id("9") };
  const location = { environmentId: context.environmentId, leaseId: id("4"), providerLeaseId: "synthetic-provider", remoteCwd: "/workspace" };
  const receipt = { schema: "paperclip.remote-workspace-run.v1", workspaceId: id("1"),
    leaseId: location.leaseId, providerLeaseId: location.providerLeaseId, remoteCwd: location.remoteCwd,
    epoch: 2, state: "saved", snapshotId: id("2") };
  const workspace = { issueId: context.issueId, workspace: { id: id("1"), companyId: context.companyId,
    providerType: "cloud_sandbox", metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1",
      epoch: 2, snapshotId: id("2"), source: { kind: "empty" }, location, writerRunId: null, dirty: false } } } };
  // activityService.runsForIssue returns runId, not full-run id or nativeIssueId.
  const summary = { runId: id("3"), runtimeMode: "native", status: "succeeded", agentId: context.agentId,
    finishedAt: "2026-10-31T13:21:00.000Z" };
  const fullRun = { id: summary.runId, companyId: context.companyId, agentId: context.agentId,
    nativeIssueId: context.issueId, runtimeMode: "native", status: "succeeded", runnerProfileJson: { remoteWorkspace: receipt } };
  const file = { content: { encoding: "utf8", data: `${"a".repeat(32)}\n` },
    resource: { workspaceId: id("1"), workspaceKind: "execution_workspace", source: { kind: "live" } } };
  const get = vi.fn(async (route: string): Promise<unknown> => {
    if (route === `/api/issues/${context.issueId}/workspace`) return workspace;
    if (route === `/api/issues/${context.issueId}/runs`) return [summary];
    if (route === `/api/heartbeat-runs/${summary.runId}`) return fullRun;
    if (route === `/api/issues/${context.issueId}/file-resources/content?workspace=execution&path=workspace-proof.txt`) return file;
    throw new Error(`Unexpected checkpoint API route: ${route}`);
  });
  return { context, workspace, summary, fullRun, file, receipt, get,
    api: { get: async <T>(route: string): Promise<T> => await get(route) as T } };
}

describe("remote workspace Product E2E qualification", () => {
  it("hydrates the actual public issue run summary before checking the native save binding", async () => {
    const fixture = checkpointApi();
    const result = await readRemoteWorkspaceStorageCheckpoint({ ...fixture.context, api: fixture.api });
    expect(result.point).toMatchObject({ workspaceId: id("1"), snapshotId: id("2"), runId: id("3"), runSaveState: "saved" });
    expect(fixture.get).toHaveBeenCalledWith(`/api/heartbeat-runs/${fixture.summary.runId}`);
    expect(result.content).toBe(`${"a".repeat(32)}\n`);
  });

  it.each(["run-id", "company", "agent", "native-issue", "runtime", "status", "schema", "workspace",
    "epoch", "snapshot", "save-state", "lease", "provider", "remote-root"] as const)(
    "rejects a full-run %s mismatch even when its public summary succeeds", async mismatch => {
      const fixture = checkpointApi();
      if (mismatch === "run-id") fixture.fullRun.id = id("5");
      if (mismatch === "company") fixture.fullRun.companyId = id("5");
      if (mismatch === "agent") fixture.fullRun.agentId = id("5");
      if (mismatch === "native-issue") fixture.fullRun.nativeIssueId = id("5");
      if (mismatch === "runtime") fixture.fullRun.runtimeMode = "legacy";
      if (mismatch === "status") fixture.fullRun.status = "running";
      if (mismatch === "schema") fixture.receipt.schema = "unknown";
      if (mismatch === "workspace") fixture.receipt.workspaceId = id("5");
      if (mismatch === "epoch") fixture.receipt.epoch += 1;
      if (mismatch === "snapshot") fixture.receipt.snapshotId = id("5");
      if (mismatch === "save-state") fixture.receipt.state = "prepared";
      if (mismatch === "lease") fixture.receipt.leaseId = id("5");
      if (mismatch === "provider") fixture.receipt.providerLeaseId = "foreign-provider";
      if (mismatch === "remote-root") fixture.receipt.remoteCwd = "/foreign";
      expect(await readRemoteWorkspaceStorageCheckpoint({ ...fixture.context, api: fixture.api })).toEqual({});
      expect(fixture.get).not.toHaveBeenCalledWith(expect.stringContaining("file-resources/content"));
    },
  );

  it.each(["issue", "company", "schema", "snapshot", "dirty", "writer", "environment"] as const)(
    "holds a saved checkpoint with invalid current workspace %s", async mismatch => {
      const fixture = checkpointApi();
      const authority = fixture.workspace.workspace.metadata.remoteWorkspace;
      if (mismatch === "issue") fixture.workspace.issueId = id("5");
      if (mismatch === "company") fixture.workspace.workspace.companyId = id("5");
      if (mismatch === "schema") authority.schema = "unknown";
      if (mismatch === "snapshot") authority.snapshotId = id("5");
      if (mismatch === "dirty") authority.dirty = true;
      if (mismatch === "writer") (authority as { writerRunId: string | null }).writerRunId = id("5");
      if (mismatch === "environment") authority.location.environmentId = id("5");
      expect(await readRemoteWorkspaceStorageCheckpoint({ ...fixture.context, api: fixture.api })).toEqual({});
      expect(fixture.get).not.toHaveBeenCalledWith(expect.stringContaining("file-resources/content"));
    },
  );

  it.each(["source", "workspace-id", "workspace-kind"] as const)("rejects file bytes from a different %s", async mismatch => {
    const fixture = checkpointApi();
    if (mismatch === "source") fixture.file.resource.source.kind = "saved";
    if (mismatch === "workspace-id") fixture.file.resource.workspaceId = id("5");
    if (mismatch === "workspace-kind") fixture.file.resource.workspaceKind = "project_workspace";
    expect(await readRemoteWorkspaceStorageCheckpoint({ ...fixture.context, api: fixture.api })).toEqual({});
  });
  it("discovers exactly one explicit Daytona cell with ordinary production instructions", () => {
    const cells = selectRunnerExecutions(parseRunnerSelectors(["--suite", REMOTE_WORKSPACE_STORAGE_SUITE]));
    expect(cells.map(row => row.id)).toEqual([executionId]);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(row => row.suite.id === REMOTE_WORKSPACE_STORAGE_SUITE)).toBe(false);
    expect(controllerOutageForExecution(cells[0]!, {})).toEqual({ signal: "SIGKILL", holdMs: 300_000 });
    expect(() => controllerOutageForExecution(cells[0]!, { PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: "1000" })).toThrow("shorter");
    expect(cells[0]!.task.expectedRunCount).toBe(4);
    expect(cells[0]!.suite.definitionMetadata).toMatchObject({ version: 3, savedRunReadback: "public-runId-summary-then-bound-native-detail", retainedControllerContinuation: true,
      retainedControllerFollowupTransport: "task_comment_api", autoStopIntervalMinutes: 15 });
    expect(retainedControllerFollowupTransport(cells[0]!)).toBe("task_comment_api");
    const environment = cells[0]!.environment.buildEnvironment({ executionId: "synthetic",
      daytonaImage: `fixture/runner@sha256:${"a".repeat(64)}`,
      secretRefs: { DAYTONA_API_KEY: { type: "secret_ref", secretId: id("9"), version: "latest" } } });
    expect(environment.config).toMatchObject({ autoStopInterval: 15, reuseLease: true, runnerLifecycleMode: "warm" });
    const agent = cells[0]!.profile.buildAgent({ environmentId: id("9"), environmentFixtureId: "daytona", workspacePath: "/unavailable-host-folder",
      secretRefs: { OPENAI_API_KEY: { type: "secret_ref", secretId: id("8"), version: "latest" } }, executionId: "synthetic" });
    expect((agent.adapterConfig as Record<string, unknown>).cwd).toBeUndefined();
    expect(cells[0]!.task.buildPrompt("synthetic")).toContain("fresh random 32-character lowercase hexadecimal reference");
  });

  it("requires independently observed snapshots, retained bytes, and browser evidence", () => {
    expect(gradeRemoteWorkspaceStorage(goodEvidence()).every(check => check.passed)).toBe(true);
    expect(gradeRemoteWorkspaceStorage({ browserReadPhases: [] }).every(check => check.passed)).toBe(false);
    for (const override of [
      { snapshotId: id("7") }, { runSaveState: "prepared" }, { authorityDirty: true },
      { authorityWriter: id("3") }, { providerType: "local_fs" }, { fileSource: "saved" },
    ]) {
      const evidence = goodEvidence();
      evidence.final = { ...evidence.final!, ...override };
      expect(gradeRemoteWorkspaceStorage(evidence).every(check => check.passed)).toBe(false);
    }
    const replaced = goodEvidence();
    replaced.final!.proofSha256 = "b".repeat(64);
    expect(gradeRemoteWorkspaceStorage(replaced).find(check => check.id === "remote-workspace-proof-retained")?.passed).toBe(false);
    const noBrowser = goodEvidence();
    noBrowser.browserReadPhases = ["before-restart"];
    expect(gradeRemoteWorkspaceStorage(noBrowser).find(check => check.id === "remote-workspace-browser-read")?.passed).toBe(false);
    for (const upgradeReadiness of [undefined, { version: 1, activeRuns: 1, recoverableRuns: 0, truncated: false },
      { version: 1, activeRuns: 1, recoverableRuns: 1, truncated: true },
      ...[{ version: 1, activeRuns: 1, recoverableRuns: 1 },
        { version: 1, activeRuns: "1", recoverableRuns: 1, truncated: false },
        { version: 1, activeRuns: 1, recoverableRuns: "1", truncated: false },
        { version: 1, activeRuns: 1, recoverableRuns: 2, truncated: false },
        { version: 1, activeRuns: 1.5, recoverableRuns: 1, truncated: false },
        { version: 1, activeRuns: 1, truncated: false }]
        .map(value => value as unknown as NonNullable<RemoteWorkspaceStorageEvidence["upgradeReadiness"]>)]) {
      expect(gradeRemoteWorkspaceStorage({ ...goodEvidence(), upgradeReadiness })
        .find(check => check.id === "remote-workspace-upgrade-recoverable")?.passed).toBe(false);
    }
  });

  it("checks the synthetic reference format before retaining its digest", () => {
    expect(remoteWorkspaceProofDigest(`${"1".repeat(32)}\n`)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => remoteWorkspaceProofDigest("recreated marker")).toThrow();
  });

  it("requires an explicit bucket and isolates object prefixes per attempt", () => {
    const env = { PAPERCLIP_RUNNER_E2E_WORKSPACE_STORAGE_BUCKET: "disposable-workspace-fixture", PAPERCLIP_STORAGE_S3_BUCKET: "ambient-bucket" };
    expect(() => remoteWorkspaceStorageServerEnvironment({ executions: [execution()], env: {}, instanceId: "test" })).toThrow("explicit disposable");
    const overrides = remoteWorkspaceStorageServerEnvironment({ executions: [execution()], env, instanceId: "attempt-one" });
    expect(overrides).toMatchObject({ PAPERCLIP_STORAGE_PROVIDER: "s3", PAPERCLIP_STORAGE_S3_BUCKET: "disposable-workspace-fixture",
      PAPERCLIP_STORAGE_S3_PREFIX: "runner-e2e/attempt-one/" });
    const ordinary = runnerMatrix.find(row => row.suite.id === "everyday-workflows")!;
    expect(remoteWorkspaceStorageServerEnvironment({ executions: [ordinary], env, instanceId: "test" })).toBeUndefined();
    expect(() => remoteWorkspaceStorageServerEnvironment({ executions: [execution(), ordinary], env, instanceId: "test" })).toThrow("run alone");
    expect(buildPaperclipServerEnvironment(env).PAPERCLIP_STORAGE_S3_BUCKET).toBeUndefined();
  });

  it("allows only the explicit storage override through the existing isolation guard", () => {
    const workspaceStorage = remoteWorkspaceStorageServerEnvironment({ executions: [execution()],
      env: { PAPERCLIP_RUNNER_E2E_WORKSPACE_STORAGE_BUCKET: "disposable-workspace-fixture" }, instanceId: "attempt-one" })!;
    const expected = { temporaryRoot: "/tmp/fixture", paperclipHome: "/tmp/fixture/home", configPath: "/tmp/fixture/config.json" };
    const env = { PAPERCLIP_HOME: expected.paperclipHome, PAPERCLIP_CONFIG: expected.configPath,
      XDG_CACHE_HOME: "/tmp/fixture/xdg-cache", PAPERCLIP_AGENT_JWT_SECRET: "synthetic", PAPERCLIP_DECISION_SIGNING_SECRET: "synthetic",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "synthetic", BETTER_AUTH_SECRET: "synthetic", ...workspaceStorage };
    expect(() => assertIsolatedServerEnvironment(env, expected)).toThrow("PAPERCLIP_STORAGE_S3_BUCKET");
    expect(() => assertIsolatedServerEnvironment(env, { ...expected, workspaceStorage })).not.toThrow();
    expect(() => assertIsolatedServerEnvironment({ ...env, PAPERCLIP_STORAGE_S3_BUCKET: "another-bucket" }, { ...expected, workspaceStorage })).toThrow();
  });
});
