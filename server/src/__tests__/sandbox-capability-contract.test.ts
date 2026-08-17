import { describe, expect, it } from "vitest";
import {
  SANDBOX_CAPABILITY_KEYS,
  buildSandboxCapabilityNarrowing,
  builtinSandboxProviderVerifiedMethods,
  resolveEffectiveSandboxCapabilities,
} from "../services/environment-runtime.js";

// The worker verbs a fully-capable plug-in provider advertises.
const ALL_PLUGIN_METHODS = [
  "environmentAcquireLease",
  "environmentResumeLease",
  "environmentReleaseLease",
  "environmentDestroyLease",
  "environmentExecute",
  "environmentSyncIn",
  "environmentSyncOut",
];

describe("sandbox capability contract normalizer", () => {
  it("test_absent_declaration_defers_to_worker_supported_methods_discovery", () => {
    // No declaration at all. The effective set must fall back to what the worker
    // verified, so a third-party provider that implements the sync hooks keeps
    // native sync without declaring it.
    const effective = resolveEffectiveSandboxCapabilities({
      verifiedMethods: ["environmentSyncIn", "environmentSyncOut"],
      declared: null,
    });

    expect(effective.nativeSyncIn).toBe(true);
    expect(effective.nativeSyncOut).toBe(true);
    // The worker did not verify these verbs, so the baseline is false.
    expect(effective.persistentProcessSessions).toBe(false);
    expect(effective.reusableLeases).toBe(false);
  });

  it("test_effective_capabilities_are_subset_of_verified_and_declared", () => {
    const verifiedMethods = ["environmentExecute"];
    const declared = {
      persistentProcessSessions: true,
      independentControlCommands: false,
      nativeSyncIn: true,
    };
    const effective = resolveEffectiveSandboxCapabilities({ verifiedMethods, declared });

    // Verified + declared true.
    expect(effective.persistentProcessSessions).toBe(true);
    // Declared false, so removed even though verified.
    expect(effective.independentControlCommands).toBe(false);
    // Declared true but not verified, so removed.
    expect(effective.nativeSyncIn).toBe(false);

    // Every effective capability must be a subset of the verified set and the
    // declaration: an effective `true` never appears where the worker did not
    // verify or the declaration set `false`.
    const verifiedOnly = resolveEffectiveSandboxCapabilities({ verifiedMethods });
    for (const key of SANDBOX_CAPABILITY_KEYS) {
      if (effective[key]) {
        expect(verifiedOnly[key]).toBe(true);
        expect((declared as Record<string, boolean | undefined>)[key]).not.toBe(false);
      }
    }
  });

  it("test_kubernetes_job_lease_disables_native_sync", () => {
    const narrowing = buildSandboxCapabilityNarrowing({
      leasePolicy: "ephemeral",
      leaseMetadata: { backend: "job" },
      config: {},
    });
    const effective = resolveEffectiveSandboxCapabilities({
      verifiedMethods: ALL_PLUGIN_METHODS,
      declared: { nativeSyncIn: true, nativeSyncOut: true },
      narrowing,
    });

    expect(effective.nativeSyncIn).toBe(false);
    expect(effective.nativeSyncOut).toBe(false);
    // A non-sync capability is unaffected by the job-lease narrowing.
    expect(effective.persistentProcessSessions).toBe(true);

    // The `nativeFileSyncUnsupported` lease flag narrows the same way.
    const flaggedNarrowing = buildSandboxCapabilityNarrowing({
      leasePolicy: "ephemeral",
      leaseMetadata: { nativeFileSyncUnsupported: true },
      config: {},
    });
    expect(flaggedNarrowing.nativeSyncIn).toBe(false);
    expect(flaggedNarrowing.nativeSyncOut).toBe(false);
  });

  it("test_daytona_persistent_process_sessions_follows_use_sessions_config", () => {
    const verifiedMethods = ["environmentExecute"];
    const declared = { persistentProcessSessions: true };

    const sessionsOff = resolveEffectiveSandboxCapabilities({
      verifiedMethods,
      declared,
      narrowing: buildSandboxCapabilityNarrowing({
        leasePolicy: "ephemeral",
        leaseMetadata: {},
        config: { useSessions: false },
      }),
    });
    expect(sessionsOff.persistentProcessSessions).toBe(false);

    const sessionsOn = resolveEffectiveSandboxCapabilities({
      verifiedMethods,
      declared,
      narrowing: buildSandboxCapabilityNarrowing({
        leasePolicy: "ephemeral",
        leaseMetadata: {},
        config: { useSessions: true },
      }),
    });
    expect(sessionsOn.persistentProcessSessions).toBe(true);

    // A provider config that omits `useSessions` adds no narrowing here.
    const noKey = buildSandboxCapabilityNarrowing({
      leasePolicy: "ephemeral",
      leaseMetadata: {},
      config: {},
    });
    expect(noKey.persistentProcessSessions).toBeUndefined();
  });

  it("test_config_resolution_failure_fails_closed_on_persistent_process_sessions", () => {
    const verifiedMethods = ["environmentExecute"];
    const declared = { persistentProcessSessions: true };

    // Config resolution failed, so the runtime cannot read `useSessions`. The
    // narrowing must deny persistent process sessions instead of allowing them
    // through an empty config. Without the fail-closed guard this narrowing key
    // stays undefined and `persistentProcessSessions` resolves to true.
    const narrowing = buildSandboxCapabilityNarrowing({
      leasePolicy: "ephemeral",
      leaseMetadata: {},
      config: {},
      configResolutionFailed: true,
    });
    expect(narrowing.persistentProcessSessions).toBe(false);

    const effective = resolveEffectiveSandboxCapabilities({
      verifiedMethods,
      declared,
      narrowing,
    });
    expect(effective.persistentProcessSessions).toBe(false);

    // Native sync and reusable lease enforcement stay unchanged on failure.
    const syncNarrowing = buildSandboxCapabilityNarrowing({
      leasePolicy: "reuse_by_environment",
      leaseMetadata: { backend: "job" },
      config: {},
      configResolutionFailed: true,
    });
    expect(syncNarrowing.reusableLeases).toBe(true);
    expect(syncNarrowing.nativeSyncIn).toBe(false);
    expect(syncNarrowing.nativeSyncOut).toBe(false);
  });

  it("test_builtin_provider_branch_uses_same_normalizer_as_plugin_branch", () => {
    const declared = { reusableLeases: true, persistentProcessSessions: true };

    // A built-in provider maps its own methods to the same verb names.
    const builtinMethods = builtinSandboxProviderVerifiedMethods({
      supportsReusableLeases: true,
      execute: () => undefined,
    });
    const builtinEffective = resolveEffectiveSandboxCapabilities({
      verifiedMethods: builtinMethods,
      declared,
    });

    // A plug-in provider that advertises the equivalent verbs.
    const pluginEffective = resolveEffectiveSandboxCapabilities({
      verifiedMethods: [
        "environmentResumeLease",
        "environmentReleaseLease",
        "environmentDestroyLease",
        "environmentExecute",
      ],
      declared,
    });

    // The one normalizer drives both branches, so equivalent verb sets resolve
    // to the identical effective capabilities.
    expect(builtinEffective).toEqual(pluginEffective);
    expect(builtinEffective.reusableLeases).toBe(true);
    expect(builtinEffective.persistentProcessSessions).toBe(true);
    // A built-in provider has no native sync hooks, so it never verifies sync.
    expect(builtinEffective.nativeSyncIn).toBe(false);

    // A built-in provider without an execute method verifies no exec capability.
    const noExec = resolveEffectiveSandboxCapabilities({
      verifiedMethods: builtinSandboxProviderVerifiedMethods({ supportsReusableLeases: false }),
      declared: { persistentProcessSessions: true },
    });
    expect(noExec.persistentProcessSessions).toBe(false);
  });

  it("test_present_declaration_never_grants_beyond_verified_supported_methods", () => {
    // One case per capability: the declaration sets the flag `true`, the worker
    // lacks a prerequisite verb, and the effective value stays `false`.
    for (const key of SANDBOX_CAPABILITY_KEYS) {
      const effective = resolveEffectiveSandboxCapabilities({
        verifiedMethods: [],
        declared: { [key]: true },
      });
      expect(effective[key]).toBe(false);
    }

    // A single missing prerequisite verb is enough: reusable leases needs
    // resume, release, and destroy, so resume alone does not grant it.
    const resumeOnly = resolveEffectiveSandboxCapabilities({
      verifiedMethods: ["environmentResumeLease"],
      declared: { reusableLeases: true },
    });
    expect(resumeOnly.reusableLeases).toBe(false);
  });

  it("test_reusable_provider_without_destroy_support_resolves_false", () => {
    // A provider that verifies resume and release but not destroy is not
    // eligible for reusable leases. The reuse path destroys a stale lease when a
    // resume fails, so a provider without destroy support would strand the lease.
    const resumeAndReleaseOnly = resolveEffectiveSandboxCapabilities({
      verifiedMethods: ["environmentResumeLease", "environmentReleaseLease"],
      declared: { reusableLeases: true },
    });
    expect(resumeAndReleaseOnly.reusableLeases).toBe(false);

    // Adding the destroy verb makes the same provider eligible.
    const allReuseVerbs = resolveEffectiveSandboxCapabilities({
      verifiedMethods: [
        "environmentResumeLease",
        "environmentReleaseLease",
        "environmentDestroyLease",
      ],
      declared: { reusableLeases: true },
    });
    expect(allReuseVerbs.reusableLeases).toBe(true);
  });

  it("test_unknown_or_unavailable_verification_resolves_false", () => {
    const declaredAll = {
      reusableLeases: true,
      nativeSyncIn: true,
      nativeSyncOut: true,
      persistentProcessSessions: true,
      independentControlCommands: true,
    };

    for (const verifiedMethods of [null, undefined, [] as string[]]) {
      const effective = resolveEffectiveSandboxCapabilities({ verifiedMethods, declared: declaredAll });
      for (const key of SANDBOX_CAPABILITY_KEYS) {
        expect(effective[key]).toBe(false);
      }
    }
  });
});
