import { promises as fs } from "node:fs";
import path from "node:path";
import { STORAGE_PROVIDERS, type StorageProvider } from "@paperclipai/shared";
import type { PaperclipConfig } from "../config/schema.js";
import {
  resolveDefaultBackupDir,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
  resolvePaperclipInstanceRoot,
} from "../config/home.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";
import type { CheckResult } from "./index.js";

const CHECK_NAME = "Disk space";
const FIVE_GIB = 5n * 1024n ** 3n;
const POSTGRES_WRITE_FLOOR = 512n * 1024n ** 2n;
const LABEL_ORDER = ["data", "storage", "logs", "backups", "instance"] as const;
const REPAIR_HINT =
  "Free disk space on the affected volume, or move the backup directory with `paperclipai configure --section database`";

export type DiskSpaceStatFs = {
  bavail: bigint | number;
  blocks: bigint | number;
  bsize: bigint | number;
};

export type DiskSpaceStat = {
  dev: bigint | number;
};

export type DiskSpaceCheckDeps = {
  statfs?: (target: string, opts: { bigint: true }) => Promise<DiskSpaceStatFs>;
  stat?: (target: string) => Promise<DiskSpaceStat>;
};

type TrackedPath = {
  label: string;
  configuredPath: string;
};

type VolumeReport = {
  mount: string;
  free: bigint;
  total: bigint;
  labels: string[];
  warn: boolean;
  threshold: bigint;
  thresholdReason: string;
  postgresRisk: boolean;
};

function toBigInt(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(bytes: bigint): string {
  const units: Array<{ size: bigint; name: string }> = [
    { size: 1024n ** 4n, name: "TiB" },
    { size: 1024n ** 3n, name: "GiB" },
    { size: 1024n ** 2n, name: "MiB" },
    { size: 1024n, name: "KiB" },
  ];
  for (const unit of units) {
    if (bytes >= unit.size) {
      const tenths = (bytes * 10n) / unit.size;
      return `${tenths / 10n}.${tenths % 10n} ${unit.name}`;
    }
  }
  return `${bytes} B`;
}

function percentFree(free: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  const rounded = Number((free * 100n + total / 2n) / total);
  return Math.min(100, Math.max(0, rounded));
}

function warnThreshold(total: bigint): { threshold: bigint; reason: string } {
  const tenPercent = total / 10n;
  if (tenPercent < FIVE_GIB) {
    return { threshold: tenPercent, reason: "10% of volume size" };
  }
  return { threshold: FIVE_GIB, reason: "5 GiB" };
}

function sortLabels(labels: string[]): string[] {
  const unique = [...new Set(labels)];
  return unique.sort((a, b) => {
    const ai = LABEL_ORDER.indexOf(a as (typeof LABEL_ORDER)[number]);
    const bi = LABEL_ORDER.indexOf(b as (typeof LABEL_ORDER)[number]);
    return (ai === -1 ? LABEL_ORDER.length : ai) - (bi === -1 ? LABEL_ORDER.length : bi);
  });
}

function effectiveStorageProvider(config: PaperclipConfig): StorageProvider {
  const selected = process.env.PAPERCLIP_STORAGE_PROVIDER;
  if (selected && STORAGE_PROVIDERS.includes(selected as StorageProvider)) {
    return selected as StorageProvider;
  }
  return config.storage?.provider ?? "local_disk";
}

function effectiveStorageLocalDir(config: PaperclipConfig): string {
  return resolveHomeAwarePath(
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR ??
      config.storage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
}

function effectiveBackupDir(config: PaperclipConfig): string {
  return resolveHomeAwarePath(
    process.env.PAPERCLIP_DB_BACKUP_DIR ??
      config.database?.backup?.dir ??
      resolveDefaultBackupDir(),
  );
}

function collectTrackedPaths(config: PaperclipConfig, configPath?: string): TrackedPath[] {
  const tracked: TrackedPath[] = [];
  if (config.database?.mode === "embedded-postgres" && config.database.embeddedPostgresDataDir) {
    tracked.push({
      label: "data",
      configuredPath: resolveHomeAwarePath(config.database.embeddedPostgresDataDir),
    });
  }
  if (effectiveStorageProvider(config) === "local_disk") {
    tracked.push({
      label: "storage",
      configuredPath: effectiveStorageLocalDir(config),
    });
  }
  if (config.logging?.logDir) {
    tracked.push({
      label: "logs",
      configuredPath: resolveRuntimeLikePath(config.logging.logDir, configPath),
    });
  }
  tracked.push({
    label: "backups",
    configuredPath: effectiveBackupDir(config),
  });
  tracked.push({
    label: "instance",
    configuredPath: resolvePaperclipInstanceRoot(),
  });
  return tracked;
}

async function nearestExisting(
  start: string,
  stat: NonNullable<DiskSpaceCheckDeps["stat"]>,
): Promise<string> {
  let current = path.resolve(start);
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

async function resolveMountPoint(
  start: string,
  dev: bigint | number,
  stat: NonNullable<DiskSpaceCheckDeps["stat"]>,
): Promise<string> {
  let current = path.resolve(start);
  const devKey = String(dev);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    try {
      const parentStat = await stat(parent);
      if (String(parentStat.dev) !== devKey) return current;
      current = parent;
    } catch {
      return current;
    }
  }
}

function formatPass(volume: VolumeReport): string {
  const labels = sortLabels(volume.labels).join(", ");
  return `${formatBytes(volume.free)} free (${percentFree(volume.free, volume.total)}%) on ${volume.mount} for ${labels}`;
}

function formatWarn(volume: VolumeReport): string {
  const labels = sortLabels(volume.labels).join(", ");
  let text =
    `${formatBytes(volume.free)} free (${percentFree(volume.free, volume.total)}%) on ${volume.mount} (${labels}). ` +
    `Less than ${formatBytes(volume.threshold)} free (${volume.thresholdReason}).`;
  if (volume.postgresRisk) {
    text += " embedded Postgres may stop accepting writes";
  }
  return text;
}

function warnResult(message: string): CheckResult {
  return {
    name: CHECK_NAME,
    status: "warn",
    message,
    canRepair: false,
    repairHint: REPAIR_HINT,
  };
}

export async function diskSpaceCheck(
  config: PaperclipConfig,
  configPath?: string,
  deps: DiskSpaceCheckDeps = {},
): Promise<CheckResult> {
  try {
    const statfs = deps.statfs ?? ((target, opts) => fs.statfs(target, opts));
    const stat = deps.stat ?? ((target) => fs.stat(target));
    if (typeof statfs !== "function") {
      return warnResult("Disk space could not be measured because statfs is not available on this platform");
    }

    const errors: string[] = [];
    const measured: Array<{
      label: string;
      measuredPath: string;
      dev: bigint | number;
      free: bigint;
      total: bigint;
    }> = [];

    for (const target of collectTrackedPaths(config, configPath)) {
      try {
        const measuredPath = await nearestExisting(target.configuredPath, stat);
        const [fileStat, fsStat] = await Promise.all([
          stat(measuredPath),
          statfs(measuredPath, { bigint: true }),
        ]);
        const bsize = toBigInt(fsStat.bsize);
        measured.push({
          label: target.label,
          measuredPath,
          dev: fileStat.dev,
          free: toBigInt(fsStat.bavail) * bsize,
          total: toBigInt(fsStat.blocks) * bsize,
        });
      } catch (err) {
        errors.push(`Could not measure ${target.label} at ${target.configuredPath}: ${errorText(err)}`);
      }
    }

    const groups = new Map<string, typeof measured>();
    for (const item of measured) {
      const key = String(item.dev);
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }

    const volumes: VolumeReport[] = [];
    for (const group of groups.values()) {
      const shortest = group.reduce((best, item) =>
        item.measuredPath.length < best.measuredPath.length ? item : best,
      );
      const mount = await resolveMountPoint(shortest.measuredPath, shortest.dev, stat);
      const { threshold, reason } = warnThreshold(shortest.total);
      volumes.push({
        mount,
        free: shortest.free,
        total: shortest.total,
        labels: group.map((item) => item.label),
        warn: shortest.free < threshold,
        threshold,
        thresholdReason: reason,
        postgresRisk: shortest.free < POSTGRES_WRITE_FLOOR,
      });
    }

    if (volumes.length === 0) {
      return warnResult(
        errors.length > 0
          ? errors.join("; ")
          : "Disk space could not be measured",
      );
    }

    const warnVolumes = volumes.filter((volume) => volume.warn);
    const passVolumes = volumes.filter((volume) => !volume.warn);
    const parts = [
      ...errors,
      ...warnVolumes.map(formatWarn),
      ...passVolumes.map(formatPass),
    ];
    const message = parts.join("; ");
    if (warnVolumes.length > 0 || errors.length > 0) {
      return warnResult(message);
    }
    return {
      name: CHECK_NAME,
      status: "pass",
      message,
    };
  } catch (err) {
    return warnResult(`Disk space could not be measured: ${errorText(err)}`);
  }
}
