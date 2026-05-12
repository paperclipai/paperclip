import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_SOURCE_OAUTH = "anthropic-oauth";
const CLAUDE_USAGE_SOURCE_CLI = "claude-cli";

// Keychain service name used by the `claude` CLI when it stores credentials on macOS.
// Verified against `security find-generic-password -s "Claude Code-credentials" -a "$USER"`.
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export function claudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

function hasNonEmptyProcessEnv(key: string): boolean {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function createClaudeQuotaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("ANTHROPIC_")) continue;
    env[key] = value;
  }
  return env;
}

function stripBackspaces(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\b") {
      out = out.slice(0, -1);
    } else {
      out += char;
    }
  }
  return out;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function cleanTerminalText(text: string): string {
  return stripAnsi(stripBackspaces(text))
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n");
}

function normalizeForLabelSearch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function trimToLatestUsagePanel(text: string): string | null {
  const lower = text.toLowerCase();
  const settingsIndex = lower.lastIndexOf("settings:");
  if (settingsIndex < 0) return null;
  let tail = text.slice(settingsIndex);
  const tailLower = tail.toLowerCase();
  if (!tailLower.includes("usage")) return null;
  if (!tailLower.includes("current session") && !tailLower.includes("loading usage")) return null;
  const stopMarkers = [
    "status dialog dismissed",
    "checking for updates",
    "press ctrl-c again to exit",
  ];
  let stopIndex = -1;
  for (const marker of stopMarkers) {
    const markerIndex = tailLower.indexOf(marker);
    if (markerIndex >= 0 && (stopIndex === -1 || markerIndex < stopIndex)) {
      stopIndex = markerIndex;
    }
  }
  if (stopIndex >= 0) {
    tail = tail.slice(0, stopIndex);
  }
  return tail;
}

/** Pure parser shared by the file and Keychain readers. The two sources store the
 * same JSON shape — the Keychain entry is literally the contents of `.credentials.json`. */
export function parseClaudeCredentialsPayload(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const oauth = obj["claudeAiOauth"];
  if (typeof oauth !== "object" || oauth === null) return null;
  const token = (oauth as Record<string, unknown>)["accessToken"];
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function readClaudeTokenFromFile(credPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(credPath, "utf8");
  } catch {
    return null;
  }
  return parseClaudeCredentialsPayload(raw);
}

/** Runs a command and returns stdout. Injectable so tests can stub the macOS
 * `security` invocation without spawning real processes. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string }>;

const defaultRunCommand: CommandRunner = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, {
    timeout: options?.timeout ?? 5_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout };
};

export interface ReadKeychainOptions {
  platform?: NodeJS.Platform;
  account?: string;
  service?: string;
  runCommand?: CommandRunner;
}

/** Reads the Claude OAuth credentials JSON from the macOS Keychain entry that the
 * `claude` CLI writes when the user logs in via claude.ai on macOS. Returns null on
 * non-darwin platforms, when the entry is missing, or when the payload isn't shaped
 * like a credentials blob. Never throws — Keychain absence is a normal state. */
export async function readClaudeTokenFromKeychain(
  options: ReadKeychainOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return null;

  const account = options.account ?? process.env.USER ?? os.userInfo().username;
  if (!account) return null;

  const service = options.service ?? CLAUDE_KEYCHAIN_SERVICE;
  const run = options.runCommand ?? defaultRunCommand;

  let stdout: string;
  try {
    const result = await run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
    stdout = result.stdout;
  } catch {
    return null;
  }

  return parseClaudeCredentialsPayload(stdout.trim());
}

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

export async function readClaudeAuthStatus(): Promise<ClaudeAuthStatus | null> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], {
      env: process.env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

function describeClaudeSubscriptionAuth(status: ClaudeAuthStatus | null): string | null {
  if (!status?.loggedIn || status.authMethod !== "claude.ai") return null;
  return status.subscriptionType
    ? `Claude is logged in via claude.ai (${status.subscriptionType})`
    : "Claude is logged in via claude.ai";
}

export interface ReadClaudeTokenOptions {
  /** Optional Keychain reader override; useful for tests. Defaults to the real macOS Keychain. */
  readKeychain?: (options?: ReadKeychainOptions) => Promise<string | null>;
}

export async function readClaudeToken(options: ReadClaudeTokenOptions = {}): Promise<string | null> {
  const configDir = claudeConfigDir();
  for (const filename of [".credentials.json", "credentials.json"]) {
    const token = await readClaudeTokenFromFile(path.join(configDir, filename));
    if (token) return token;
  }
  const readKeychain = options.readKeychain ?? readClaudeTokenFromKeychain;
  return readKeychain();
}

interface AnthropicUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface AnthropicExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string | null;
}

interface AnthropicUsageResponse {
  five_hour?: AnthropicUsageWindow | null;
  seven_day?: AnthropicUsageWindow | null;
  seven_day_sonnet?: AnthropicUsageWindow | null;
  seven_day_opus?: AnthropicUsageWindow | null;
  extra_usage?: AnthropicExtraUsage | null;
}

function formatCurrencyAmount(value: number, currency: string | null | undefined): string {
  const code = typeof currency === "string" && currency.trim().length > 0 ? currency.trim().toUpperCase() : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatExtraUsageLabel(extraUsage: AnthropicExtraUsage): string | null {
  const monthlyLimit = extraUsage.monthly_limit;
  const usedCredits = extraUsage.used_credits;
  if (
    typeof monthlyLimit !== "number" ||
    !Number.isFinite(monthlyLimit) ||
    typeof usedCredits !== "number" ||
    !Number.isFinite(usedCredits)
  ) {
    return null;
  }
  // API returns values in cents — convert to dollars for display
  return `${formatCurrencyAmount(usedCredits / 100, extraUsage.currency)} / ${formatCurrencyAmount(monthlyLimit / 100, extraUsage.currency)}`;
}

/** Convert a utilization value to a 0-100 integer percent. Returns null for null/undefined input.
 *  Handles both 0-1 fractions (legacy) and 0-100 percentages (current API). */
export function toPercent(utilization: number | null | undefined): number | null {
  if (utilization == null) return null;
  return Math.min(100, Math.round(utilization < 1 ? utilization * 100 : utilization));
}

/** fetch with an abort-based timeout so a hanging provider api doesn't block the response indefinitely */
export async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeQuota(token: string): Promise<QuotaWindow[]> {
  const resp = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!resp.ok) throw new Error(`anthropic usage api returned ${resp.status}`);
  const body = (await resp.json()) as AnthropicUsageResponse;
  const windows: QuotaWindow[] = [];

  if (body.five_hour != null) {
    windows.push({
      label: "Current session",
      usedPercent: toPercent(body.five_hour.utilization),
      resetsAt: body.five_hour.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day != null) {
    windows.push({
      label: "Current week (all models)",
      usedPercent: toPercent(body.seven_day.utilization),
      resetsAt: body.seven_day.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_sonnet != null) {
    windows.push({
      label: "Current week (Sonnet only)",
      usedPercent: toPercent(body.seven_day_sonnet.utilization),
      resetsAt: body.seven_day_sonnet.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.seven_day_opus != null) {
    windows.push({
      label: "Current week (Opus only)",
      usedPercent: toPercent(body.seven_day_opus.utilization),
      resetsAt: body.seven_day_opus.resets_at ?? null,
      valueLabel: null,
      detail: null,
    });
  }
  if (body.extra_usage != null) {
    windows.push({
      label: "Extra usage",
      usedPercent: body.extra_usage.is_enabled === false ? null : toPercent(body.extra_usage.utilization),
      resetsAt: null,
      valueLabel:
        body.extra_usage.is_enabled === false
          ? "Not enabled"
          : formatExtraUsageLabel(body.extra_usage),
      detail:
        body.extra_usage.is_enabled === false
          ? "Extra usage not enabled"
          : "Monthly extra usage pool",
    });
  }
  return windows;
}

function usageOutputLooksRelevant(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  return normalized.includes("currentsession")
    || normalized.includes("currentweek")
    || normalized.includes("loadingusage")
    || normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited");
}

function usageOutputLooksComplete(text: string): boolean {
  const normalized = normalizeForLabelSearch(text);
  if (
    normalized.includes("failedtoloadusagedata")
    || normalized.includes("tokenexpired")
    || normalized.includes("authenticationerror")
    || normalized.includes("ratelimited")
  ) {
    return true;
  }
  return normalized.includes("currentsession")
    && (normalized.includes("currentweek") || normalized.includes("extrausage"))
    && /[0-9]{1,3}(?:\.[0-9]+)?%/i.test(text);
}

function extractUsageError(text: string): string | null {
  const lower = text.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (lower.includes("token_expired") || lower.includes("token has expired")) {
    return "Claude CLI token expired. Run `claude login` to refresh.";
  }
  if (lower.includes("authentication_error")) {
    return "Claude CLI authentication error. Run `claude login`.";
  }
  if (lower.includes("rate_limit_error") || lower.includes("rate limited") || compact.includes("ratelimited")) {
    return "Claude CLI usage endpoint is rate limited right now. Please try again later.";
  }
  if (lower.includes("failed to load usage data") || compact.includes("failedtoloadusagedata")) {
    return "Claude CLI could not load usage data. Open the CLI and retry `/usage`.";
  }
  return null;
}

function percentFromLine(line: string): number | null {
  const match = line.match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i);
  if (!match) return null;
  const rawValue = Number(match[1]);
  if (!Number.isFinite(rawValue)) return null;
  const clamped = Math.min(100, Math.max(0, rawValue));
  const lower = line.toLowerCase();
  if (lower.includes("remaining") || lower.includes("left") || lower.includes("available")) {
    return Math.max(0, Math.min(100, Math.round(100 - clamped)));
  }
  return Math.round(clamped);
}

function isQuotaLabel(line: string): boolean {
  const normalized = normalizeForLabelSearch(line);
  return normalized === "currentsession"
    || normalized === "currentweekallmodels"
    || normalized === "currentweeksonnetonly"
    || normalized === "currentweeksonnet"
    || normalized === "currentweekopusonly"
    || normalized === "currentweekopus"
    || normalized === "extrausage";
}

function canonicalQuotaLabel(line: string): string {
  switch (normalizeForLabelSearch(line)) {
    case "currentsession":
      return "Current session";
    case "currentweekallmodels":
      return "Current week (all models)";
    case "currentweeksonnetonly":
    case "currentweeksonnet":
      return "Current week (Sonnet only)";
    case "currentweekopusonly":
    case "currentweekopus":
      return "Current week (Opus only)";
    case "extrausage":
      return "Extra usage";
    default:
      return line;
  }
}

function formatClaudeCliDetail(label: string, lines: string[]): string | null {
  const normalizedLabel = normalizeForLabelSearch(label);
  if (normalizedLabel === "extrausage") {
    const compact = lines.join(" ").replace(/\s+/g, "").toLowerCase();
    if (compact.includes("extrausagenotenabled")) {
      return "Extra usage not enabled • /extra-usage to enable";
    }
    const firstLine = lines.find((line) => line.trim().length > 0) ?? null;
    return firstLine;
  }

  const resetLine = lines.find((line) => /^resets/i.test(line) || normalizeForLabelSearch(line).startsWith("resets"));
  if (!resetLine) return null;
  return resetLine
    .replace(/^Resets/i, "Resets ")
    .replace(/([A-Z][a-z]{2})(\d)/g, "$1 $2")
    .replace(/(\d)at(\d)/g, "$1 at $2")
    .replace(/(am|pm)\(/gi, "$1 (")
    .replace(/([A-Za-z])\(/g, "$1 (")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseClaudeCliUsageText(text: string): QuotaWindow[] {
  const cleaned = trimToLatestUsagePanel(cleanTerminalText(text)) ?? cleanTerminalText(text);
  const usageError = extractUsageError(cleaned);
  if (usageError) throw new Error(usageError);

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const sections: Array<{ label: string; lines: string[] }> = [];
  let current: { label: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (isQuotaLabel(line)) {
      if (current) sections.push(current);
      current = { label: canonicalQuotaLabel(line), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  const windows = sections.map<QuotaWindow>((section) => {
    const usedPercent = section.lines.map(percentFromLine).find((value) => value != null) ?? null;
    return {
      label: section.label,
      usedPercent,
      resetsAt: null,
      valueLabel: null,
      detail: formatClaudeCliDetail(section.label, section.lines),
    };
  });

  if (!windows.some((window) => normalizeForLabelSearch(window.label) === "currentsession")) {
    throw new Error("Could not parse Claude CLI usage output.");
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Claude CLI `/usage` TTY scrape — DIAGNOSTIC USE ONLY.
//
// The functions below shell out to `script -q` to drive the `claude` TUI and
// scrape the rendered `/usage` panel. They are NOT used by the production
// quota-polling path (`getQuotaWindows`) because the TTY pipeline is brittle
// and produces shell-quoted error strings that surface as scary UI errors.
// They remain exported so the diagnostic CLI (`src/cli/quota-probe.ts`) can
// still gather forensic data when a support engineer asks for `--raw-cli`.
// ---------------------------------------------------------------------------

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildClaudeCliShellProbeCommand(): string {
  const feed = "(sleep 2; printf '/usage\\r'; sleep 6; printf '\\033'; sleep 1; printf '\\003')";
  const claudeCommand = "claude --tools \"\"";
  if (process.platform === "darwin") {
    return `${feed} | script -q /dev/null ${claudeCommand}`;
  }
  return `${feed} | script -q -e -f -c ${quoteForShell(claudeCommand)} /dev/null`;
}

export async function captureClaudeCliUsageText(timeoutMs = 12_000): Promise<string> {
  const command = buildClaudeCliShellProbeCommand();
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      env: createClaudeQuotaEnv(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = `${stdout}${stderr}`;
    const cleaned = cleanTerminalText(output);
    if (usageOutputLooksComplete(cleaned)) return output;
    throw new Error("Claude CLI usage probe ended before rendering usage.");
  } catch (error) {
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    const output = `${stdout}${stderr}`;
    const cleaned = cleanTerminalText(output);
    if (usageOutputLooksComplete(cleaned)) return output;
    if (usageOutputLooksRelevant(cleaned)) {
      throw new Error("Claude CLI usage probe ended before rendering usage.");
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function fetchClaudeCliQuota(): Promise<QuotaWindow[]> {
  const rawText = await captureClaudeCliUsageText();
  return parseClaudeCliUsageText(rawText);
}

export interface GetQuotaWindowsOptions {
  readAuthStatus?: () => Promise<ClaudeAuthStatus | null>;
  readToken?: () => Promise<string | null>;
  fetchOauthQuota?: (token: string) => Promise<QuotaWindow[]>;
  env?: NodeJS.ProcessEnv;
}

const TOKEN_UNAVAILABLE_MESSAGE =
  "Quota polling unavailable: no Claude OAuth token in ~/.claude/.credentials.json or macOS Keychain. " +
  "If you only use the `claude` CLI on macOS, this is expected — the CLI keeps the token in Keychain " +
  "but Paperclip only reads it from there on macOS hosts.";

export async function getQuotaWindows(options: GetQuotaWindowsOptions = {}): Promise<ProviderQuotaResult> {
  const env = options.env ?? process.env;
  const envHas = (key: string): boolean => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  };

  if (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    envHas("ANTHROPIC_BEDROCK_BASE_URL")
  ) {
    return { provider: "anthropic", source: "bedrock", ok: true, windows: [] };
  }

  const readAuthStatus = options.readAuthStatus ?? readClaudeAuthStatus;
  const readToken = options.readToken ?? readClaudeToken;
  const fetchOauthQuota = options.fetchOauthQuota ?? fetchClaudeQuota;

  const authStatus = await readAuthStatus();
  const authDescription = describeClaudeSubscriptionAuth(authStatus);
  const token = await readToken();

  if (token) {
    try {
      const windows = await fetchOauthQuota(token);
      return { provider: "anthropic", source: CLAUDE_USAGE_SOURCE_OAUTH, ok: true, windows };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        provider: "anthropic",
        ok: false,
        error: authDescription
          ? `${authDescription}, but the Anthropic usage API call failed: ${message}`
          : `Anthropic usage API call failed: ${message}`,
        windows: [],
      };
    }
  }

  if (envHas("ANTHROPIC_API_KEY") && !authDescription) {
    return {
      provider: "anthropic",
      ok: false,
      error:
        "ANTHROPIC_API_KEY is set and no local Claude subscription session is available for quota polling",
      windows: [],
    };
  }

  if (authDescription) {
    return {
      provider: "anthropic",
      ok: false,
      error: `${authDescription}, but ${TOKEN_UNAVAILABLE_MESSAGE.charAt(0).toLowerCase()}${TOKEN_UNAVAILABLE_MESSAGE.slice(1)}`,
      windows: [],
    };
  }

  return {
    provider: "anthropic",
    ok: false,
    error: TOKEN_UNAVAILABLE_MESSAGE,
    windows: [],
  };
}
