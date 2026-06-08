import { statfs } from "node:fs/promises";

const BYTES_PER_GIB = 1024 * 1024 * 1024;

const DEFAULT_MIN_FREE_GB = 2;
const DEFAULT_AGGRESSIVE_PRUNE_GB = 5;
const CONSECUTIVE_SKIPS_BEFORE_PAUSE = 3;

export type DiskPressureResult = {
  skip: boolean;
  aggressivePrune: boolean;
  freeGiB: number;
  minFreeGiB: number;
  aggressivePruneGiB: number;
};

export type EvaluateBackupDiskPressureOptions = {
  targetPath: string;
  minFreeGiB?: number;
  aggressivePruneGiB?: number;
  statfsImpl?: (path: string) => Promise<{ bsize: number | bigint; bavail: number | bigint }>;
};

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function readGiBEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export async function getFreeDiskSpaceGiB(
  targetPath: string,
  statfsImpl: EvaluateBackupDiskPressureOptions["statfsImpl"] = statfs,
): Promise<number> {
  const stats = await statfsImpl(targetPath);
  const bsize = toNumber(stats.bsize);
  const bavail = toNumber(stats.bavail);
  const freeBytes = bsize * bavail;
  return freeBytes / BYTES_PER_GIB;
}

export async function evaluateBackupDiskPressure(
  opts: EvaluateBackupDiskPressureOptions,
): Promise<DiskPressureResult> {
  const minFreeGiB = opts.minFreeGiB ?? readGiBEnv("PAPERCLIP_BACKUP_MIN_FREE_GB", DEFAULT_MIN_FREE_GB);
  const aggressivePruneGiB =
    opts.aggressivePruneGiB ?? readGiBEnv("PAPERCLIP_BACKUP_AGGRESSIVE_PRUNE_GB", DEFAULT_AGGRESSIVE_PRUNE_GB);
  const freeGiB = await getFreeDiskSpaceGiB(opts.targetPath, opts.statfsImpl);
  const skip = freeGiB < minFreeGiB;
  const aggressivePrune = freeGiB < aggressivePruneGiB;
  return { skip, aggressivePrune, freeGiB, minFreeGiB, aggressivePruneGiB };
}

export type ConsecutiveSkipState = {
  count: number;
  pauseLogEmitted: boolean;
};

export type RecordSkipResult = {
  count: number;
  shouldEmitPauseLog: boolean;
};

export class ConsecutiveSkipCounter {
  private state: ConsecutiveSkipState = { count: 0, pauseLogEmitted: false };

  recordSkip(): RecordSkipResult {
    this.state.count += 1;
    const reachedThreshold = this.state.count >= CONSECUTIVE_SKIPS_BEFORE_PAUSE;
    const shouldEmitPauseLog = reachedThreshold && !this.state.pauseLogEmitted;
    if (shouldEmitPauseLog) {
      this.state.pauseLogEmitted = true;
    }
    return { count: this.state.count, shouldEmitPauseLog };
  }

  recordSuccess(): void {
    this.state = { count: 0, pauseLogEmitted: false };
  }

  snapshot(): ConsecutiveSkipState {
    return { ...this.state };
  }
}
