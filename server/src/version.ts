import { createRequire } from "node:module";

type PackageJson = {
  version?: string;
  name?: string;
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as PackageJson;

export const serverVersion = pkg.version ?? "0.0.0";

/**
 * Checks that sibling @paperclipai/* packages share the same version as the
 * server.  A version mismatch almost always means a stale npx cache is mixing
 * packages from different releases.  Call this early in `startServer()` so the
 * user gets an actionable message before the server crashes with an obscure
 * missing-export error.
 */
export function assertPackageVersionConsistency(): void {
  const packagesToCheck = [
    "@paperclipai/shared",
    "@paperclipai/db",
  ];

  const mismatches: Array<{ name: string; version: string }> = [];

  for (const pkgName of packagesToCheck) {
    try {
      const dep = require(`${pkgName}/package.json`) as PackageJson;
      const depVersion = dep.version ?? "0.0.0";
      if (depVersion !== serverVersion) {
        mismatches.push({ name: pkgName, version: depVersion });
      }
    } catch {
      // Package not resolvable — skip (may be in a bundled/monorepo context)
    }
  }

  if (mismatches.length > 0) {
    const lines = mismatches.map((m) => `  ${m.name}@${m.version}`).join("\n");
    const msg = [
      `Paperclip package version mismatch detected.`,
      `Server version: ${serverVersion}`,
      `Mismatched packages:`,
      lines,
      ``,
      `This is almost always caused by a stale npx cache mixing packages from`,
      `different releases.  To fix:`,
      `  rm -rf ~/.npm/_npx/`,
      `  npm cache clean --force`,
      `  # then restart the server`,
    ].join("\n");
    throw new Error(msg);
  }
}
