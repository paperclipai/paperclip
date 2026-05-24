import fs from "node:fs";
import path from "node:path";
import { resolveDefaultConfigPath } from "./home-paths.js";

const VALADRIEN_OS_CONFIG_BASENAME = "config.json";
const VALADRIEN_OS_ENV_FILENAME = ".env";

function findConfigFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".valadrien-os", VALADRIEN_OS_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveValadrienOsConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.VALADRIEN_OS_CONFIG) return path.resolve(process.env.VALADRIEN_OS_CONFIG);
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath();
}

export function resolveValadrienOsEnvPath(overrideConfigPath?: string): string {
  return path.resolve(path.dirname(resolveValadrienOsConfigPath(overrideConfigPath)), VALADRIEN_OS_ENV_FILENAME);
}
