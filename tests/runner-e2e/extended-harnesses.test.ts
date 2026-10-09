import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites, extendedHarnessProfiles, extendedHarnessFileTask } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment, buildPaperclipServerEnvironment } from "./harness-env.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { findSecretLeak, redactText } from "./redaction.js";

const selected = runnerMatrix.filter(cell => cell.suite.id === "extended-harnesses");
describe("extended ACP harness qualification", () => {
  it("has exactly five real product journeys per provider in both environments, excluded from all", () => {
    expect(selected).toHaveLength(40);
    expect(new Set(selected.map(cell => cell.environment.id))).toEqual(new Set(["local", "daytona"]));
    expect(new Set(selected.map(cell => cell.task.id))).toEqual(new Set([
      "hello-complete", "question-resume-complete", "plan-approve-complete", "structured-question-restart-resume", "file-edit-validate",
    ]));
    const all = selectRunnerExecutions(parseRunnerSelectors(["--all"]));
    expect(all.some(cell => cell.suite.id === "extended-harnesses")).toBe(false);
    expect(runnerSuites.find(suite => suite.id === "extended-harnesses")?.manualOnly).toBe(true);
  });
  it("uses exact discovered models, encrypted credential references and current qualification metadata", () => {
    expect(extendedHarnessProfiles.map(profile => profile.model)).toEqual([
      "deepseek/deepseek-v4-flash-0731",
      "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]", "gpt-5.6-luna", "openrouter/deepseek/deepseek-v4-flash-0731",
    ]);
    for (const profile of extendedHarnessProfiles) {
      expect(profile.modelQualification.source).toBe(profile.qualificationCandidate === "cursor" ? "qualified_runner_profile" : "candidate_runner_profile");
      const secretRef = { type: "secret_ref" as const, secretId: "11111111-1111-4111-8111-111111111111", version: "latest" as const };
      const payload = profile.buildAgent({ executionId: "fixture", environmentId: "local", environmentFixtureId: "local", workspacePath: "/tmp/workspace", secretRefs: { [profile.credential]: secretRef } });
      expect(payload.adapterConfig).toMatchObject({ provider: "acpx", model: profile.model, timeoutSec: 120, acpxAgent: profile.qualificationCandidate, env: { [profile.credential]: secretRef } });
    }
  });
  it("replaces ambient admission with the selected exact pairs and strips raw provider credentials from server", () => {
    const cell = selected.find(cell => cell.profile.qualificationCandidate === "cursor")!;
    const ambient = { PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient", CURSOR_AUTH_TOKEN: "cursor", CURSOR_API_KEY: "cursor-key", COPILOT_GITHUB_TOKEN: "copilot", GH_TOKEN: "github", GITHUB_TOKEN: "github" };
    const env = buildRunnerE2EProcessEnvironment(ambient, [cell]);
    expect(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    const server = buildPaperclipServerEnvironment(env);
    for (const name of Object.keys(ambient).filter(name => name !== "PAPERCLIP_RUNNER_ACPX_QUALIFICATION")) expect(server[name]).toBeUndefined();
    expect(buildRunnerE2EProcessEnvironment(ambient, []).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    const pending = selected.find(value => value.profile.qualificationCandidate === "copilot")!;
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...pending, suite: { ...pending.suite, manualOnly: false } }])).toThrow("explicit");
  });
  it("grades the actual file independently of the model's validation claim", () => {
    const cell = selected.find(cell => cell.task.id === "file-edit-validate")!;
    expect(extendedHarnessFileTask.buildMatchers("nonce", cell)).toContainEqual({ kind: "file_exact", path: "extended-nonce.txt", expected: "verified-nonce\n" });
    expect(extendedHarnessFileTask.buildMatchers("nonce", cell)).toContainEqual({ kind: "artifact_exact", name: "extended-nonce.txt", expected: "verified-nonce\n", mimeType: "text/plain" });
  });
  it("redacts and detects GitHub credential shapes even without the bound value", () => {
    const token = `github_pat_${"x".repeat(40)}`;
    expect(findSecretLeak(token, [])).toBe("secret-shaped value");
    expect(redactText(token, [])).not.toContain(token);
  });
});
