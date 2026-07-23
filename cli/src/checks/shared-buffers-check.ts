import os from "node:os";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { openDoctorDb } from "./db-connect.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MIN_SHARED_BUFFERS_BYTES = 128 * MIB;
const MAX_SHARED_BUFFERS_BYTES = 8 * GIB;

const SHARED_BUFFERS_QUERY = `
  SELECT
    setting,
    unit,
    pending_restart,
    (
      SELECT setting
      FROM pg_file_settings
      WHERE name = 'shared_buffers'
      ORDER BY seqno DESC
      LIMIT 1
    ) AS configured_setting
  FROM pg_settings
  WHERE name = 'shared_buffers'
`;

type SharedBuffersCheckOptions = {
  hostMemoryBytes?: number;
  openDb?: typeof openDoctorDb;
};

type SharedBuffersRow = {
  setting: string;
  unit: string | null;
  pending_restart: boolean;
  configured_setting: string | null;
};

export async function sharedBuffersCheck(
  config: PaperclipConfig,
  configPath?: string,
  opts: SharedBuffersCheckOptions = {},
): Promise<CheckResult> {
  if (config.database.mode !== "embedded-postgres") {
    return {
      name: "PostgreSQL shared buffers",
      status: "pass",
      message: "External PostgreSQL manages shared_buffers",
    };
  }

  let db;
  try {
    ({ db } = await (opts.openDb ?? openDoctorDb)(config, configPath));
  } catch {
    return skippedResult();
  }

  let rows: SharedBuffersRow[];
  try {
    rows = Array.from(await db.execute(SHARED_BUFFERS_QUERY)) as SharedBuffersRow[];
  } catch {
    return skippedResult();
  }

  const row = rows[0];
  const activeBytes = row ? parseSettingBytes(row.setting, row.unit) : null;
  if (!row || activeBytes === null) {
    return skippedResult();
  }

  const hostMemoryBytes = opts.hostMemoryBytes ?? os.totalmem();
  const recommendedBytes = recommendedSharedBuffers(hostMemoryBytes);
  const lowerBound = recommendedBytes * 0.5;
  const upperBound = recommendedBytes * 1.5;
  if (activeBytes >= lowerBound && activeBytes <= upperBound) {
    return {
      name: "PostgreSQL shared buffers",
      status: "pass",
      message: `shared_buffers is ${formatBytes(activeBytes)} for ${formatBytes(hostMemoryBytes)} of host RAM`,
    };
  }

  const configuredBytes = row.configured_setting
    ? parseSettingBytes(row.configured_setting, null)
    : null;
  if (
    row.pending_restart &&
    configuredBytes !== null &&
    configuredBytes >= lowerBound &&
    configuredBytes <= upperBound
  ) {
    return {
      name: "PostgreSQL shared buffers",
      status: "warn",
      message: `shared_buffers is configured to ${formatBytes(configuredBytes)}; restart Paperclip to apply it`,
      canRepair: false,
      repairHint: "Restart the Paperclip server",
    };
  }

  const recommendedMiB = recommendedBytes / MIB;
  return {
    name: "PostgreSQL shared buffers",
    status: "warn",
    message: `shared_buffers is ${formatBytes(activeBytes)}; recommended ${formatBytes(recommendedBytes)} for this host`,
    canRepair: true,
    repairHint: "Update embedded PostgreSQL shared_buffers and restart Paperclip",
    repair: async () => {
      await db.execute(`ALTER SYSTEM SET shared_buffers = '${recommendedMiB}MB'`);
      await db.execute("SELECT pg_reload_conf()");
    },
  };
}

function recommendedSharedBuffers(hostMemoryBytes: number): number {
  const target = Math.floor(hostMemoryBytes / 4 / MIB) * MIB;
  return Math.min(MAX_SHARED_BUFFERS_BYTES, Math.max(MIN_SHARED_BUFFERS_BYTES, target));
}

function parseSettingBytes(setting: string, unit: string | null): number | null {
  const match = setting.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!match) return null;

  const value = Number(match[1]);
  const normalizedUnit = (match[2] ?? unit ?? "B").toLowerCase();
  const multiplier = {
    b: 1,
    kb: 1024,
    "8kb": 8 * 1024,
    mb: MIB,
    gb: GIB,
  }[normalizedUnit];
  return multiplier ? value * multiplier : null;
}

function skippedResult(): CheckResult {
  return {
    name: "PostgreSQL shared buffers",
    status: "warn",
    message: "Embedded PostgreSQL is not reachable; shared_buffers check skipped",
    canRepair: false,
    repairHint: "Start the Paperclip server, then re-run `paperclipai doctor`",
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${formatUnit(bytes / GIB)} GiB`;
  if (bytes >= MIB) return `${formatUnit(bytes / MIB)} MiB`;
  return `${formatUnit(bytes / 1024)} KiB`;
}

function formatUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
