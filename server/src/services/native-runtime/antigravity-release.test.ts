import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both release states are exercised against the same build: the qualified
// declaration that ships today (revision 2, no qualificationStatus), and the
// historical pending candidate declaration (revision 1, qualificationStatus: "pending").
const release = vi.hoisted(() => ({ pending: false }));
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>();
  const pending = {
    ...original.QUALIFIED_ACPX_PROFILES.antigravity,
    agentProfileVersion: original.QUALIFIED_ACPX_PROFILES.antigravity.agentProfileVersion - 1,
    qualificationStatus: "pending" as const,
  };
  const profiles = { ...original.QUALIFIED_ACPX_PROFILES };
  Object.defineProperty(profiles, "antigravity", { enumerable: true,
    get: () => release.pending ? pending : original.QUALIFIED_ACPX_PROFILES.antigravity });
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
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode, retireNeverOpenedCandidateRunRoot, scopedRunnerdStateRoot } from "./native-session-executor.js";
import { NATIVE_PROVIDER_STATE_INCOMPATIBLE } from "./native-session-resume.js";
import { ANTIGRAVITY_FIXTURE_COMPANY_ID as companyId, ANTIGRAVITY_FIXTURE_MODEL as model, antigravityExecution } from "./antigravity.test-fixture.js";

const distributions = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/antigravity-distributions.json", import.meta.url), "utf8"));

const candidateGrant = (target = "darwin-arm64", changes: Record<string, unknown> = {}) => {
  const [platform, architecture] = target.split("-");
  return JSON.stringify({ schema: "paperclip.acpx-candidate-admission.v1", companyId,
    agent: "antigravity", model, profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest,
    nativeClosureDigest: `sha256:${distributions.platforms[target].closureSha256}`,
    platform, architecture, expiresAt: Date.now() + 60_000, ...changes });
};

afterEach(() => { release.pending = false; vi.unstubAllEnvs(); });

describe("Antigravity executor admission", () => {
  const admissible = (execution: NativeExecutionInput, changes: Partial<Parameters<typeof assertAntigravityExecutionAdmissible>[0]> = {}) =>
    () => assertAntigravityExecutionAdmissible({ execution, useRunnerd: true, remoteTarget: false, ...changes });

  it("takes the general qualified path without a candidate grant, including pluginTask and remote targets", () => {
    expect(antigravityReleasePending()).toBe(false);
    expect(QUALIFIED_ACPX_PROFILES.antigravity.agentProfileVersion).toBe(2);
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, undefined);
    const execution = antigravityExecution();
    expect(admissible(execution)).not.toThrow();
    expect(admissible(execution, { remoteTarget: true, pluginTask: true })).not.toThrow();
    expect(admissible(execution, { remoteTarget: true, restartRecovery: { kind: "reattach_remote_runner" } })).not.toThrow();
    const preconfigured = { ...execution, homeMode: "preconfigured" } as NativeExecutionInput;
    expect(admissible(preconfigured)).not.toThrow();
  });

  it("refuses ungranted and pluginTask execution when releasePending is forced true", () => {
    release.pending = true;
    expect(antigravityReleasePending()).toBe(true);
    const execution = antigravityExecution();
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, undefined);
    expect(admissible(execution)).toThrow(/paperclip_runner_antigravity_candidate_ineligible/);
    expect(admissible(execution, { remoteTarget: true })).toThrow(/candidate_ineligible/);
    expect(admissible(execution, { remoteTarget: true, pluginTask: true })).toThrow(/candidate_ineligible/);
    const warm = { ...execution, session: { ...execution.session, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 1 } } } as NativeExecutionInput;
    expect(admissible(warm)).toThrow(/candidate_ineligible/);
  });
});

describe("Antigravity agent picker candidate", () => {
  const cloud = { driver: "sandbox", platform: "linux", architecture: "x64", libc: "glibc" as const, glibcVersion: "2.39" };

  it("offers no candidate once the profile is released, even if a stale grant env var is set", () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, candidateGrant("linux-x64"));
    expect(antigravityCandidateForRunnerTarget(companyId, cloud)).toBeUndefined();
    expect(antigravityCandidateForRunnerTarget(companyId, { driver: "local" })).toBeUndefined();
    expect(antigravityCandidateForRunnerTarget(companyId, { driver: "plugin", runnerTasks: true })).toBeUndefined();
  });
});

describe("Antigravity recovery policy and state root", () => {
  it("uses ordinary session-scoped state when released and per-run candidate scope only while pending", () => {
    const execution = antigravityExecution();
    const nextRun = antigravityExecution({ runId: "50000000-0000-4000-8000-000000000005" });
    expect(antigravityForcesSameSessionRecovery(execution.provider)).toBe(false);
    expect(antigravityUsesRunScopedState(execution)).toBe(false);
    // Qualified: one root per session scope, kept across the session's runs.
    expect(scopedRunnerdStateRoot(execution)).toBe(scopedRunnerdStateRoot(nextRun));

    release.pending = true;
    expect(antigravityForcesSameSessionRecovery(execution.provider)).toBe(true);
    expect(antigravityUsesRunScopedState(execution)).toBe(true);
    expect(scopedRunnerdStateRoot(execution)).not.toBe(scopedRunnerdStateRoot(nextRun));
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

  it("retires a root whose session.open never opened a provider session only while pending", async () => {
    release.pending = true;
    const execution = antigravityExecution();
    const root = writeFailedOpenRoot(execution);
    expect(await retireNeverOpenedCandidateRunRoot(execution, root)).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(quarantined(root)).toBe(true);
  });

  it("keeps a root that opened a provider session or started a turn, and every root once released", async () => {
    release.pending = true;
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
  it("refuses the candidate's in-flight v1 state permanently and by name, never as a retryable interruption", () => {
    // Saved before the deploy under the candidate's v1 profile version.
    release.pending = true;
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
    const saved = antigravityExecution();
    (saved.provider as { profile: { agentProfileVersion: number } }).profile.agentProfileVersion -= 1;
    expect(() => assertAntigravityExecutionAdmissible({ execution: saved, useRunnerd: true, remoteTarget: false }))
      .toThrow(NativeProviderStateIncompatibleError);
  });
});
