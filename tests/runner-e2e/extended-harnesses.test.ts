import { assertRemoteNativeEvidencePrerequisites } from "./prerequisites.js";
import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites, suiteDefinitionHash, extendedHarnessProfiles, extendedHarnessFileTask, daytonaWarmContinuityTask } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment, buildPaperclipServerEnvironment } from "./harness-env.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { findSecretLeak, redactText } from "./redaction.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const selected = runnerMatrix.filter(cell => cell.suite.id === "extended-harnesses");
describe("extended ACP harness qualification", () => {
  it("does not reuse the pre-validation-prompt suite identity", () => {
    const suite = runnerSuites.find(suite => suite.id === "extended-harnesses")!;
    const { copilotFileValidation: _copilotPrompt, ...historical } = suite.definitionMetadata as Record<string, unknown>;
    expect(suiteDefinitionHash(suite)).not.toBe(suiteDefinitionHash({
      ...suite, definitionMetadata: { ...historical, version: 5 },
    }));
    const file = selected.find(cell => cell.profile.qualificationCandidate === "copilot" && cell.task.id === "file-edit-validate")!;
    expect(file.task.buildPrompt("nonce")).toContain("Exact read-only validation command:");
    expect(file.task.buildMatchers("nonce", file)).toContainEqual({ kind: "file_exact", path: "extended-nonce.txt", expected: "verified-nonce\n" });
  });

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
  it("uses exact discovered models, encrypted credential references and current qualification metadata", () => {
    expect(extendedHarnessProfiles.map(profile => profile.model)).toEqual([
      "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]", "gpt-5.6-luna", "openrouter/anthropic/claude-sonnet-4.6",
    ]);
    for (const profile of extendedHarnessProfiles) {
      expect(profile.modelQualification.source).toBe(profile.qualificationCandidate === "cursor" ? "qualified_runner_profile" : "candidate_runner_profile");
      const secretRef = { type: "secret_ref" as const, secretId: "11111111-1111-4111-8111-111111111111", version: "latest" as const };
      const payload = profile.buildAgent({ executionId: "fixture", environmentId: "local", environmentFixtureId: "local", workspacePath: "/tmp/workspace", secretRefs: { [profile.credential]: secretRef } });
      expect(payload.adapterConfig).toMatchObject({ provider: "acpx", model: profile.model, timeoutSec: 120, acpxAgent: profile.qualificationCandidate, env: { [profile.credential]: secretRef } });
    }
  });
  it("replaces ambient admission with the selected exact pairs and strips raw provider credentials from server", () => {
    const cell = selected[0]!;
    const ambient = { PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient", CURSOR_AUTH_TOKEN: "cursor", CURSOR_API_KEY: "cursor-key", COPILOT_GITHUB_TOKEN: "copilot", GH_TOKEN: "github", GITHUB_TOKEN: "github" };
    const env = buildRunnerE2EProcessEnvironment(ambient, [cell]);
    expect(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    const server = buildPaperclipServerEnvironment(env);
    for (const name of Object.keys(ambient).filter(name => name !== "PAPERCLIP_RUNNER_ACPX_QUALIFICATION")) expect(server[name]).toBeUndefined();
    expect(buildRunnerE2EProcessEnvironment(ambient, []).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    const pending = selected.find(value => value.profile.qualificationCandidate === "copilot")!;
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...pending, suite: { ...pending.suite, manualOnly: false } }])).toThrow("explicit");
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
      if (cell.profile.qualificationCandidate !== "copilot") expect(admission).toBeUndefined();
      else expect(JSON.parse(admission!)).toEqual([{ agent: "copilot", model: cell.profile.model }]);
      expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, suite: { ...cell.suite, manualOnly: false } }])).toThrow("explicit");
    }
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(cell => cell.suite.id === "rich-acp-warm-continuity")).toBe(false);
  });
  it("separates ACP process continuity from managed-home checkpoint writes", () => {
    for (const cell of runnerMatrix.filter(cell => cell.suite.id === "rich-acp-warm-continuity")) {
      const prompts = [cell.task.buildPrompt("nonce"), ...cell.task.buildFollowupMessages!("nonce")];
      expect(prompts).toHaveLength(3);
      for (const [index, prompt] of prompts.entries()) {
        expect(prompt).toContain(`warm Daytona continuity turn ${index + 1} of 3`);
        expect(prompt).toContain("daytona-warm-nonce.txt");
        expect(prompt).not.toContain("AGENT_HOME");
        expect(prompt).not.toContain("notes/");
      }
      expect(cell.task).toMatchObject({ turnTimeoutMs: 120_000, attemptTimeoutMs: { local: 420_000, daytona: 420_000 } });
    }
    const managed = [daytonaWarmContinuityTask.buildPrompt("nonce"), ...daytonaWarmContinuityTask.buildFollowupMessages!("nonce")];
    expect(managed.every(prompt => prompt.includes("AGENT_HOME") && prompt.includes("notes/warm-memory.txt"))).toBe(true);
    expect(managed[0]).toContain("8388608 bytes");
    expect(managed[1]).toContain("Delete notes/delete-me.txt");
    expect(managed[2]).toContain("Verify notes/delete-me.txt is absent");
  });
  it("admits native qualification only for its matching provider and explicit suite", () => {
    for (const suiteId of ["cursor-native", "pi-native", "copilot-protection"]) {
      const cells = runnerMatrix.filter(cell => cell.suite.id === suiteId);
      expect(new Set(cells.map(cell => cell.environment.id))).toEqual(new Set(["local", "daytona"]));
      for (const cell of cells) {
        const admission = buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION;
        if (cell.profile.qualificationCandidate !== "copilot") expect(admission).toBeUndefined();
        else expect(JSON.parse(admission!)).toEqual([{ agent: "copilot", model: cell.profile.model }]);
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
      const admission = buildRunnerE2EProcessEnvironment({ PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" }, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION;
      if (cell.profile.qualificationCandidate !== "copilot") expect(admission).toBeUndefined();
      else expect(JSON.parse(admission!)).toEqual([{ agent: "copilot", model: cell.profile.model }]);
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
    expect(extendedHarnessFileTask.buildMatchers("nonce", cell)).toContainEqual({ kind: "artifact_exact", name: "extended-nonce.txt", expected: "verified-nonce\n", mimeType: "text/plain" });
  });
  it("supplies a portable read-only byte check only to the Copilot file case", () => {
    for (const cell of selected.filter(cell => cell.task.id === "file-edit-validate")) {
      const prompt = cell.task.buildPrompt("nonce");
      expect(prompt.includes("Exact read-only validation command:")).toBe(cell.profile.qualificationCandidate === "copilot");
      if (cell.profile.qualificationCandidate === "copilot") {
        expect(cell.task.buildMatchers("nonce", cell)).toEqual(extendedHarnessFileTask.buildMatchers("nonce", cell));
        expect(cell.task.attemptTimeoutMs).toEqual(extendedHarnessFileTask.attemptTimeoutMs);
        expect(prompt).toContain("Create extended-nonce.txt");
        expect(prompt).toContain("Edit that file");
        expect(prompt).toContain("Wait for paperclip_finish to succeed");
      }
    }
  });
  it("runs the supplied Copilot check successfully only for the exact edited bytes", () => {
    const cell = selected.find(cell => cell.profile.qualificationCandidate === "copilot" && cell.task.id === "file-edit-validate")!;
    const command = cell.task.buildPrompt("nonce").match(/Exact read-only validation command:\n([^\n]+)/u)?.[1];
    expect(command).toBeDefined();
    const workspace = mkdtempSync(join(tmpdir(), "copilot-file-validation-"));
    try {
      for (const bytes of ["verified-nonce\n", "ready-nonce\n", "verified-nonce", "verified-nonce\n\n", "verified-nonce\\n", ""]) {
        writeFileSync(join(workspace, "extended-nonce.txt"), bytes);
        const result = spawnSync("/bin/sh", ["-c", command!], { cwd: workspace, encoding: "utf8", timeout: 10_000 });
        expect(result.status === 0).toBe(bytes === "verified-nonce\n");
        expect(result.stdout.includes("COPILOT-VALIDATED-nonce")).toBe(bytes === "verified-nonce\n");
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  it("redacts and detects GitHub credential shapes even without the bound value", () => {
    const token = `github_pat_${"x".repeat(40)}`;
    expect(findSecretLeak(token, [])).toBe("secret-shaped value");
    expect(redactText(token, [])).not.toContain(token);
  });
});
