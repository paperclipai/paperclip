import { execSync } from "node:child_process";
import { createRequire } from "node:module";

type PackageJson = {
  version?: string;
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as PackageJson;

export const serverVersion = pkg.version ?? "0.0.0";

function detectGitSha(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", timeout: 3000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export const buildGitSha = detectGitSha();
