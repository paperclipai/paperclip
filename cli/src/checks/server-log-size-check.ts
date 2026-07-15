import fs from "node:fs";
import path from "node:path";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

export const SERVER_LOG_WARN_BYTES = 100 * 1024 ** 2;

type ServerLogSizeCheckOptions = {
  maxBytes?: number;
  now?: () => Date;
};

export function serverLogSizeCheck(
  config: PaperclipConfig,
  configPath?: string,
  opts: ServerLogSizeCheckOptions = {},
): CheckResult {
  const logFile = path.join(resolveRuntimeLikePath(config.logging.logDir, configPath), "server.log");
  if (!fs.existsSync(logFile)) {
    return {
      name: "Server log size",
      status: "pass",
      message: "server.log does not exist yet",
    };
  }

  let size: number;
  try {
    size = fs.statSync(logFile).size;
  } catch (error) {
    return {
      name: "Server log size",
      status: "warn",
      message: `Could not inspect server.log: ${error instanceof Error ? error.message : String(error)}`,
      canRepair: false,
    };
  }

  const maxBytes = opts.maxBytes ?? SERVER_LOG_WARN_BYTES;
  if (size <= maxBytes) {
    return {
      name: "Server log size",
      status: "pass",
      message: `server.log uses ${formatBytes(size)}`,
    };
  }

  return {
    name: "Server log size",
    status: "warn",
    message: `server.log uses ${formatBytes(size)}, above the ${formatBytes(maxBytes)} warning threshold`,
    canRepair: true,
    repairHint: "Rotate server.log",
    repair: () => {
      const rotatedPath = nextRotationPath(logFile, opts.now?.() ?? new Date());
      fs.copyFileSync(logFile, rotatedPath, fs.constants.COPYFILE_EXCL);
      fs.truncateSync(logFile, 0);
    },
  };
}

function nextRotationPath(logFile: string, now: Date): string {
  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const basePath = `${logFile}.${timestamp}`;
  let candidate = basePath;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${basePath}.${suffix}`;
    suffix += 1;
  }
  return candidate;
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
