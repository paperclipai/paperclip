import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  version?: string;
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as PackageJson;

export const serverVersion = pkg.version ?? "0.0.0";

function readServerBuildCommit(): string | null {
  const buildCommitPath = resolve(dirname(fileURLToPath(import.meta.url)), "BUILD_COMMIT");
  if (!existsSync(buildCommitPath)) return null;

  const buildCommit = readFileSync(buildCommitPath, "utf8").trim();
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(buildCommit) ? buildCommit : null;
}

export const serverBuildCommit = readServerBuildCommit();
