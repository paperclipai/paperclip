import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT,
  SANDBOX_CAPABILITY_KEYS,
  buildSandboxCapabilityNarrowing,
  builtinSandboxProviderVerifiedMethods,
  classifyEnvironmentCapabilities,
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

describe("environment capability contract normalizer", () => {
  it("test_absent_declaration_defers_to_worker_supported_methods_discovery", () => {
    // No declaration at all. The effective set must fall back to what the worker
    // verified, so a third-party provider that implements the sync hooks keeps
    // native sync without declaring it.
    const effective = classifyEnvironmentCapabilities({
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
    const effective = classifyEnvironmentCapabilities({ verifiedMethods, declared });

    // Verified + declared true.
    expect(effective.persistentProcessSessions).toBe(true);
    // Declared false, so removed even though verified.
    expect(effective.independentControlCommands).toBe(false);
    // Declared true but not verified, so removed.
    expect(effective.nativeSyncIn).toBe(false);

    // Every effective capability must be a subset of the verified set and the
    // declaration: an effective `true` never appears where the worker did not
    // verify or the declaration set `false`.
    const verifiedOnly = classifyEnvironmentCapabilities({ verifiedMethods });
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
    });
    const effective = classifyEnvironmentCapabilities({
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
    });
    expect(flaggedNarrowing.nativeSyncIn).toBe(false);
    expect(flaggedNarrowing.nativeSyncOut).toBe(false);
  });

  it("test_persistent_process_sessions_follow_the_verified_and_declared_capability", () => {
    // Session-output streaming now follows the capability snapshot alone, not a
    // config flag. A provider that declares and verifies persistent process
    // sessions keeps the capability when no narrowing removes it.
    const verifiedMethods = ["environmentExecute"];
    const declared = { persistentProcessSessions: true };

    const narrowing = buildSandboxCapabilityNarrowing({
      leasePolicy: "ephemeral",
      leaseMetadata: {},
    });
    // A normal lease adds no persistent-session narrowing.
    expect(narrowing.persistentProcessSessions).toBeUndefined();

    const effective = classifyEnvironmentCapabilities({
      verifiedMethods,
      declared,
      narrowing,
    });
    expect(effective.persistentProcessSessions).toBe(true);
  });

  it("test_config_resolution_failure_fails_closed_on_persistent_process_sessions", () => {
    const verifiedMethods = ["environmentExecute"];
    const declared = { persistentProcessSessions: true };

    // Config resolution failed, so the provider is untrusted. The narrowing must
    // deny persistent process sessions instead of allowing them through. Without
    // the fail-closed guard this narrowing key stays undefined and
    // `persistentProcessSessions` resolves to true.
    const narrowing = buildSandboxCapabilityNarrowing({
      leasePolicy: "ephemeral",
      leaseMetadata: {},
      configResolutionFailed: true,
    });
    expect(narrowing.persistentProcessSessions).toBe(false);

    const effective = classifyEnvironmentCapabilities({
      verifiedMethods,
      declared,
      narrowing,
    });
    expect(effective.persistentProcessSessions).toBe(false);

    // Native sync and reusable lease enforcement stay unchanged on failure.
    const syncNarrowing = buildSandboxCapabilityNarrowing({
      leasePolicy: "reuse_by_environment",
      leaseMetadata: { backend: "job" },
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
    const builtinEffective = classifyEnvironmentCapabilities({
      verifiedMethods: builtinMethods,
      declared,
    });

    // A plug-in provider that advertises the equivalent verbs.
    const pluginEffective = classifyEnvironmentCapabilities({
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
    const noExec = classifyEnvironmentCapabilities({
      verifiedMethods: builtinSandboxProviderVerifiedMethods({ supportsReusableLeases: false }),
      declared: { persistentProcessSessions: true },
    });
    expect(noExec.persistentProcessSessions).toBe(false);
  });

  it("test_present_declaration_never_grants_beyond_verified_supported_methods", () => {
    // One case per capability: the declaration sets the flag `true`, the worker
    // lacks a prerequisite verb, and the effective value stays `false`.
    for (const key of SANDBOX_CAPABILITY_KEYS) {
      const effective = classifyEnvironmentCapabilities({
        verifiedMethods: [],
        declared: { [key]: true },
      });
      expect(effective[key]).toBe(false);
    }

    // A single missing prerequisite verb is enough: reusable leases needs
    // resume, release, and destroy, so resume alone does not grant it.
    const resumeOnly = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentResumeLease"],
      declared: { reusableLeases: true },
    });
    expect(resumeOnly.reusableLeases).toBe(false);
  });

  it("test_reusable_provider_without_destroy_support_resolves_false", () => {
    // A provider that verifies resume and release but not destroy is not
    // eligible for reusable leases. The reuse path destroys a stale lease when a
    // resume fails, so a provider without destroy support would strand the lease.
    const resumeAndReleaseOnly = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentResumeLease", "environmentReleaseLease"],
      declared: { reusableLeases: true },
    });
    expect(resumeAndReleaseOnly.reusableLeases).toBe(false);

    // Adding the destroy verb makes the same provider eligible.
    const allReuseVerbs = classifyEnvironmentCapabilities({
      verifiedMethods: [
        "environmentResumeLease",
        "environmentReleaseLease",
        "environmentDestroyLease",
      ],
      declared: { reusableLeases: true },
    });
    expect(allReuseVerbs.reusableLeases).toBe(true);
  });

  it("test_generic_one_shot_provider_does_not_get_session_output_streaming", () => {
    // The regression: a generic one-shot provider (for example Modal) verifies
    // `environmentExecute` and declares the two broad session capabilities, yet
    // it never emits incremental session output. Both broad capabilities resolve
    // true, but `incrementalSessionOutput` must stay false because the provider
    // did not declare the opt-in behavior. The session-output streaming gate
    // reads `incrementalSessionOutput`, so this provider keeps the poll path.
    const effective = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentExecute"],
      declared: {
        persistentProcessSessions: true,
        independentControlCommands: true,
      },
    });

    expect(effective.persistentProcessSessions).toBe(true);
    expect(effective.independentControlCommands).toBe(true);
    // Opt-in denied: the provider did not declare incremental session output.
    expect(effective.incrementalSessionOutput).toBe(false);
  });

  it("test_incremental_session_output_is_opt_in_and_needs_a_declaration", () => {
    // An absent declaration denies the opt-in capability even when the worker
    // verifies the prerequisite verb. This differs from a worker-property
    // capability, which defers to the verified baseline.
    const undeclared = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentExecute"],
      declared: null,
    });
    expect(undeclared.incrementalSessionOutput).toBe(false);

    // A provider that declares the capability and verifies the prerequisite gets
    // the streaming path.
    const declared = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentExecute"],
      declared: { incrementalSessionOutput: true },
    });
    expect(declared.incrementalSessionOutput).toBe(true);

    // A declaration never grants the capability without the verified verb.
    const declaredButUnverified = classifyEnvironmentCapabilities({
      verifiedMethods: [],
      declared: { incrementalSessionOutput: true },
    });
    expect(declaredButUnverified.incrementalSessionOutput).toBe(false);
  });

  it("test_config_resolution_failure_fails_closed_on_incremental_session_output", () => {
    // Config resolution failed, so the provider is untrusted. The narrowing must
    // deny incremental session output even with a positive declaration, so the
    // session-output streaming gate fails closed to the poll path.
    const narrowing = buildSandboxCapabilityNarrowing({
      leasePolicy: "ephemeral",
      leaseMetadata: {},
      configResolutionFailed: true,
    });
    expect(narrowing.incrementalSessionOutput).toBe(false);

    const effective = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentExecute"],
      declared: { incrementalSessionOutput: true },
      narrowing,
    });
    expect(effective.incrementalSessionOutput).toBe(false);
  });

  it("test_concurrent_sync_operations_is_opt_in_and_needs_both_sync_verbs", () => {
    // Parallel bidirectional file sync is opt-in and direction-neutral. It needs
    // both sync verbs, so a provider that verifies only one direction cannot get
    // the capability. An absent declaration denies it even with both verbs.
    const undeclared = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentSyncIn", "environmentSyncOut"],
      declared: null,
    });
    expect(undeclared.concurrentSyncOperations).toBe(false);

    // A positive declaration with both verified verbs resolves true.
    const bothVerbs = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentSyncIn", "environmentSyncOut"],
      declared: { concurrentSyncOperations: true },
    });
    expect(bothVerbs.concurrentSyncOperations).toBe(true);

    // Only the inbound verb: the outbound prerequisite is missing, so it resolves
    // false.
    const inOnly = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentSyncIn"],
      declared: { concurrentSyncOperations: true },
    });
    expect(inOnly.concurrentSyncOperations).toBe(false);

    // Only the outbound verb: the inbound prerequisite is missing, so it resolves
    // false.
    const outOnly = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentSyncOut"],
      declared: { concurrentSyncOperations: true },
    });
    expect(outOnly.concurrentSyncOperations).toBe(false);
  });

  it("test_duplex_command_stream_absent_declaration_resolves_false", () => {
    // The duplex channel is opt-in and fail-closed. An absent declaration denies
    // the capability even when the worker verifies the duplex open verb. This
    // matches the incremental-session-output pattern: an opt-in behavioral
    // guarantee needs a positive declaration, not just a verified verb.
    const undeclared = classifyEnvironmentCapabilities({
      verifiedMethods: ["duplexChannelOpen"],
      declared: null,
    });
    expect(undeclared.duplexCommandStream).toBe(false);
  });

  it("test_duplex_command_stream_needs_verified_worker_method", () => {
    // A declaration never grants the capability without the verified duplex open
    // verb. A provider that declares the capability but whose worker does not
    // report the duplex open method resolves false.
    const declaredButUnverified = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentExecute"],
      declared: { duplexCommandStream: true },
    });
    expect(declaredButUnverified.duplexCommandStream).toBe(false);
  });

  it("test_duplex_command_stream_declared_and_verified_resolves_true_but_narrowing_removes_it", () => {
    // A provider that declares the capability and whose worker verifies the
    // duplex open verb gets the capability.
    const granted = classifyEnvironmentCapabilities({
      verifiedMethods: ["duplexChannelOpen"],
      declared: { duplexCommandStream: true },
    });
    expect(granted.duplexCommandStream).toBe(true);

    // Per-target narrowing still removes a verified and declared capability, so a
    // lease that cannot use the duplex channel keeps the file bridge.
    const narrowed = classifyEnvironmentCapabilities({
      verifiedMethods: ["duplexChannelOpen"],
      declared: { duplexCommandStream: true },
      narrowing: { duplexCommandStream: false },
    });
    expect(narrowed.duplexCommandStream).toBe(false);
  });

  it("test_unknown_or_unavailable_verification_resolves_false", () => {
    const declaredAll = {
      reusableLeases: true,
      nativeSyncIn: true,
      nativeSyncOut: true,
      persistentProcessSessions: true,
      independentControlCommands: true,
      incrementalSessionOutput: true,
      concurrentSyncOperations: true,
    };

    for (const verifiedMethods of [null, undefined, [] as string[]]) {
      const effective = classifyEnvironmentCapabilities({ verifiedMethods, declared: declaredAll });
      for (const key of SANDBOX_CAPABILITY_KEYS) {
        expect(effective[key]).toBe(false);
      }
    }
  });
});

describe("general runtime capability resolver — four-driver matrix", () => {
  // A declaration that would grant every capability, paired with a worker
  // method list that verifies every prerequisite. Used to probe each driver's
  // static support ceiling: whatever the driver family cannot support must
  // stay `false` even under the most permissive declaration and worker.
  const DECLARE_ALL = {
    reusableLeases: true,
    nativeSyncIn: true,
    nativeSyncOut: true,
    persistentProcessSessions: true,
    independentControlCommands: true,
    incrementalSessionOutput: true,
    concurrentSyncOperations: true,
    duplexCommandStream: true,
  };
  const VERIFY_ALL = [...ALL_PLUGIN_METHODS, "duplexChannelOpen"];

  it("test_local_and_ssh_drivers_support_no_capability_regardless_of_declaration_or_worker", () => {
    // The `local` and `ssh` static support definitions name none of the
    // capabilities, so the classifier resolves every field `false` even with a
    // full declaration and a fully verified worker.
    for (const driver of ["local", "ssh"] as const) {
      const effective = classifyEnvironmentCapabilities({
        verifiedMethods: VERIFY_ALL,
        declared: DECLARE_ALL,
        supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT[driver].supportedCapabilities,
      });
      for (const key of SANDBOX_CAPABILITY_KEYS) {
        expect(effective[key]).toBe(false);
      }
    }
  });

  it("test_sandbox_and_plugin_drivers_support_the_whole_capability_set", () => {
    // The `sandbox` and `plugin` static support definitions name every
    // capability, so the classifier defers fully to the declaration, the
    // verified worker methods, and the narrowing — the static gate adds no
    // extra restriction for either driver.
    for (const driver of ["sandbox", "plugin"] as const) {
      const effective = classifyEnvironmentCapabilities({
        verifiedMethods: VERIFY_ALL,
        declared: DECLARE_ALL,
        supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT[driver].supportedCapabilities,
      });
      for (const key of SANDBOX_CAPABILITY_KEYS) {
        expect(effective[key]).toBe(true);
      }
      // The static gate changes nothing versus the ungated normalizer for
      // these two drivers, so the two results match field for field.
      expect(effective).toEqual(
        classifyEnvironmentCapabilities({ verifiedMethods: VERIFY_ALL, declared: DECLARE_ALL }),
      );
    }
  });

  it("test_sandbox_and_plugin_drivers_fail_closed_on_a_missing_worker_method_list", () => {
    // A missing, undefined, or empty worker method list verifies no
    // prerequisite, so every capability resolves `false` for a driver that
    // supports the whole set, even under a full declaration. This is the
    // fail-closed contract Phase 2 must keep for the live plugin worker path.
    for (const driver of ["sandbox", "plugin"] as const) {
      for (const verifiedMethods of [null, undefined, [] as string[]]) {
        const effective = classifyEnvironmentCapabilities({
          verifiedMethods,
          declared: DECLARE_ALL,
          supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT[driver].supportedCapabilities,
        });
        for (const key of SANDBOX_CAPABILITY_KEYS) {
          expect(effective[key]).toBe(false);
        }
      }
    }
  });

  it("test_narrowing_still_removes_a_capability_the_static_support_and_declaration_both_grant", () => {
    // Per-target narrowing stays a separate, later gate: it removes a
    // capability that the static support, the verified worker, and the
    // declaration all grant. This holds for every driver whose static support
    // names the capability.
    for (const driver of ["sandbox", "plugin"] as const) {
      const effective = classifyEnvironmentCapabilities({
        verifiedMethods: VERIFY_ALL,
        declared: DECLARE_ALL,
        narrowing: { duplexCommandStream: false },
        supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT[driver].supportedCapabilities,
      });
      expect(effective.duplexCommandStream).toBe(false);
      // A capability the narrowing does not name is unaffected.
      expect(effective.persistentProcessSessions).toBe(true);
    }
  });
});
