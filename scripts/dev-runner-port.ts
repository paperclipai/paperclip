import fs from "node:fs";
import path from "node:path";

export const DEFAULT_DEV_SERVER_PORT = 3100;

const PAPERCLIP_CONFIG_BASENAME = "config.json";

function isUsablePort(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isInteger(value)
    && value > 0
    && value <= 65535
  );
}

/**
 * Locate the config file the server will read, using the server's own rule.
 *
 * `server/src/paths.ts` prefers `PAPERCLIP_CONFIG` and otherwise walks up from
 * the working directory looking for `.paperclip/config.json`.
 */
export function findPaperclipConfigPath(input: {
  env: NodeJS.ProcessEnv;
  startDir: string;
  fallbackConfigPath?: string | null;
}): string | null {
  const override = input.env.PAPERCLIP_CONFIG?.trim();
  if (override) return path.resolve(override);

  let currentDir = path.resolve(input.startDir);
  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", PAPERCLIP_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) return candidate;
    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return input.fallbackConfigPath ? path.resolve(input.fallbackConfigPath) : null;
}

export function readConfiguredServerPort(configPath: string | null): number | null {
  if (!configPath) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      server?: { port?: unknown };
    };
    const port = raw?.server?.port;
    return isUsablePort(port) ? port : null;
  } catch {
    // A missing or malformed config is the server's problem to report; the
    // supervisor only needs a starting guess and corrects itself from the
    // listener record once the child binds.
    return null;
  }
}

/**
 * Resolve the port the server child is going to ask for.
 *
 * This must stay identical to `server/src/config.ts`, which resolves
 * `Number(process.env.PORT) || fileConfig?.server.port || 3100`. The dev runner
 * used to read only `PORT`, so a repository that pinned `server.port` in its
 * `.paperclip/config.json` left the supervisor believing its child was on 3100
 * while the child bound the configured port instead. Every supervisor health
 * probe then went to a port nobody listened on, and because
 * `maybeAutoRestartChild` swallows a failed probe, both the automatic and the
 * manual restart paths went permanently dead without a single log line
 * (TES-2189).
 */
export function resolveRequestedDevServerPort(input: {
  env: NodeJS.ProcessEnv;
  startDir: string;
  fallbackConfigPath?: string | null;
}): number {
  const fromEnv = Number(input.env.PORT);
  if (isUsablePort(fromEnv)) return fromEnv;
  return readConfiguredServerPort(findPaperclipConfigPath(input)) ?? DEFAULT_DEV_SERVER_PORT;
}
