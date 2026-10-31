import { describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { controllerOutageForExecution } from "./controller-outage.js";
import { retainedControllerFollowupTransport } from "./retained-controller-continuation.js";
import { assertIsolatedServerEnvironment, buildPaperclipServerEnvironment } from "./harness-env.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { gradeRemoteWorkspaceStorage, remoteWorkspaceProofDigest, remoteWorkspaceStorageServerEnvironment,
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

describe("remote workspace Product E2E qualification", () => {
  it("discovers exactly one explicit Daytona cell with ordinary production instructions", () => {
    const cells = selectRunnerExecutions(parseRunnerSelectors(["--suite", REMOTE_WORKSPACE_STORAGE_SUITE]));
    expect(cells.map(row => row.id)).toEqual([executionId]);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(row => row.suite.id === REMOTE_WORKSPACE_STORAGE_SUITE)).toBe(false);
    expect(controllerOutageForExecution(cells[0]!, {})).toEqual({ signal: "SIGKILL", holdMs: 300_000 });
    expect(() => controllerOutageForExecution(cells[0]!, { PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS: "1000" })).toThrow("shorter");
    expect(cells[0]!.task.expectedRunCount).toBe(4);
    expect(cells[0]!.suite.definitionMetadata).toMatchObject({ version: 2, retainedControllerContinuation: true,
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
