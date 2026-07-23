import { describe, expect, it, vi } from "vitest";
import {
  createDatabaseBackupCoordinator,
  startDatabaseBackupScheduler,
} from "../services/database-backup-scheduler.js";

describe("database backup startup scheduling", () => {
  it("queues one startup backup and preserves the configured interval", async () => {
    let startupCallback: (() => void) | undefined;
    let intervalCallback: (() => void) | undefined;
    const run = vi.fn().mockResolvedValue(undefined);

    startDatabaseBackupScheduler({
      intervalMs: 60 * 60 * 1000,
      run,
      queueStartup: (callback) => {
        startupCallback = callback;
      },
      setInterval: (callback, intervalMs) => {
        intervalCallback = callback;
        expect(intervalMs).toBe(60 * 60 * 1000);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
    });

    expect(run).not.toHaveBeenCalled();
    startupCallback?.();
    await Promise.resolve();
    expect(run).toHaveBeenNthCalledWith(1, "startup");

    intervalCallback?.();
    await Promise.resolve();
    expect(run).toHaveBeenNthCalledWith(2, "scheduled");
  });

  it("keeps interval scheduling alive when the startup backup fails", async () => {
    let startupCallback: (() => void) | undefined;
    let intervalCallback: (() => void) | undefined;
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("pg_dump failed"))
      .mockResolvedValueOnce(undefined);

    startDatabaseBackupScheduler({
      intervalMs: 1000,
      run,
      queueStartup: (callback) => {
        startupCallback = callback;
      },
      setInterval: (callback) => {
        intervalCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
    });

    startupCallback?.();
    await Promise.resolve();
    await Promise.resolve();
    intervalCallback?.();
    await Promise.resolve();

    expect(run.mock.calls).toEqual([["startup"], ["scheduled"]]);
  });
});

describe("database backup overlap protection", () => {
  it("skips automated overlap and rejects manual overlap", async () => {
    let release!: () => void;
    const execute = vi.fn(() => new Promise<string>((resolve) => {
      release = () => resolve("complete");
    }));
    const onAutomatedOverlap = vi.fn();
    const coordinator = createDatabaseBackupCoordinator({ execute, onAutomatedOverlap });

    const startup = coordinator.run("startup");
    await expect(coordinator.run("scheduled")).resolves.toBeNull();
    await expect(coordinator.run("manual")).rejects.toMatchObject({ status: 409 });
    expect(onAutomatedOverlap).toHaveBeenCalledWith("scheduled");
    expect(execute).toHaveBeenCalledTimes(1);

    release();
    await expect(startup).resolves.toBe("complete");
  });

  it("releases the overlap guard after a failed backup", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("pg_dump failed"))
      .mockResolvedValueOnce("recovered");
    const coordinator = createDatabaseBackupCoordinator({
      execute,
      onAutomatedOverlap: vi.fn(),
    });

    await expect(coordinator.run("startup")).rejects.toThrow("pg_dump failed");
    await expect(coordinator.run("scheduled")).resolves.toBe("recovered");
  });
});
