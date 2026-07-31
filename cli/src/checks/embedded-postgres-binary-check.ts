import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

/**
 * Maps Node.js os.platform()/os.arch() to the corresponding
 * `@embedded-postgres/<platform>-<arch>` package name.
 */
export function getEmbeddedPostgresPlatformPackage(): string | null {
  const platform = os.platform();
  const arch = os.arch();

  const platformMap: Record<string, Record<string, string>> = {
    darwin: {
      arm64: "@embedded-postgres/darwin-arm64",
      x64: "@embedded-postgres/darwin-x64",
    },
    linux: {
      arm64: "@embedded-postgres/linux-arm64",
      x64: "@embedded-postgres/linux-x64",
    },
    win32: {
      x64: "@embedded-postgres/windows-x64",
    },
  };

  return platformMap[platform]?.[arch] ?? null;
}

/**
 * In a development/monorepo context the server is loaded from local source
 * via tsx, so the platform binary is resolved differently at runtime.
 * We skip the binary check in that case to avoid false positives.
 */
function isDevContext(): boolean {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const devEntry = path.resolve(projectRoot, "server/src/index.ts");
  return fs.existsSync(devEntry);
}

export function embeddedPostgresBinaryCheck(config: PaperclipConfig): CheckResult {
  if (config.database.mode !== "embedded-postgres") {
    return {
      name: "Embedded PostgreSQL binary",
      status: "pass",
      message: "Not using embedded PostgreSQL — skipped",
    };
  }

  if (isDevContext()) {
    return {
      name: "Embedded PostgreSQL binary",
      status: "pass",
      message: "Development context detected — binary resolved at runtime",
    };
  }

  const packageName = getEmbeddedPostgresPlatformPackage();

  if (!packageName) {
    return {
      name: "Embedded PostgreSQL binary",
      status: "fail",
      message: `Unsupported platform: ${os.platform()}-${os.arch()}. Embedded PostgreSQL does not provide a binary for this system.`,
      canRepair: false,
      repairHint: "Switch to an external PostgreSQL database with `paperclipai configure --section database`",
    };
  }

  try {
    const require = createRequire(import.meta.url);
    require.resolve(packageName);
    return {
      name: "Embedded PostgreSQL binary",
      status: "pass",
      message: `Platform binary package found: ${packageName}`,
    };
  } catch {
    return {
      name: "Embedded PostgreSQL binary",
      status: "warn",
      message: `Platform binary package not found: ${packageName}. The server may fail to start.`,
      canRepair: false,
      repairHint: `Install it manually with: npm install -g ${packageName}`,
    };
  }
}
