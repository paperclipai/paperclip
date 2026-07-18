import { conflict } from "../errors.js";
import type { InstanceDatabaseBackupTrigger } from "../routes/instance-database-backups.js";

type BackupTimer = ReturnType<typeof setInterval>;

export type DatabaseBackupCoordinator<T> = {
  run(trigger: InstanceDatabaseBackupTrigger): Promise<T | null>;
};

export function createDatabaseBackupCoordinator<T>(opts: {
  execute(trigger: InstanceDatabaseBackupTrigger): Promise<T>;
  onAutomatedOverlap(trigger: Exclude<InstanceDatabaseBackupTrigger, "manual">): void;
}): DatabaseBackupCoordinator<T> {
  let inFlight = false;

  return {
    async run(trigger) {
      if (inFlight) {
        if (trigger === "manual") {
          throw conflict("Database backup already in progress");
        }
        opts.onAutomatedOverlap(trigger);
        return null;
      }

      inFlight = true;
      try {
        return await opts.execute(trigger);
      } finally {
        inFlight = false;
      }
    },
  };
}

export function startDatabaseBackupScheduler(opts: {
  intervalMs: number;
  run(trigger: Exclude<InstanceDatabaseBackupTrigger, "manual">): Promise<unknown>;
  queueStartup?: (callback: () => void) => void;
  setInterval?: (callback: () => void, intervalMs: number) => BackupTimer;
}): BackupTimer {
  const invoke = (trigger: Exclude<InstanceDatabaseBackupTrigger, "manual">) => {
    void opts.run(trigger).catch(() => {
      // The shared backup execution path records failures with full context.
    });
  };

  (opts.queueStartup ?? queueMicrotask)(() => invoke("startup"));
  return (opts.setInterval ?? setInterval)(() => invoke("scheduled"), opts.intervalMs);
}
