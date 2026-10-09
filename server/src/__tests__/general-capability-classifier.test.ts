import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT,
  SANDBOX_CAPABILITY_KEYS,
  classifyEnvironmentCapabilities,
} from "../services/environment-runtime.js";

// The worker verbs a fully-capable provider advertises. A built-in driver maps
// its own methods onto these verb names, so the general classifier reads one
// verb vocabulary for every driver.
const ALL_PROVIDER_METHODS = [
  "environmentResumeLease",
  "environmentReleaseLease",
  "environmentDestroyLease",
  "environmentExecute",
  "environmentSyncIn",
  "environmentSyncOut",
  "duplexChannelOpen",
  "environmentRunnerIngressEndpoint",
];

describe("general capability classifier", () => {
  it("returns every Boolean field for a full sandbox declaration input", () => {
    // A sandbox provider that verifies every prerequisite verb and declares every
    // capability resolves the whole eight-field set to true. The classifier reads
    // the sandbox driver's static support definition, so it names no driver.
    const effective = classifyEnvironmentCapabilities({
      verifiedMethods: ALL_PROVIDER_METHODS,
      declared: {
        reusableLeases: true,
        nativeSyncIn: true,
        nativeSyncOut: true,
        persistentProcessSessions: true,
        independentControlCommands: true,
        incrementalSessionOutput: true,
        concurrentSyncOperations: true,
        duplexCommandStream: true,
        runnerWebSocketIngress: true,
      },
      supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT.sandbox.supportedCapabilities,
    });

    // The result carries exactly the eight capability fields, each a Boolean.
    expect(Object.keys(effective).sort()).toEqual([...SANDBOX_CAPABILITY_KEYS].sort());
    for (const key of SANDBOX_CAPABILITY_KEYS) {
      expect(typeof effective[key]).toBe("boolean");
      expect(effective[key]).toBe(true);
    }
  });

  it("default rule one: an absent declaration defers to verification for a worker-property field", () => {
    // A worker-property capability has no opt-in declaration. An absent
    // declaration defers to the verified baseline, so a verified verb grants the
    // capability and an unverified verb denies it.
    const effective = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentSyncIn", "environmentSyncOut"],
      declared: null,
      supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT.sandbox.supportedCapabilities,
    });

    // Verified sync verbs grant native sync without any declaration.
    expect(effective.nativeSyncIn).toBe(true);
    expect(effective.nativeSyncOut).toBe(true);
    // The worker did not verify the execute or reuse verbs, so the baseline denies
    // the matching worker-property capabilities.
    expect(effective.persistentProcessSessions).toBe(false);
    expect(effective.independentControlCommands).toBe(false);
    expect(effective.reusableLeases).toBe(false);
  });

  it("default rule two: opt-in fields deny by default without a declaration", () => {
    // The opt-in fields are behavioral guarantees. An absent declaration denies
    // them even when the worker verifies the prerequisite verb.
    const effective = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentExecute", "environmentSyncIn", "environmentSyncOut", "duplexChannelOpen"],
      declared: null,
      supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT.sandbox.supportedCapabilities,
    });

    expect(effective.incrementalSessionOutput).toBe(false);
    expect(effective.concurrentSyncOperations).toBe(false);
    expect(effective.duplexCommandStream).toBe(false);
  });

  it("a built-in driver static definition denies every capability it does not support", () => {
    // The local and SSH drivers run no provider capability model, so their static
    // support definition names no capability. Every capability resolves false even
    // with every verb verified and every capability declared.
    for (const driver of ["local", "ssh"] as const) {
      const effective = classifyEnvironmentCapabilities({
        verifiedMethods: ALL_PROVIDER_METHODS,
        declared: {
          reusableLeases: true,
          nativeSyncIn: true,
          nativeSyncOut: true,
          persistentProcessSessions: true,
          independentControlCommands: true,
          incrementalSessionOutput: true,
          concurrentSyncOperations: true,
          duplexCommandStream: true,
          runnerWebSocketIngress: true,
        },
        supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT[driver].supportedCapabilities,
      });
      for (const key of SANDBOX_CAPABILITY_KEYS) {
        expect(effective[key]).toBe(false);
      }
    }
  });

  it("defines static capability support for the four drivers", () => {
    expect(Object.keys(ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT).sort()).toEqual([
      "local",
      "plugin",
      "sandbox",
      "ssh",
    ]);
    // The two remote provider drivers support the whole capability set; the two
    // host drivers support none.
    expect(ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT.sandbox.supportedCapabilities.size).toBe(
      SANDBOX_CAPABILITY_KEYS.length,
    );
    expect(ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT.plugin.supportedCapabilities.size).toBe(
      SANDBOX_CAPABILITY_KEYS.length,
    );
    expect(ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT.local.supportedCapabilities.size).toBe(0);
    expect(ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT.ssh.supportedCapabilities.size).toBe(0);
  });
});
