import fs from "node:fs";
import path from "node:path";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveConfigPath } from "../config/store.js";
import { resolvePaperclipEnvFile } from "../config/env.js";
import { applyPathMode, formatMode, isModeTooPermissive, readPathMode } from "../utils/fs-permissions.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

type PathCheck = {
  label: string;
  targetPath: string;
  maxMode: number;
};

type PathViolation = PathCheck & {
  actualMode: number;
};

function collectViolation(violations: PathViolation[], check: PathCheck): void {
  if (!fs.existsSync(check.targetPath)) return;
  const actualMode = readPathMode(check.targetPath);
  if (actualMode === null || !isModeTooPermissive(actualMode, check.maxMode)) return;
  violations.push({ ...check, actualMode });
}

export function runtimePermissionsCheck(config: PaperclipConfig, configPath?: string): CheckResult {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const envPath = resolvePaperclipEnvFile(configPath);
  const checks: PathCheck[] = [
    {
      label: "config directory",
      targetPath: path.dirname(resolvedConfigPath),
      maxMode: 0o700,
    },
    {
      label: "config file",
      targetPath: resolvedConfigPath,
      maxMode: 0o600,
    },
    {
      label: "agent env file",
      targetPath: envPath,
      maxMode: 0o600,
    },
    {
      label: "log directory",
      targetPath: resolveRuntimeLikePath(config.logging.logDir, configPath),
      maxMode: 0o700,
    },
    {
      label: "backup directory",
      targetPath: resolveRuntimeLikePath(config.database.backup.dir, configPath),
      maxMode: 0o700,
    },
  ];

  if (config.database.mode === "embedded-postgres") {
    checks.push({
      label: "embedded Postgres data directory",
      targetPath: resolveRuntimeLikePath(config.database.embeddedPostgresDataDir, configPath),
      maxMode: 0o700,
    });
  }

  if (config.storage.provider === "local_disk") {
    checks.push({
      label: "storage directory",
      targetPath: resolveRuntimeLikePath(config.storage.localDisk.baseDir, configPath),
      maxMode: 0o700,
    });
  }

  if (config.secrets.provider === "local_encrypted") {
    const keyFilePath = resolveRuntimeLikePath(config.secrets.localEncrypted.keyFilePath, configPath);
    checks.push(
      {
        label: "secrets directory",
        targetPath: path.dirname(keyFilePath),
        maxMode: 0o700,
      },
      {
        label: "secrets key file",
        targetPath: keyFilePath,
        maxMode: 0o600,
      },
    );
  }

  const violations: PathViolation[] = [];
  for (const check of checks) {
    collectViolation(violations, check);
  }

  if (violations.length === 0) {
    return {
      name: "Runtime permissions",
      status: "pass",
      message: "Existing runtime paths satisfy the hardening baseline",
    };
  }

  return {
    name: "Runtime permissions",
    status: "fail",
    message: violations
      .map((violation) => `${violation.label} ${violation.targetPath} is ${formatMode(violation.actualMode)} (max ${formatMode(violation.maxMode)})`)
      .join("; "),
    canRepair: true,
    repair: () => {
      for (const violation of violations) {
        applyPathMode(violation.targetPath, violation.maxMode);
      }
    },
    repairHint: "Run with --repair to clamp existing runtime paths to least-privilege modes",
  };
}
