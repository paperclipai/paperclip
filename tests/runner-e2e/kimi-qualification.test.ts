import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { buildPaperclipServerEnvironment, buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { assertRunnerE2EPrerequisites } from "./prerequisites.js";

const suiteId = "kimi-qualification";
const cells = runnerMatrix.filter(cell => cell.suite.id === suiteId);

describe("Kimi Code explicit Product qualification", () => {
  it("keeps twenty separately selected user journeys without expanding other harness suites", () => {
    expect(cells).toHaveLength(20);
    expect(new Set(cells.map(cell => cell.environment.id))).toEqual(new Set(["local", "daytona"]));
    expect(new Set(cells.map(cell => cell.task.id))).toEqual(new Set([
      "message-marker", "plan-revise-accept", "ask-question", "structured-question-resume",
      "structured-question-restart-resume", "file-edit-validate", "stop-new-resume", "continuity-restart",
      "native-write-permission-stop", "native-write-provider-loss",
    ]));
    expect(selectRunnerExecutions(parseRunnerSelectors(["--suite", suiteId]))).toHaveLength(20);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(cell => cell.suite.id === suiteId)).toBe(false);
    expect(() => selectRunnerExecutions(parseRunnerSelectors(["--profile", "runner-acpx-kimi"]))).toThrow("zero executions");
    expect(runnerMatrix.filter(cell => cell.suite.id === "extended-harnesses")).toHaveLength(30);
    expect(runnerSuites.find(suite => suite.id === suiteId)?.definitionMetadata).toMatchObject({
      qualification: "qualified", scheduling: "explicit-only", modelDiscovery: "exact-model-authenticated-observed",
      nativeQuestions: "not-claimed", nativePlans: "not-claimed", accounting: "usage-and-cost-unavailable",
    });
  });

  it.each([
    { platform: "linux" as const, arch: "x64" as const },
    { platform: "darwin" as const, arch: "x64" as const },
    { platform: "win32" as const, arch: "x64" as const },
  ])("rejects the local provider-loss cell before admission on $platform-$arch", host => {
    const cell = cells.find(cell => cell.environment.id === "local" && cell.task.id === "native-write-provider-loss")!;
    expect(() => assertRunnerE2EPrerequisites([cell], host)).toThrow(/Local native Kimi provider-loss.*No provider credentials were loaded or sent/);
  });

  it("keeps the twenty logical cells and qualified Mac-local/Linux-Daytona paths available", () => {
    for (const cell of cells) {
      expect(() => assertRunnerE2EPrerequisites([cell], { platform: "darwin", arch: "arm64" })).not.toThrow();
      if (cell.environment.id === "daytona" || cell.task.id !== "native-write-provider-loss") {
        expect(() => assertRunnerE2EPrerequisites([cell], { platform: "linux", arch: "x64" })).not.toThrow();
      }
    }
    expect(cells).toHaveLength(20);
  });

  it("binds only the selected encrypted Code credential and marks each attempt single-shot", () => {
    const ref = { type: "secret_ref" as const, secretId: "11111111-1111-4111-8111-111111111111", version: "latest" as const };
    for (const cell of cells) {
      expect(cell.suite.manualOnly).toBe(true);
      expect(cell.profile).toMatchObject({ qualificationCandidate: "kimi", model: "kimi-for-coding",
        modelQualification: { source: "qualified_runner_profile" } });
      expect(cell.task.automaticRetryPolicy).toBe("single_attempt");
      expect(cell.requiredCredentials).toEqual(cell.environment.id === "local" ? ["KIMI_API_KEY"] : ["KIMI_API_KEY", "DAYTONA_API_KEY"]);
      expect(cell.profile.buildAgent({ executionId: cell.id, environmentId: "env", environmentFixtureId: cell.environment.id,
        workspacePath: "/workspace", secretRefs: { KIMI_API_KEY: ref } })).toMatchObject({
        adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "kimi", model: "kimi-for-coding",
          lifecycleMode: "per_turn", timeoutSec: 120, env: { KIMI_API_KEY: ref } },
      });
    }
  });

  it("requires its own manual suite without inheriting candidate authority", () => {
    const cell = cells[0]!;
    const ambient = { PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient", PAPERCLIP_ACPX_CANDIDATE_ADMISSION: "ambient" };
    const env = buildRunnerE2EProcessEnvironment(ambient, [cell]);
    expect(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    expect(env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION).toBeUndefined();
    for (const suite of [{ ...cell.suite, manualOnly: false }, { ...cell.suite, id: "extended-harnesses" }, { ...cell.suite, id: "unrelated-manual-suite" }]) {
      expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, suite }])).toThrow("explicit provider qualification suite");
    }
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, profile: { ...cell.profile, id: "unrelated-profile" } }])).toThrow("explicit provider qualification suite");
    const empty = buildRunnerE2EProcessEnvironment(ambient, []);
    expect(empty.PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    expect(empty.PAPERCLIP_ACPX_CANDIDATE_ADMISSION).toBeUndefined();
  });

  it("removes ambient Kimi secrets and login-home aliases before starting the product server", () => {
    const source = { KIMI_API_KEY: "selected", KIMI_MODEL_API_KEY: "ambient-key", KIMI_CODE_HOME: "/ambient-login",
      KIMI_CODE_BASE_URL: "https://unselected.example", KIMI_MODEL_NAME: "unselected", KIMI_WEB_SEARCH_API_KEY: "other-secret" };
    const server = buildPaperclipServerEnvironment(source);
    for (const name of Object.keys(source)) expect(server[name]).toBeUndefined();
  });

  it("requires independent workspace and downloaded file bytes in the delivery cell", () => {
    for (const cell of cells.filter(cell => cell.task.id === "file-edit-validate")) {
      expect(cell.task.buildMatchers("nonce", cell)).toEqual(expect.arrayContaining([
        { kind: "file_exact", path: "extended-nonce.txt", expected: "verified-nonce\n" },
        { kind: "artifact_exact", name: "extended-nonce.txt", expected: "verified-nonce\n", mimeType: "text/plain" },
      ]));
    }
  });
});
