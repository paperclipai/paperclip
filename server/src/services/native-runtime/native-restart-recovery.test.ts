import { describe, expect, it, vi } from "vitest";

import {
  classifyNativeRunnerRecoveryEvidence,
  evaluateNativeControllerTakeover,
  evaluateNativeProviderProcesses,
  nextNativeProviderAttempt,
} from "./native-restart-recovery.js";

describe("native restart recovery classification", () => {
  it("keeps controller-only recovery out of the provider retry budget", () => {
    expect(nextNativeProviderAttempt(2, "reattach_existing_runner")).toBe(2);
    expect(nextNativeProviderAttempt(2, "bootstrap_incomplete")).toBe(2);
    expect(nextNativeProviderAttempt(2, "resume_dead_runner")).toBe(3);
  });

  it.each([
    {
      name: "reattaches an exact live runner",
      evidence: {
        runnerPidAlive: true,
        runnerGroupAlive: true,
        processStartMatches: true,
        hasCheckpoint: true,
        hasProviderEvidence: true,
      },
      expected: "reattach_existing_runner",
    },
    {
      name: "resumes a dead checkpointed runner",
      evidence: {
        runnerPidAlive: false,
        runnerGroupAlive: false,
        processStartMatches: false,
        hasCheckpoint: true,
        hasProviderEvidence: true,
      },
      expected: "resume_dead_runner",
    },
    {
      name: "retries an incomplete bootstrap on the same run",
      evidence: {
        runnerPidAlive: false,
        runnerGroupAlive: false,
        processStartMatches: false,
        hasCheckpoint: false,
        hasProviderEvidence: false,
      },
      expected: "bootstrap_incomplete",
    },
    {
      name: "blocks a recycled live PID",
      evidence: {
        runnerPidAlive: true,
        runnerGroupAlive: true,
        processStartMatches: false,
        hasCheckpoint: true,
        hasProviderEvidence: true,
      },
      expected: null,
    },
    {
      name: "blocks ambiguous checkpoint evidence",
      evidence: {
        runnerPidAlive: false,
        runnerGroupAlive: false,
        processStartMatches: false,
        hasCheckpoint: true,
        hasProviderEvidence: false,
      },
      expected: null,
    },
    {
      name: "blocks a checkpoint bound to a different native identity",
      evidence: {
        runnerPidAlive: false,
        runnerGroupAlive: false,
        processStartMatches: false,
        hasCheckpoint: true,
        checkpointIdentityMatches: false,
        hasProviderEvidence: true,
      },
      expected: null,
    },
    {
      name: "blocks while a known provider process outlives its runner",
      evidence: {
        runnerPidAlive: false,
        runnerGroupAlive: false,
        processStartMatches: false,
        knownProviderProcessAlive: true,
        hasCheckpoint: true,
        hasProviderEvidence: true,
      },
      expected: null,
    },
    {
      name: "blocks while a live provider PID has no durable fingerprint",
      evidence: {
        runnerPidAlive: false,
        runnerGroupAlive: false,
        processStartMatches: false,
        knownProviderProcessIdentityAmbiguous: true,
        hasCheckpoint: true,
        hasProviderEvidence: true,
      },
      expected: null,
    },
  ])("$name", ({ evidence, expected }) => {
    expect(classifyNativeRunnerRecoveryEvidence(evidence).claimKind).toBe(
      expected,
    );
  });
});

describe("native controller takeover fencing", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  const recordedStart = new Date("2026-09-04T11:00:00.000Z");

  function owner(
    overrides: Partial<{
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
      controllerPid: number | null;
      controllerProcessStartedAt: Date | null;
    }> = {},
  ) {
    return {
      leaseOwner: "old-controller",
      leaseExpiresAt: new Date("2026-09-04T12:20:00.000Z"),
      controllerPid: 123,
      controllerProcessStartedAt: recordedStart,
      ...overrides,
    };
  }

  it("takes over immediately when the exact prior controller process died", async () => {
    await expect(
      evaluateNativeControllerTakeover({
        owner: owner(),
        now,
        isProcessAlive: () => false,
      }),
    ).resolves.toEqual({
      allowed: true,
      reason: "controller_process_dead",
    });
  });

  it("takes over a recycled controller PID", async () => {
    await expect(
      evaluateNativeControllerTakeover({
        owner: owner(),
        now,
        isProcessAlive: () => true,
        readProcessStartedAt: async () => new Date("2026-09-04T11:30:00.000Z"),
      }),
    ).resolves.toEqual({
      allowed: true,
      reason: "controller_pid_recycled",
    });
  });

  it("does not steal a live controller lease", async () => {
    const readStartedAt = vi.fn(async () => recordedStart);
    await expect(
      evaluateNativeControllerTakeover({
        owner: owner(),
        now,
        isProcessAlive: () => true,
        readProcessStartedAt: readStartedAt,
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "controller_still_alive",
    });
    expect(readStartedAt).toHaveBeenCalledWith(123);
  });

  it("does not let lease expiry bypass a live controller fence", async () => {
    const isProcessAlive = vi.fn(() => true);
    await expect(
      evaluateNativeControllerTakeover({
        owner: owner({
          leaseExpiresAt: new Date("2026-09-04T11:59:59.000Z"),
        }),
        now,
        isProcessAlive,
      }),
    ).resolves.toEqual({ allowed: false, reason: "controller_still_alive" });
    expect(isProcessAlive).toHaveBeenCalledWith(123);
  });

  it("takes over an expired lease after proving the controller died", async () => {
    await expect(
      evaluateNativeControllerTakeover({
        owner: owner({
          leaseExpiresAt: new Date("2026-09-04T11:59:59.000Z"),
        }),
        now,
        isProcessAlive: () => false,
      }),
    ).resolves.toEqual({
      allowed: true,
      reason: "expired_lease_controller_process_dead",
    });
  });

  it("keeps a coordinated previous controller fenced until that exact process exits", async () => {
    await expect(
      evaluateNativeControllerTakeover({
        owner: owner(),
        now,
        coordinatedPreviousController: {
          pid: 123,
          processStartedAt: recordedStart,
        },
        isProcessAlive: () => true,
        readProcessStartedAt: async () => recordedStart,
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "coordinated_controller_still_alive",
    });
  });
});

describe("native provider process fencing", () => {
  const recordedStart = new Date("2026-09-04T11:00:00.000Z");

  it("does not mistake a recycled provider PID for the old live provider", async () => {
    await expect(
      evaluateNativeProviderProcesses({
        identities: [{ pid: 456, processStartedAt: recordedStart }],
        isProcessAlive: () => true,
        readProcessStartedAt: async () => new Date("2026-09-04T11:30:00.000Z"),
      }),
    ).resolves.toEqual({
      knownPids: [456],
      livePids: [],
      ambiguousLivePids: [],
      recycledPids: [456],
    });
  });

  it("fails closed when a live provider has no comparable fingerprint", async () => {
    await expect(
      evaluateNativeProviderProcesses({
        identities: [{ pid: 456, processStartedAt: null }],
        isProcessAlive: () => true,
        readProcessStartedAt: async () => recordedStart,
      }),
    ).resolves.toMatchObject({
      livePids: [],
      ambiguousLivePids: [456],
      recycledPids: [],
    });
  });
});
