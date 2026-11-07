import { currentProcessSpaceHash } from "../controller-process-identity.js";
import { describe, expect, it, vi } from "vitest";

import {
  classifyNativeRunnerRecoveryEvidence,
  evaluateNativeControllerTakeover,
  evaluateNativeProviderProcesses,
  nextNativeProviderAttempt,
  proveNativeLocalRunnerStopped,
} from "./native-restart-recovery.js";

describe("local runner stop proof", () => {
  const startedAt = new Date("2026-11-06T17:58:54.000Z");
  const base = { processPid: 72454, processGroupId: 72454, processStartedAt: startedAt };
  const probe = (alive: number[], starts: Record<number, Date | null>, groups: number[] = []) => ({
    isProcessAlive: (pid: number) => alive.includes(pid),
    isProcessGroupAlive: (group: number) => groups.includes(group),
    readProcessStartedAt: async (pid: number) => starts[pid] ?? null,
  });

  it.each([
    ["the runner and its group exited", base, probe([], {}), { stopped: true }],
    ["the runner PID now belongs to another process", base,
      probe([72454], { 72454: new Date(startedAt.getTime() + 60_000) }), { stopped: true }],
    ["the recorded runner is alive", base, probe([72454], { 72454: startedAt }),
      { stopped: false, reason: "runner_process_alive" }],
    ["the live PID start time is unknown", base, probe([72454], {}),
      { stopped: false, reason: "runner_process_identity_unverifiable" }],
    ["the runner group is alive", base, probe([], {}, [72454]),
      { stopped: false, reason: "runner_process_group_alive" }],
    ["no runner PID was recorded", { ...base, processPid: null }, probe([], {}),
      { stopped: false, reason: "runner_process_identity_missing" }],
    ["no runner start time was recorded", { ...base, processStartedAt: null }, probe([], {}),
      { stopped: false, reason: "runner_process_identity_missing" }],
    ["no runner process group was recorded", { ...base, processGroupId: null }, probe([], {}),
      { stopped: false, reason: "runner_process_identity_missing" }],
    ["a stop receipt proved the runner absent", { ...base, processStartedAt: null, runnerStopRecorded: true },
      probe([], {}), { stopped: true }],
  ] as const)("decides when %s", async (_case, identity, checks, expected) => {
    await expect(proveNativeLocalRunnerStopped({ ...identity, ...checks })).resolves.toEqual(expected);
  });

  it("refuses while a recorded provider process is alive", async () => {
    const providerStartedAt = new Date("2026-11-06T17:58:56.000Z");
    await expect(proveNativeLocalRunnerStopped({ ...base,
      providerProcesses: [{ pid: 72460, processStartedAt: providerStartedAt }],
      ...probe([72460], { 72460: providerStartedAt }) })).resolves.toEqual({ stopped: false, reason: "provider_process_alive" });
  });
});

describe("native restart recovery classification", () => {
  it.each([false, true])("recognizes verified staged remote evidence with target snapshot=%s", hasCheckpoint => {
    const evidence = { remoteSandbox: true, runnerPidAlive: false, runnerGroupAlive: false,
      processStartMatches: false, hasCheckpoint, hasProviderEvidence: false };
    expect(classifyNativeRunnerRecoveryEvidence(evidence).claimKind).toBeNull();
    expect(classifyNativeRunnerRecoveryEvidence({ ...evidence, stagedAttachmentVerified: true })).toEqual({
      claimKind: "reattach_remote_runner", reason: "staged_remote_attachment_requires_sandbox_verification",
    });
    expect(classifyNativeRunnerRecoveryEvidence({ ...evidence, stagedAttachmentVerified: true,
      checkpointFailed: true }).claimKind).toBeNull();
    expect(classifyNativeRunnerRecoveryEvidence({ ...evidence, remoteSandbox: false,
      stagedAttachmentVerified: true }).claimKind).toBe(hasCheckpoint ? null : "bootstrap_incomplete");
  });
  it.each([true, false])("uses the remote fenced lease instead of the old container PID (live=%s)", async live => {
    const now = new Date();
    const probe = vi.fn(() => { throw new Error("must not probe another container's PID"); });
    const result = await evaluateNativeControllerTakeover({ now, remoteLeaseFenced: true,
      owner: { leaseOwner: "old-controller", leaseExpiresAt: new Date(now.getTime() + (live ? 1000 : -1000)),
        controllerPid: process.pid, controllerProcessStartedAt: now }, isProcessAlive: probe });
    expect(result.allowed).toBe(!live);
    expect(probe).not.toHaveBeenCalled();
  });
  it("does not reopen a failed checkpoint or reset an exhausted provider budget", () => {
    const evidence = {
      runnerPidAlive: false,
      runnerGroupAlive: false,
      processStartMatches: false,
      hasCheckpoint: true,
      hasProviderEvidence: true,
    };
    expect(
      classifyNativeRunnerRecoveryEvidence({
        ...evidence,
        checkpointFailed: true,
      }),
    ).toMatchObject({
      claimKind: null,
      reason: "provider_checkpoint_permanently_failed",
    });
    expect(
      classifyNativeRunnerRecoveryEvidence({ ...evidence, providerAttempt: 3 }),
    ).toMatchObject({
      claimKind: null,
      reason: "execution_recovery_budget_exhausted",
    });
  });
  it("keeps controller-only recovery out of the provider retry budget", () => {
    expect(nextNativeProviderAttempt(2, "reattach_existing_runner")).toBe(2);
    expect(nextNativeProviderAttempt(2, "reattach_remote_runner")).toBe(2);
    expect(nextNativeProviderAttempt(2, "bootstrap_incomplete")).toBe(3);
    expect(nextNativeProviderAttempt(2, "resume_dead_runner")).toBe(3);
  });

  it("verifies remote ownership in the sandbox instead of interpreting its PIDs locally", () => {
    const evidence = {
      remoteSandbox: true,
      runnerPidAlive: true,
      runnerGroupAlive: true,
      processStartMatches: false,
      knownProviderProcessAlive: true,
      knownProviderProcessIdentityAmbiguous: true,
      hasCheckpoint: true,
      checkpointIdentityMatches: true,
      hasProviderEvidence: true,
      providerAttempt: 3,
    };
    expect(classifyNativeRunnerRecoveryEvidence(evidence).claimKind).toBe(
      "reattach_remote_runner",
    );
    expect(
      classifyNativeRunnerRecoveryEvidence({
        ...evidence,
        checkpointIdentityMatches: false,
      }).claimKind,
    ).toBeNull();
    expect(
      classifyNativeRunnerRecoveryEvidence({
        ...evidence,
        checkpointFailed: true,
      }).claimKind,
    ).toBeNull();
    expect(
      classifyNativeRunnerRecoveryEvidence({
        ...evidence,
        hasCheckpoint: false,
      }).claimKind,
    ).toBeNull();
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

  it.each([
    ["another host", "another-host-pid-space"],
    ["an unreadable PID space", "unknown"],
  ])("never treats a dead or recycled local PID as proof for a controller on %s", async (_name, controllerHostHash) => {
    for (const probe of [{ isProcessAlive: () => false }, { isProcessAlive: () => true,
      readProcessStartedAt: async () => new Date("2026-09-04T11:30:00.000Z") }]) {
      await expect(evaluateNativeControllerTakeover({ owner: { ...owner(), controllerHostHash }, now, ...probe }))
        .resolves.toEqual({ allowed: false, reason: "controller_host_unprovable" });
    }
  });

  it("proves a controller gone only in its own recorded PID space", async () => {
    await expect(evaluateNativeControllerTakeover({ owner: { ...owner(), controllerHostHash: currentProcessSpaceHash() },
      now, isProcessAlive: () => false })).resolves.toEqual({ allowed: true, reason: "controller_process_dead" });
    // A row saved before the PID space was recorded keeps the previous local proof for one release.
    await expect(evaluateNativeControllerTakeover({ owner: { ...owner(), controllerHostHash: null },
      now, isProcessAlive: () => false })).resolves.toEqual({ allowed: true, reason: "controller_process_dead" });
  });

  it.each([true, false])("requires a stopped idle controller even after its run lease was released: alive=%s", async alive => {
    await expect(evaluateNativeControllerTakeover({
      owner: owner({ leaseOwner: null, leaseExpiresAt: null }), now, requireStoppedController: true,
      isProcessAlive: () => alive, readProcessStartedAt: async () => recordedStart,
    })).resolves.toEqual({ allowed: !alive, reason: alive ? "controller_still_alive" : "controller_process_dead" });
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

  it("does not treat a sub-second process-start precision difference as PID reuse", async () => {
    await expect(
      evaluateNativeControllerTakeover({
        owner: owner({
          controllerProcessStartedAt: new Date("2026-09-04T11:00:00.456Z"),
        }),
        now,
        isProcessAlive: () => true,
        readProcessStartedAt: async () => new Date("2026-09-04T11:00:00.000Z"),
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "controller_still_alive",
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
        readProcessStartedAt: async () => recordedStart,
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

  it("fails closed on a sub-second provider process-start precision difference", async () => {
    await expect(
      evaluateNativeProviderProcesses({
        identities: [
          {
            pid: 456,
            processStartedAt: new Date("2026-09-04T11:00:00.456Z"),
          },
        ],
        isProcessAlive: () => true,
        readProcessStartedAt: async () => new Date("2026-09-04T11:00:00.000Z"),
      }),
    ).resolves.toEqual({
      knownPids: [456],
      livePids: [],
      ambiguousLivePids: [456],
      recycledPids: [],
    });
  });
});
