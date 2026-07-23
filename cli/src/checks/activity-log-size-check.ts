import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { openDoctorDb } from "./db-connect.js";

export const ACTIVITY_LOG_WARN_BYTES = 1024 ** 3;

const ACTIVITY_LOG_SIZE_QUERY = `
  SELECT COALESCE(pg_total_relation_size(to_regclass('public.activity_log')), 0)::text AS total_bytes
`;

type ActivityLogSizeCheckOptions = {
  maxBytes?: number;
  openDb?: typeof openDoctorDb;
};

type ActivityLogSizeRow = {
  total_bytes: string | number;
};

export async function activityLogSizeCheck(
  config: PaperclipConfig,
  configPath?: string,
  opts: ActivityLogSizeCheckOptions = {},
): Promise<CheckResult> {
  let db;
  try {
    ({ db } = await (opts.openDb ?? openDoctorDb)(config, configPath));
  } catch {
    return skippedResult();
  }

  let rows: ActivityLogSizeRow[];
  try {
    rows = Array.from(await db.execute(ACTIVITY_LOG_SIZE_QUERY)) as ActivityLogSizeRow[];
  } catch {
    return skippedResult();
  }

  const totalBytes = Number(rows[0]?.total_bytes ?? 0);
  const maxBytes = opts.maxBytes ?? ACTIVITY_LOG_WARN_BYTES;
  if (Number.isFinite(totalBytes) && totalBytes <= maxBytes) {
    return {
      name: "Activity log size",
      status: "pass",
      message: `activity_log uses ${formatBytes(totalBytes)}`,
    };
  }

  return {
    name: "Activity log size",
    status: "warn",
    message: `activity_log uses ${formatBytes(totalBytes)}, above the ${formatBytes(maxBytes)} warning threshold`,
    canRepair: false,
    repairHint: "Archive or delete old activity rows, then run `VACUUM FULL public.activity_log` during a maintenance window",
  };
}

function skippedResult(): CheckResult {
  return {
    name: "Activity log size",
    status: "warn",
    message: "PostgreSQL is not reachable; activity_log size check skipped",
    canRepair: false,
    repairHint: "Start the Paperclip server, then re-run `paperclipai doctor`",
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${formatUnit(bytes / 1024 ** 3)} GiB`;
  if (bytes >= 1024 ** 2) return `${formatUnit(bytes / 1024 ** 2)} MiB`;
  if (bytes >= 1024) return `${formatUnit(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function formatUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
