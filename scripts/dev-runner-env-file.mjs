import fs from "node:fs";
import path from "node:path";

function stripInlineComment(value) {
  const start = value.search(/\s#/);
  return start === -1 ? value.trimEnd() : value.slice(0, start).trimEnd();
}

/**
 * Parse the dotenv file format: blank lines, `#` comments, `export KEY=value`,
 * single-quoted values (verbatim), double-quoted values (`\n`/`\r` escapes),
 * unquoted values with inline ` #` comments removed, and no value as `""`.
 */
export function parseDotenvFile(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const raw = line.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      out[key] = raw
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r");
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      out[key] = raw.slice(1, -1);
    } else {
      out[key] = stripInlineComment(raw);
    }
  }
  return out;
}

function readParsedEnvFile(envPath) {
  if (!envPath || !fs.existsSync(envPath)) return {};
  try {
    return parseDotenvFile(fs.readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

// Mirrors the server's own resolution (server/src/paths.ts): PAPERCLIP_CONFIG
// wins, then a `.paperclip/config.json` found from the server cwd upward,
// then the default instance directory. The server loads `<that dir>/.env`.
export function resolveInstanceEnvPath({
  configOverride = process.env.PAPERCLIP_CONFIG,
  serverCwd,
  homedir = () => process.env.HOME ?? "~",
} = {}) {
  if (configOverride) {
    return path.join(path.dirname(path.resolve(configOverride)), ".env");
  }
  let current = path.resolve(serverCwd);
  while (true) {
    const candidate = path.resolve(current, ".paperclip", "config.json");
    if (fs.existsSync(candidate)) {
      return path.join(path.dirname(candidate), ".env");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(homedir(), ".paperclip", "instances", "default", ".env");
}

/**
 * Fill keys that the given env object does not already define. An explicit
 * empty export (`KEY=""`) counts as defined, so a shell can disable a key.
 */
export function mergeMissingEnvEntries(env, parsed) {
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * Build the env for one server (re)start: the repo-root `.env` fills only the
 * gaps. Precedence is shell > instance `.env` > repo-root `.env`, matching
 * the server's own dotenv loads. The file is re-read on every call, so an
 * auto-restart picks up edited values.
 */
export function applyRepoRootEnvFile(baseEnv, repoRoot, options = {}) {
  const {
    log = () => {},
    instanceEnvPath = resolveInstanceEnvPath({ serverCwd: path.join(repoRoot, "server") }),
  } = options;
  const rootParsed = readParsedEnvFile(path.join(repoRoot, ".env"));
  const instanceKeys = new Set(Object.keys(readParsedEnvFile(instanceEnvPath)));
  const env = { ...baseEnv };
  const applied = [];
  for (const [key, value] of Object.entries(rootParsed)) {
    if (env[key] !== undefined || instanceKeys.has(key)) continue;
    env[key] = value;
    applied.push(key);
  }
  if (applied.length > 0) {
    log(`[paperclip] loaded repo-root .env into the server process: ${applied.join(", ")}`);
  }
  return { env, applied };
}
