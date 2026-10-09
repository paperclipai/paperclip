import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { assertNativeCompletionSelection, prepareNativeCompletionPreflight, nativeCompletionPreflightEnvironment, verifyNativeCompletionPreflight } from "./native-completion-admission.js";
import { CREDENTIAL_NAMES, type MatrixExecution } from "./types.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const campaignDirectory = "/fixture/results/gha-1-1-native-completion.fixture";
beforeEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("native completion credential-free admission", () => {
  it("allows toolchain paths and excludes every present or future credential", () => {
    const source = { PATH: "/bin", HOME: "/home/fixture", CARGO_HOME: "/cargo", CI: "true",
      GH_TOKEN: "secret", FUTURE_PROVIDER_API_KEY: "secret", NODE_OPTIONS: "ambient override",
      ...Object.fromEntries(CREDENTIAL_NAMES.map(name => [name, "secret"])) };
    expect(nativeCompletionPreflightEnvironment(source)).toEqual({ PATH: "/bin", HOME: "/home/fixture", CARGO_HOME: "/cargo", CI: "true" });
  });
  it("carries only public hosted identity through actual prepare and verify subprocess options", () => {
    const identity = { GITHUB_ACTIONS: "true", PAPERCLIP_RUNNER_E2E_SOURCE_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
    for (const [name, value] of Object.entries(identity)) vi.stubEnv(name, value);
    for (const name of [...CREDENTIAL_NAMES, "GH_TOKEN", "FUTURE_PROVIDER_API_KEY", "NODE_OPTIONS"]) vi.stubEnv(name, "secret");
    spawn.mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>);
    spawn.mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ passed: true, sourceSha: identity.PAPERCLIP_RUNNER_E2E_SOURCE_SHA }) } as ReturnType<typeof spawnSync>);
    prepareNativeCompletionPreflight(campaignDirectory);
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const call of spawn.mock.calls) {
      expect(call[2]?.env).toMatchObject(identity);
      for (const name of [...CREDENTIAL_NAMES, "GH_TOKEN", "FUTURE_PROVIDER_API_KEY", "NODE_OPTIONS"]) expect(call[2]?.env).not.toHaveProperty(name);
    }
    expect(spawn.mock.calls[0]?.[1]?.some(arg => arg.startsWith("--output-dir="))).toBe(true);
    expect(spawn.mock.calls[1]?.[1]?.some(arg => arg.startsWith("--verify="))).toBe(true);
  });
  it("rejects missing receipts without invoking a process", () => {
    expect(() => verifyNativeCompletionPreflight(undefined)).toThrow("no prerequisite receipt");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("fails before provider execution when the prerequisite subprocess fails", () => {
    spawn.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    expect(() => prepareNativeCompletionPreflight(campaignDirectory)).toThrow("before provider execution");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("retains credential-free prerequisites inside the exact campaign root and verifies them", () => {
    const sourceSha = "c".repeat(40);
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_SOURCE_SHA", sourceSha);
    vi.stubEnv("OPENAI_API_KEY", "secret"); vi.stubEnv("UNLISTED_PROVIDER_CREDENTIAL", "secret");
    spawn.mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>);
    spawn.mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ passed: true, sourceSha }) } as ReturnType<typeof spawnSync>);
    const receipt = prepareNativeCompletionPreflight(campaignDirectory);
    expect(receipt).toMatch(/^\/fixture\/results\/gha-1-1-native-completion\.fixture\/native-completion-prerequisites\/[^/]+\/preflight.json$/);
    expect(spawn.mock.calls[1]?.[1]).toContain(`--verify=${receipt}`);
    for (const call of spawn.mock.calls) {
      expect(call[2]?.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(call[2]?.env).not.toHaveProperty("UNLISTED_PROVIDER_CREDENTIAL");
    }
  });
  it("rejects a workflow source override that differs from the exact receipt SHA", () => {
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_SOURCE_SHA", "a".repeat(40));
    spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({ passed: true, sourceSha: "b".repeat(40) }) } as ReturnType<typeof spawnSync>);
    expect(() => verifyNativeCompletionPreflight("/fixture/preflight.json")).toThrow("source SHA differs");
    spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({ passed: true, sourceSha: "a".repeat(40) }) } as ReturnType<typeof spawnSync>);
    expect(verifyNativeCompletionPreflight("/fixture/preflight.json").sourceSha).toBe("a".repeat(40));
  });
  it("refuses failed or unreadable receipt verification", () => {
    spawn.mockReturnValue({ status: 1, stderr: "stale source" } as ReturnType<typeof spawnSync>);
    expect(() => verifyNativeCompletionPreflight("/fixture/preflight.json")).toThrow("stale source");
    spawn.mockReturnValue({ status: 0, stdout: "malformed" } as ReturnType<typeof spawnSync>);
    expect(() => verifyNativeCompletionPreflight("/fixture/preflight.json")).toThrow();
  });
});

function selectedFixture() {
  const tasks = ["assigned-skill-explicit-invocation", "native-blocked-report"].map(id =>
    ({ id, expectedRunCount: 1, automaticRetryPolicy: "single_attempt" }));
  return { id: "native-completion.runner-codex.local.assigned-skill-explicit-invocation",
    profile: { id: "runner-codex", generation: "native" }, environment: { id: "local" }, task: tasks[0],
    suite: { id: "native-completion", manualOnly: true, expectedMatrixSize: 6, tasks } };
}
describe("native completion selected-fixture policy", () => {
  it("admits an exact subset of the six declared one-turn single-attempt cells", () => {
    const base = selectedFixture();
    const executions = ["runner-codex", "runner-acpx-claude", "runner-opencode"].flatMap(id => base.suite.tasks.map(task =>
      ({ ...structuredClone(base), profile: { id, generation: "native" }, task,
        id: `native-completion.${id}.local.${task.id}` })));
    expect(() => assertNativeCompletionSelection(executions as unknown as MatrixExecution[])).not.toThrow();
    expect(() => assertNativeCompletionSelection([executions[0]!] as unknown as MatrixExecution[])).not.toThrow();
  });
  const invalid: Array<[string, (fixture: ReturnType<typeof selectedFixture>) => void]> = [
    ["a legacy generation", f => { f.profile.generation = "legacy"; }],
    ["an unlisted profile", f => { f.profile.id = "runner-other"; }],
    ["a remote environment", f => { f.environment.id = "daytona"; }],
    ["an unexpected case", f => { f.task!.id = "other-task"; }],
    ["an extra expected turn", f => { f.task!.expectedRunCount = 2; }],
    ["a missing single-attempt policy", f => { f.task!.automaticRetryPolicy = "default"; }],
    ["a forged execution ID", f => { f.id = "other-cell"; }],
    ["an automatic suite", f => { f.suite.manualOnly = false; }],
    ["an expanded matrix", f => { f.suite.expectedMatrixSize = 7; }],
    ["a missing original completion case", f => { f.suite.tasks.shift(); }],
    ["an extra task", f => { f.suite.tasks.push({ ...f.suite.tasks[1]!, id: "extra-task" }); }],
  ];
  for (const [label, mutate] of invalid) it(`rejects ${label} before credentials`, () => {
    const f = selectedFixture(); mutate(f);
    expect(() => assertNativeCompletionSelection([f] as unknown as MatrixExecution[])).toThrow("before provider execution");
  });
  it("leaves ordinary suites and their retry policies unchanged", () => {
    const f = selectedFixture(); f.suite.id = "ordinary-suite"; f.task!.automaticRetryPolicy = "default";
    expect(() => assertNativeCompletionSelection([f] as unknown as MatrixExecution[])).not.toThrow();
  });
});
