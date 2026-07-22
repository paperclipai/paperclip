import { createRequire } from "node:module";
import {
  isManagedExecutable,
  readInstallManifest,
  resolveInstallStorePaths,
} from "./install-store.js";

type PackageJson = {
  version?: string;
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as PackageJson;

const packageVersion = pkg.version ?? "0.0.0";

export function resolveCliVersion(executablePath = process.argv[1]): string {
  try {
    const paths = resolveInstallStorePaths();
    const manifest = readInstallManifest(paths);
    if (!manifest || !isManagedExecutable(executablePath, manifest, paths)) return packageVersion;
    const provenance =
      manifest.source === "git"
        ? `managed git ${manifest.ref ?? manifest.sha ?? "unknown"}`
        : `managed npm ${manifest.channel}`;
    return `${packageVersion} (${provenance}; payload ${manifest.payloadPath})`;
  } catch {
    return packageVersion;
  }
}

export const cliVersion = resolveCliVersion();
