// Identity split and launch-environment finalization tests (Phase 17).
//
// Two tests are compile-time: the real assertion is that this file typechecks.
// A `@ts-expect-error` marks an assignment that MUST fail; if it starts to
// compile, tsc reports the unused directive and the typecheck fails. Each
// compile-time assertion lives in a declared, unexecuted function, so vitest
// never runs a synthetic value.

import { describe, expect, it } from "vitest";
import { buildSessionFingerprint, finalizeLaunchEnvironment } from "./execute.js";
import type {
  LaunchEnvironment,
  RunScopedContribution,
  RunSiteReuseCandidate,
  SessionFingerprintIdentity,
} from "./run-contracts.js";

// A complete fingerprint identity with representative values for the 17 fields.
const SAMPLE_FINGERPRINT_IDENTITY: SessionFingerprintIdentity = {
  acpxAgent: "claude",
  agentCommand: "claude",
  cwd: "/work",
  mode: "persistent",
  permissionMode: "approve-all",
  nonInteractivePermissions: "deny",
  requestedModel: "",
  requestedThinkingEffort: "",
  fastMode: false,
  remoteExecutionIdentity: null,
  additionalSourcesIdentity: {},
  skillsIdentity: {},
  skillPromptInstructions: "",
  paperclipClaudeSettings: null,
  mcpServers: [],
  secretManifestHash: "0000",
  adapterEnvHash: "0000",
};

describe("acpx identity split and launch environment", () => {
  it("test_fingerprint_builder_accepts_only_session_fingerprint_identity", () => {
    // The builder accepts a fingerprint identity and returns a stable hash.
    const first = buildSessionFingerprint(SAMPLE_FINGERPRINT_IDENTITY);
    const second = buildSessionFingerprint(SAMPLE_FINGERPRINT_IDENTITY);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);

    // The compile-time assertions live in an unexecuted function.
    function _assertOnlyIdentity(): void {
      // An outer-key field is not a fingerprint field, so the builder rejects it.
      // @ts-expect-error companyId is not a SessionFingerprintIdentity field.
      buildSessionFingerprint({ ...SAMPLE_FINGERPRINT_IDENTITY, companyId: "c" });
      // @ts-expect-error taskKey is not a SessionFingerprintIdentity field.
      buildSessionFingerprint({ ...SAMPLE_FINGERPRINT_IDENTITY, taskKey: "t" });
    }
    void _assertOnlyIdentity;
  });

  it("test_finalize_launch_environment_is_sole_constructor_of_branded_environment", () => {
    // The finalizer merges every contribution and freezes the launch env.
    const baseEnv: Record<string, string> = { LAUNCH_ENV_TEST_BASE: "base" };
    const launchEnvironment = finalizeLaunchEnvironment(baseEnv, [
      { scope: "session", env: { LAUNCH_ENV_TEST_CONTRIB: "contrib" } },
    ]);
    expect(launchEnvironment.env.LAUNCH_ENV_TEST_BASE).toBe("base");
    expect(launchEnvironment.env.LAUNCH_ENV_TEST_CONTRIB).toBe("contrib");
    expect(Object.isFrozen(launchEnvironment.env)).toBe(true);

    // No plain object literal can stand in for the branded environment; it lacks
    // the private brand that only `finalizeLaunchEnvironment` sets.
    function _assertBrand(): void {
      // @ts-expect-error missing the private launch-environment brand.
      const _fake: LaunchEnvironment = { env: {} };
      void _fake;
    }
    void _assertBrand;
  });

  it("test_run_scoped_contribution_is_not_assignable_to_a_reuse_payload", () => {
    // A run-scoped contribution and the branded launch environment must never
    // enter a reuse payload (Amendment B). The reuse candidate types reject both.
    function _assertNotReusable(
      contribution: RunScopedContribution,
      launchEnvironment: LaunchEnvironment,
    ): void {
      // @ts-expect-error a run-scoped contribution is not a reuse candidate.
      const _a: RunSiteReuseCandidate = contribution;
      // @ts-expect-error the branded launch environment is not a reuse candidate.
      const _b: RunSiteReuseCandidate = launchEnvironment;
      void _a;
      void _b;
    }
    void _assertNotReusable;
    expect(true).toBe(true);
  });
});
