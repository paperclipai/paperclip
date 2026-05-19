import fs from "node:fs";
import { detectInsecureLogDir } from "@paperclipai/shared";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

export function logCheck(config: PaperclipConfig, configPath?: string): CheckResult {
  const logDir = resolveRuntimeLikePath(config.logging.logDir, configPath);
  const reportedDir = logDir;

  // LET-436: surface misconfigured production logDirs that point at vitest
  // scratch paths (e.g. /tmp/paperclip-vitest-*). Doctor must fail visibly so
  // operators catch the misconfiguration before the heartbeat reaper turns
  // missing log/state into an `adapter_failed` / `process_lost` flood.
  const insecure = detectInsecureLogDir(config.logging.logDir, {
    mode: process.env.NODE_ENV === "test" ? "test" : "production",
  });
  if (!insecure.ok) {
    return {
      name: "Log directory",
      status: insecure.severity === "warn" ? "warn" : "fail",
      message: insecure.reason ?? `Insecure log directory: ${logDir}`,
      canRepair: false,
      repairHint:
        "Set logging.logDir to a stable path (e.g. ~/.paperclip/instances/<name>/logs).",
    };
  }

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(reportedDir, { recursive: true });
  }

  try {
    fs.accessSync(reportedDir, fs.constants.W_OK);
    return {
      name: "Log directory",
      status: "pass",
      message: `Log directory is writable: ${reportedDir}`,
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
