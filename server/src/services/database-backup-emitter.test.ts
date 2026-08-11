import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDatabaseBackupEmitter,
  type DatabaseBackupEmitterLease,
} from "./database-backup-emitter.js";

type TimerRecord = {
  kind: "interval" | "timeout";
  callback: () => void;
  intervalMs: number;
  cleared: boolean;
};

function createTimerHarness() {
  const records: TimerRecord[] = [];
  return {
    records,
    api: {
      setInterval(callback: () => void, intervalMs: number) {
        const record: TimerRecord = { kind: "interval", callback, intervalMs, cleared: false };
        records.push(record);
        return record;
      },
      setTimeout(callback: () => void, intervalMs: number) {
        const record: TimerRecord = { kind: "timeout", callback, intervalMs, cleared: false };
        records.push(record);
        return record;
      },
      clearInterval(handle: unknown) {
        (handle as TimerRecord).cleared = true;
      },
      clearTimeout(handle: unknown) {
        (handle as TimerRecord).cleared = true;
      },
      unref: vi.fn(),
    },
  };
}

function createLease(): DatabaseBackupEmitterLease & { lose(): void } {
  let held = true;
  let resolveLost!: () => void;
  const lost = new Promise<void>((resolve) => {
    resolveLost = resolve;
  });
  const lose = () => {
    if (!held) return;
    held = false;
    resolveLost();
  };
  return {
    lost,
    isHeld: () => held,
    lose,
    release: vi.fn(async () => {
      lose();
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDatabaseBackupEmitter", () => {
  it("allows only the elected server to emit automatic backups", async () => {
    const timers = createTimerHarness();
    const leaderLease = createLease();
    let currentTimeMs = 0;
    let claimed = false;
    const acquireLease = vi.fn(async () => {
      if (claimed) return null;
      claimed = true;
      return leaderLease;
    });
    const firstBackup = vi.fn(async () => undefined);
    const secondBackup = vi.fn(async () => undefined);
    const first = createDatabaseBackupEmitter({
      backupIntervalMs: 12_000,
      leadershipPollIntervalMs: 1_000,
      acquireLease,
      getLastSuccessfulBackupAtMs: vi.fn(async () => 0),
      now: () => currentTimeMs,
      runBackup: firstBackup,
      timers: timers.api,
    });
    const second = createDatabaseBackupEmitter({
      backupIntervalMs: 12_000,
      leadershipPollIntervalMs: 1_000,
      acquireLease,
      getLastSuccessfulBackupAtMs: vi.fn(async () => 0),
      now: () => currentTimeMs,
      runBackup: secondBackup,
      timers: timers.api,
    });

    await first.start();
    await second.start();

    expect(first.isLeader()).toBe(true);
    expect(second.isLeader()).toBe(false);
    const activeBackupTimers = timers.records.filter(
      (record) => record.intervalMs === 12_000 && !record.cleared,
    );
    expect(activeBackupTimers).toHaveLength(1);

    currentTimeMs = 12_000;
    activeBackupTimers[0]!.callback();
    await Promise.resolve();
    expect(firstBackup).toHaveBeenCalledTimes(1);
    expect(secondBackup).not.toHaveBeenCalled();

    await first.stop();
    await second.stop();
  });

  it("drops emission immediately when leadership is lost and permits failover", async () => {
    const timers = createTimerHarness();
    const firstLease = createLease();
    const replacementLease = createLease();
    let currentTimeMs = 0;
    const leases: Array<DatabaseBackupEmitterLease | null> = [firstLease, null, replacementLease];
    const acquireLease = vi.fn(async () => leases.shift() ?? null);
    const firstBackup = vi.fn(async () => undefined);
    const secondBackup = vi.fn(async () => undefined);
    const onLeadershipLost = vi.fn();
    const first = createDatabaseBackupEmitter({
      backupIntervalMs: 12_000,
      leadershipPollIntervalMs: 1_000,
      acquireLease,
      getLastSuccessfulBackupAtMs: vi.fn(async () => 0),
      now: () => currentTimeMs,
      runBackup: firstBackup,
      onLeadershipLost,
      timers: timers.api,
    });
    const second = createDatabaseBackupEmitter({
      backupIntervalMs: 12_000,
      leadershipPollIntervalMs: 1_000,
      acquireLease,
      getLastSuccessfulBackupAtMs: vi.fn(async () => 0),
      now: () => currentTimeMs,
      runBackup: secondBackup,
      timers: timers.api,
    });

    await first.start();
    await second.start();
    const firstBackupTimer = timers.records.find(
      (record) => record.intervalMs === 12_000 && !record.cleared,
    )!;

    firstLease.lose();
    await Promise.resolve();
    await Promise.resolve();

    expect(first.isLeader()).toBe(false);
    expect(firstBackupTimer.cleared).toBe(true);
    expect(onLeadershipLost).toHaveBeenCalledTimes(1);

    await second.attemptLeadership();
    expect(second.isLeader()).toBe(true);
    const replacementBackupTimer = timers.records.find(
      (record) =>
        record !== firstBackupTimer && record.intervalMs === 12_000 && !record.cleared,
    )!;
    currentTimeMs = 12_000;
    replacementBackupTimer.callback();
    await Promise.resolve();
    expect(secondBackup).toHaveBeenCalledTimes(1);
    expect(firstBackup).not.toHaveBeenCalled();

    await first.stop();
    await second.stop();
  });

  it("retries after an acquisition error and releases a late lease after stop", async () => {
    const timers = createTimerHarness();
    const lateLease = createLease();
    let resolveAcquisition!: (lease: DatabaseBackupEmitterLease) => void;
    const acquisition = new Promise<DatabaseBackupEmitterLease>((resolve) => {
      resolveAcquisition = resolve;
    });
    const onLeadershipError = vi.fn();
    const acquireLease = vi
      .fn<() => Promise<DatabaseBackupEmitterLease | null>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementationOnce(async () => acquisition);
    const emitter = createDatabaseBackupEmitter({
      backupIntervalMs: 12_000,
      leadershipPollIntervalMs: 1_000,
      acquireLease,
      getLastSuccessfulBackupAtMs: vi.fn(async () => 0),
      now: () => 0,
      runBackup: vi.fn(async () => undefined),
      onLeadershipError,
      timers: timers.api,
    });

    await emitter.start();
    expect(onLeadershipError).toHaveBeenCalledWith(expect.any(Error));

    const retry = emitter.attemptLeadership();
    const stop = emitter.stop();
    resolveAcquisition(lateLease);
    await retry;
    await stop;

    expect(emitter.isLeader()).toBe(false);
    expect(lateLease.release).toHaveBeenCalledTimes(1);
    expect(timers.records.every((record) => record.cleared)).toBe(true);
  });

  it("preserves the last-success cadence when a replacement leader takes over", async () => {
    const timers = createTimerHarness();
    const lease = createLease();
    let currentTimeMs = 10_000;
    const runBackup = vi.fn(async () => undefined);
    const emitter = createDatabaseBackupEmitter({
      backupIntervalMs: 1_000,
      leadershipPollIntervalMs: 50,
      acquireLease: vi.fn(async () => lease),
      getLastSuccessfulBackupAtMs: vi.fn(async () => 9_100),
      now: () => currentTimeMs,
      runBackup,
      timers: timers.api,
    });

    await emitter.start();

    const dueTimer = timers.records.find(
      (record) => record.kind === "timeout" && !record.cleared,
    );
    expect(dueTimer?.intervalMs).toBe(100);
    expect(runBackup).not.toHaveBeenCalled();

    currentTimeMs = 10_100;
    dueTimer!.callback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runBackup).toHaveBeenCalledTimes(1);

    await emitter.stop();
  });

  it("observes lease loss before awaiting the recovery-point lookup", async () => {
    const timers = createTimerHarness();
    const lease = createLease();
    let resolveLatest!: (value: number | null) => void;
    const latest = new Promise<number | null>((resolve) => {
      resolveLatest = resolve;
    });
    const onLeadershipAcquired = vi.fn();
    const onLeadershipLost = vi.fn();
    const emitter = createDatabaseBackupEmitter({
      backupIntervalMs: 12_000,
      leadershipPollIntervalMs: 1_000,
      acquireLease: vi.fn(async () => lease),
      getLastSuccessfulBackupAtMs: vi.fn(async () => latest),
      runBackup: vi.fn(async () => undefined),
      onLeadershipAcquired,
      onLeadershipLost,
      timers: timers.api,
    });

    const start = emitter.start();
    await Promise.resolve();
    lease.lose();
    resolveLatest(0);
    await start;
    await Promise.resolve();

    expect(emitter.isLeader()).toBe(false);
    expect(onLeadershipAcquired).not.toHaveBeenCalled();
    expect(onLeadershipLost).toHaveBeenCalledTimes(1);
    expect(
      timers.records.filter((record) => record.kind === "timeout" && !record.cleared),
    ).toHaveLength(0);

    await emitter.stop();
  });

  it("aborts active work after a bounded shutdown grace period and never waits forever", async () => {
    const timers = createTimerHarness();
    const lease = createLease();
    let receivedSignal: AbortSignal | null = null;
    const neverSettles = new Promise<void>(() => {});
    const emitter = createDatabaseBackupEmitter({
      backupIntervalMs: 1_000,
      leadershipPollIntervalMs: 50,
      backupStopGraceMs: 25,
      backupCancellationWaitMs: 10,
      acquireLease: vi.fn(async () => lease),
      getLastSuccessfulBackupAtMs: vi.fn(async () => null),
      runBackup: vi.fn(async (signal) => {
        receivedSignal = signal;
        return neverSettles;
      }),
      now: () => 1_000,
      timers: timers.api,
    });

    await emitter.start();
    const dueTimer = timers.records.find(
      (record) => record.kind === "timeout" && record.intervalMs === 0 && !record.cleared,
    );
    expect(dueTimer).toBeDefined();
    dueTimer!.callback();
    await Promise.resolve();
    expect(receivedSignal).not.toBeNull();

    let stopped = false;
    const stop = emitter.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    const graceTimer = timers.records.find(
      (record) => record.kind === "timeout" && record.intervalMs === 25 && !record.cleared,
    );
    expect(graceTimer).toBeDefined();
    graceTimer!.callback();
    await vi.waitFor(() => {
      expect(receivedSignal!.aborted).toBe(true);
    });

    let cancellationTimer: TimerRecord | undefined;
    await vi.waitFor(() => {
      cancellationTimer = timers.records.find(
        (record) => record.kind === "timeout" && record.intervalMs === 10 && !record.cleared,
      );
      expect(cancellationTimer).toBeDefined();
    });
    cancellationTimer!.callback();
    await stop;

    expect(stopped).toBe(true);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("aborts active automatic-backup work when emitter leadership is lost", async () => {
    const timers = createTimerHarness();
    const lease = createLease();
    let receivedSignal: AbortSignal | null = null;
    let rejectBackup!: (error: Error) => void;
    const backup = new Promise<void>((_, reject) => {
      rejectBackup = reject;
    });
    const runBackup = vi.fn(async (signal: AbortSignal) => {
      receivedSignal = signal;
      signal.addEventListener(
        "abort",
        () => rejectBackup(new Error("backup aborted after lease loss")),
        { once: true },
      );
      return backup;
    });
    const emitter = createDatabaseBackupEmitter({
      backupIntervalMs: 1_000,
      leadershipPollIntervalMs: 50,
      acquireLease: vi.fn(async () => lease),
      getLastSuccessfulBackupAtMs: vi.fn(async () => null),
      runBackup,
      now: () => 1_000,
      timers: timers.api,
    });

    await emitter.start();
    const dueTimer = timers.records.find(
      (record) => record.kind === "timeout" && record.intervalMs === 0 && !record.cleared,
    );
    dueTimer!.callback();
    await Promise.resolve();
    expect(receivedSignal).not.toBeNull();

    lease.lose();
    await vi.waitFor(() => {
      expect(receivedSignal!.aborted).toBe(true);
    });
    expect(emitter.isLeader()).toBe(false);

    await emitter.stop();
  });

  it("bounds shutdown when leadership acquisition never settles", async () => {
    const timers = createTimerHarness();
    const neverAcquired = new Promise<DatabaseBackupEmitterLease | null>(() => {});
    const emitter = createDatabaseBackupEmitter({
      backupIntervalMs: 1_000,
      leadershipPollIntervalMs: 50,
      electionStopWaitMs: 7,
      acquireLease: vi.fn(async () => neverAcquired),
      getLastSuccessfulBackupAtMs: vi.fn(async () => null),
      runBackup: vi.fn(async () => undefined),
      timers: timers.api,
    });

    void emitter.start();
    await Promise.resolve();
    let stopped = false;
    const stop = emitter.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    const electionDeadline = timers.records.find(
      (record) => record.kind === "timeout" && record.intervalMs === 7 && !record.cleared,
    );
    expect(electionDeadline).toBeDefined();
    electionDeadline?.callback();
    await stop;
    expect(stopped).toBe(true);
  });

  it("bounds shutdown when leadership release never settles", async () => {
    const timers = createTimerHarness();
    const lease = createLease();
    lease.release = vi.fn(async () => new Promise<void>(() => {}));
    const emitter = createDatabaseBackupEmitter({
      backupIntervalMs: 1_000,
      leadershipPollIntervalMs: 50,
      leaseReleaseWaitMs: 9,
      acquireLease: vi.fn(async () => lease),
      getLastSuccessfulBackupAtMs: vi.fn(async () => 0),
      runBackup: vi.fn(async () => undefined),
      timers: timers.api,
    });

    await emitter.start();
    let stopped = false;
    const stop = emitter.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    const releaseDeadline = timers.records.find(
      (record) => record.kind === "timeout" && record.intervalMs === 9 && !record.cleared,
    );
    expect(releaseDeadline).toBeDefined();
    releaseDeadline?.callback();
    await stop;
    expect(stopped).toBe(true);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
});
