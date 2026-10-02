import { assertRemoteNativeEvidencePrerequisites } from "./prerequisites.js";
import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites, extendedHarnessProfiles, extendedHarnessFileTask } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment, buildPaperclipServerEnvironment } from "./harness-env.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { findSecretLeak, redactText } from "./redaction.js";

const selected = runnerMatrix.filter(cell => cell.suite.id === "extended-harnesses");
describe("extended ACP harness qualification", () => {
  it("has exactly five real product journeys per provider in both environments, excluded from all", () => {
    expect(selected).toHaveLength(30);
    expect(new Set(selected.map(cell => cell.environment.id))).toEqual(new Set(["local", "daytona"]));
    expect(new Set(selected.map(cell => cell.task.id))).toEqual(new Set([
      "hello-complete", "question-resume-complete", "plan-approve-complete", "structured-question-restart-resume", "file-edit-validate",
    ]));
    const all = selectRunnerExecutions(parseRunnerSelectors(["--all"]));
    expect(all.some(cell => cell.suite.id === "extended-harnesses")).toBe(false);
    expect(runnerSuites.find(suite => suite.id === "extended-harnesses")?.manualOnly).toBe(true);
  });
  it("uses exact discovered models, encrypted credential references and pending qualification metadata", () => {
    expect(extendedHarnessProfiles.map(profile => profile.model)).toEqual([
      "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]", "gpt-5.6-luna", "openrouter/deepseek/deepseek-v4-flash-0731",
    ]);
    for (const profile of extendedHarnessProfiles) {
      expect(profile.modelQualification.source).toBe("candidate_runner_profile");
      const secretRef = { type: "secret_ref" as const, secretId: "11111111-1111-4111-8111-111111111111", version: "latest" as const };
      const payload = profile.buildAgent({ executionId: "fixture", environmentId: "local", environmentFixtureId: "local", workspacePath: "/tmp/workspace", secretRefs: { [profile.credential]: secretRef } });
      expect(payload.adapterConfig).toMatchObject({ provider: "acpx", model: profile.model, timeoutSec: 120, acpxAgent: profile.qualificationCandidate, env: { [profile.credential]: secretRef } });
    }
  });
  it("replaces ambient admission with the selected exact pairs and strips raw provider credentials from server", () => {
    const cell = selected[0]!;
    const ambient = { PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient", CURSOR_AUTH_TOKEN: "cursor", CURSOR_API_KEY: "cursor-key", COPILOT_GITHUB_TOKEN: "copilot", GH_TOKEN: "github", GITHUB_TOKEN: "github" };
    const env = buildRunnerE2EProcessEnvironment(ambient, [cell]);
    expect(JSON.parse(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent: "cursor", model: cell.profile.model }]);
    const server = buildPaperclipServerEnvironment(env);
    for (const name of Object.keys(ambient).filter(name => name !== "PAPERCLIP_RUNNER_ACPX_QUALIFICATION")) expect(server[name]).toBeUndefined();
    expect(buildRunnerE2EProcessEnvironment(ambient, []).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, suite: { ...cell.suite, manualOnly: false } }])).toThrow("explicit");
  });
  it("adds six explicit local/Daytona warm cells without admitting them implicitly", () => {
    const warm = runnerMatrix.filter(cell => cell.suite.id === "rich-acp-warm-continuity");
    expect(warm).toHaveLength(6);
    expect(new Set(warm.map(cell => cell.profile.qualificationCandidate))).toEqual(new Set(["cursor", "copilot", "pi"]));
    for (const cell of warm) {
      expect(cell.task).toMatchObject({ flow: "warm_three_turn", expectedRunCount: 3 });
      expect(cell.task.buildMatchers("nonce", cell)).toContainEqual({ kind: "environment", expected: cell.environment.id });
      const config = cell.profile.buildAgent({ executionId: "warm", environmentId: "env", environmentFixtureId: cell.environment.id, workspacePath: "/tmp/workspace", secretRefs: { [cell.profile.credential]: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" } } }).adapterConfig;
      expect(config).toMatchObject({ lifecycleMode: "warm", idleTimeoutMs: 300_000, timeoutSec: 120 });
      const admission = buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION;
      if (cell.profile.qualificationCandidate === "pi") expect(admission).toBeUndefined();
      else expect(JSON.parse(admission!)).toEqual([{ agent: cell.profile.qualificationCandidate, model: cell.profile.model }]);
      expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, suite: { ...cell.suite, manualOnly: false } }])).toThrow("explicit");
    }
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(cell => cell.suite.id === "rich-acp-warm-continuity")).toBe(false);
  });
  it("admits native qualification only for its matching provider and explicit suite", () => {
    for (const suiteId of ["cursor-native", "pi-native", "copilot-protection"]) {
      const cells = runnerMatrix.filter(cell => cell.suite.id === suiteId);
      expect(new Set(cells.map(cell => cell.environment.id))).toEqual(new Set(["local", "daytona"]));
      for (const cell of cells) {
        const admission = buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION;
        if (cell.profile.qualificationCandidate === "pi") expect(admission).toBeUndefined();
        else expect(admission).toBeDefined();
        expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, profile: { ...cell.profile, qualificationCandidate: cell.profile.qualificationCandidate === "pi" ? "cursor" : "pi" } }])).toThrow("explicit");
      }
    }
  });
  it("admits all four explicit active-Stop cells only for Cursor and Copilot", () => {
    const cells = selectRunnerExecutions(parseRunnerSelectors(["--suite", "native-active-stop"]));
    expect(cells).toHaveLength(4);
    expect(new Set(cells.map(cell => `${cell.profile.qualificationCandidate}:${cell.environment.id}`))).toEqual(
      new Set(["cursor:local", "cursor:daytona", "copilot:local", "copilot:daytona"]),
    );
    for (const cell of cells) {
      expect(cell.suite.manualOnly).toBe(true);
      expect(JSON.parse(buildRunnerE2EProcessEnvironment({ PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" }, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION!))
        .toEqual([{ agent: cell.profile.qualificationCandidate, model: cell.profile.model }]);
      expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, suite: { ...cell.suite, manualOnly: false } }])).toThrow("explicit");
      expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, profile: { ...cell.profile, qualificationCandidate: "pi" } }])).toThrow("explicit");
      expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, suite: { ...cell.suite, id: "unrelated-manual-suite" } }])).toThrow("explicit");
    }
    const implicit = selectRunnerExecutions(parseRunnerSelectors(["--all"]));
    expect(implicit.some(cell => cell.suite.id === "native-active-stop")).toBe(false);
  });
  it("requires both image executable pins for remote native cases before setup", () => {
    const remote = runnerMatrix.filter(cell => cell.environment.id === "daytona" && ["cursor-native", "pi-native", "copilot-protection"].includes(cell.suite.id));
    const valid = { PAPERCLIP_E2E_DAYTONA_NODE_SHA256: `sha256:${"a".repeat(64)}`, PAPERCLIP_E2E_DAYTONA_RUNNERD_SHA256: `sha256:${"b".repeat(64)}` };
    expect(() => assertRemoteNativeEvidencePrerequisites(remote, valid)).not.toThrow();
    for (const field of Object.keys(valid)) expect(() => assertRemoteNativeEvidencePrerequisites(remote, { ...valid, [field]: "latest" })).toThrow(field);
    expect(() => assertRemoteNativeEvidencePrerequisites(remote, {})).toThrow("exact image executable digests");
    expect(() => assertRemoteNativeEvidencePrerequisites(selected, {})).not.toThrow();
    expect(() => assertRemoteNativeEvidencePrerequisites(runnerMatrix.filter(cell => cell.environment.id === "local"), {})).not.toThrow();
  });
  it("grades the actual file independently of the model's validation claim", () => {
    const cell = selected.find(cell => cell.task.id === "file-edit-validate")!;
    expect(extendedHarnessFileTask.buildMatchers("nonce", cell)).toContainEqual({ kind: "file_exact", path: "extended-nonce.txt", expected: "verified-nonce\n" });
  });
  it("redacts and detects GitHub credential shapes even without the bound value", () => {
    const token = `github_pat_${"x".repeat(40)}`;
    expect(findSecretLeak(token, [])).toBe("secret-shaped value");
    expect(redactText(token, [])).not.toContain(token);
  });
});
