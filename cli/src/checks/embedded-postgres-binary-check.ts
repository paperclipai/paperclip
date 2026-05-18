import { createRequire } from "node:module";
import os from "node:os";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

/**
 * Maps Node.js os.platform()/os.arch() to the @embedded-postgres package suffix.
 */
function getEmbeddedPostgresPlatformPackage(): string | null {
  const platform = os.platform();
  const arch = os.arch();

  const map: Record<string, Record<string, string>> = {
    darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
    linux: {
      arm64: "linux-arm64",
      arm: "linux-arm",
      ia32: "linux-ia32",
      ppc64: "linux-ppc64",
      x64: "linux-x64",
    },
    win32: { x64: "windows-x64" },
  };

  return map[platform]?.[arch] ?? null;
}

export function embeddedPostgresBinaryCheck(config: PaperclipConfig): CheckResult {
  if (config.database.mode !== "embedded-postgres") {
    return {
      name: "Embedded PostgreSQL binary",
      status: "pass",
      message: "Not using embedded-postgres; skipped",
    };
  }

  const suffix = getEmbeddedPostgresPlatformPackage();
  if (!suffix) {
    return {
      name: "Embedded PostgreSQL binary",
      status: "fail",
      message: `Unsupported platform: ${os.platform()}-${os.arch()}`,
      canRepair: false,
      repairHint: "embedded-postgres does not ship a binary for this platform. Use an external PostgreSQL instead: paperclipai configure --section database",
    };
  }

  const packageName = `@embedded-postgres/${suffix}`;

  try {
    const require = createRequire(import.meta.url);
    require.resolve(packageName);
    return {
      name: "Embedded PostgreSQL binary",
      status: "pass",
      message: `Platform binary found (${packageName})`,
    };
  } catch {
    return {
      name: "Embedded PostgreSQL binary",
      status: "fail",
      message: `Missing platform binary: ${packageName}`,
      canRepair: false,
      repairHint: `Run: npm install -g ${packageName}`,
    };
  }
}
