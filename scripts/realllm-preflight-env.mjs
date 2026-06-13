/**
 * CMP-37 / CMP-479 / CMP-531 — realllm Anthropic preflight for Paperclip canonical
 * (`bash scripts/run-realllm-contract.sh`). Same merge rules as
 * `tests/realllm/playwright.config.ts`: each file only fills missing `process.env`
 * keys; earlier files win for a given key (infra/.env first, then `.env`, then optional
 * extra chain).
 *
 * Optional: set `REALLLM_EXTRA_ENV_FILE` in the environment or in `.env` to a path
 * (absolute or repo-relative) of another dotenv file injected by dogfood (for example
 * a sibling Dongtian checkout’s `infra/.env`). Values never appear in stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** @param {string} filePath */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith("\"") && v.endsWith("\"")) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}

/** @param {string} absPath */
function dotenvLocatorLabel(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  const rel = path.relative(root, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(absPath);
  return rel || ".";
}

/** @param {string} p */
function resolveExtraPath(p) {
  const t = p.trim();
  if (!t) return "";
  return path.isAbsolute(t) ? t : path.join(root, t);
}

/**
 * After file merge, mirror Dongtian `load-infra-env` / docker-compose behaviour:
 * treat `ANTHROPIC_AUTH_TOKEN` as the Anthropic API credential when
 * `ANTHROPIC_API_KEY` is empty and we are not in alt-provider (`ANTHROPIC_BASE_URL`) mode.
 */
function hydrateAnthropicMirrors() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const auth = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (baseUrl || apiKey) return;
  if (auth && !auth.startsWith("sk-ant-oat")) {
    process.env.ANTHROPIC_API_KEY = auth;
  }
}

/**
 * @param {string} filePath
 * @param {(k: string, v: string) => void} onKey
 */
function scanEnvDeclarations(filePath, onKey) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith("\"") && v.endsWith("\"")) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v) onKey(k, v);
  }
}

const preShellAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
const preShellAuth = Boolean(process.env.ANTHROPIC_AUTH_TOKEN?.trim());
const preShellBaseUrl = Boolean(process.env.ANTHROPIC_BASE_URL?.trim());

const infraPath = path.join(root, "infra/.env");
const rootDotPath = path.join(root, ".env");

loadEnvFile(infraPath);
loadEnvFile(rootDotPath);

/** First pass at extra pointer (may come from .env / infra) */
let extraRaw = process.env.REALLLM_EXTRA_ENV_FILE?.trim() ?? "";
let extraResolved = extraRaw ? resolveExtraPath(extraRaw) : "";
if (extraResolved && fs.existsSync(extraResolved)) {
  loadEnvFile(extraResolved);
}

hydrateAnthropicMirrors();

/** If extra was set only after second wave (edge case), reload once */
extraRaw = process.env.REALLLM_EXTRA_ENV_FILE?.trim() ?? "";
const extraResolved2 = extraRaw ? resolveExtraPath(extraRaw) : "";
if (extraResolved2 && fs.existsSync(extraResolved2) && extraResolved2 !== extraResolved) {
  loadEnvFile(extraResolved2);
  extraResolved = extraResolved2;
  hydrateAnthropicMirrors();
}

const infraExists = fs.existsSync(infraPath);
const dotEnvExists = fs.existsSync(rootDotPath);
const extraLabel = dotenvLocatorLabel(
  extraResolved && fs.existsSync(extraResolved) ? extraResolved : "",
);

/** Which file first declares Anthropic-ish keys under infra → `.env` → extra order */
function firstAnthropicSourcePath() {
  const files = [infraPath, rootDotPath];
  if (extraResolved) files.push(extraResolved);
  for (const fp of files) {
    let declares = false;
    scanEnvDeclarations(fp, (k, v) => {
      if (declares) return;
      if (
        k === "ANTHROPIC_API_KEY" ||
        k === "ANTHROPIC_AUTH_TOKEN" ||
        k === "ANTHROPIC_BASE_URL"
      ) {
        if (v.trim()) declares = true;
      }
    });
    if (declares) return dotenvLocatorLabel(fp) ?? "";
  }
  return "";
}

const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const authTok = process.env.ANTHROPIC_AUTH_TOKEN?.trim();

const anthropicDeclarator = firstAnthropicSourcePath();
let effectiveFrom = "unknown";
if (preShellAnthropicKey || preShellAuth || preShellBaseUrl) {
  effectiveFrom = "shell_environment";
} else if (anthropicDeclarator) {
  effectiveFrom = anthropicDeclarator;
}

/** Alt-provider mode (parity with `dongtian/scripts/preflight-anthropic-key.sh`) */
if (baseUrl) {
  if (!authTok) {
    console.log(
      JSON.stringify({
        ok: false,
        reason:
          "ANTHROPIC_BASE_URL set but ANTHROPIC_AUTH_TOKEN missing/empty after merge",
        mode: "alt_provider",
        infraDotenvExists: infraExists,
        rootDotenvExists: dotEnvExists,
        extraEnvFile: extraLabel,
        firstFileDeclaringAnthropicKey: anthropicDeclarator || null,
        effectiveFrom,
      }),
    );
    process.exit(1);
  }
  if (authTok.startsWith("sk-ant-oat")) {
    console.log(
      JSON.stringify({
        ok: false,
        reason:
          "ANTHROPIC_AUTH_TOKEN is OAuth-shaped (sk-ant-oat…) in alt-provider mode",
        mode: "alt_provider",
        infraDotenvExists: infraExists,
        rootDotenvExists: dotEnvExists,
        extraEnvFile: extraLabel,
        firstFileDeclaringAnthropicKey: anthropicDeclarator || null,
        effectiveFrom,
      }),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      ok: true,
      reason: "preflight OK (Anthropic-compat provider via ANTHROPIC_BASE_URL)",
      mode: "alt_provider",
      infraDotenvExists: infraExists,
      rootDotenvExists: dotEnvExists,
      extraEnvFile: extraLabel,
      firstFileDeclaringAnthropicKey: anthropicDeclarator || null,
      effectiveFrom,
    }),
  );
  process.exit(0);
}

if (!apiKey) {
  console.log(
    JSON.stringify({
      ok: false,
      reason:
        "ANTHROPIC_API_KEY missing after merge (infra/.env → .env → REALLLM_EXTRA_ENV_FILE); mirrored ANTHROPIC_AUTH_TOKEN was also empty",
      mode: "direct_anthropic",
      infraDotenvExists: infraExists,
      rootDotenvExists: dotEnvExists,
      extraEnvFile: extraLabel,
      firstFileDeclaringAnthropicKey: anthropicDeclarator || null,
      effectiveFrom,
    }),
  );
  process.exit(1);
}

if (apiKey.startsWith("sk-ant-oat")) {
  console.log(
    JSON.stringify({
      ok: false,
      reason:
        "ANTHROPIC_API_KEY is OAuth-shaped (sk-ant-oat…) — use long-lived API key",
      mode: "direct_anthropic",
      infraDotenvExists: infraExists,
      rootDotenvExists: dotEnvExists,
      extraEnvFile: extraLabel,
      firstFileDeclaringAnthropicKey: anthropicDeclarator || null,
      effectiveFrom,
    }),
  );
  process.exit(1);
}

if (!apiKey.startsWith("sk-ant-")) {
  console.log(
    JSON.stringify({
      ok: false,
      reason:
        "ANTHROPIC_API_KEY does not start with sk-ant-* (unset ANTHROPIC_BASE_URL for direct Anthropic)",
      mode: "direct_anthropic",
      infraDotenvExists: infraExists,
      rootDotenvExists: dotEnvExists,
      extraEnvFile: extraLabel,
      firstFileDeclaringAnthropicKey: anthropicDeclarator || null,
      effectiveFrom,
    }),
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    reason: "preflight OK (Anthropic credential shape acceptable)",
    mode: "direct_anthropic",
    infraDotenvExists: infraExists,
    rootDotenvExists: dotEnvExists,
    extraEnvFile: extraLabel,
    firstFileDeclaringAnthropicKey: anthropicDeclarator || null,
    effectiveFrom,
  }),
);
process.exit(0);
