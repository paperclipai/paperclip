import fs from "node:fs";
import path from "node:path";
import { resolveDefaultConfigPath } from "./home-paths.js";

const ODYSSEUS_CONFIG_BASENAME = "config.json";
const ODYSSEUS_ENV_FILENAME = ".env";

function findConfigFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".odysseus", ODYSSEUS_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveOdysseusConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.ODYSSEUS_CONFIG) return path.resolve(process.env.ODYSSEUS_CONFIG);
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath();
}

export function resolveOdysseusEnvPath(overrideConfigPath?: string): string {
  return path.resolve(path.dirname(resolveOdysseusConfigPath(overrideConfigPath)), ODYSSEUS_ENV_FILENAME);
}
