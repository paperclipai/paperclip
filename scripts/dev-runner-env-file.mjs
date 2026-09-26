import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";
import path from "node:path";

/**
 * Parse the dotenv file format: blank lines, `#` comments, `export KEY=value`,
 * single-quoted values (verbatim), double-quoted values (`\n`/`\r` escapes),
 * and unquoted values with trailing whitespace trimmed.
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
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Merge parsed `.env` entries into an env object only where the key is not
 * already set. A real shell export and the instance env file keep precedence
 * over the repo-root `.env`, matching dotenv's own no-override behavior.
 */
export function mergeMissingEnvEntries(env, parsed) {
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined && env[key] !== "") continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

export function applyRepoRootEnvFile(env, repoRoot, { readFile, existsSync, log = () => {} } = {}) {
  const envPath = path.join(repoRoot, ".env");
  if (!(existsSync ?? nodeExistsSync)(envPath)) return [];
  const content = (readFile ?? nodeReadFileSync)(envPath, "utf8");
  const applied = mergeMissingEnvEntries(env, parseDotenvFile(content));
  if (applied.length > 0) {
    log(`[paperclip] loaded repo-root .env into the server process: ${applied.join(", ")}`);
  }
  return applied;
}
