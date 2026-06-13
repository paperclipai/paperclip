import pc from "picocolors";
import type { Command } from "commander";
import { getStoredBoardCredential, loginBoardCli } from "../../client/board-auth.js";
import { buildCliCommandLabel } from "../../client/command-label.js";
import { readConfig } from "../../config/store.js";
import { readContext, resolveProfile, type ClientContextProfile } from "../../client/context.js";
import { ApiRequestError, PaperclipApiClient } from "../../client/http.js";

export interface BaseClientOptions {
  config?: string;
  dataDir?: string;
  context?: string;
  profile?: string;
  apiBase?: string;
  apiKey?: string;
  runId?: string;
  companyId?: string;
  json?: boolean;
}

export interface ResolvedClientContext {
  api: PaperclipApiClient;
  companyId?: string;
  profileName: string;
  profile: ClientContextProfile;
  json: boolean;
  authSource: "explicit" | "env" | "profile_env" | "stored_board" | "none";
}

export function addCommonClientOptions(command: Command, opts?: { includeCompany?: boolean }): Command {
  command
    .option("-c, --config <path>", "Path to Paperclip config file")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "CLI context profile name")
    .option("--api-base <url>", "Base URL for the Paperclip API")
    .option("--api-key <token>", "Bearer token for agent-authenticated calls")
    .option("--run-id <id>", "Heartbeat run id for agent-authenticated mutations (checkout/release/interactions/in-progress update); falls back to $PAPERCLIP_RUN_ID")
    .option("--json", "Output raw JSON");

  if (opts?.includeCompany) {
    command.option("-C, --company-id <id>", "Company ID (overrides context default)");
  }

  return command;
}

export function resolveCommandContext(
  options: BaseClientOptions,
  opts?: { requireCompany?: boolean },
): ResolvedClientContext {
  const context = readContext(options.context);
  const { name: profileName, profile } = resolveProfile(context, options.profile);

  const apiBase = resolveApiBase(options, profile);

  const resolvedApiKey = resolveApiKey(options, profile);
  const explicitApiKey = resolvedApiKey.value;
  const storedBoardCredential = explicitApiKey ? null : getStoredBoardCredential(apiBase);
  const apiKey = explicitApiKey || storedBoardCredential?.token;

  const companyId =
    options.companyId?.trim() ||
    process.env.PAPERCLIP_COMPANY_ID?.trim() ||
    profile.companyId;

  if (opts?.requireCompany && !companyId) {
    throw new Error(
      "Company ID is required. Pass --company-id, set PAPERCLIP_COMPANY_ID, or set context profile companyId via `paperclipai context set`.",
    );
  }

  // Agent-authenticated mutations (checkout, release, interactions, PATCH of an
  // in-progress issue) require the X-Paperclip-Run-Id header (the server returns
  // "401 Agent run id required" without it). Source it from --run-id, else the
  // PAPERCLIP_RUN_ID env the adapter/embodiment context already exports.
  const runId = options.runId?.trim() || process.env.PAPERCLIP_RUN_ID?.trim() || undefined;

  const api = new PaperclipApiClient({
    apiBase,
    apiKey,
    runId,
    recoverAuth: explicitApiKey || !canAttemptInteractiveBoardAuth()
      ? undefined
      : async ({ error }) => {
          const requestedAccess = error.message.includes("Instance admin required")
            ? "instance_admin_required"
            : "board";
          if (!shouldRecoverBoardAuth(error)) {
            return null;
          }
          const login = await loginBoardCli({
            apiBase,
            requestedAccess,
            requestedCompanyId: companyId ?? null,
            command: buildCliCommandLabel(),
          });
          return login.token;
        },
  });
  return {
    api,
    companyId,
    profileName,
    profile,
    json: Boolean(options.json),
    authSource: explicitApiKey ? resolvedApiKey.source : storedBoardCredential ? "stored_board" : "none",
  };
}

export function resolveApiBase(options: Pick<BaseClientOptions, "apiBase" | "config">, profile: ClientContextProfile = {}): string {
  return normalizeApiBase(
    options.apiBase?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    profile.apiBase ||
    inferApiBaseFromConfig(options.config),
  );
}

export function normalizeApiBase(apiBase: string): string {
  return apiBase.trim().replace(/\/+$/, "");
}

export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number | boolean | null | undefined>): string {
  let path = strings[0] ?? "";
  values.forEach((value, index) => {
    if (value === null || value === undefined || String(value).trim() === "") {
      throw new Error("Cannot build API path with an empty path segment.");
    }
    path += `${encodeURIComponent(String(value))}${strings[index + 1] ?? ""}`;
  });
  return path;
}

export function inferContentTypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  // These MIME strings are matched against the server's issue-attachment
  // allowlist (server/src/attachment-types.ts DEFAULT_ALLOWED_TYPES) by EXACT
  // string, so text types must carry no "; charset=..." parameter or the upload
  // is rejected with "422 Unsupported attachment content type". Keep this set in
  // sync with that allowlist (plus svg/avif, accepted by the asset routes).
  return {
    avif: "image/avif",
    csv: "text/csv",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    m4v: "video/x-m4v",
    md: "text/markdown",
    mov: "video/quicktime",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    qt: "video/quicktime",
    svg: "image/svg+xml",
    txt: "text/plain",
    webm: "video/webm",
    webp: "image/webp",
    zip: "application/zip",
  }[ext];
}

function resolveApiKey(
  options: Pick<BaseClientOptions, "apiKey">,
  profile: ClientContextProfile,
): { value: string | undefined; source: "explicit" | "env" | "profile_env" | "none" } {
  const optionValue = options.apiKey?.trim();
  if (optionValue) return { value: optionValue, source: "explicit" };

  const envValue = process.env.PAPERCLIP_API_KEY?.trim();
  if (envValue) return { value: envValue, source: "env" };

  const profileEnvValue = readKeyFromProfileEnv(profile);
  if (profileEnvValue) return { value: profileEnvValue, source: "profile_env" };

  return { value: undefined, source: "none" };
}

function shouldRecoverBoardAuth(error: ApiRequestError): boolean {
  if (error.status === 401) return true;
  if (error.status !== 403) return false;
  return error.message.includes("Board access required") || error.message.includes("Instance admin required");
}

function canAttemptInteractiveBoardAuth(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function printOutput(data: unknown, opts: { json?: boolean; label?: string } = {}): void {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (opts.label) {
    console.log(pc.bold(opts.label));
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log(pc.dim("(empty)"));
      return;
    }
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        console.log(formatInlineRecord(item as Record<string, unknown>));
      } else {
        console.log(String(item));
      }
    }
    return;
  }

  if (typeof data === "object" && data !== null) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data === undefined || data === null) {
    console.log(pc.dim("(null)"));
    return;
  }

  console.log(String(data));
}

export function formatInlineRecord(record: Record<string, unknown>): string {
  const keyOrder = ["identifier", "id", "name", "status", "priority", "title", "action"];
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const key of keyOrder) {
    if (!(key in record)) continue;
    parts.push(`${key}=${renderValue(record[key])}`);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(record)) {
    if (seen.has(key)) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${renderValue(value)}`);
  }

  return parts.join(" ");
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 90 ? `${compact.slice(0, 87)}...` : compact;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "[object]";
}

export function inferApiBaseFromConfig(configPath?: string): string {
  const envHost = process.env.PAPERCLIP_SERVER_HOST?.trim() || "localhost";
  let port = Number(process.env.PAPERCLIP_SERVER_PORT || "");

  if (!Number.isFinite(port) || port <= 0) {
    try {
      const config = readConfig(configPath);
      port = Number(config?.server?.port ?? 3100);
    } catch {
      port = 3100;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    port = 3100;
  }

  return `http://${envHost}:${port}`;
}

function readKeyFromProfileEnv(profile: ClientContextProfile): string | undefined {
  if (!profile.apiKeyEnvVarName) return undefined;
  return process.env[profile.apiKeyEnvVarName]?.trim() || undefined;
}

export function handleCommandError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    const detailSuffix = error.details !== undefined ? ` details=${JSON.stringify(error.details)}` : "";
    console.error(pc.red(`API error ${error.status}: ${error.message}${detailSuffix}`));
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exit(1);
}

/**
 * Tokenize argv so we can reason about flags and the command/subcommand pair
 * WITHOUT confusing flag names with user-supplied argument values.
 *
 * Rules (conservative, sufficient for hint detection):
 *  - `commandPath` = leading positional tokens (everything before the first
 *    token that starts with `-`). For `paperclipai issue update <uuid> --status done`
 *    this yields `["issue", "update", "<uuid>"]`, which is enough to match the
 *    `issue update` subcommand prefix.
 *  - `flagTokens` = exact argv entries that start with `-`, split on `=` so
 *    that `--project-name=gBETA` becomes `--project-name`. Values (the argv
 *    entry after a flag, or any entry after the first flag that isn't itself
 *    a flag) are NOT inspected, which is what prevents false positives when a
 *    value (e.g. a `--title`) contains flag-like substrings.
 */
function tokenizeArgvForHints(argv: readonly string[]): {
  commandPath: string[];
  flagTokens: Set<string>;
} {
  const commandPath: string[] = [];
  const flagTokens = new Set<string>();
  let sawFlag = false;

  for (const raw of argv) {
    if (raw.startsWith("-")) {
      sawFlag = true;
      const name = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
      flagTokens.add(name);
    } else if (!sawFlag) {
      commandPath.push(raw);
    }
    // Once we've seen a flag, any subsequent non-flag token is treated as a
    // value and deliberately ignored for hint-matching purposes.
  }

  return { commandPath, flagTokens };
}

function matchesSubcommand(
  commandPath: readonly string[],
  expected: readonly string[],
): boolean {
  if (commandPath.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (commandPath[i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Known-wrong flag → friendly hint. Emits a guidance line (to stderr) BEFORE
 * commander renders its generic "unknown option" error, so the user sees the
 * actionable remediation first.
 *
 * This is a best-effort pre-parse sweep over argv. It scans flag NAMES (not
 * argument values) for a short allow-list of common mistakes, and it does NOT
 * short-circuit commander — commander still runs and still exits non-zero,
 * which preserves scripted workflows that rely on a failure exit code.
 *
 * Scanning flag names rather than the joined argv string avoids false
 * positives when a user-supplied value (e.g. an `--title` containing the
 * literal text "issue update -C") accidentally matches a hint pattern.
 */
export function emitFlagHintsFromArgv(argv: readonly string[]): void {
  const { commandPath, flagTokens } = tokenizeArgvForHints(argv);

  // --project-name / --project-title: not supported; CLI accepts --project-id only.
  if (flagTokens.has("--project-name") || flagTokens.has("--project-title")) {
    console.error(
      pc.yellow(
        "[paperclipai] Flag hint: --project-name / --project-title are not supported. Use --project-id <uuid>.\n" +
          "  Resolve a project UUID from its name via REST: curl -u admin:<pw> http://localhost:3100/api/companies/$CID/projects | jq '.[] | {id, name}'",
      ),
    );
  }

  // --parent-issue-id: legacy/expected name, actual flag is --parent-id.
  if (flagTokens.has("--parent-issue-id")) {
    console.error(
      pc.yellow(
        "[paperclipai] Flag hint: --parent-issue-id is not a recognized option. Use --parent-id <uuid> on `issue create`.",
      ),
    );
  }

  // `issue update ... -C/--company-id ...` — unsupported on update.
  const isIssueUpdate = matchesSubcommand(commandPath, ["issue", "update"]);
  const hasCompanyFlag =
    flagTokens.has("-C") || flagTokens.has("--company-id");
  if (isIssueUpdate && hasCompanyFlag) {
    console.error(
      pc.yellow(
        "[paperclipai] Flag hint: `issue update` does NOT accept -C/--company-id. The issue is resolved from the <issueId> argument alone.\n" +
          "  Correct usage: paperclipai issue update <issueId> --status in_progress [--comment \"activity log entry\"]",
      ),
    );
  }

  // `issue comment` with --content (expected name is --body).
  const isIssueComment = matchesSubcommand(commandPath, ["issue", "comment"]);
  if (isIssueComment && flagTokens.has("--content")) {
    console.error(
      pc.yellow(
        "[paperclipai] Flag hint: `issue comment` uses --body <text>, not --content.",
      ),
    );
  }
}
