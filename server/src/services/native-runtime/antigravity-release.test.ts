import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both release states are exercised against the same build: the pending
// candidate declaration that ships today, and the qualified declaration the
// flip produces (no qualificationStatus, profile version bumped), as the Kimi
// probe tests stub it.
const release = vi.hoisted(() => ({ pending: true }));
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>();
  const { qualificationStatus: _pending, ...qualified } = original.QUALIFIED_ACPX_PROFILES.antigravity;
  const released = { ...qualified, agentProfileVersion: qualified.agentProfileVersion + 1 };
  const profiles = { ...original.QUALIFIED_ACPX_PROFILES };
  Object.defineProperty(profiles, "antigravity", { enumerable: true,
    get: () => release.pending ? original.QUALIFIED_ACPX_PROFILES.antigravity : released });
  return { ...original, QUALIFIED_ACPX_PROFILES: profiles };
});

import { NativeProviderStateIncompatibleError, QUALIFIED_ACPX_PROFILES, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { ANTIGRAVITY_CANDIDATE_ADMISSION_ENV } from "./acpx-qualification.js";
import {
  antigravityCandidateForRunnerTarget,
  antigravityForcesSameSessionRecovery,
  antigravityReleasePending,
  antigravityUsesRunScopedState,
  assertAntigravityExecutionAdmissible,
} from "./antigravity-release.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode, retireNeverOpenedCandidateRunRoot, scopedRunnerdStateRoot } from "./native-session-executor.js";
import { NATIVE_PROVIDER_STATE_INCOMPATIBLE } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const model = "gemini-3.8-flash-low";
const localHost = process.platform === "darwin" && process.arch === "arm64";
const distributions = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/antigravity-distributions.json", import.meta.url), "utf8"));

function antigravityExecution(input: { runId?: string; issueId?: string; workspaceId?: string; sessionId?: string } = {}) {
  const runId = input.runId ?? "40000000-0000-4000-8000-000000000004";
  const execution = buildNativeExecutionInput({
    companyId, runId, agentId: "30000000-0000-4000-8000-000000000003",
    issue: { id: input.issueId ?? "20000000-0000-4000-8000-000000000002", identifier: "AG-1", title: "Test", description: null, workMode: "standard" },
    taskPrompt: "Only the current turn",
    workspace: { id: input.workspaceId ?? "90000000-0000-4000-8000-000000000009", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: input.sessionId ?? "60000000-0000-4000-8000-000000000006",
    provider: "acpx", acpxAgent: "antigravity", model, acpxPermissionMode: "approve-all",
    completionContract: { id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Test", criteria: [{ id: "objective", requirement: "Answer" }] } },
    runtimeContext: nativeRuntimeContextFixture(),
  }) as NativeExecutionInput;
  // The execution input binds the profile version the running release declares.
  (execution.provider as { profile: { agentProfileVersion: number } }).profile.agentProfileVersion =
    QUALIFIED_ACPX_PROFILES.antigravity.agentProfileVersion;
  return execution;
}

const candidateGrant = (target = "darwin-arm64", changes: Record<string, unknown> = {}) => {
  const [platform, architecture] = target.split("-");
  return JSON.stringify({ schema: "paperclip.acpx-candidate-admission.v1", companyId,
    agent: "antigravity", model, profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest,
    nativeClosureDigest: `sha256:${distributions.platforms[target].closureSha256}`,
    platform, architecture, expiresAt: Date.now() + 60_000, ...changes });
};

afterEach(() => { release.pending = true; vi.unstubAllEnvs(); });

describe("Antigravity executor admission", () => {
  const admissible = (execution: NativeExecutionInput, changes: Partial<Parameters<typeof assertAntigravityExecutionAdmissible>[0]> = {}) =>
    () => assertAntigravityExecutionAdmissible({ execution, useRunnerd: true, remoteTarget: false, ...changes });

  it("requires the exact local per-turn candidate grant while the profile is pending", () => {
    expect(antigravityReleasePending()).toBe(true);
    const execution = antigravityExecution();
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, undefined);
    expect(admissible(execution)).toThrow(/paperclip_runner_antigravity_candidate_ineligible/);
    if (!localHost) return;
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant());
    expect(admissible(execution)).not.toThrow();
    // A local grant never admits a cloud run.
    for (const change of [{ remoteTarget: true }, { restartRecovery: { kind: "same_run" } }, { useRunnerd: false }, { backend: {} }]) {
      expect(admissible(execution, change)).toThrow(/candidate_ineligible/);
    }
    const warm = { ...execution, session: { ...execution.session, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 1 } } } as NativeExecutionInput;
    expect(admissible(warm)).toThrow(/candidate_ineligible/);
  });

  it("admits a cloud run only with a linux-x64 grant naming the patched closure, for the granted company", () => {
    const execution = antigravityExecution();
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant("linux-x64"));
    expect(admissible(execution, { remoteTarget: true })).not.toThrow();
    const warm = { ...execution, session: { ...execution.session, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 1 } } } as NativeExecutionInput;
    expect(admissible(warm, { remoteTarget: true })).toThrow(/candidate_ineligible/);
    expect(admissible(execution, { remoteTarget: true, restartRecovery: { kind: "reattach_remote_runner" } })).toThrow(/candidate_ineligible/);
    const otherCompany = { ...execution, binding: { ...execution.binding, companyId: "10000000-0000-4000-8000-0000000000ff" } } as NativeExecutionInput;
    expect(admissible(otherCompany, { remoteTarget: true })).toThrow(/candidate_ineligible/);
    for (const grant of [candidateGrant("linux-arm64"), candidateGrant("darwin-arm64"),
      candidateGrant("linux-x64", { nativeClosureDigest: `sha256:${distributions.platforms["linux-x64"].vendorClosureSha256}` }),
      candidateGrant("linux-x64", { model: "gemini-3.8-flash-high" })]) {
      vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, grant);
      expect(admissible(execution, { remoteTarget: true })).toThrow(/candidate_ineligible/);
    }
  });

  it("takes the general qualified path after the flip: no grant, restart recovery, remote and warm targets", () => {
    release.pending = false;
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, undefined);
    const execution = antigravityExecution();
    expect(admissible(execution)).not.toThrow();
    expect(admissible(execution, { remoteTarget: true, restartRecovery: { kind: "reattach_remote_runner" } })).not.toThrow();
    const preconfigured = { ...execution, homeMode: "preconfigured" } as NativeExecutionInput;
    expect(admissible(preconfigured)).not.toThrow();
  });
});

describe("Antigravity agent picker candidate", () => {
  const cloud = { driver: "sandbox", platform: "linux", architecture: "x64", libc: "glibc" as const, glibcVersion: "2.39" };

  it("offers a cloud environment only the company's own unexpired linux-x64 grant", () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant("linux-x64"));
    expect(antigravityCandidateForRunnerTarget(companyId, cloud)).toMatchObject({ model, platform: "linux", architecture: "x64" });
    expect(antigravityCandidateForRunnerTarget(companyId, { driver: "sandbox", managedCloudImage: true })).toMatchObject({ model });
    expect(antigravityCandidateForRunnerTarget("10000000-0000-4000-8000-00000000000f", cloud)).toBeUndefined();
    expect(antigravityCandidateForRunnerTarget(companyId, { ...cloud, architecture: "arm64" })).toBeUndefined();
    expect(antigravityCandidateForRunnerTarget(companyId, { driver: "plugin", runnerTasks: true })).toBeUndefined();
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant("linux-x64", { expiresAt: Date.now() - 1 }));
    expect(() => antigravityCandidateForRunnerTarget(companyId, cloud)).toThrow();
  });

  it("does not open a cloud environment with a grant for this host", () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant("darwin-arm64"));
    expect(() => antigravityCandidateForRunnerTarget(companyId, cloud)).toThrow(/does not match the execution target/);
  });

  it("offers a cloud environment nothing when its Linux libc cannot run the Runner", () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant("linux-x64"));
    for (const target of [
      { ...cloud, libc: "musl" as const, glibcVersion: undefined },
      { ...cloud, libc: "unknown" as const, glibcVersion: undefined },
      { ...cloud, glibcVersion: "2.35" },
      { driver: "ssh", platform: "linux", architecture: "x64", libc: "glibc" as const, glibcVersion: "2.31" },
    ]) expect(antigravityCandidateForRunnerTarget(companyId, target)).toBeUndefined();
    expect(antigravityCandidateForRunnerTarget(companyId, { driver: "ssh", platform: "linux", architecture: "x64", libc: "glibc", glibcVersion: "2.41" }))
      .toMatchObject({ model });
  });

  it("offers this host only a grant that names this host", () => {
    // Pin the host to darwin-arm64 so the result does not depend on the machine
    // running the test. A cloud (linux-x64) grant is valid for an untargeted
    // lookup on every host, so only a host-bound lookup refuses it.
    const host = { platform: Object.getOwnPropertyDescriptor(process, "platform")!, arch: Object.getOwnPropertyDescriptor(process, "arch")! };
    Object.defineProperty(process, "platform", { ...host.platform, value: "darwin" });
    Object.defineProperty(process, "arch", { ...host.arch, value: "arm64" });
    try {
      vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant("linux-x64"));
      expect(() => antigravityCandidateForRunnerTarget(companyId, { driver: "local" })).toThrow(/does not match the execution target/);
      vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant("darwin-arm64"));
      expect(antigravityCandidateForRunnerTarget(companyId, { driver: "local" })).toMatchObject({ model, platform: "darwin", architecture: "arm64" });
    } finally {
      Object.defineProperty(process, "platform", host.platform);
      Object.defineProperty(process, "arch", host.arch);
    }
  });

  it("offers no candidate once the profile is released", () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant("linux-x64"));
    release.pending = false;
    expect(antigravityCandidateForRunnerTarget(companyId, cloud)).toBeUndefined();
    expect(antigravityCandidateForRunnerTarget(companyId, { driver: "local" })).toBeUndefined();
  });
});

describe("Antigravity recovery policy and state root", () => {
  it("forces the candidate's same-session recovery and per-run root only while pending", () => {
    const execution = antigravityExecution();
    const nextRun = antigravityExecution({ runId: "50000000-0000-4000-8000-000000000005" });
    expect(antigravityForcesSameSessionRecovery(execution.provider)).toBe(true);
    expect(antigravityUsesRunScopedState(execution)).toBe(true);
    expect(scopedRunnerdStateRoot(execution)).not.toBe(scopedRunnerdStateRoot(nextRun));

    release.pending = false;
    expect(antigravityForcesSameSessionRecovery(execution.provider)).toBe(false);
    expect(antigravityUsesRunScopedState(execution)).toBe(false);
    // Qualified: one root per session scope, kept across the session's runs.
    expect(scopedRunnerdStateRoot(execution)).toBe(scopedRunnerdStateRoot(nextRun));
  });

  it.each([false, true])("never shares a state root across subtasks or workspaces (pending=%s)", pending => {
    release.pending = pending;
    const parent = antigravityExecution();
    const subtask = antigravityExecution({ issueId: "21000000-0000-4000-8000-000000000002",
      workspaceId: "91000000-0000-4000-8000-000000000009", sessionId: "61000000-0000-4000-8000-000000000006" });
    const otherWorkspace = antigravityExecution({ workspaceId: "92000000-0000-4000-8000-000000000009" });
    const roots = new Set([parent, subtask, otherWorkspace].map(scopedRunnerdStateRoot));
    expect(roots.size).toBe(3);
  });
});

describe("Antigravity candidate same-run startup retry", () => {
  let stateBase: string;
  beforeEach(() => {
    stateBase = mkdtempSync(join(tmpdir(), "antigravity-candidate-root-"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", stateBase);
  });
  afterEach(() => rmSync(stateBase, { recursive: true, force: true }));

  /** What a candidate runner leaves after its session.open failed and it suspended. */
  function writeFailedOpenRoot(execution: NativeExecutionInput, provider: Record<string, unknown> = {}) {
    const root = scopedRunnerdStateRoot(execution);
    mkdirSync(join(root, "control-plane"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "runner"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "control-plane", "control-plane-state.json"), JSON.stringify({
      schema: "paperclip.runner.durable.control-plane-state.v2",
      identity: { runnerInstanceId: "80000000-0000-4000-8000-000000000008", environmentLeaseId: execution.binding.executionWorkspaceId,
        runId: execution.binding.runId, normalizedSessionId: execution.session.normalizedSessionId },
    }));
    writeFileSync(join(root, "runner", "acpx-provider-state.json"), JSON.stringify({
      schema: "paperclip.runner.acpx-provider-state.v3", lifecycle: "closed", identity: null, activeTurnId: null,
      providerExitUnconfirmed: false, semanticResult: null, pendingEvents: [], pendingRuntimeRequests: {}, openSemanticCalls: [],
      ...provider,
    }));
    return root;
  }
  const quarantined = (root: string) => existsSync(join(stateBase, "quarantine"))
    && readdirSync(join(stateBase, "quarantine")).some(name => name.startsWith(`${basename(root)}.identity_indeterminate.`));

  it("retires a root whose session.open never opened a provider session, so the retry starts fresh", async () => {
    const execution = antigravityExecution();
    const root = writeFailedOpenRoot(execution);
    expect(await retireNeverOpenedCandidateRunRoot(execution, root)).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(quarantined(root)).toBe(true);
  });

  it("keeps a root that opened a provider session or started a turn, and every root once released", async () => {
    for (const provider of [
      { lifecycle: "suspended", identity: { kind: "acpx", acpxRecordId: "record" } },
      { lifecycle: "closed", identity: { kind: "acpx", acpxRecordId: "record" } },
      { lifecycle: "turn_active", activeTurnId: "turn" },
      { providerExitUnconfirmed: true },
    ]) {
      const execution = antigravityExecution();
      const root = writeFailedOpenRoot(execution, provider);
      expect(await retireNeverOpenedCandidateRunRoot(execution, root)).toBe(false);
      expect(existsSync(root)).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
    // Another run's root is never this run's to retire.
    const other = antigravityExecution({ runId: "50000000-0000-4000-8000-000000000005" });
    const otherRoot = writeFailedOpenRoot(other);
    expect(await retireNeverOpenedCandidateRunRoot(antigravityExecution(), otherRoot)).toBe(false);
    expect(existsSync(otherRoot)).toBe(true);
    release.pending = false;
    const released = antigravityExecution();
    const releasedRoot = writeFailedOpenRoot(released);
    expect(await retireNeverOpenedCandidateRunRoot(released, releasedRoot)).toBe(false);
    expect(existsSync(releasedRoot)).toBe(true);
  });
});

describe("Antigravity state saved by the pending candidate, resumed by the qualified release", () => {
  it("refuses the candidate's in-flight state permanently and by name, never as a retryable interruption", () => {
    // Saved before the deploy under the candidate's profile version.
    const saved = antigravityExecution();
    release.pending = false;
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, undefined);
    let refusal: unknown;
    try {
      assertAntigravityExecutionAdmissible({ execution: saved, useRunnerd: true, remoteTarget: false,
        restartRecovery: { kind: "same_run_resume" } });
    } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(NativeProviderStateIncompatibleError);
    const code = nativeSessionFailureSourceCode(refusal);
    expect(code).toBe(NATIVE_PROVIDER_STATE_INCOMPATIBLE);
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toMatchObject({
      phase: "terminal_failure", failureCode: NATIVE_PROVIDER_STATE_INCOMPATIBLE, nextAttemptAt: null });
  });

  it("refuses an older qualified profile version by the same name", () => {
    release.pending = false;
    const saved = antigravityExecution();
    (saved.provider as { profile: { agentProfileVersion: number } }).profile.agentProfileVersion -= 1;
    expect(() => assertAntigravityExecutionAdmissible({ execution: saved, useRunnerd: true, remoteTarget: false }))
      .toThrow(NativeProviderStateIncompatibleError);
  });
});
