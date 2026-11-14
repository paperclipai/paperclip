import { execFileSync } from "node:child_process";
import type { CheckResult } from "./index.js";

const REQUIRED_LOCALE = "en_US.UTF-8";

function isLocaleAvailable(): boolean {
  try {
    const output = execFileSync("locale", ["-a"], { encoding: "utf8", timeout: 5000 });
    // locale -a outputs names like "en_US.utf8" or "en_US.UTF-8" depending on distro
    return output
      .split(/\r?\n/)
      .some((line) => line.trim().replace(/[_.-]/g, "").toLowerCase() === "enusutf8");
  } catch {
    // If locale command is unavailable, skip the check rather than block setup
    return true;
  }
}

export function localeCheck(): CheckResult {
  if (process.platform !== "linux") {
    return {
      name: "Locale",
      status: "pass",
      message: `Locale check skipped (not required on ${process.platform})`,
    };
  }

  if (isLocaleAvailable()) {
    return {
      name: "Locale",
      status: "pass",
      message: `${REQUIRED_LOCALE} locale is available`,
    };
  }

  return {
    name: "Locale",
    status: "fail",
    message: `${REQUIRED_LOCALE} locale is missing — embedded PostgreSQL requires it`,
    canRepair: false,
    repairHint: `On Debian/Ubuntu: sudo locale-gen ${REQUIRED_LOCALE} && sudo dpkg-reconfigure locales\nOn RHEL/Fedora: sudo localedef -i en_US -f UTF-8 en_US.UTF-8`,
  };
}
