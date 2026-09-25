import fs from "node:fs";
import path from "node:path";
import {
  resolveLegacyInstanceServerLogFilePath,
  resolveServerLogFilePath,
} from "@paperclipai/shared/home-paths";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

export function logCheck(config: PaperclipConfig, configPath?: string): CheckResult {
  const logDir = resolveRuntimeLikePath(config.logging.logDir, configPath);
  const reportedDir = logDir;
  const serverLogPath = resolveServerLogFilePath({ logDir });
  const legacyServerLogPath = resolveLegacyInstanceServerLogFilePath();

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(reportedDir, { recursive: true });
  }

  try {
    fs.accessSync(reportedDir, fs.constants.W_OK);
    const legacyExists = fs.existsSync(legacyServerLogPath);
    const canonicalExists = fs.existsSync(serverLogPath);
    const legacyStale =
      legacyExists &&
      canonicalExists &&
      path.resolve(legacyServerLogPath) !== path.resolve(serverLogPath) &&
      fs.statSync(legacyServerLogPath).mtimeMs <
        fs.statSync(serverLogPath).mtimeMs;

    let message = `Log directory is writable: ${reportedDir}`;
    if (config.logging.mode === "file") {
      message += `; server log: ${serverLogPath}`;
    }
    if (legacyStale) {
      message += `; stale legacy log at ${legacyServerLogPath} (use ${serverLogPath})`;
    }

    return {
      name: "Log directory",
      status: "pass",
      message,
    };
  } catch {
    return {
      name: "Log directory",
      status: "fail",
      message: `Log directory is not writable: ${logDir}`,
      canRepair: false,
      repairHint: "Check file permissions on the log directory",
    };
  }
}
